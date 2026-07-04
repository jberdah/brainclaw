import { memoryExists } from '../core/io.js';
import { mutate } from '../core/mutation-pipeline.js';
import { loadClaim, listClaims, releaseClaim } from '../core/claims.js';
import { rebuildProjectMd } from '../core/markdown.js';
import { loadState, mutateState } from '../core/state.js';
import { requireMinimumTrustLevel, requireRegisteredAgentIdentity } from '../core/agent-registry.js';

export interface ReleaseClaimOptions {
  planStatus?: 'todo' | 'in_progress' | 'blocked' | 'done' | 'dropped';
  coordinatorOverride?: boolean;
  cwd?: string;
}

export function runReleaseClaim(id: string, options: ReleaseClaimOptions = {}): void {
  if (!memoryExists(options.cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  try {
    // Surface split (trp#928 follow-up): the ownership gate lives on the MCP
    // surface (bclaw_release_claim / bclaw_transition), where agent callers
    // carry a session-bound identity. The CLI `release-claim <id>` is the
    // operator/scripting surface and keeps its historic unguarded semantics —
    // the e2e contract (collaboration.test.ts) has always released cross-agent
    // claims from an env-identified CLI. Deriving an ambient identity here and
    // gating on it turned every operator release into a false ownership
    // mismatch (silent-default anti-pattern, pln#607). `--coordinator-override`
    // stays available to make a cross-agent release explicit and audited.
    let releaseAuth: { agent?: string; agent_id?: string; override: boolean } | undefined;
    if (options.coordinatorOverride) {
      const identity = requireRegisteredAgentIdentity({ cwd: options.cwd, allowCurrent: true, allowEnv: true });
      requireMinimumTrustLevel(identity, 'trusted');
      releaseAuth = {
        agent: identity.agent_name,
        agent_id: identity.agent_id,
        override: true,
      };
    }
    let claim = loadClaim(id, options.cwd);
    mutate({ cwd: options.cwd }, () => {
      const existing = loadClaim(id, options.cwd);
      claim = releaseClaim(id, options.cwd, releaseAuth);
      if (existing.plan_id) {
        const updated = mutateState((state) => {
          const plan = state.plan_items.find((item) => item.id === existing.plan_id);
          if (!plan) {
            return false;
          }
          const otherActiveClaims = listClaims(options.cwd).filter((item) => item.status === 'active' && item.plan_id === existing.plan_id);
          if (options.planStatus) {
            plan.status = options.planStatus;
          } else if (otherActiveClaims.length === 0 && plan.status === 'in_progress') {
            plan.status = 'todo';
          }
          if (otherActiveClaims.length === 0 && plan.assignee === existing.agent) {
            plan.assignee = undefined;
          }
          plan.updated_at = new Date().toISOString();
          return true;
        }, options.cwd, { writeProjectMarkdown: false });

        if (updated) {
          const state = loadState(options.cwd);
          rebuildProjectMd(state, options.cwd);
        }
      }
    });
    console.log(`✔ Claim [${id}] released (was: ${claim.agent} → ${claim.scope})`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }
}
