import { findAgentIdentityByName, resolveAgentScope, resolveCurrentAgentIdentity } from './agent-registry.js';
import { loadConfig } from './config.js';
import { resolveCurrentHostId } from './host.js';
import { listClaims } from './claims.js';
import { inferProjectFromTarget, loadInstructions, resolveInstructions } from './instructions.js';
import { buildReputationSummary, findAgentReputationSummary } from './reputation.js';
import { listRuntimeNotes } from './runtime.js';
import { loadState } from './state.js';

export interface CoordinationOptions {
  agent?: string;
  project?: string;
  target?: string;
  host?: string;
  allHosts?: boolean;
  includeReputation?: boolean;
}

export function buildCoordinationSnapshot(options: CoordinationOptions = {}) {
  const config = loadConfig();
  const state = loadState();
  const currentHost = resolveCurrentHostId();
  const project = options.project ?? inferProjectFromTarget(options.target, config);
  const agent = resolveAgentScope(options.agent);
  const resolvedAgentIdentity = agent
    ? (options.agent ? findAgentIdentityByName(agent) : resolveCurrentAgentIdentity())
    : undefined;
  const claims = listClaims().filter((claim) => claim.status === 'active');
  const runtimeNotes = listRuntimeNotes({
    agent,
    hostId: options.host,
    includeAllHosts: options.allHosts,
  });
  const activePlans = state.plan_items.filter((plan) => plan.status !== 'done' && plan.status !== 'dropped');
  const openHandoffs = state.open_handoffs.filter((handoff) => handoff.status === 'open');
  const instructions = resolveInstructions(loadInstructions(), { project, agent });
  const reputationSummary = options.includeReputation ? buildReputationSummary() : undefined;
  const agentReputation = options.includeReputation && agent ? findAgentReputationSummary(resolvedAgentIdentity?.agent_id ?? agent) : undefined;

  const filteredPlans = project
    ? activePlans.filter((plan) => !plan.project || plan.project === project)
    : activePlans;
  const filteredClaims = project
    ? claims.filter((claim) => !claim.project || claim.project === project)
    : claims;

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
    runtime_notes: project
      ? runtimeNotes.filter((note) => !note.project || note.project === project)
      : runtimeNotes,
    open_handoffs: agent
      ? openHandoffs.filter((handoff) => (!project || !handoff.project || handoff.project === project) && (handoff.to === agent || handoff.from === agent))
      : (project ? openHandoffs.filter((handoff) => !handoff.project || handoff.project === project) : openHandoffs),
    resolved_instructions: instructions,
    reputation_summary: reputationSummary,
    agent_reputation: agentReputation,
  };
}