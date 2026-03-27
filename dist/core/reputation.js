import { listAgentIdentities, resolveCurrentAgentIdentity } from './agent-registry.js';
import { listArchivedCandidates, listCandidates } from './candidates.js';
import { listClaims } from './claims.js';
import { loadConfig } from './config.js';
import { nowISO } from './ids.js';
import { listRuntimeNotes } from './runtime.js';
function clampScore(value) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.max(0, Math.min(100, Math.round(value)));
}
function createAccumulator(identity) {
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
        },
    };
}
function buildIdentityResolvers(registered) {
    const byId = new Map();
    const byName = new Map();
    for (const agent of registered) {
        byId.set(agent.agent_id, agent);
        byName.set(agent.agent_name.trim().toLowerCase(), agent);
    }
    return {
        resolve(value) {
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
function withinWindow(timestamp, sinceMs) {
    if (!timestamp) {
        return false;
    }
    const parsed = Date.parse(timestamp);
    if (Number.isNaN(parsed)) {
        return false;
    }
    return parsed >= sinceMs;
}
function getAccumulator(store, identity) {
    const existing = store.get(identity.key);
    if (existing) {
        return existing;
    }
    const created = createAccumulator(identity);
    store.set(identity.key, created);
    return created;
}
function trackCandidateSignals(candidate, bucket, store, sinceMs, config, resolveIdentity) {
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
        if (candidate.source?.startsWith('runtime-note:')) {
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
function trackRuntimeSignals(note, store, sinceMs, resolveIdentity) {
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
function trackClaimSignals(claim, store, sinceMs, resolveIdentity) {
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
function finalizeSnapshot(accumulator) {
    const orphanRuntimeNoise = Math.max(0, accumulator.signals.runtime_notes_created - accumulator.signals.promoted_runtime_candidates - accumulator.signals.plan_linked_activity);
    accumulator.signals.orphan_runtime_noise = orphanRuntimeNoise;
    const boundedStars = Math.min(accumulator.signals.stars_received, 5);
    const boundedUses = Math.min(accumulator.signals.uses_received, 4);
    const boundedRuntimeNotes = Math.min(accumulator.signals.runtime_notes_created, 4);
    const boundedPromotions = Math.min(accumulator.signals.promoted_runtime_candidates, 4);
    const boundedPlanActivity = Math.min(accumulator.signals.plan_linked_activity, 4);
    const boundedNoise = Math.min(accumulator.signals.orphan_runtime_noise, 4);
    const contributionQuality = clampScore(35 * accumulator.signals.accepted_candidates
        + 20 * accumulator.signals.promoted_runtime_accepted
        + 10 * boundedUses
        + 4 * boundedStars
        - 12 * accumulator.signals.rejected_candidates_authored);
    const reviewReliability = clampScore(30 * accumulator.signals.accepted_reviews
        + 18 * accumulator.signals.rejected_reviews
        + 4 * accumulator.signals.reasoned_rejections);
    const continuityHygiene = clampScore(12 * boundedRuntimeNotes
        + 12 * boundedPromotions
        + 8 * boundedPlanActivity
        + 4 * Math.min(accumulator.signals.released_claims, 4)
        - 6 * boundedNoise);
    const internalTrust = clampScore(contributionQuality * 0.5 + reviewReliability * 0.3 + continuityHygiene * 0.2);
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
export function buildReputationSnapshot(cwd) {
    const config = loadConfig(cwd);
    const reputationConfig = config.reputation ?? {
        enabled: false,
        visibility: 'internal-only',
        decay_days: 30,
        ranking_weight: 0.15,
        resume_weight: 0.35,
        mcp_exposure: false,
    };
    const registered = listAgentIdentities(cwd);
    const currentAgent = resolveCurrentAgentIdentity(cwd);
    const resolvers = buildIdentityResolvers(registered);
    const store = new Map();
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
export function buildCurrentAgentResumeSummary(cwd) {
    const snapshot = buildReputationSnapshot(cwd);
    const current = snapshot.current_agent;
    if (!snapshot.enabled || !current) {
        return undefined;
    }
    const strengths = [];
    const cautions = [];
    const suggestedFocus = [];
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
export function buildReputationRankingLookup(cwd) {
    const config = loadConfig(cwd);
    const rankingWeight = config.reputation?.ranking_weight ?? 0.15;
    const snapshot = buildReputationSnapshot(cwd);
    const byId = new Map();
    const byName = new Map();
    const byKey = new Map();
    for (const agent of snapshot.agents) {
        byKey.set(agent.key, agent.scores.internal_trust);
        if (agent.agent_id) {
            byId.set(agent.agent_id, agent.scores.internal_trust);
        }
        byName.set(agent.agent_name.trim().toLowerCase(), agent.scores.internal_trust);
    }
    const getInternalTrust = (actorId, actorName) => {
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
    const getRankingBonus = (actorId, actorName) => {
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
export function toPublicReputationSummary(agent) {
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
export function buildReputationSummary(cwd) {
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
export function findAgentReputationSummary(agentNameOrId, cwd) {
    const value = agentNameOrId?.trim();
    if (!value) {
        return undefined;
    }
    const snapshot = buildReputationSnapshot(cwd);
    const found = snapshot.agents.find((agent) => agent.agent_id === value || agent.agent_name.toLowerCase() === value.toLowerCase());
    return found ? toPublicReputationSummary(found) : undefined;
}
//# sourceMappingURL=reputation.js.map