import { listAgentIdentities, resolveCurrentAgentIdentity } from './agent-registry.js';
import { listArchivedCandidates, listCandidates } from './candidates.js';
import { listClaims } from './claims.js';
import { loadConfig } from './config.js';
import { nowISO } from './ids.js';
import { listRuntimeNotes } from './runtime.js';
import { loadState } from './state.js';
import type { AgentIdentityDocument, Candidate, Claim, Config, Constraint, Decision, RuntimeNote, Trap } from './schema.js';

type IdentityKind = 'registered-agent' | 'actor';

interface IdentityRef {
  key: string;
  agent_id?: string;
  agent_name: string;
  kind: IdentityKind;
}

interface ReputationAccumulator {
  identity: IdentityRef;
  signals: {
    candidates_authored: number;
    pending_candidates: number;
    accepted_candidates: number;
    rejected_candidates_authored: number;
    promoted_runtime_candidates: number;
    promoted_runtime_accepted: number;
    stars_received: number;
    uses_received: number;
    accepted_reviews: number;
    rejected_reviews: number;
    reasoned_rejections: number;
    runtime_notes_created: number;
    plan_linked_activity: number;
    claims_created: number;
    released_claims: number;
    orphan_runtime_noise: number;
    /** pln#544 — memory-lifecycle signals. */
    memory_confirmations_authored: number;
    memory_infirmations_authored: number;
    memory_saved_me_reports: number;
    memory_misled_me_reports: number;
    /** Items this actor authored that another actor flagged saved_me. */
    memory_items_reinforced: number;
    /** Items this actor authored that another actor flagged misled_me. */
    memory_items_misled_others: number;
  };
}

export interface ReputationAgentSnapshot {
  key: string;
  agent_id?: string;
  agent_name: string;
  kind: IdentityKind;
  signals: ReputationAccumulator['signals'];
  scores: {
    contribution_quality: number;
    review_reliability: number;
    continuity_hygiene: number;
    internal_trust: number;
  };
}

export interface ReputationSnapshot {
  enabled: boolean;
  visibility: 'internal-only' | 'summary' | 'full';
  window_days: number;
  generated_at: string;
  project_id?: string;
  current_agent_id?: string;
  current_agent?: ReputationAgentSnapshot;
  agents: ReputationAgentSnapshot[];
}

export interface AgentResumeSummary {
  agent_name: string;
  agent_id?: string;
  internal_trust: number;
  contribution_quality: number;
  review_reliability: number;
  continuity_hygiene: number;
  strengths: string[];
  cautions: string[];
  suggested_focus: string[];
}

export interface ReputationRankingLookup {
  enabled: boolean;
  ranking_weight: number;
  getInternalTrust: (actorId?: string, actorName?: string) => number;
  getRankingBonus: (actorId?: string, actorName?: string) => number;
}

export interface ReputationSummary {
  enabled: boolean;
  visibility: 'internal-only' | 'summary' | 'full';
  tracked_agents: number;
  avg_internal_trust: number;
  current_agent_id?: string;
  current_agent_trust?: number;
  total_pending_candidates: number;
  total_review_resolutions: number;
  total_runtime_notes: number;
}

export interface ReputationAgentPublicSummary {
  agent_name: string;
  agent_id?: string;
  internal_trust: number;
  contribution_quality: number;
  review_reliability: number;
  continuity_hygiene: number;
  pending_candidates: number;
  accepted_candidates: number;
  accepted_reviews: number;
  rejected_reviews: number;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function createAccumulator(identity: IdentityRef): ReputationAccumulator {
  return {
    identity,
    signals: {
      candidates_authored: 0,
      pending_candidates: 0,
      accepted_candidates: 0,
      rejected_candidates_authored: 0,
      promoted_runtime_candidates: 0,
      promoted_runtime_accepted: 0,
      stars_received: 0,
      uses_received: 0,
      accepted_reviews: 0,
      rejected_reviews: 0,
      reasoned_rejections: 0,
      runtime_notes_created: 0,
      plan_linked_activity: 0,
      claims_created: 0,
      released_claims: 0,
      orphan_runtime_noise: 0,
      memory_confirmations_authored: 0,
      memory_infirmations_authored: 0,
      memory_saved_me_reports: 0,
      memory_misled_me_reports: 0,
      memory_items_reinforced: 0,
      memory_items_misled_others: 0,
    },
  };
}

function buildIdentityResolvers(registered: AgentIdentityDocument[]) {
  const byId = new Map<string, AgentIdentityDocument>();
  const byName = new Map<string, AgentIdentityDocument>();
  for (const agent of registered) {
    byId.set(agent.agent_id, agent);
    byName.set(agent.agent_name.trim().toLowerCase(), agent);
  }

  return {
    resolve(value?: string): IdentityRef | undefined {
      const trimmed = value?.trim();
      if (!trimmed) {
        return undefined;
      }

      const byAgentId = byId.get(trimmed);
      if (byAgentId) {
        return {
          key: byAgentId.agent_id,
          agent_id: byAgentId.agent_id,
          agent_name: byAgentId.agent_name,
          kind: 'registered-agent',
        };
      }

      const byAgentName = byName.get(trimmed.toLowerCase());
      if (byAgentName) {
        return {
          key: byAgentName.agent_id,
          agent_id: byAgentName.agent_id,
          agent_name: byAgentName.agent_name,
          kind: 'registered-agent',
        };
      }

      return {
        key: `actor:${trimmed.toLowerCase()}`,
        agent_name: trimmed,
        kind: 'actor',
      };
    },
  };
}

function withinWindow(timestamp: string | undefined, sinceMs: number): boolean {
  if (!timestamp) {
    return false;
  }
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) {
    return false;
  }
  return parsed >= sinceMs;
}

function getAccumulator(store: Map<string, ReputationAccumulator>, identity: IdentityRef): ReputationAccumulator {
  const existing = store.get(identity.key);
  if (existing) {
    return existing;
  }

  const created = createAccumulator(identity);
  store.set(identity.key, created);
  return created;
}

function trackCandidateSignals(
  candidate: Candidate,
  bucket: 'pending' | 'accepted' | 'rejected',
  store: Map<string, ReputationAccumulator>,
  sinceMs: number,
  config: Config,
  resolveIdentity: (value?: string) => IdentityRef | undefined,
): void {
  if (!withinWindow(candidate.created_at, sinceMs) && !withinWindow(candidate.resolved_at, sinceMs)) {
    return;
  }

  const author = resolveIdentity(candidate.author_id ?? candidate.author);
  if (author) {
    const stats = getAccumulator(store, author);
    stats.signals.candidates_authored += 1;
    stats.signals.stars_received += candidate.star_count ?? 0;
    stats.signals.uses_received += candidate.usage_count ?? 0;
    if (bucket === 'pending') {
      stats.signals.pending_candidates += 1;
    }
    if (bucket === 'accepted') {
      stats.signals.accepted_candidates += 1;
    }
    if (bucket === 'rejected') {
      stats.signals.rejected_candidates_authored += 1;
    }
    // Count runtime-origin candidates: either explicit `source: 'auto'` (session-end
    // auto handoffs) or any runtime-note / session-end origin string (back-compat
    // with writers that still set only `origin`).
    const isRuntimeOrigin = candidate.source === 'auto'
      || candidate.origin?.startsWith('runtime-note:') === true
      || candidate.origin?.startsWith('session-end:') === true;
    if (isRuntimeOrigin) {
      stats.signals.promoted_runtime_candidates += 1;
      if (bucket === 'accepted') {
        stats.signals.promoted_runtime_accepted += 1;
      }
    }
  }

  const reviewer = resolveIdentity(candidate.resolved_by);
  if (reviewer && bucket !== 'pending' && withinWindow(candidate.resolved_at, sinceMs)) {
    const stats = getAccumulator(store, reviewer);
    if (bucket === 'accepted') {
      stats.signals.accepted_reviews += 1;
    }
    if (bucket === 'rejected') {
      stats.signals.rejected_reviews += 1;
      if (candidate.resolution_reason?.trim()) {
        stats.signals.reasoned_rejections += 1;
      }
    }
  }
}

function trackRuntimeSignals(
  note: RuntimeNote,
  store: Map<string, ReputationAccumulator>,
  sinceMs: number,
  resolveIdentity: (value?: string) => IdentityRef | undefined,
): void {
  if (!withinWindow(note.created_at, sinceMs)) {
    return;
  }

  const identity = resolveIdentity(note.agent_id ?? note.agent);
  if (!identity) {
    return;
  }

  const stats = getAccumulator(store, identity);
  stats.signals.runtime_notes_created += 1;
  if (note.plan_id) {
    stats.signals.plan_linked_activity += 1;
  }
}

/**
 * pln#544 — memory lifecycle reinforcement signals.
 *
 * For each decision / constraint / trap, walk the bounded confirmations[]
 * log and attribute:
 *   - the event itself to the attesting agent (`by`/`by_id`), increasing
 *     their confirmations/infirmations/saved-me/misled-me counters.
 *   - reinforcement back to the item author (saved_me / misled_me) so that
 *     "memory that actually helped" rewards whoever wrote it.
 *
 * The 30-day reputation window applies — older confirmation events do not
 * count, mirroring how stale candidate signals are excluded above.
 */
function trackMemoryLifecycleSignals(
  item: { author: string; author_id?: string; confirmations?: { at: string; by: string; by_id?: string; kind: string }[] },
  store: Map<string, ReputationAccumulator>,
  sinceMs: number,
  resolveIdentity: (value?: string) => IdentityRef | undefined,
): void {
  const events = item.confirmations ?? [];
  if (events.length === 0) return;

  const author = resolveIdentity(item.author_id ?? item.author);

  for (const event of events) {
    if (!withinWindow(event.at, sinceMs)) continue;
    const attester = resolveIdentity(event.by_id ?? event.by);
    if (attester) {
      const stats = getAccumulator(store, attester);
      if (event.kind === 'confirm') stats.signals.memory_confirmations_authored += 1;
      else if (event.kind === 'infirm') stats.signals.memory_infirmations_authored += 1;
      else if (event.kind === 'saved_me') {
        stats.signals.memory_confirmations_authored += 1;
        stats.signals.memory_saved_me_reports += 1;
      } else if (event.kind === 'misled_me') {
        stats.signals.memory_infirmations_authored += 1;
        stats.signals.memory_misled_me_reports += 1;
      }
    }

    // Reinforcement back to the item author — only "explicitly reinforced" /
    // "explicitly debunked" events flow there. Passive confirm/infirm are
    // peer-review signals, not author signals.
    if (author && attester && attester.key !== author.key) {
      const ownerStats = getAccumulator(store, author);
      if (event.kind === 'saved_me') ownerStats.signals.memory_items_reinforced += 1;
      else if (event.kind === 'misled_me') ownerStats.signals.memory_items_misled_others += 1;
    }
  }
}

function trackClaimSignals(
  claim: Claim,
  store: Map<string, ReputationAccumulator>,
  sinceMs: number,
  resolveIdentity: (value?: string) => IdentityRef | undefined,
): void {
  if (!withinWindow(claim.created_at, sinceMs) && !withinWindow(claim.released_at, sinceMs)) {
    return;
  }

  const identity = resolveIdentity(claim.agent_id ?? claim.agent);
  if (!identity) {
    return;
  }

  const stats = getAccumulator(store, identity);
  stats.signals.claims_created += 1;
  if (claim.plan_id) {
    stats.signals.plan_linked_activity += 1;
  }
  if (claim.status === 'released' && withinWindow(claim.released_at, sinceMs)) {
    stats.signals.released_claims += 1;
  }
}

function finalizeSnapshot(accumulator: ReputationAccumulator): ReputationAgentSnapshot {
  const orphanRuntimeNoise = Math.max(
    0,
    accumulator.signals.runtime_notes_created - accumulator.signals.promoted_runtime_candidates - accumulator.signals.plan_linked_activity,
  );
  accumulator.signals.orphan_runtime_noise = orphanRuntimeNoise;

  const boundedStars = Math.min(accumulator.signals.stars_received, 5);
  const boundedUses = Math.min(accumulator.signals.uses_received, 4);
  const boundedRuntimeNotes = Math.min(accumulator.signals.runtime_notes_created, 4);
  const boundedPromotions = Math.min(accumulator.signals.promoted_runtime_candidates, 4);
  const boundedPlanActivity = Math.min(accumulator.signals.plan_linked_activity, 4);
  const boundedNoise = Math.min(accumulator.signals.orphan_runtime_noise, 4);

  // pln#544 — memory-lifecycle reinforcement caps so a single noisy attester
  // can't dominate the score. Saved-me on items I authored is the strongest
  // positive signal ("my memory actually saved another agent"); misled-me on
  // my items is the symmetric penalty.
  const boundedSavedMeAuthored = Math.min(accumulator.signals.memory_items_reinforced, 5);
  const boundedMisledOthers = Math.min(accumulator.signals.memory_items_misled_others, 5);
  const boundedMemoryReviewVolume = Math.min(
    accumulator.signals.memory_confirmations_authored + accumulator.signals.memory_infirmations_authored,
    10,
  );

  const contributionQuality = clampScore(
    35 * accumulator.signals.accepted_candidates
      + 20 * accumulator.signals.promoted_runtime_accepted
      + 10 * boundedUses
      + 4 * boundedStars
      + 15 * boundedSavedMeAuthored
      - 12 * accumulator.signals.rejected_candidates_authored
      - 18 * boundedMisledOthers,
  );
  const reviewReliability = clampScore(
    30 * accumulator.signals.accepted_reviews
      + 18 * accumulator.signals.rejected_reviews
      + 4 * accumulator.signals.reasoned_rejections
      + 6 * boundedMemoryReviewVolume,
  );
  const continuityHygiene = clampScore(
    12 * boundedRuntimeNotes
      + 12 * boundedPromotions
      + 8 * boundedPlanActivity
      + 4 * Math.min(accumulator.signals.released_claims, 4)
      - 6 * boundedNoise,
  );
  const internalTrust = clampScore(
    contributionQuality * 0.5 + reviewReliability * 0.3 + continuityHygiene * 0.2,
  );

  return {
    key: accumulator.identity.key,
    agent_id: accumulator.identity.agent_id,
    agent_name: accumulator.identity.agent_name,
    kind: accumulator.identity.kind,
    signals: accumulator.signals,
    scores: {
      contribution_quality: contributionQuality,
      review_reliability: reviewReliability,
      continuity_hygiene: continuityHygiene,
      internal_trust: internalTrust,
    },
  };
}

export function buildReputationSnapshot(cwd?: string): ReputationSnapshot {
  const config = loadConfig(cwd);
  const reputationConfig = config.reputation ?? {
    enabled: false,
    visibility: 'internal-only' as const,
    decay_days: 30,
    ranking_weight: 0.15,
    resume_weight: 0.35,
    mcp_exposure: false,
  };
  // pln#578 — disabled reputation (the default) must not pay for the sweep.
  // Every consumer already treats a disabled snapshot as empty: agents is []
  // (line below gates on enabled), so ranking bonuses are 0 and the resume
  // summary is undefined. Yet the full signal sweep (pending + archived
  // candidates, all runtime notes, all claims, a complete loadState) was still
  // running — two of the four full-store read passes a single buildContext
  // performed on a large store. Exit before any store read when disabled.
  if (!reputationConfig.enabled) {
    return {
      enabled: false,
      visibility: reputationConfig.visibility,
      window_days: reputationConfig.decay_days,
      generated_at: nowISO(),
      project_id: config.project_id,
      current_agent_id: resolveCurrentAgentIdentity(cwd)?.agent_id,
      agents: [],
    };
  }
  const registered = listAgentIdentities(cwd);
  const currentAgent = resolveCurrentAgentIdentity(cwd);
  const resolvers = buildIdentityResolvers(registered);
  const store = new Map<string, ReputationAccumulator>();
  const sinceMs = Date.now() - reputationConfig.decay_days * 24 * 60 * 60 * 1000;

  for (const agent of registered) {
    getAccumulator(store, {
      key: agent.agent_id,
      agent_id: agent.agent_id,
      agent_name: agent.agent_name,
      kind: 'registered-agent',
    });
  }

  for (const candidate of listCandidates('pending', cwd)) {
    trackCandidateSignals(candidate, 'pending', store, sinceMs, config, resolvers.resolve);
  }
  for (const candidate of listArchivedCandidates('accepted', cwd)) {
    trackCandidateSignals(candidate, 'accepted', store, sinceMs, config, resolvers.resolve);
  }
  for (const candidate of listArchivedCandidates('rejected', cwd)) {
    trackCandidateSignals(candidate, 'rejected', store, sinceMs, config, resolvers.resolve);
  }
  for (const note of listRuntimeNotes({ visibility: 'all', includeAllHosts: true }, cwd)) {
    trackRuntimeSignals(note, store, sinceMs, resolvers.resolve);
  }
  for (const claim of listClaims(cwd)) {
    trackClaimSignals(claim, store, sinceMs, resolvers.resolve);
  }

  // pln#544 — feed memory-lifecycle confirmations back into reputation:
  // attesting agents earn confirmation_authored; items reinforced by
  // 'saved_me' reward their author. Best-effort: never let a lifecycle
  // signal failure block reputation rebuild.
  try {
    const state = loadState(cwd);
    const memoryItems: Array<Decision | Constraint | Trap> = [
      ...state.recent_decisions,
      ...state.active_constraints,
      ...state.known_traps,
    ];
    for (const item of memoryItems) {
      trackMemoryLifecycleSignals(item, store, sinceMs, resolvers.resolve);
    }
  } catch { /* state may be unreadable in cold-start scenarios */ }

  const agents = [...store.values()]
    .map((entry) => finalizeSnapshot(entry))
    .sort((a, b) => {
      const trustDelta = b.scores.internal_trust - a.scores.internal_trust;
      if (trustDelta !== 0) {
        return trustDelta;
      }
      return a.agent_name.localeCompare(b.agent_name);
    });

  const currentAgentSnapshot = currentAgent
    ? agents.find((agent) => agent.agent_id === currentAgent.agent_id)
    : undefined;

  return {
    enabled: reputationConfig.enabled,
    visibility: reputationConfig.visibility,
    window_days: reputationConfig.decay_days,
    generated_at: nowISO(),
    project_id: config.project_id,
    current_agent_id: currentAgent?.agent_id,
    current_agent: currentAgentSnapshot,
    agents: reputationConfig.enabled ? agents : [],
  };
}

export function buildCurrentAgentResumeSummary(cwd?: string): AgentResumeSummary | undefined {
  const snapshot = buildReputationSnapshot(cwd);
  const current = snapshot.current_agent;
  if (!snapshot.enabled || !current) {
    return undefined;
  }

  const strengths: string[] = [];
  const cautions: string[] = [];
  const suggestedFocus: string[] = [];

  if (current.signals.accepted_candidates > 0) {
    strengths.push(`${current.signals.accepted_candidates} accepted candidate(s) landed in canonical memory recently.`);
  }
  if (current.signals.promoted_runtime_accepted > 0) {
    strengths.push(`${current.signals.promoted_runtime_accepted} runtime note(s) were promoted and then accepted.`);
  }
  if ((current.signals.accepted_reviews + current.signals.rejected_reviews) > 0) {
    strengths.push(`${current.signals.accepted_reviews + current.signals.rejected_reviews} review resolution(s) were recorded for this agent.`);
  }
  if (current.signals.plan_linked_activity > 0) {
    strengths.push(`${current.signals.plan_linked_activity} plan-linked activity signal(s) were captured.`);
  }

  if (current.signals.pending_candidates > 0) {
    cautions.push(`${current.signals.pending_candidates} pending candidate(s) still need review.`);
    suggestedFocus.push('Review pending candidates before starting new exploration.');
  }
  if (current.signals.orphan_runtime_noise > 0) {
    cautions.push(`${current.signals.orphan_runtime_noise} runtime note(s) are not yet linked to a plan or durable promotion.`);
    suggestedFocus.push('Promote or prune runtime notes that still carry useful signal.');
  }
  if (current.signals.claims_created > current.signals.released_claims) {
    cautions.push(`${current.signals.claims_created - current.signals.released_claims} claim(s) may still need release or refresh.`);
    suggestedFocus.push('Release or refresh stale claims before deep work resumes.');
  }
  if (current.signals.runtime_notes_created > 0 && current.signals.plan_linked_activity === 0) {
    suggestedFocus.push('Link future runtime notes to plans when possible to improve session continuity.');
  }

  if (strengths.length === 0) {
    strengths.push('No strong durability signal yet; this agent is still building a project-specific track record.');
  }
  if (cautions.length === 0) {
    cautions.push('No immediate continuity warning detected in the recent reputation window.');
  }
  if (suggestedFocus.length === 0) {
    suggestedFocus.push('Keep recording concise runtime notes and promote only the ones worth preserving.');
  }

  return {
    agent_name: current.agent_name,
    agent_id: current.agent_id,
    internal_trust: current.scores.internal_trust,
    contribution_quality: current.scores.contribution_quality,
    review_reliability: current.scores.review_reliability,
    continuity_hygiene: current.scores.continuity_hygiene,
    strengths: strengths.slice(0, 3),
    cautions: cautions.slice(0, 3),
    suggested_focus: suggestedFocus.slice(0, 3),
  };
}

export function buildReputationRankingLookup(cwd?: string): ReputationRankingLookup {
  const config = loadConfig(cwd);
  const rankingWeight = config.reputation?.ranking_weight ?? 0.15;
  const snapshot = buildReputationSnapshot(cwd);
  const byId = new Map<string, number>();
  const byName = new Map<string, number>();
  const byKey = new Map<string, number>();

  for (const agent of snapshot.agents) {
    byKey.set(agent.key, agent.scores.internal_trust);
    if (agent.agent_id) {
      byId.set(agent.agent_id, agent.scores.internal_trust);
    }
    byName.set(agent.agent_name.trim().toLowerCase(), agent.scores.internal_trust);
  }

  const getInternalTrust = (actorId?: string, actorName?: string): number => {
    const byAgentId = actorId?.trim() ? byId.get(actorId.trim()) : undefined;
    if (typeof byAgentId === 'number') {
      return byAgentId;
    }

    const normalizedName = actorName?.trim().toLowerCase();
    if (normalizedName) {
      const direct = byName.get(normalizedName);
      if (typeof direct === 'number') {
        return direct;
      }

      const actorKey = byKey.get(`actor:${normalizedName}`);
      if (typeof actorKey === 'number') {
        return actorKey;
      }
    }

    return 0;
  };

  const getRankingBonus = (actorId?: string, actorName?: string): number => {
    if (!snapshot.enabled || rankingWeight <= 0) {
      return 0;
    }

    const trust = getInternalTrust(actorId, actorName);
    const bonus = (trust / 100) * (rankingWeight * 20);
    return Math.max(0, Math.min(3, Number(bonus.toFixed(2))));
  };

  return {
    enabled: snapshot.enabled,
    ranking_weight: rankingWeight,
    getInternalTrust,
    getRankingBonus,
  };
}

export function toPublicReputationSummary(agent: ReputationAgentSnapshot): ReputationAgentPublicSummary {
  return {
    agent_name: agent.agent_name,
    agent_id: agent.agent_id,
    internal_trust: agent.scores.internal_trust,
    contribution_quality: agent.scores.contribution_quality,
    review_reliability: agent.scores.review_reliability,
    continuity_hygiene: agent.scores.continuity_hygiene,
    pending_candidates: agent.signals.pending_candidates,
    accepted_candidates: agent.signals.accepted_candidates,
    accepted_reviews: agent.signals.accepted_reviews,
    rejected_reviews: agent.signals.rejected_reviews,
  };
}

export function buildReputationSummary(cwd?: string): ReputationSummary {
  const snapshot = buildReputationSnapshot(cwd);
  const trackedAgents = snapshot.agents.length;
  const avgInternalTrust = trackedAgents > 0
    ? Number((snapshot.agents.reduce((sum, agent) => sum + agent.scores.internal_trust, 0) / trackedAgents).toFixed(1))
    : 0;
  const currentTrust = snapshot.current_agent?.scores.internal_trust;

  return {
    enabled: snapshot.enabled,
    visibility: snapshot.visibility,
    tracked_agents: trackedAgents,
    avg_internal_trust: avgInternalTrust,
    current_agent_id: snapshot.current_agent_id,
    current_agent_trust: currentTrust,
    total_pending_candidates: snapshot.agents.reduce((sum, agent) => sum + agent.signals.pending_candidates, 0),
    total_review_resolutions: snapshot.agents.reduce((sum, agent) => sum + agent.signals.accepted_reviews + agent.signals.rejected_reviews, 0),
    total_runtime_notes: snapshot.agents.reduce((sum, agent) => sum + agent.signals.runtime_notes_created, 0),
  };
}

export function findAgentReputationSummary(agentNameOrId: string | undefined, cwd?: string): ReputationAgentPublicSummary | undefined {
  const value = agentNameOrId?.trim();
  if (!value) {
    return undefined;
  }

  const snapshot = buildReputationSnapshot(cwd);
  const found = snapshot.agents.find((agent) => agent.agent_id === value || agent.agent_name.toLowerCase() === value.toLowerCase());
  return found ? toPublicReputationSummary(found) : undefined;
}
