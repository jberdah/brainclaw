import { findAgentIdentityByName, resolveAgentScope, resolveCurrentAgentIdentity } from './agent-registry.js';
import { loadConfig } from './config.js';
import { resolveCurrentHostId } from './host.js';
import { listClaims } from './claims.js';
import { inferProjectFromTarget, loadInstructions, resolveInstructions } from './instructions.js';
import { buildReputationSummary, findAgentReputationSummary } from './reputation.js';
import { listRuntimeNotes } from './runtime.js';
import { loadState, persistState } from './state.js';

export interface CoordinationOptions {
  agent?: string;
  project?: string;
  target?: string;
  host?: string;
  allHosts?: boolean;
  includeReputation?: boolean;
  /** If false (default), session_start and session_end runtime notes are excluded from the board. */
  includeSessionMeta?: boolean;
  /** If true, all open handoffs shown to the agent are auto-marked as 'accepted'. */
  autoAcknowledge?: boolean;
  cwd?: string;
}

export function buildCoordinationSnapshot(options: CoordinationOptions = {}) {
  const config = loadConfig(options.cwd);
  const state = loadState(options.cwd);
  const currentHost = resolveCurrentHostId();
  const project = options.project ?? inferProjectFromTarget(options.target, config);
  const agent = resolveAgentScope(options.agent, options.cwd);
  const resolvedAgentIdentity = agent
    ? (options.agent ? findAgentIdentityByName(agent, options.cwd) : resolveCurrentAgentIdentity(options.cwd))
    : undefined;
  const claims = listClaims(options.cwd).filter((claim) => claim.status === 'active');
  const runtimeNotes = listRuntimeNotes({
    agent,
    hostId: options.host,
    includeAllHosts: options.allHosts,
  }, options.cwd);
  const activePlans = state.plan_items.filter((plan) => plan.status !== 'done' && plan.status !== 'dropped');
  const openHandoffs = state.open_handoffs.filter((handoff) => handoff.status === 'open');
  const instructions = resolveInstructions(loadInstructions(options.cwd), { project, agent });
  const reputationSummary = options.includeReputation ? buildReputationSummary(options.cwd) : undefined;
  const agentReputation = options.includeReputation && agent
    ? findAgentReputationSummary(resolvedAgentIdentity?.agent_id ?? agent, options.cwd)
    : undefined;

  const filteredPlans = project
    ? activePlans.filter((plan) => !plan.project || plan.project === project)
    : activePlans;
  const filteredClaims = project
    ? claims.filter((claim) => !claim.project || claim.project === project)
    : claims;

  // perf.3: filter session lifecycle notes unless explicitly requested
  const sessionMetaNoteTypes = new Set(['session_start', 'session_end']);
  const visibleNotes = options.includeSessionMeta
    ? runtimeNotes
    : runtimeNotes.filter((note) => !sessionMetaNoteTypes.has(note.note_type ?? ''));
  const sessionMetaHidden = runtimeNotes.length - visibleNotes.length;
  const filteredNotes = project
    ? visibleNotes.filter((note) => !note.project || note.project === project)
    : visibleNotes;

  // factor out handoff filter for reuse in auto-acknowledge
  const filteredHandoffs = agent
    ? openHandoffs.filter((h) => (!project || !h.project || h.project === project) && (h.to === agent || h.from === agent))
    : (project ? openHandoffs.filter((h) => !h.project || h.project === project) : openHandoffs);

  // perf.2: auto-acknowledge shown handoffs
  if (options.autoAcknowledge && filteredHandoffs.length > 0) {
    const toAckIds = new Set(filteredHandoffs.map((h) => h.id));
    let changed = false;
    for (const h of state.open_handoffs) {
      if (toAckIds.has(h.id) && h.status === 'open') {
        h.status = 'accepted';
        changed = true;
      }
    }
    if (changed) persistState(state, options.cwd);
  }

  return {
    project_id: config.project_id,
    current_host: currentHost,
    host_filter: options.host,
    all_hosts: options.allHosts ?? false,
    project,
    agent,
    agent_id: resolvedAgentIdentity?.agent_id,
    active_plans: filteredPlans.map((plan) => ({
      ...plan,
      claims: filteredClaims.filter((claim) => claim.plan_id === plan.id),
    })),
    active_claims: agent
      ? filteredClaims.filter((claim) => claim.agent === agent)
      : filteredClaims,
    runtime_notes: filteredNotes,
    session_meta_hidden: sessionMetaHidden,
    open_handoffs: filteredHandoffs,
    resolved_instructions: instructions,
    reputation_summary: reputationSummary,
    agent_reputation: agentReputation,
  };
}
