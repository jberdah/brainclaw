import { findAgentIdentityByName, listAgentIdentities, resolveAgentScope, resolveCurrentAgentIdentity } from './agent-registry.js';
import { loadConfig } from './config.js';
import { resolveCurrentHostId } from './host.js';
import { listClaims } from './claims.js';
import { getActiveSequence } from './sequence.js';
import { resolveCrossProjectLinks, listIncomingCrossProjectSignals, type CrossProjectSignalEnvelope } from './cross-project.js';
import { inferProjectFromTarget, loadInstructions, resolveInstructions } from './instructions.js';
import { buildReputationSummary, findAgentReputationSummary } from './reputation.js';
import { listRuntimeNotes } from './runtime.js';
import { loadState, persistState } from './state.js';
import { countActionable } from './messaging.js';
import { listCandidates } from './candidates.js';
import { pullSignalsFromLinkedProjects } from './federation-transport.js';

export interface CoordinationOptions {
  agent?: string;
  /** Skip auto-detection of current agent — show unfiltered board (supervisor mode). */
  skipAgentAutoDetect?: boolean;
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
  const agent = options.skipAgentAutoDetect ? undefined : resolveAgentScope(options.agent, options.cwd);
  const resolvedAgentIdentity = agent
    ? (options.agent ? findAgentIdentityByName(agent, options.cwd) : resolveCurrentAgentIdentity(options.cwd))
    : undefined;
  const claims = listClaims(options.cwd).filter((claim) => claim.status === 'active');
  const activeSequence = getActiveSequence(options.cwd);
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
    active_sequence: enrichSequenceWithPlanStatus(activeSequence, state.plan_items),
    runtime_notes: filteredNotes,
    session_meta_hidden: sessionMetaHidden,
    open_handoffs: filteredHandoffs,
    resolved_instructions: instructions,
    reputation_summary: reputationSummary,
    agent_reputation: agentReputation,
    other_agents: buildOtherAgentsSummary(filteredClaims, runtimeNotes, agent, options.cwd),
    linked_projects: buildLinkedProjectsSummary(options.cwd),
    incoming_signals: buildIncomingSignalsSummary(options.cwd),
    known_traps: state.known_traps
      .filter((t) => t.visibility === 'shared' && (!t.status || t.status === 'active'))
      .sort((a, b) => severityOrder(b.severity) - severityOrder(a.severity)),
    pending_candidates: listCandidates('pending', options.cwd),
    inbox_pending: agent ? countActionable(agent, options.cwd ?? process.cwd()) : 0,
  };
}

function enrichSequenceWithPlanStatus(sequence: ReturnType<typeof getActiveSequence>, allPlans: {
  id: string;
  status: string;
  text: string;
  priority?: string;
  assignee?: string;
  steps?: { id: string; text: string; status: string }[];
}[]): typeof sequence {
  if (!sequence) return sequence;
  const planMap = new Map(allPlans.map(p => [p.id, p]));
  return {
    ...sequence,
    items: sequence.items.map((item: any) => {
      const plan = planMap.get(item.planId);
      let planStatus = plan?.status ?? 'unknown';
      let planText = plan?.text?.slice(0, 80) ?? item.planId;

      if (item.stepId && plan?.steps) {
        const step = plan.steps.find((s) => s.id === item.stepId);
        if (step) {
          planStatus = step.status === 'done' ? 'done' : plan.status;
          planText = step.text.slice(0, 80);
        }
      }

      return {
        ...item,
        plan_status: planStatus,
        plan_text: planText,
        plan_priority: plan?.priority,
        plan_assignee: plan?.assignee,
      };
    }),
  };
}

interface OtherAgentSummary {
  name: string;
  trust_level: string;
  claim_count: number;
  scopes: string[];
  last_active?: string;
  has_open_session: boolean;
}

function buildOtherAgentsSummary(
  claims: ReturnType<typeof listClaims>,
  notes: ReturnType<typeof listRuntimeNotes>,
  currentAgent?: string,
  cwd?: string,
): OtherAgentSummary[] | undefined {
  // Start from ALL registered agents — they always appear
  const agentMap = new Map<string, OtherAgentSummary>();
  for (const identity of listAgentIdentities(cwd)) {
    if (identity.agent_name === currentAgent) continue;
    agentMap.set(identity.agent_name, {
      name: identity.agent_name,
      trust_level: identity.trust_level ?? 'contributor',
      claim_count: 0,
      scopes: [],
      has_open_session: false,
    });
  }

  // Enrich with active claims
  for (const claim of claims) {
    if (claim.agent === currentAgent) continue;
    const existing = agentMap.get(claim.agent) ?? { name: claim.agent, trust_level: 'contributor', claim_count: 0, scopes: [], has_open_session: false };
    existing.claim_count++;
    existing.scopes.push(claim.scope);
    if (!existing.last_active || claim.created_at > existing.last_active) {
      existing.last_active = claim.created_at;
    }
    agentMap.set(claim.agent, existing);
  }

  // Enrich with runtime notes (including session lifecycle) for last_active + open session detection
  for (const note of notes) {
    if (note.agent === currentAgent) continue;
    const existing = agentMap.get(note.agent);
    if (!existing) continue; // skip unregistered agents in notes
    if (!existing.last_active || note.created_at > existing.last_active) {
      existing.last_active = note.created_at;
    }
    if ((note as any).note_type === 'session_start') {
      existing.has_open_session = true;
    }
    if ((note as any).note_type === 'session_end') {
      existing.has_open_session = false;
    }
  }

  const result = [...agentMap.values()];
  return result.length > 0 ? result : undefined;
}

interface LinkedProjectSummary {
  name: string;
  path: string;
  role: string;
  available: boolean;
  active_claims: number;
  active_plans: number;
  agents: string[];
}

function buildLinkedProjectsSummary(cwd?: string): LinkedProjectSummary[] | undefined {
  const links = resolveCrossProjectLinks(cwd);
  if (links.length === 0) return undefined;

  const summaries: LinkedProjectSummary[] = [];
  for (const link of links) {
    const summary: LinkedProjectSummary = {
      name: link.projectName,
      path: link.path,
      role: link.role,
      available: link.available,
      active_claims: 0,
      active_plans: 0,
      agents: [],
    };

    if (link.available) {
      try {
        const claims = listClaims(link.absolutePath).filter(c => c.status === 'active');
        const state = loadState(link.absolutePath);
        const plans = state.plan_items.filter(p => p.status !== 'done' && p.status !== 'dropped');
        summary.active_claims = claims.length;
        summary.active_plans = plans.length;
        const agentSet = new Set<string>();
        for (const c of claims) agentSet.add(c.agent);
        summary.agents = [...agentSet];
      } catch { /* linked project read failed, skip */ }
    }

    summaries.push(summary);
  }

  return summaries.length > 0 ? summaries : undefined;
}

interface IncomingSignalSummary {
  id: string;
  entity_type: string;
  from_project: string;
  from_agent: string;
  created_at: string;
  preview: string;
}

function buildIncomingSignalsSummary(cwd?: string): IncomingSignalSummary[] | undefined {
  const signals = listIncomingCrossProjectSignals(cwd);
  const incomingSignals: IncomingSignalSummary[] = signals.map((signal) => {
    const text = 'text' in signal.payload ? (signal.payload as { text: string }).text : '';
    return {
      id: signal.id,
      entity_type: signal.entity_type,
      from_project: signal.from_project.name,
      from_agent: signal.from_agent.name,
      created_at: signal.created_at,
      preview: text.length > 120 ? text.slice(0, 117) + '...' : text,
    };
  });

  try {
    const fedSignals = pullSignalsFromLinkedProjects(cwd);
    for (const sig of fedSignals) {
      const payloadPreview = typeof sig.payload === 'string'
        ? sig.payload.slice(0, 120)
        : JSON.stringify(sig.payload).slice(0, 120);
      incomingSignals.push({
        id: sig.id,
        entity_type: sig.type,
        from_project: sig.from.project_name,
        from_agent: sig.from.agent_name,
        preview: payloadPreview,
        created_at: sig.created_at,
      });
    }
  } catch { /* non-fatal */ }

  if (incomingSignals.length === 0) return undefined;
  return incomingSignals;
}

function severityOrder(severity: string): number {
  switch (severity) {
    case 'high': return 3;
    case 'medium': return 2;
    case 'low': return 1;
    default: return 0;
  }
}
