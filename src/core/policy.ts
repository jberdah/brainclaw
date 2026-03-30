/**
 * Pre-execution policy checks.
 *
 * Deterministic guardrails that verify whether an agent is allowed
 * to act on a given scope.  No AI, no external dependencies —
 * just claims, constraints, traps and instructions.
 *
 * @module
 */

import { listClaims, isClaimExpired } from './claims.js';
import { loadState } from './state.js';
import { loadInstructions, resolveInstructions } from './instructions.js';
import type { Claim, Constraint, Trap, InstructionEntry } from './schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PolicyIssueKind =
  | 'no_claim'
  | 'claim_expired'
  | 'claim_conflict'
  | 'constraint'
  | 'trap'
  | 'instruction';

export type PolicySeverity = 'block' | 'warn';

export interface PolicyIssue {
  kind: PolicyIssueKind;
  severity: PolicySeverity;
  id?: string;
  message: string;
}

export interface PolicyCheckResult {
  allowed: boolean;
  blocks: PolicyIssue[];
  warnings: PolicyIssue[];
  governance_context: GovernanceContext;
}

export interface GovernanceContext {
  active_instructions: InstructionEntry[];
  matching_constraints: Constraint[];
  matching_traps: Trap[];
  active_claims_on_scope: Claim[];
}

export interface CheckPolicyOptions {
  scope: string;
  agent?: string;
  agentId?: string;
  action?: string;
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Path matching (reuses check-constraints pattern)
// ---------------------------------------------------------------------------

function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Returns true if `targetScope` overlaps with `relatedPath`.
 * Matches exactly or via prefix (directory containment) in both directions.
 */
function scopeOverlaps(targetScope: string, relatedPath: string): boolean {
  const s = normPath(targetScope).replace(/\/$/, '');
  const r = normPath(relatedPath).replace(/\/$/, '');
  // Exact match
  if (s === r) return true;
  // Target is inside related path (e.g. scope=src/core/foo.ts, related=src/core)
  if (s.startsWith(r + '/')) return true;
  // Related path is inside target scope (e.g. scope=src/core, related=src/core/foo.ts)
  if (r.startsWith(s + '/')) return true;
  return false;
}

/**
 * Check if a claim's scope overlaps with the target scope.
 * Claims use free-form scope strings (file paths, directory paths, or descriptive scopes).
 */
function claimScopeOverlaps(targetScope: string, claimScope: string): boolean {
  return scopeOverlaps(targetScope, claimScope);
}

// ---------------------------------------------------------------------------
// Core check
// ---------------------------------------------------------------------------

export function checkPolicy(options: CheckPolicyOptions): PolicyCheckResult {
  const cwd = options.cwd;
  const scope = options.scope;
  const agent = options.agent;

  const blocks: PolicyIssue[] = [];
  const warnings: PolicyIssue[] = [];

  // --- 1. Claim check ---
  const allClaims = listClaims(cwd);
  const activeClaims = allClaims.filter(c => c.status === 'active' && !isClaimExpired(c));
  const claimsOnScope = activeClaims.filter(c => claimScopeOverlaps(scope, c.scope));

  if (agent) {
    const agentLower = agent.toLowerCase();
    const myClaimsOnScope = claimsOnScope.filter(c =>
      c.agent.toLowerCase() === agentLower ||
      c.agent_id?.toLowerCase() === agentLower
    );
    const otherClaimsOnScope = claimsOnScope.filter(c =>
      c.agent.toLowerCase() !== agentLower &&
      c.agent_id?.toLowerCase() !== agentLower
    );

    if (myClaimsOnScope.length === 0 && claimsOnScope.length === 0) {
      blocks.push({
        kind: 'no_claim',
        severity: 'block',
        message: `No active claim on scope "${scope}". Run bclaw_claim first.`,
      });
    } else if (myClaimsOnScope.length === 0 && otherClaimsOnScope.length > 0) {
      for (const c of otherClaimsOnScope) {
        blocks.push({
          kind: 'claim_conflict',
          severity: 'block',
          id: c.id,
          message: `Scope "${scope}" is claimed by ${c.agent} [${c.id}]: ${c.description}`,
        });
      }
    }

    // Check for expired claims by this agent (informational)
    const expiredMyClaims = allClaims.filter(c =>
      c.status === 'active' && isClaimExpired(c) &&
      (c.agent.toLowerCase() === agentLower || c.agent_id?.toLowerCase() === agentLower) &&
      claimScopeOverlaps(scope, c.scope)
    );
    for (const c of expiredMyClaims) {
      warnings.push({
        kind: 'claim_expired',
        severity: 'warn',
        id: c.id,
        message: `Your claim [${c.id}] on "${c.scope}" has expired. Re-claim before editing.`,
      });
    }
  } else {
    // No agent specified — just report claim state
    if (claimsOnScope.length === 0) {
      warnings.push({
        kind: 'no_claim',
        severity: 'warn',
        message: `No active claim on scope "${scope}".`,
      });
    }
  }

  // --- 2. Constraint check ---
  const state = loadState(cwd);
  const matchingConstraints = state.active_constraints.filter(c =>
    c.related_paths?.some(rp => scopeOverlaps(scope, rp))
  );
  for (const c of matchingConstraints) {
    const catLabel = c.category ? ` [${c.category}]` : '';
    warnings.push({
      kind: 'constraint',
      severity: 'warn',
      id: c.id,
      message: `Constraint${catLabel}: ${c.text}`,
    });
  }

  // --- 3. Trap check ---
  const matchingTraps = state.known_traps.filter(t =>
    t.status === 'active' &&
    t.related_paths?.some(rp => scopeOverlaps(scope, rp))
  );
  for (const t of matchingTraps) {
    const sevLabel = t.severity ? ` [${t.severity}]` : '';
    warnings.push({
      kind: 'trap',
      severity: 'warn',
      id: t.id,
      message: `Trap${sevLabel}: ${t.text}`,
    });
  }

  // --- 4. Instructions (governance context — no matching in v1) ---
  const allInstructions = loadInstructions(cwd);
  const activeInstructions = resolveInstructions(allInstructions, {});

  const allowed = blocks.length === 0;

  return {
    allowed,
    blocks,
    warnings,
    governance_context: {
      active_instructions: activeInstructions,
      matching_constraints: matchingConstraints,
      matching_traps: matchingTraps,
      active_claims_on_scope: claimsOnScope,
    },
  };
}
