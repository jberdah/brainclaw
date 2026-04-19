import { buildCoordinationSnapshot } from '../core/coordination.js';
import { listAgentIdentities } from '../core/agent-registry.js';
import { memoryExists } from '../core/io.js';
import { listCandidates } from '../core/candidates.js';
import { listRuntimeNotes } from '../core/runtime.js';
import { loadState } from '../core/state.js';
import { detectStaleness, staleSummary } from '../core/staleness.js';

export interface AgentBoardOptions {
  agent?: string;
  project?: string;
  for?: string;
  host?: string;
  allHosts?: boolean;
  allAgents?: boolean;
  json?: boolean;
  withReputation?: boolean;
  capabilities?: boolean;
  suggest?: string;
  includeSessionMeta?: boolean;
}

export function runAgentBoard(options: AgentBoardOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const board = buildCoordinationSnapshot({
    agent: options.allAgents ? undefined : options.agent,
    skipAgentAutoDetect: options.allAgents,
    project: options.project,
    target: options.for,
    host: options.host,
    allHosts: options.allHosts,
    includeReputation: options.withReputation,
    includeSessionMeta: options.includeSessionMeta,
  });

  // Phase 4 Sprint 1 Lane A step 3 (pln#390): surface non-destructive
  // stale warnings alongside the board so operators see them without
  // running `doctor` separately. Capped at 5 to keep output lean.
  let staleReport: ReturnType<typeof detectStaleness> | undefined;
  try {
    const state = loadState();
    const pending = listCandidates('pending');
    const notes = listRuntimeNotes(undefined);
    staleReport = detectStaleness(
      state.plan_items,
      state.known_traps,
      state.open_handoffs,
      pending,
      Date.now(),
      notes,
    );
  } catch { /* non-fatal */ }

  if (options.json) {
    console.log(JSON.stringify({
      ...board,
      ...(staleReport && staleReport.warnings.length > 0 ? { stale_report: staleReport } : {}),
    }, null, 2));
    return;
  }

  console.log(`Agent board${board.agent ? ` for ${board.agent}` : ''}${board.project ? ` (${board.project})` : ''}`);
  console.log('');
  console.log(`Current host: ${board.current_host}`);
  if (board.all_hosts) {
    console.log('Host filter: all-hosts');
  } else if (board.host_filter) {
    console.log(`Host filter: ${board.host_filter}`);
  }
  if (options.withReputation && board.reputation_summary) {
    console.log(`Reputation: tracked=${board.reputation_summary.tracked_agents}, avg_trust=${board.reputation_summary.avg_internal_trust}`);
    if (board.agent_reputation) {
      console.log(`Agent trust: ${board.agent_reputation.internal_trust} (cq=${board.agent_reputation.contribution_quality}, rv=${board.agent_reputation.review_reliability}, ct=${board.agent_reputation.continuity_hygiene})`);
    }
  }
  console.log('');
  console.log(`Active plans: ${board.active_plans.length}`);
  for (const plan of board.active_plans.slice(0, 10)) {
    const claims = plan.claims.length ? ` claims=${plan.claims.map((claim) => claim.agent).join(',')}` : '';
    console.log(`  [${plan.id}] ${plan.text} (${plan.status}, ${plan.priority})${claims}`);
  }
  console.log('');
  console.log(`Active claims: ${board.active_claims.length}`);
  for (const claim of board.active_claims.slice(0, 10)) {
    console.log(`  [${claim.id}] ${claim.agent} -> ${claim.scope}${claim.plan_id ? ` (plan ${claim.plan_id})` : ''}`);
  }
  console.log('');
  console.log(`Active assignments: ${board.active_assignments.length}`);
  for (const assignment of board.active_assignments.slice(0, 10)) {
    console.log(`  [${assignment.id}] ${assignment.agent} (${assignment.status}) -> ${assignment.scope}${assignment.plan_id ? ` (plan ${assignment.plan_id})` : ''}`);
  }
  console.log('');
  console.log(`Active runs: ${board.active_runs.length}`);
  for (const run of board.active_runs.slice(0, 10)) {
    console.log(`  [${run.id}] ${run.agent} (${run.status}/${run.transport}) -> ${run.scope}${run.assignment_id ? ` (assignment ${run.assignment_id})` : ''} [attempt ${run.attempt_index}]`);
  }
  console.log('');
  console.log(`Pending actions: ${board.active_actions.length}`);
  for (const action of board.active_actions.slice(0, 10)) {
    console.log(`  [${action.id}] ${action.kind} for ${action.agent} (${action.status})${action.assignment_id ? ` [assignment ${action.assignment_id}]` : ''}: ${action.title}`);
  }
  console.log('');
  console.log(`Active sequence: ${board.active_sequence ? `1 (${board.active_sequence.name})` : '0'}`);
  if (board.active_sequence) {
    console.log(`  [${board.active_sequence.id}] ${board.active_sequence.name} (${board.active_sequence.status})`);
    for (const item of board.active_sequence.items.slice(0, 10)) {
      const lane = item.lane ? ` lane=${item.lane}` : '';
      const hardAfter = item.hard_after.length ? ` hard_after=${item.hard_after.join(',')}` : '';
      const softAfter = item.soft_after.length ? ` soft_after=${item.soft_after.join(',')}` : '';
      console.log(`    #${item.rank} ${item.planId}${lane}${hardAfter}${softAfter}`);
    }
  }
  console.log('');
  const sessionMetaHint = board.session_meta_hidden > 0 ? ` (+${board.session_meta_hidden} session lifecycle notes hidden — use --include-session-meta to show)` : '';
  console.log(`Runtime notes: ${board.runtime_notes.length}${sessionMetaHint}`);
  for (const note of board.runtime_notes.slice(-10)) {
    const scope = note.visibility === 'shared' ? 'shared' : `${note.visibility}:${note.host_id ?? 'unknown-host'}`;
    console.log(`  [${note.id}] ${note.agent}: ${note.text}${note.plan_id ? ` (plan ${note.plan_id})` : ''} [${scope}]`);
  }
  console.log('');
  console.log(`Open handoffs: ${board.open_handoffs.length}`);
  for (const handoff of board.open_handoffs.slice(0, 10)) {
    console.log(`  [${handoff.id}] ${handoff.from} -> ${handoff.to}: ${handoff.text}${handoff.plan_id ? ` (plan ${handoff.plan_id})` : ''}`);
  }
  console.log('');
  console.log(`Resolved instructions: ${board.resolved_instructions.length}`);
  for (const instruction of board.resolved_instructions.slice(0, 10)) {
    console.log(`  [${instruction.id}] <${instruction.layer}${instruction.scope ? `:${instruction.scope}` : ''}> ${instruction.text}`);
  }

  // Capability routing
  if (options.capabilities || options.suggest) {
    const agents = listAgentIdentities();
    if (agents.length === 0) {
      console.log('');
      console.log('No agents registered.');
      return;
    }

    if (options.suggest) {
      const query = options.suggest.toLowerCase();
      const scored = agents
        .map(a => ({
          name: a.agent_name,
          capabilities: a.capabilities ?? [],
          score: (a.capabilities ?? []).filter(c => c.toLowerCase().includes(query)).length,
          trust_level: a.trust_level ?? 'contributor',
        }))
        .filter(a => a.score > 0)
        .sort((a, b) => b.score - a.score);

      console.log('');
      if (scored.length === 0) {
        console.log(`No agents have capabilities matching '${options.suggest}'.`);
      } else {
        console.log(`Suggested agents for '${options.suggest}':`);
        for (const a of scored) {
          console.log(`  ${a.name} (${a.trust_level}) — ${a.capabilities.join(', ')}`);
        }
      }
    } else {
      console.log('');
      console.log(`Registered agents: ${agents.length}`);
      for (const a of agents) {
        const caps = (a.capabilities ?? []).length > 0 ? ` — ${a.capabilities!.join(', ')}` : '';
        const fingerprint = a.identity_key?.fingerprint ? ` fp=${a.identity_key.fingerprint.slice(0, 12)}` : '';
        console.log(`  ${a.agent_name} (${a.trust_level ?? 'contributor'})${caps}${fingerprint}`);
      }
    }
  }

  // Stale-memory summary — non-destructive. Shown after the core board
  // so the signal is visible but does not push the primary state off
  // the screen.
  if (staleReport && staleReport.warnings.length > 0) {
    console.log('');
    console.log(`⚠ Stale memory: ${staleSummary(staleReport)}`);
    for (const w of staleReport.warnings.slice(0, 5)) {
      console.log(`  [${w.entity} ${w.id}] ${w.reason}`);
      console.log(`    → ${w.suggested_action}`);
    }
    if (staleReport.warnings.length > 5) {
      console.log(`  … and ${staleReport.warnings.length - 5} more (run \`brainclaw doctor\` for the full list).`);
    }
  }
}
