import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readProjectVision } from './io.js';
import { loadActiveProject, type ActiveProject } from './active-project.js';
import { checkBrainclawInstallableUpdate, renderBrainclawInstallableUpdateNotice } from './brainclaw-version.js';
import { loadConfig } from './config.js';
import { loadCurrentSession, loadAllSessions } from './identity.js';
import { resolveCrossProjectLinks, loadCrossProjectState } from './cross-project.js';
import { buildContextDiff, buildContextDiffFromEvents, type ContextDiffResult } from './context-diff.js';
import { resolveContextStoreCwd, resolveStoreChain, type StoreRef } from './store-resolution.js';
import { findAgentIdentityByName, resolveCurrentAgentIdentity } from './agent-registry.js';
import { hasReusableBootstrapProfile, runBootstrapProfile, selectDerivedSignals, type DerivedContextSignal } from './bootstrap.js';
import { buildAgentToolingContext, type AgentToolingSnapshot } from './agent-context.js';
import { buildExecutionContext, compactExecutionContext, type CompactExecutionContextSnapshot } from './execution-context.js';
import { getVisibleMemoryVersion } from './freshness.js';
import { resolveCurrentHostId } from './host.js';
import { inferProjectFromTarget, loadInstructions, resolveInstructions } from './instructions.js';
import { buildCurrentAgentResumeSummary, buildReputationRankingLookup, type AgentResumeSummary } from './reputation.js';
import { loadState } from './state.js';
import { readAuditLog, type AuditAction, type AuditEntry } from './audit.js';
import { listCandidates } from './candidates.js';
import { listClaims, isClaimExpired, assessClaimLiveness, type ClaimLivenessStatus } from './claims.js';
import { listAssignments } from './assignments.js';
import { listRuntimeNotes } from './runtime.js';
import { isTrapActive, listOperationalTraps } from './traps.js';
import { buildEstimationReport } from '../commands/estimation-report.js';
import { detectStaleness, type StalenessWarning } from './staleness.js';
import type { Claim, InstructionEntry, PlanItem, ProjectMode, ProjectStrategy } from './schema.js';

export const CONTEXT_SCHEMA_VERSION = '1.2';

export interface ContextOptions {
  target?: string;
  project?: string;
  agent?: string;
  host?: string;
  allHosts?: boolean;
  includePending?: boolean;
  profile?: 'dev' | 'dense' | 'openclaw' | 'ops' | 'research' | 'compact' | 'copilot' | 'quick' | 'briefing' | 'claude-desktop';
  maxItems?: number;
  maxChars?: number;
  digest?: boolean;
  bootstrap?: boolean;
  refreshBootstrap?: boolean;
  sinceSession?: string;
  cwd?: string;
}

export interface ContextItem {
  id: string;
  section: 'plan' | 'constraint' | 'decision' | 'trap' | 'handoff' | 'candidate' | 'runtime' | 'cross_project';
  text: string;
  tags: string[];
  score: number;
  reasons: string[];
  related_paths?: string[];
  extra?: string;
  plan_id?: string;
  from_project?: string;
  provenance?: {
    actor?: string;
    actor_id?: string;
    project_id?: string;
    host_id?: string;
    session_id?: string;
  };
}

export interface OpenWorkSummary {
  active_claims: Array<
    Pick<Claim, 'id' | 'scope' | 'description' | 'created_at' | 'plan_id' | 'expires_at'> & {
      /** Session-aware classification (live/young/orphaned/stale/never-adopted) — pln#388 stp_aa095668. */
      liveness?: ClaimLivenessStatus;
    }
  >;
  active_assignments: Array<{
    id: string;
    status: string;
    scope: string;
    description: string;
    plan_id?: string;
    last_heartbeat_at?: string;
  }>;
  in_progress_plans: Pick<PlanItem, 'id' | 'text' | 'assignee'>[];
}

export interface SessionMetricsSummary {
  active_claims: number;
  edits_since_last_memory: number;
  session_duration_minutes: number;
  last_brainclaw_write?: string;
}

export interface ContextResult {
  context_schema: string;
  profile: string;
  project_id?: string;
  agent_id?: string;
  project_mode: ProjectMode;
  project_strategy: ProjectStrategy;
  current_host: string;
  host_filter?: string;
  all_hosts: boolean;
  memory_version: string;
  target: string;
  project?: string;
  agent?: string;
  digest?: string;
  memory_density: 'low' | 'medium' | 'high';
  bootstrap_available: boolean;
  derived_signals?: DerivedContextSignal[];
  execution_context?: CompactExecutionContextSnapshot;
  agent_tooling?: Pick<AgentToolingSnapshot, 'agents_md_present' | 'agents_md_title' | 'agents_rules' | 'skills' | 'mcp_servers'>;
  scoped_activity?: ScopedActivitySummary;
  context_diff?: ContextDiffResult;
  resolved_instructions: InstructionEntry[];
  resume_summary?: AgentResumeSummary;
  open_work?: OpenWorkSummary;
  session_metrics?: SessionMetricsSummary;
  estimation_calibration?: string;
  stores?: Pick<StoreRef, 'cwd' | 'depth' | 'role'>[];
  cross_project_items?: ContextItem[];
  active_project?: ActiveProject;
  claim_conflicts?: ClaimConflict[];
  workflow_hints?: string[];
  project_vision?: string;
  stale_warnings?: StalenessWarning[];
  selected: ContextItem[];
}

export interface ClaimConflict {
  my_claim_id: string;
  my_scope: string;
  other_claim_id: string;
  other_agent: string;
  other_scope: string;
  overlap_reason: string;
}

export interface ScopedActivityItemSummary {
  id: string;
  text: string;
  age_hours: number;
}

export interface ScopedActivitySummary {
  scope: string;
  last_decision?: ScopedActivityItemSummary;
  last_trap?: ScopedActivityItemSummary;
  recent_notes: number;
  pending_candidates: number;
  last_agent?: string;
  last_session?: string;
}

export function buildContext(options: ContextOptions = {}): ContextResult {
  const requestedCwd = options.cwd ?? process.cwd();
  const contextCwd = resolveContextStoreCwd(requestedCwd, options.target);
  const state = loadState(contextCwd);
  const config = loadConfig(contextCwd);
  // Resolve parent stores for multi-store merge (walk-up from cwd)
  const storeChain = resolveStoreChain(contextCwd);

  const projectMode = config.project_mode ?? 'auto';
  const projectStrategy = config.projects?.strategy ?? 'manual';
  const currentHost = resolveCurrentHostId();
  const memoryVersion = getVisibleMemoryVersion({ cwd: contextCwd, hostId: options.host, allHosts: options.allHosts });
  const target = normalizeContextTarget(options.target, requestedCwd, contextCwd);
  const project = options.project?.trim() || inferProjectFromTarget(target, config);
  // Agent resolution: explicit param > resolveCurrentAgentIdentity (env + detection).
  // config.current_agent is NOT used — it's a singleton global that cross-contaminates in multi-agent.
  const currentAgentIdentity = options.agent?.trim()
    ? findAgentIdentityByName(options.agent.trim(), contextCwd)
    : resolveCurrentAgentIdentity(contextCwd);
  const agent = options.agent?.trim() || currentAgentIdentity?.agent_name;
  // Profile resolution: explicit param > agent default > config default > 'dev'
  const profile = options.profile ?? currentAgentIdentity?.context_profile ?? config.profile ?? 'dev';
  const profileMaxItems: Record<string, number> = { dense: 20, compact: 6, copilot: 5, quick: 3, briefing: 5, 'claude-desktop': 8 };
  const maxItems = options.maxItems ?? profileMaxItems[profile] ?? 8;
  const maxChars = options.maxChars && options.maxChars > 0 ? options.maxChars : undefined;
  // Instructions will be resolved after parent-store merge below (line ~460)
  const rankingLookup = buildReputationRankingLookup(contextCwd);

  // Profile-specific section allow-list (undefined = all sections allowed)
  type Section = ContextItem['section'];
  const profileSections: Record<string, Section[]> = {
    compact:  ['plan', 'constraint'],
    copilot:  ['constraint', 'trap'],
    quick:    ['constraint', 'plan'],
    briefing: ['trap', 'constraint', 'decision'],
    'claude-desktop': ['plan', 'handoff', 'candidate'],
  };
  const allowedSections = profileSections[profile] as Section[] | undefined;

  const items: ContextItem[] = [];

  for (const plan of state.plan_items.filter((item) => item.status !== 'done' && item.status !== 'dropped')) {
    const meta: string[] = [plan.status, plan.priority];
    if (plan.assignee) meta.push(`assignee:${plan.assignee}`);
    if (plan.project) meta.push(`project:${plan.project}`);
    if (plan.steps && plan.steps.length > 0) {
      const done = plan.steps.filter((s) => s.status === 'done').length;
      meta.push(`${done}/${plan.steps.length}`);
    }
    items.push({
      id: plan.id,
      section: 'plan',
      text: plan.text,
      tags: plan.tags,
      related_paths: plan.related_paths,
      score: 0,
      reasons: [],
      extra: meta.join(', '),
      provenance: { actor: plan.author },
    });
  }

  for (const c of state.active_constraints) {
    items.push({
      id: c.id,
      section: 'constraint',
      text: c.text,
      tags: c.tags,
      related_paths: c.related_paths,
      score: 0,
      reasons: [],
      extra: c.status,
      plan_id: c.plan_id,
      provenance: {
        actor: c.author,
        actor_id: c.author_id,
        project_id: c.project_id,
        host_id: c.host_id,
        session_id: c.session_id,
      },
    });
  }

  for (const d of state.recent_decisions) {
    items.push({
      id: d.id,
      section: 'decision',
      text: d.text,
      tags: d.tags,
      related_paths: d.related_paths,
      score: 0,
      reasons: [],
      extra: d.related_paths?.join(', '),
      plan_id: d.plan_id,
      provenance: {
        actor: d.author,
        actor_id: d.author_id,
        project_id: d.project_id,
        host_id: d.host_id,
        session_id: d.session_id,
      },
    });
  }

  for (const t of state.known_traps.filter((trap) => isTrapActive(trap))) {
    items.push({
      id: t.id,
      section: 'trap',
      text: t.text,
      tags: t.tags,
      related_paths: t.related_paths,
      score: 0,
      reasons: [],
      extra: `${t.severity}, visibility:${t.visibility ?? 'shared'}`,
      plan_id: t.plan_id,
      provenance: {
        actor: t.author,
        actor_id: t.author_id,
        project_id: t.project_id,
        host_id: t.host_id,
        session_id: t.session_id,
      },
    });
  }

  for (const trap of listOperationalTraps({ hostId: options.host, includeAllHosts: options.allHosts }, contextCwd).filter((entry) => isTrapActive(entry))) {
    items.push({
      id: trap.id,
      section: 'trap',
      text: trap.text,
      tags: trap.tags,
      related_paths: trap.related_paths,
      score: 0,
      reasons: [],
      extra: `${trap.severity}, visibility:${trap.visibility ?? 'machine'}${trap.host_id ? `, host:${trap.host_id}` : ''}`,
    });
  }

  for (const h of state.open_handoffs.filter((x) => x.status === 'open')) {
    items.push({
      id: h.id,
      section: 'handoff',
      text: h.text,
      tags: h.tags,
      related_paths: h.related_paths,
      score: 0,
      reasons: [],
      extra: `${h.from} -> ${h.to}`,
      provenance: {
        actor: h.author,
        actor_id: h.author_id,
        project_id: h.project_id,
        host_id: h.host_id,
        session_id: h.session_id,
      },
    });
  }

  const runtimeNotes = listRuntimeNotes({
    hostId: options.host,
    includeAllHosts: options.allHosts,
  }, contextCwd);
  for (const note of runtimeNotes) {
    if (project && note.project && note.project !== project) {
      continue;
    }

    const meta: string[] = [`agent:${note.agent}`, `visibility:${note.visibility}`];
    if (note.host_id) meta.push(`host:${note.host_id}`);
    if (note.agent_id) meta.push(`agent_id:${note.agent_id}`);
    if (note.session_id) meta.push(`session:${note.session_id}`);
    if (note.plan_id) meta.push(`plan:${note.plan_id}`);
    if (note.project) meta.push(`project:${note.project}`);
    items.push({
      id: note.id,
      section: 'runtime',
      text: note.text,
      tags: note.tags,
      score: 0,
      reasons: [],
      extra: meta.join(', '),
      provenance: {
        actor: note.agent,
        actor_id: note.agent_id,
        project_id: note.project_id,
        host_id: note.host_id,
        session_id: note.session_id,
      },
    });
  }

  if (options.includePending) {
    for (const p of listCandidates('pending', contextCwd)) {
      const meta: string[] = [`${p.type}`, `stars:${p.star_count ?? 0}`, `uses:${p.usage_count ?? 0}`];
      if (p.author_id) meta.push(`author_id:${p.author_id}`);
      if (p.session_id) meta.push(`session:${p.session_id}`);
      items.push({
        id: p.id,
        section: 'candidate',
        text: p.text,
        tags: p.tags,
        related_paths: p.related_paths,
        score: 0,
        reasons: [],
        extra: meta.join(', '),
        provenance: {
          actor: p.author,
          actor_id: p.author_id,
          project_id: p.project_id,
          host_id: p.host_id,
          session_id: p.session_id,
        },
      });
    }
  }

  // Merge items from parent stores (multi-store hierarchy)
  // Primary store is storeChain[0]; parents are storeChain[1+]
  const seenIds = new Set(items.map((i) => i.id));
  for (const parentStore of storeChain.slice(1)) {
    try {
      const parentState = loadState(parentStore.cwd);
      const storeLabel = parentStore.role !== 'unknown' ? parentStore.role : `depth:${parentStore.depth}`;

      for (const c of parentState.active_constraints) {
        if (seenIds.has(c.id)) continue;
        seenIds.add(c.id);
        items.push({
          id: c.id, section: 'constraint', text: c.text, tags: c.tags,
          related_paths: c.related_paths, score: 0, reasons: [],
          extra: `${c.status} [from:${storeLabel}]`,
          provenance: { actor: c.author, actor_id: c.author_id, project_id: c.project_id },
        });
      }

      for (const d of parentState.recent_decisions) {
        if (seenIds.has(d.id)) continue;
        seenIds.add(d.id);
        items.push({
          id: d.id, section: 'decision', text: d.text, tags: d.tags,
          related_paths: d.related_paths, score: 0, reasons: [],
          extra: `[from:${storeLabel}]`,
          provenance: { actor: d.author, actor_id: d.author_id, project_id: d.project_id },
        });
      }

      for (const t of parentState.known_traps.filter((trap) => isTrapActive(trap))) {
        if (seenIds.has(t.id)) continue;
        seenIds.add(t.id);
        items.push({
          id: t.id, section: 'trap', text: t.text, tags: t.tags,
          related_paths: t.related_paths, score: 0, reasons: [],
          extra: `${t.severity} [from:${storeLabel}]`,
          provenance: { actor: t.author, actor_id: t.author_id, project_id: t.project_id },
        });
      }

      for (const plan of parentState.plan_items.filter((p) => p.status !== 'done' && p.status !== 'dropped')) {
        if (seenIds.has(plan.id)) continue;
        seenIds.add(plan.id);
        const meta = [plan.status, plan.priority, `from:${storeLabel}`];
        if (plan.assignee) meta.push(`assignee:${plan.assignee}`);
        items.push({
          id: plan.id, section: 'plan', text: plan.text, tags: plan.tags,
          related_paths: plan.related_paths, score: 0, reasons: [],
          extra: meta.join(', '),
        });
      }

      for (const h of parentState.open_handoffs.filter((x) => x.status === 'open')) {
        if (seenIds.has(h.id)) continue;
        seenIds.add(h.id);
        items.push({
          id: h.id, section: 'handoff', text: h.text, tags: h.tags,
          related_paths: h.related_paths, score: 0, reasons: [],
          extra: `${h.from} -> ${h.to} [from:${storeLabel}]`,
          provenance: { actor: h.author, actor_id: h.author_id, project_id: h.project_id },
        });
      }
    } catch {
      // Non-fatal: skip unreadable parent store
    }
  }

  // Merge active claims from all parent stores for open_work visibility
  const parentStoreClaims: ReturnType<typeof listClaims> = [];
  for (const parentStore of storeChain.slice(1)) {
    try {
      parentStoreClaims.push(...listClaims(parentStore.cwd));
    } catch { /* non-fatal */ }
  }

  // Merge instructions from all stores in the chain
  const allInstructions: InstructionEntry[] = [...loadInstructions(contextCwd)];
  for (const parentStore of storeChain.slice(1)) {
    try {
      const parentInstrs = loadInstructions(parentStore.cwd);
      for (const instr of parentInstrs) {
        if (!allInstructions.some((existing) => existing.id === instr.id)) {
          allInstructions.push(instr);
        }
      }
    } catch { /* non-fatal */ }
  }
  const resolvedInstructions = resolveInstructions(allInstructions, { project, agent });

  // Apply profile section filter before scoring
  if (allowedSections) {
    const allowed = allowedSections;
    items.splice(0, items.length, ...items.filter((i) => allowed.includes(i.section)));
  }

  const queryTerms = tokenise(target);

  // Agent-layer scoring: boost items related to the current agent's claims
  const agentName = agent;
  const agentId = currentAgentIdentity?.agent_id;
  const allClaims = [...listClaims(contextCwd), ...parentStoreClaims];
  const myClaims = allClaims.filter(
    (c) => c.status === 'active' && (agentId ? c.agent_id === agentId : c.agent === agentName)
  );
  const myClaimScopes = myClaims.map((c) => c.scope);
  const otherActiveClaims = allClaims.filter(
    (c) => c.status === 'active' && !(agentId ? c.agent_id === agentId : c.agent === agentName)
  );

  for (const item of items) {
    const relevance = computeRelevance(item, queryTerms, profile, target);
    item.score = relevance.score;
    item.reasons = relevance.reasons;

    // Layer 1: boost items in my claimed scope (+6)
    if (item.score >= 0 && myClaimScopes.length > 0 && item.related_paths) {
      const overlaps = item.related_paths.some((p) =>
        myClaimScopes.some((scope) => p.includes(scope) || scope.includes(p))
      );
      if (overlaps) {
        item.score += 6;
        item.reasons = uniqueReasons([...item.reasons, 'agent-layer: my claimed scope']);
      }
    }

    // Layer 1: boost plans assigned to me (+5)
    if (item.score >= 0 && item.section === 'plan' && item.extra?.includes(`assignee:${agentName}`)) {
      item.score += 5;
      item.reasons = uniqueReasons([...item.reasons, 'agent-layer: my assigned plan']);
    }

    // Layer 2: boost items authored by me (+0.5)
    if (item.score >= 0 && item.provenance?.actor === agentName) {
      item.score += 0.5;
      item.reasons = uniqueReasons([...item.reasons, 'agent-layer: my authored item']);
    }

    // Reputation signal
    if (item.score >= 0 && item.provenance) {
      const trustBonus = rankingLookup.getRankingBonus(item.provenance.actor_id, item.provenance.actor);
      if (trustBonus > 0) {
        item.score += trustBonus;
        item.reasons = uniqueReasons([...item.reasons, `reputation signal:+${trustBonus.toFixed(2)}`]);
      }
    }

    // Layer 3: boost machine-scoped items for broader visibility (+1)
    if (item.score >= 0) {
      const itemScope = (item as ContextItem & { scope?: string }).scope;
      if (itemScope === 'machine') {
        item.score += 1;
        item.reasons = uniqueReasons([...item.reasons, 'machine-scope signal']);
      }
    }
  }

  const ranked = items
    .filter(item => item.score >= 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, maxItems);

  const selected = maxChars ? applyCharBudget(ranked, maxChars) : ranked;
  const resumeSummary = buildCurrentAgentResumeSummary(contextCwd);
  const scopedActivity = buildScopedActivity({
    target,
    project,
    state,
    runtimeNotes,
    pendingCandidates: listCandidates('pending', contextCwd),
  });
  // Density reflects what the store HAS, not what the char budget keeps:
  // classify pre-budget so a tight budget_tokens on a rich store never
  // misreads as 'low' and triggers a bootstrap re-scan (pln#542 interaction).
  const memoryDensity = classifyMemoryDensity(ranked.length);
  const bootstrapEnabled = options.bootstrap !== false;
  const testMode = process.env.BRAINCLAW_TEST_MODE === '1';
  let bootstrapAvailable = false;
  let derivedSignals: DerivedContextSignal[] | undefined;

  if (!testMode) {
    bootstrapAvailable = hasReusableBootstrapProfile(target, contextCwd);

    if (bootstrapEnabled && (options.refreshBootstrap || memoryDensity === 'low')) {
      const bootstrap = runBootstrapProfile({
        target,
        refresh: options.refreshBootstrap,
        cwd: contextCwd,
      });
      bootstrapAvailable = bootstrap.profile.seed_count > 0;
      if (memoryDensity === 'low') {
        const signals = selectDerivedSignals(target, 5, contextCwd);
        if (signals.length > 0) {
          derivedSignals = signals;
        }
      }
    } else if (bootstrapEnabled && bootstrapAvailable && memoryDensity === 'low') {
      const signals = selectDerivedSignals(target, 5, contextCwd);
      if (signals.length > 0) {
        derivedSignals = signals;
      }
    }
  }

  const executionSensitive = isExecutionSensitiveTarget(target);
  const derivedUsesExecution = derivedSignals?.some((signal) => signal.source_kind === 'machine') ?? false;
  const derivedUsesTooling = derivedSignals?.some((signal) => signal.source_kind === 'skill' || signal.source_kind === 'mcp') ?? false;
  const rawAgentTooling = buildAgentToolingContext({ cwd: contextCwd });
  const actionableAgentRules = rawAgentTooling.agents_rules.length > 0;
  const blockingTooling = rawAgentTooling.mcp_servers.some((server) => server.availability === 'missing_command');
  const shouldExposeExecution = memoryDensity === 'low' || executionSensitive || derivedUsesExecution;
  const shouldExposeAgentTooling = memoryDensity === 'low'
    || executionSensitive
    || derivedUsesTooling
    || actionableAgentRules
    || blockingTooling;
  const executionContext = shouldExposeExecution
    ? compactExecutionContext(buildExecutionContext({ cwd: contextCwd }))
    : undefined;
  const agentTooling = shouldExposeAgentTooling
    ? summariseAgentTooling(rawAgentTooling)
    : undefined;

  // Build open_work: active claims and in_progress plans owned by the current agent
  // Reuses myClaims computed in agent-layer scoring above
  let openWork: OpenWorkSummary | undefined;
  const currentSession = loadCurrentSession(contextCwd);
  if (currentAgentIdentity || agent) {
    const claimPlanIds = new Set(myClaims.map((c) => c.plan_id).filter(Boolean) as string[]);
    const activeAssignments = listAssignments(contextCwd, { agent: agentName }).filter((assignment) =>
      !['completed', 'failed', 'cancelled', 'expired', 'rerouted', 'timed_out'].includes(assignment.status),
    );
    const inProgressPlans = state.plan_items.filter(
      (p) =>
        p.status === 'in_progress' &&
        (p.assignee === agentName || claimPlanIds.has(p.id))
    );
    if (myClaims.length > 0 || activeAssignments.length > 0 || inProgressPlans.length > 0) {
      openWork = {
        active_claims: myClaims.map((c) => ({
          id: c.id,
          scope: c.scope,
          description: c.description,
          created_at: c.created_at,
          plan_id: c.plan_id,
          expires_at: c.expires_at,
          liveness: assessClaimLiveness(c, { cwd: contextCwd }).status,
        })),
        active_assignments: activeAssignments.map(({ id, status, scope, description, plan_id, last_heartbeat_at }) => ({
          id,
          status,
          scope,
          description,
          plan_id,
          last_heartbeat_at,
        })),
        in_progress_plans: inProgressPlans.map(({ id, text, assignee }) => ({ id, text, assignee })),
      };
    }
  }
  const sessionMetrics = buildSessionMetrics({
    cwd: contextCwd,
    sessionId: currentSession?.session_id,
    sessionStartedAt: currentSession?.started_at,
    agentName: agentName,
    agentId: currentAgentIdentity?.agent_id,
    activeClaimsCount: openWork?.active_claims.length ?? 0,
    runtimeNotes,
  });

  // Cross-project items (subscriber links — read-only, always injected, bypass scoring)
  const crossProjectItems: ContextItem[] = [];
  for (const link of resolveCrossProjectLinks(contextCwd)) {
    if (!link.available) continue;
    try {
      const linkedState = loadCrossProjectState(link.absolutePath);
      for (const p of linkedState.plan_items.filter((plan) => plan.status !== 'done' && plan.status !== 'dropped')) {
        crossProjectItems.push({
          id: p.id, section: 'cross_project', text: `[plan] ${p.text}`,
          tags: p.tags, score: 0, reasons: [], from_project: link.projectName,
          extra: `${p.status}, ${p.priority}`,
        });
      }
      for (const d of linkedState.recent_decisions) {
        crossProjectItems.push({
          id: d.id, section: 'cross_project', text: d.text,
          tags: d.tags, score: 0, reasons: [], from_project: link.projectName,
          plan_id: d.plan_id,
        });
      }
      for (const c of linkedState.active_constraints) {
        crossProjectItems.push({
          id: c.id, section: 'cross_project', text: c.text,
          tags: c.tags, score: 0, reasons: [], from_project: link.projectName,
          plan_id: c.plan_id,
        });
      }
      for (const t of linkedState.known_traps.filter((trap) => isTrapActive(trap))) {
        crossProjectItems.push({
          id: t.id, section: 'cross_project', text: t.text,
          tags: t.tags, score: 0, reasons: [], from_project: link.projectName,
          plan_id: t.plan_id,
        });
      }
    } catch { /* skip unavailable linked project */ }
  }

  // Staleness detection: non-blocking, capped at 5 warnings to keep context lean.
  // Phase 4 Sprint 1 Lane A step 3 (pln#390): runtime_note staleness now
  // flows through the same surface.
  let staleWarnings: StalenessWarning[] | undefined;
  try {
    const pendingCandidatesForStaleness = listCandidates('pending', contextCwd);
    const runtimeNotesForStaleness = listRuntimeNotes(undefined, contextCwd);
    const staleReport = detectStaleness(
      state.plan_items,
      state.known_traps,
      state.open_handoffs,
      pendingCandidatesForStaleness,
      Date.now(),
      runtimeNotesForStaleness,
      // pln#557 step 2 — dead related_paths detection. Surfaces "confident
      // but wrong" memory (paths deleted by a refactor) in stale_warnings,
      // which both the steady-state context and the arrival digest carry.
      {
        decisions: state.recent_decisions,
        constraints: state.active_constraints,
        projectRoot: contextCwd,
      },
    );
    if (staleReport.warnings.length > 0) {
      staleWarnings = staleReport.warnings.slice(0, 5);
    }
  } catch { /* non-fatal */ }

  const result: ContextResult = {
    context_schema: CONTEXT_SCHEMA_VERSION,
    profile,
    project_id: config.project_id,
    agent_id: currentAgentIdentity?.agent_id,
    project_mode: projectMode,
    project_strategy: projectStrategy,
    current_host: currentHost,
    project_vision: readProjectVision(contextCwd),
    host_filter: options.host,
    all_hosts: options.allHosts ?? false,
    memory_version: memoryVersion,
    target,
    project,
    agent,
    memory_density: memoryDensity,
    bootstrap_available: bootstrapAvailable,
    derived_signals: derivedSignals,
    execution_context: executionContext,
    agent_tooling: agentTooling,
    scoped_activity: scopedActivity,
    // "What's new" — explicit session reference keeps the timestamp diff;
    // otherwise the per-agent event-log cursor is the converged default
    // (covers status transitions, no store-global marker). Note: the cursor
    // read marks the surfaced events as seen for this agent.
    context_diff: options.sinceSession
      ? buildContextDiff({
          session: options.sinceSession,
          cwd: contextCwd,
          includeItems: true,
        })
      : agent
        ? buildContextDiffFromEvents(agent, contextCwd, { includeItems: true })
        : undefined,
    resolved_instructions: resolvedInstructions,
    resume_summary: resumeSummary,
    open_work: openWork,
    session_metrics: sessionMetrics,
    stores: storeChain.length > 1
      ? storeChain.map(({ cwd, depth, role }) => ({ cwd, depth, role }))
      : undefined,
    estimation_calibration: (() => {
      try {
        const report = buildEstimationReport({ agent, cwd: contextCwd });
        return report.summary.with_both >= 3 ? report.summary.calibration_hint : undefined;
      } catch { return undefined; }
    })(),
    active_project: findActiveProjectInChain(contextCwd, storeChain),
    cross_project_items: crossProjectItems.length > 0 ? crossProjectItems : undefined,
    claim_conflicts: detectClaimConflicts(myClaims, otherActiveClaims),
    workflow_hints: buildWorkflowHints(myClaims, openWork, state.plan_items),
    stale_warnings: staleWarnings,
    selected,
  };

  if (options.digest) {
    result.digest = buildContextDigest(result);
  }

  return result;
}

export function renderContextMarkdown(result: ContextResult, explain: boolean = false): string {
  const lines: string[] = [];
  lines.push(`# Agent Context (${result.profile})`);
  lines.push('');
  if (result.open_work && (result.open_work.active_claims.length > 0 || result.open_work.active_assignments.length > 0 || result.open_work.in_progress_plans.length > 0)) {
    lines.push('## ⚠ Your open work');
    lines.push('');
    if (result.open_work.active_claims.length > 0) {
      lines.push('Active claims (release when done):');
      const now = new Date().toISOString();
      for (const claim of result.open_work.active_claims) {
        const planRef = claim.plan_id ? ` [plan: ${claim.plan_id}]` : '';
        const expired = claim.expires_at && claim.expires_at < now ? ' ⚠ EXPIRED — run brainclaw prune' : '';
        const ttlInfo = claim.expires_at && !expired ? ` (expires ${claim.expires_at.slice(0, 16).replace('T', ' ')})` : '';
        const livenessTag = claim.liveness && claim.liveness !== 'live' && claim.liveness !== 'young'
          ? ` [${claim.liveness.toUpperCase()}]`
          : '';
        lines.push(`- [${claim.id}] ${claim.description}${planRef}${ttlInfo}${livenessTag}${expired}`);
        lines.push(`  scope: ${claim.scope}`);
      }
    }
    if (result.open_work.active_assignments.length > 0) {
      lines.push('Active assignments (runtime state):');
      for (const assignment of result.open_work.active_assignments) {
        const planRef = assignment.plan_id ? ` [plan: ${assignment.plan_id}]` : '';
        const heartbeat = assignment.last_heartbeat_at ? ` [heartbeat: ${assignment.last_heartbeat_at.slice(0, 16).replace('T', ' ')}]` : '';
        lines.push(`- [${assignment.id}] ${assignment.description}${planRef} (${assignment.status})${heartbeat}`);
        lines.push(`  scope: ${assignment.scope}`);
      }
    }
    if (result.open_work.in_progress_plans.length > 0) {
      lines.push('In-progress plan items (update status when done):');
      for (const plan of result.open_work.in_progress_plans) {
        lines.push(`- [${plan.id}] ${plan.text}`);
      }
    }
    lines.push('');
  }
  if (result.session_metrics) {
    lines.push('## Session metrics');
    lines.push('');
    lines.push(`- Active claims: ${result.session_metrics.active_claims}`);
    lines.push(`- Edits since last Brainclaw write: ${result.session_metrics.edits_since_last_memory}`);
    lines.push(`- Session duration: ${result.session_metrics.session_duration_minutes} min`);
    if (result.session_metrics.last_brainclaw_write) {
      lines.push(`- Last Brainclaw write: ${result.session_metrics.last_brainclaw_write}`);
    }
    lines.push('');
  }
  if (result.estimation_calibration) {
    lines.push(`Estimation calibration: ${result.estimation_calibration}`);
    lines.push('');
  }
  lines.push(`Context schema: ${result.context_schema}`);
  if (result.project_id) {
    lines.push(`Project ID: ${result.project_id}`);
  }
  if (result.agent_id && result.agent) {
    lines.push(`Agent ID: ${result.agent_id}`);
  }
  if (result.project_vision) {
    lines.push(`Project vision: ${result.project_vision.split('\n')[0]}`);
  }
  lines.push(`Project mode: ${result.project_mode} (${result.project_strategy})`);
  if (result.active_project) {
    const ap = result.active_project;
    const age = Math.floor((Date.now() - Date.parse(ap.switched_at)) / 3_600_000);
    const sourceHint = ap.source === 'session' ? ', session-scoped' : ', global';
    lines.push(`Active project: ${ap.name ?? ap.path} (switched ${age}h ago by ${ap.switched_by ?? 'unknown'}${sourceHint})`);
    if (ap.source === 'global') {
      lines.push(`  ⚠ This is a global switch — all agents on this host see the same project. Use \`brainclaw switch <project>\` during a session for agent-scoped switching.`);
    }
    lines.push(`  All commands target this project. Use \`brainclaw switch --clear\` to return to workspace root or \`brainclaw switch <project>\` to change.`);
  }
  lines.push(`Current host: ${result.current_host}`);

  // Show other active sessions
  try {
    const allSessions = loadAllSessions();
    const ttlMs = 4 * 60 * 60 * 1000;
    const now = Date.now();
    const otherSessions = allSessions.filter(s =>
      s.agent_id !== result.agent_id
      && (now - Date.parse(s.last_seen_at)) <= ttlMs
    );
    if (otherSessions.length > 0) {
      const summaries = otherSessions.map(s => {
        const proj = s.active_project?.name ?? s.active_project?.path;
        return `${s.user ?? 'unknown'}/${s.agent}${proj ? ` on ${proj}` : ''}`;
      });
      lines.push(`Other active agents: ${summaries.join(', ')}`);
    }
  } catch { /* ignore — sessions dir may not exist yet */ }

  // Check for brainclaw update (lightweight local manifest read only)
  try {
    const config = loadConfig();
    const updateCheck = checkBrainclawInstallableUpdate(config, process.cwd());
    const notice = renderBrainclawInstallableUpdateNotice(updateCheck);
    if (notice) {
      lines.push(`⚠ ${notice}`);
    }
  } catch { /* ignore — update check is best-effort */ }

  lines.push(`Memory version: ${result.memory_version}`);
  lines.push(`Memory density: ${result.memory_density}`);
  lines.push(`Bootstrap available: ${result.bootstrap_available ? 'yes' : 'no'}`);
  if (result.stores && result.stores.length > 1) {
    lines.push(`Store chain: ${result.stores.map((s) => `${s.role}(d=${s.depth})`).join(' → ')}`);
  }
  if (result.all_hosts) {
    lines.push('Runtime host filter: all-hosts');
  } else if (result.host_filter) {
    lines.push(`Runtime host filter: ${result.host_filter}`);
  }
  if (result.project) {
    lines.push(`Resolved project: ${result.project}`);
  }
  if (result.agent) {
    const suffix = result.agent_id ? ` (${result.agent_id})` : '';
    lines.push(`Resolved agent: ${result.agent}${suffix}`);
  }
  if (result.execution_context) {
    lines.push('');
    lines.push('Execution context:');
    if (result.execution_context.branch) {
      lines.push(`- Branch: ${result.execution_context.branch}`);
    }
    lines.push(`- Git status: ${result.execution_context.git_status}`);
    lines.push(`- Workspace: ${result.execution_context.workspace_root}`);
    const toolchains = result.execution_context.toolchains.map((tool) => `${tool.name}${tool.version ? ` ${tool.version}` : ''}`);
    if (toolchains.length > 0) {
      lines.push(`- Toolchains: ${toolchains.join(', ')}`);
    }
  }
  if (result.agent_tooling) {
    lines.push('');
    lines.push('Agent tooling:');
    lines.push(`- AGENTS.md: ${result.agent_tooling.agents_md_present ? 'present' : 'absent'}`);
    if (result.agent_tooling.agents_md_title) {
      lines.push(`- AGENTS title: ${result.agent_tooling.agents_md_title}`);
    }
    for (const rule of result.agent_tooling.agents_rules) {
      lines.push(`- Rule: ${rule}`);
    }
    if (result.agent_tooling.skills.length > 0) {
      lines.push(`- Skills: ${result.agent_tooling.skills.map((skill) => formatSkillSummary(skill)).join(', ')}`);
    }
    if (result.agent_tooling.mcp_servers.length > 0) {
      lines.push(`- MCP servers: ${result.agent_tooling.mcp_servers.map((server) => formatMcpServerSummary(server)).join(', ')}`);
    }
  }
  if (result.context_diff) {
    lines.push('');
    lines.push('New since session started:');
    lines.push(`- ${result.context_diff.summary}`);
  }
  if (result.digest) {
    lines.push('');
    lines.push('Digest:');
    for (const line of result.digest.split('\n')) {
      lines.push(`- ${line}`);
    }
  }
  if (result.resume_summary) {
    lines.push('');
    lines.push(`Resume summary for ${result.resume_summary.agent_name}:`);
    lines.push(`- Internal trust: ${result.resume_summary.internal_trust}`);
    lines.push(`- Contribution quality: ${result.resume_summary.contribution_quality}`);
    lines.push(`- Review reliability: ${result.resume_summary.review_reliability}`);
    lines.push(`- Continuity hygiene: ${result.resume_summary.continuity_hygiene}`);
    for (const item of result.resume_summary.strengths) {
      lines.push(`- Strength: ${item}`);
    }
    for (const item of result.resume_summary.cautions) {
      lines.push(`- Caution: ${item}`);
    }
    for (const item of result.resume_summary.suggested_focus) {
      lines.push(`- Focus: ${item}`);
    }
  }
  lines.push('');
  if (result.target) {
    lines.push(`Target: ${result.target}`);
    lines.push('');
  }

  lines.push('Instructions:');
  if (result.resolved_instructions.length === 0) {
    lines.push('- None resolved.');
  } else {
    for (const instruction of result.resolved_instructions) {
      const scope = instruction.scope ? `:${instruction.scope}` : '';
      const tags = instruction.tags.length ? ` [${instruction.tags.join(', ')}]` : '';
      lines.push(`- [${instruction.id}] <${instruction.layer}${scope}> ${instruction.text}${tags}`);
    }
  }
  lines.push('');

  if (result.selected.length === 0) {
    lines.push('- No relevant canonical memory found.');
    if (result.derived_signals && result.derived_signals.length > 0) {
      lines.push('');
      lines.push('Derived signals:');
      for (const signal of result.derived_signals) {
        lines.push(`- [${signal.seed_kind}/${signal.confidence}] ${signal.text} <${signal.source_kind}:${signal.source_ref}>`);
      }
    }
    return lines.join('\n');
  }

  lines.push('Canonical memory:');
  for (const item of result.selected) {
    const tags = item.tags.length ? ` [${item.tags.join(', ')}]` : '';
    const extra = item.extra ? ` (${item.extra})` : '';
    const planRef = item.plan_id ? ` [plan: ${item.plan_id}]` : '';
    const why = explain && item.reasons.length ? ` {why: ${item.reasons.join(', ')}}` : '';
    lines.push(`- [${item.id}] <${item.section}> ${item.text}${extra}${planRef}${tags}${why}`);
  }

  if (result.derived_signals && result.derived_signals.length > 0) {
    lines.push('');
    lines.push('Derived signals:');
    for (const signal of result.derived_signals) {
      lines.push(`- [${signal.seed_kind}/${signal.confidence}] ${signal.text} <${signal.source_kind}:${signal.source_ref}>`);
    }
  }

  return lines.join('\n');
}

export function renderContextPromptTemplate(result: ContextResult, compact: boolean = false): string {
  const lines: string[] = [];
  if (!compact) {
    lines.push('Use the following project memory context before planning or making changes:');
    lines.push('');
  }
  lines.push('```memory-context');
  if (compact) {
    lines.push(`cs=${result.context_schema}`);
    if (result.digest) {
      lines.push('dg:');
      for (const line of result.digest.split('\n')) {
        lines.push(`  - ${line}`);
      }
    }
    lines.push(`p=${result.profile}`);
    if (result.project_id) {
      lines.push(`pid=${result.project_id}`);
    }
    if (result.agent_id) {
      lines.push(`aid=${result.agent_id}`);
    }
    lines.push(`pm=${result.project_mode}`);
    lines.push(`ps=${result.project_strategy}`);
    lines.push(`ch=${result.current_host}`);
    lines.push(`mv=${result.memory_version}`);
    lines.push(`md=${result.memory_density}`);
    lines.push(`ba=${result.bootstrap_available ? 'y' : 'n'}`);
    if (result.all_hosts) {
      lines.push('hf=all-hosts');
    } else if (result.host_filter) {
      lines.push(`hf=${result.host_filter}`);
    }
    if (result.project) {
      lines.push(`pr=${result.project}`);
    }
    if (result.agent) {
      lines.push(`ag=${result.agent}`);
    }
    if (result.execution_context) {
      if (result.execution_context.branch) {
        lines.push(`br=${result.execution_context.branch}`);
      }
      lines.push(`gs=${result.execution_context.git_status}`);
      lines.push(`wr=${result.execution_context.workspace_root}`);
    }
    if (result.agent_tooling) {
      lines.push(`am=${result.agent_tooling.agents_md_present ? 'y' : 'n'}`);
      lines.push(`ar=${result.agent_tooling.agents_rules.length}`);
      lines.push(`sk=${result.agent_tooling.skills.length}`);
      lines.push(`ms=${result.agent_tooling.mcp_servers.length}`);
    }
    if (result.context_diff) {
      lines.push(`sd=${result.context_diff.since_session ?? ''}`);
      lines.push(`dc=${result.context_diff.counts.total}`);
    }
    if (result.stale_warnings && result.stale_warnings.length > 0) {
      lines.push(`sw=${result.stale_warnings.length}`);
      for (const w of result.stale_warnings) {
        lines.push(`  - en=${w.entity} id=${w.id} ag=${w.age_days} tx="${w.reason}"`);
      }
    }
    if (result.resume_summary) {
      lines.push(`rt=${result.resume_summary.internal_trust}`);
      lines.push('rs:');
      for (const item of result.resume_summary.suggested_focus) {
        lines.push(`  - ${item}`);
      }
    }
    if (result.target) {
      lines.push(`t=${result.target}`);
    }
  } else {
    lines.push(`context_schema: ${result.context_schema}`);
    if (result.digest) {
      lines.push('digest:');
      for (const line of result.digest.split('\n')) {
        lines.push(`  - ${line}`);
      }
    }
    lines.push(`profile: ${result.profile}`);
    if (result.project_id) {
      lines.push(`project_id: ${result.project_id}`);
    }
    if (result.agent_id) {
      lines.push(`agent_id: ${result.agent_id}`);
    }
    lines.push(`project_mode: ${result.project_mode}`);
    lines.push(`project_strategy: ${result.project_strategy}`);
    if (result.project_vision) {
      lines.push(`project_vision: "${result.project_vision.split('\n')[0]}"`);
    }
    if (result.active_project) {
      lines.push(`active_project: ${result.active_project.name ?? result.active_project.path}`);
      lines.push(`active_project_switched: ${result.active_project.switched_at}`);
      lines.push(`active_project_source: ${result.active_project.source ?? 'global'}`);
    }
    lines.push(`current_host: ${result.current_host}`);
    lines.push(`memory_version: ${result.memory_version}`);
    lines.push(`memory_density: ${result.memory_density}`);
    lines.push(`bootstrap_available: ${result.bootstrap_available}`);
    if (result.all_hosts) {
      lines.push('host_filter: all-hosts');
    } else if (result.host_filter) {
      lines.push(`host_filter: ${result.host_filter}`);
    }
    if (result.project) {
      lines.push(`project: ${result.project}`);
    }
    if (result.agent) {
      lines.push(`agent: ${result.agent}`);
    }
    if (result.execution_context) {
      lines.push('execution_context:');
      lines.push(`  platform: ${result.execution_context.platform}`);
      if (result.execution_context.branch) {
        lines.push(`  branch: ${result.execution_context.branch}`);
      }
      lines.push(`  git_status: ${result.execution_context.git_status}`);
      lines.push(`  workspace_root: ${result.execution_context.workspace_root}`);
      lines.push('  toolchains:');
      for (const tool of result.execution_context.toolchains) {
        lines.push(`    - ${tool.name}${tool.version ? ` ${tool.version}` : ''}`);
      }
    }
    if (result.agent_tooling) {
      lines.push('agent_tooling:');
      lines.push(`  agents_md_present: ${result.agent_tooling.agents_md_present}`);
      if (result.agent_tooling.agents_md_title) {
        lines.push(`  agents_md_title: ${result.agent_tooling.agents_md_title}`);
      }
      lines.push('  agents_rules:');
      for (const rule of result.agent_tooling.agents_rules) {
        lines.push(`    - ${rule}`);
      }
      lines.push('  skills:');
      for (const skill of result.agent_tooling.skills) {
        lines.push(`    - ${formatSkillSummary(skill)}`);
      }
      lines.push('  mcp_servers:');
      for (const server of result.agent_tooling.mcp_servers) {
        lines.push(`    - ${formatMcpServerSummary(server)}`);
      }
    }
    if (result.context_diff) {
      lines.push('context_diff:');
      if (result.context_diff.since_session) {
        lines.push(`  since_session: ${result.context_diff.since_session}`);
      }
      if (result.context_diff.since) {
        lines.push(`  since: ${result.context_diff.since}`);
      }
      lines.push(`  summary: ${result.context_diff.summary}`);
      lines.push('  counts:');
      lines.push(`    constraints: ${result.context_diff.counts.constraints}`);
      lines.push(`    decisions: ${result.context_diff.counts.decisions}`);
      lines.push(`    traps: ${result.context_diff.counts.traps}`);
      lines.push(`    handoffs: ${result.context_diff.counts.handoffs}`);
      lines.push(`    plans: ${result.context_diff.counts.plans}`);
      lines.push(`    pending_candidates: ${result.context_diff.counts.pending_candidates}`);
      lines.push(`    total: ${result.context_diff.counts.total}`);
    }
    if (result.resume_summary) {
      lines.push('resume_summary:');
      lines.push(`  agent_name: ${result.resume_summary.agent_name}`);
      if (result.resume_summary.agent_id) {
        lines.push(`  agent_id: ${result.resume_summary.agent_id}`);
      }
      lines.push(`  internal_trust: ${result.resume_summary.internal_trust}`);
      lines.push(`  contribution_quality: ${result.resume_summary.contribution_quality}`);
      lines.push(`  review_reliability: ${result.resume_summary.review_reliability}`);
      lines.push(`  continuity_hygiene: ${result.resume_summary.continuity_hygiene}`);
      lines.push('  suggested_focus:');
      for (const item of result.resume_summary.suggested_focus) {
        lines.push(`    - ${item}`);
      }
    }
    if (result.stale_warnings && result.stale_warnings.length > 0) {
      lines.push('stale_warnings:');
      for (const w of result.stale_warnings) {
        lines.push(`  - entity=${w.entity} id=${w.id} age_days=${w.age_days} reason="${w.reason}" action="${w.suggested_action}"`);
      }
    }
    if (result.target) {
      lines.push(`target: ${result.target}`);
    }
  }
  if (result.open_work && (result.open_work.active_claims.length > 0 || result.open_work.active_assignments.length > 0 || result.open_work.in_progress_plans.length > 0)) {
    lines.push(compact ? 'ow:' : 'open_work:');
    if (result.open_work.active_claims.length > 0) {
      lines.push(compact ? '  claims:' : '  active_claims:');
      for (const claim of result.open_work.active_claims) {
        const lv = claim.liveness ? (compact ? ` lv=${claim.liveness}` : ` liveness=${claim.liveness}`) : '';
        if (compact) {
          const planRef = claim.plan_id ? ` pl=${claim.plan_id}` : '';
          lines.push(`    - id=${claim.id}${planRef} sc="${claim.scope}" tx="${claim.description}"${lv}`);
        } else {
          const planRef = claim.plan_id ? ` plan_id=${claim.plan_id}` : '';
          lines.push(`    - id=${claim.id}${planRef} scope="${claim.scope}" description="${claim.description}"${lv}`);
        }
      }
    }
    if (result.open_work.active_assignments.length > 0) {
      lines.push(compact ? '  assignments:' : '  active_assignments:');
      for (const assignment of result.open_work.active_assignments) {
        if (compact) {
          const planRef = assignment.plan_id ? ` pl=${assignment.plan_id}` : '';
          lines.push(`    - id=${assignment.id}${planRef} st=${assignment.status} sc="${assignment.scope}" tx="${assignment.description}"`);
        } else {
          const planRef = assignment.plan_id ? ` plan_id=${assignment.plan_id}` : '';
          lines.push(`    - id=${assignment.id}${planRef} status=${assignment.status} scope="${assignment.scope}" description="${assignment.description}"`);
        }
      }
    }
    if (result.open_work.in_progress_plans.length > 0) {
      lines.push(compact ? '  plans:' : '  in_progress_plans:');
      for (const plan of result.open_work.in_progress_plans) {
        if (compact) {
          lines.push(`    - id=${plan.id} tx="${plan.text}"`);
        } else {
          lines.push(`    - id=${plan.id} text="${plan.text}"`);
        }
      }
    }
  }
  if (result.session_metrics) {
    lines.push(compact ? 'sm:' : 'session_metrics:');
    if (compact) {
      lines.push(`  ac=${result.session_metrics.active_claims}`);
      lines.push(`  ed=${result.session_metrics.edits_since_last_memory}`);
      lines.push(`  dur=${result.session_metrics.session_duration_minutes}`);
      if (result.session_metrics.last_brainclaw_write) {
        lines.push(`  lbw=${result.session_metrics.last_brainclaw_write}`);
      }
    } else {
      lines.push(`  active_claims: ${result.session_metrics.active_claims}`);
      lines.push(`  edits_since_last_memory: ${result.session_metrics.edits_since_last_memory}`);
      lines.push(`  session_duration_minutes: ${result.session_metrics.session_duration_minutes}`);
      if (result.session_metrics.last_brainclaw_write) {
        lines.push(`  last_brainclaw_write: ${result.session_metrics.last_brainclaw_write}`);
      }
    }
  }
  lines.push(compact ? 'ins:' : 'instructions:');
  if (result.resolved_instructions.length === 0) {
    lines.push(compact ? '  - n' : '  - none');
  } else {
    for (const instruction of result.resolved_instructions) {
      if (compact) {
        const scope = instruction.scope ? ` sc=${instruction.scope}` : '';
        const tags = instruction.tags.length ? ` tg=[${instruction.tags.join(',')}]` : '';
        lines.push(`  - id=${instruction.id} ly=${instruction.layer}${scope}${tags} tx="${instruction.text}"`);
      } else {
        const scope = instruction.scope ? ` scope=${instruction.scope}` : '';
        const tags = instruction.tags.length ? ` tags=[${instruction.tags.join(',')}]` : '';
        lines.push(`  - id=${instruction.id} layer=${instruction.layer}${scope}${tags} text="${instruction.text}"`);
      }
    }
  }
  lines.push(compact ? 'i:' : 'items:');
  if (result.selected.length === 0) {
    lines.push(compact ? '  - n' : '  - none');
  } else {
    for (const item of result.selected) {
      if (compact) {
        const tags = item.tags.length ? ` tg=[${item.tags.join(',')}]` : '';
        const extra = item.extra ? ` ex="${item.extra}"` : '';
        const planRef = item.plan_id ? ` pl=${item.plan_id}` : '';
        const why = item.reasons.length ? ` why=[${item.reasons.join('|')}]` : '';
        lines.push(`  - id=${item.id} tp=${item.section}${tags}${extra}${planRef}${why} tx="${item.text}"`);
      } else {
        const tags = item.tags.length ? ` tags=[${item.tags.join(',')}]` : '';
        const extra = item.extra ? ` extra="${item.extra}"` : '';
        const planRef = item.plan_id ? ` plan=${item.plan_id}` : '';
        const why = item.reasons.length ? ` why=[${item.reasons.join(', ')}]` : '';
        lines.push(`  - id=${item.id} type=${item.section}${tags}${extra}${planRef}${why} text="${item.text}"`);
      }
    }
  }
  if (result.derived_signals && result.derived_signals.length > 0) {
    lines.push(compact ? 'ds:' : 'derived_signals:');
    for (const signal of result.derived_signals) {
      if (compact) {
        const paths = signal.related_paths?.length ? ` rp=[${signal.related_paths.join(',')}]` : '';
        lines.push(`  - id=${signal.id} sk=${signal.seed_kind} cf=${signal.confidence} src=${signal.source_kind}:${signal.source_ref}${paths} tx="${signal.text}"`);
      } else {
        const paths = signal.related_paths?.length ? ` related_paths=[${signal.related_paths.join(',')}]` : '';
        lines.push(`  - id=${signal.id} seed_kind=${signal.seed_kind} confidence=${signal.confidence} source=${signal.source_kind}:${signal.source_ref}${paths} text="${signal.text}"`);
      }
    }
  }
  if (result.context_diff) {
    lines.push(compact ? 'cd:' : 'context_diff_items:');
    for (const item of result.context_diff.changed_items ?? []) {
      if (compact) {
        lines.push(`  - tp=${item.section} id=${item.id} tx="${item.text}"`);
      } else {
        lines.push(`  - type=${item.section} id=${item.id} created_at=${item.created_at} text="${item.text}"`);
      }
    }
  }
  lines.push('```');
  return lines.join('\n');
}

/**
 * Render context as an ultra-compact scope briefing (< 500 chars).
 * Designed for pre-action injection: only what matters for THIS scope, NOW.
 *
 * Output example:
 *   scope: src/core/agent-files.ts
 *   traps: [high] MCP server hérite env vars VS Code
 *   claims: no conflict
 *   decisions: brainclawMcpEntry preserves existing command
 *   confidence: high (3 items, freshest 2d ago)
 */
export function renderContextBriefing(result: ContextResult): string {
  const lines: string[] = [];

  if (result.target) {
    lines.push(`scope: ${result.target}`);
  }

  // Traps (high severity first, max 2)
  const traps = result.selected
    .filter(i => i.section === 'trap')
    .slice(0, 2);
  if (traps.length > 0) {
    for (const t of traps) {
      const severity = t.extra?.match(/\b(high|medium|low)\b/)?.[0] ?? '';
      const text = t.text.length > 80 ? t.text.slice(0, 77) + '...' : t.text;
      lines.push(`trap: [${severity}] ${text}`);
    }
  }

  // Claim conflicts
  if (result.claim_conflicts && result.claim_conflicts.length > 0) {
    for (const c of result.claim_conflicts.slice(0, 2)) {
      lines.push(`conflict: ${c.other_agent} claims ${c.other_scope}`);
    }
  } else {
    lines.push('claims: no conflict');
  }

  // Recent decisions (max 1, truncated)
  const decisions = result.selected
    .filter(i => i.section === 'decision')
    .slice(0, 1);
  if (decisions.length > 0) {
    const text = decisions[0]!.text.length > 80 ? decisions[0]!.text.slice(0, 77) + '...' : decisions[0]!.text;
    lines.push(`decision: ${text}`);
  }

  // Confidence score based on item count and scope activity
  const totalItems = result.selected.length;
  const hasActivity = result.scoped_activity != null;

  let confidence = 'low';
  if (totalItems >= 3 && hasActivity) {
    confidence = 'high';
  } else if (totalItems >= 1) {
    confidence = 'medium';
  }
  lines.push(`confidence: ${confidence} (${totalItems} items${hasActivity ? ', scope has recent activity' : ''})`);

  // Sequence position placeholder (populated when Sequences land)
  // lines.push(`sequence: ...`);

  return lines.join('\n');
}


/**
 * Render context for Claude Desktop: surface tasks, inbox items, and active plans.
 * Excludes traps, constraints, and decisions — Claude Desktop sessions are task-oriented.
 * Target output: < 1500 chars, actionable items only.
 */
export function renderContextClaudeDesktop(result: ContextResult): string {
  const lines: string[] = [];

  lines.push('# Brainclaw — Claude Desktop Session');
  lines.push('');

  // Active plans (task queue)
  const plans = result.selected.filter(i => i.section === 'plan');
  if (plans.length > 0) {
    lines.push('## Tasks');
    for (const p of plans.slice(0, 5)) {
      const status = p.extra?.match(/\b(todo|in_progress|blocked)\b/)?.[0] ?? 'todo';
      const text = p.text.length > 100 ? p.text.slice(0, 97) + '...' : p.text;
      lines.push(`- [${status}] ${text} (${p.id})`);
    }
    lines.push('');
  }

  // Open handoffs (pending work from other agents)
  const handoffs = result.selected.filter(i => i.section === 'handoff');
  if (handoffs.length > 0) {
    lines.push('## Inbox');
    for (const h of handoffs.slice(0, 3)) {
      const from = h.provenance?.actor ?? 'unknown';
      const text = h.text.length > 100 ? h.text.slice(0, 97) + '...' : h.text;
      lines.push(`- from:${from} — ${text}`);
    }
    lines.push('');
  }

  // Candidates (review items)
  const candidates = result.selected.filter(i => i.section === 'candidate');
  if (candidates.length > 0) {
    lines.push('## Review');
    for (const c of candidates.slice(0, 3)) {
      const text = c.text.length > 100 ? c.text.slice(0, 97) + '...' : c.text;
      lines.push(`- ${text} (${c.id})`);
    }
    lines.push('');
  }

  if (plans.length === 0 && handoffs.length === 0 && candidates.length === 0) {
    lines.push('No pending tasks. Use `bclaw_quick_capture` to queue work for Claude Desktop.');
  }

  // Claim conflicts (always show if present)
  if (result.claim_conflicts && result.claim_conflicts.length > 0) {
    lines.push('## Conflicts');
    for (const c of result.claim_conflicts.slice(0, 2)) {
      lines.push(`- ${c.other_agent} claims ${c.other_scope}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function buildScopedActivity(input: {
  target?: string;
  project?: string;
  state: ReturnType<typeof loadState>;
  runtimeNotes: ReturnType<typeof listRuntimeNotes>;
  pendingCandidates: ReturnType<typeof listCandidates>;
}): ScopedActivitySummary | undefined {
  const target = input.target?.trim();
  if (!target) {
    return undefined;
  }

  const project = input.project?.trim();
  const matchingDecisions = input.state.recent_decisions.filter((item) => matchesScopeTarget(item, target, project));
  const matchingTraps = [
    ...input.state.known_traps.filter((item) => isTrapActive(item) && matchesScopeTarget(item, target, project)),
  ].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const matchingRuntime = input.runtimeNotes
    .filter((item) => matchesScopeTarget(item, target, project))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const matchingPending = input.pendingCandidates.filter((item) => matchesScopeTarget(item, target, project));

  if (
    matchingDecisions.length === 0
    && matchingTraps.length === 0
    && matchingRuntime.length === 0
    && matchingPending.length === 0
  ) {
    return undefined;
  }

  const lastDecision = matchingDecisions.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const lastTrap = matchingTraps[0];
  const latestRuntime = matchingRuntime[0];

  return {
    scope: target,
    last_decision: lastDecision ? summariseScopedItem(lastDecision) : undefined,
    last_trap: lastTrap ? summariseScopedItem(lastTrap) : undefined,
    recent_notes: matchingRuntime.filter((item) => isRecent(item.created_at, 7 * 24)).length,
    pending_candidates: matchingPending.length,
    last_agent: latestRuntime?.agent,
    last_session: latestRuntime?.session_id,
  };
}

export function buildContextDigest(result: ContextResult): string {
  const lines: string[] = [];
  const highTraps = result.selected.filter((item) => item.section === 'trap' && item.extra?.includes('high'));
  const constraints = result.selected.filter((item) => item.section === 'constraint');
  const decisions = result.selected.filter((item) => item.section === 'decision');
  const candidates = result.selected.filter((item) => item.section === 'candidate');
  const scoped = result.scoped_activity;

  if (highTraps.length > 0) {
    lines.push(`High trap: ${highTraps[0].text}`);
  }
  if (constraints.length > 0) {
    lines.push(`Active constraint: ${constraints[0].text}`);
  }
  if (decisions.length > 0) {
    lines.push(`Recent decision: ${decisions[0].text}`);
  }
  if (candidates.length > 0 || (scoped?.pending_candidates ?? 0) > 0) {
    const pendingCount = Math.max(candidates.length, scoped?.pending_candidates ?? 0);
    lines.push(`Pending candidates: ${pendingCount}`);
  }
  if (scoped) {
    const scopedParts = [`Scoped activity on ${scoped.scope}: ${scoped.recent_notes} recent note(s)`];
    if (scoped.last_agent) {
      scopedParts.push(`last agent ${scoped.last_agent}`);
    }
    lines.push(scopedParts.join(', '));
  } else if (result.selected.some((item) => item.section === 'runtime')) {
    lines.push(`Runtime signal: ${result.selected.find((item) => item.section === 'runtime')?.text}`);
  }
  if (result.memory_density === 'low' && result.derived_signals && result.derived_signals.length > 0) {
    const signal = result.derived_signals[0];
    lines.push(`Derived ${signal.seed_kind}: ${signal.text}`);
  }
  if (result.context_diff && result.context_diff.counts.total > 0) {
    lines.push(`New since session started: ${result.context_diff.summary}`);
  }
  if (result.agent_tooling?.agents_rules.length) {
    lines.push(`Agent rule: ${result.agent_tooling.agents_rules[0]}`);
  }
  const blockingServer = result.agent_tooling?.mcp_servers.find((server) => server.availability === 'missing_command');
  if (blockingServer) {
    lines.push(`Tooling warning: MCP ${blockingServer.name} is configured but ${blockingServer.command ?? 'its command'} is unavailable.`);
  }
  if ((result.memory_density === 'low' || result.execution_context?.git_status === 'dirty') && result.execution_context) {
    if (result.execution_context.git_status === 'dirty') {
      lines.push('Execution: repository has uncommitted changes.');
    } else if (result.execution_context.branch) {
      lines.push(`Execution: branch ${result.execution_context.branch}`);
    } else if (result.execution_context.toolchains[0]) {
      const tool = result.execution_context.toolchains[0];
      lines.push(`Execution: toolchain ${tool.name}${tool.version ? ` ${tool.version}` : ''}`);
    }
  }

  return lines.slice(0, 5).join('\n');
}

function classifyMemoryDensity(selectedCount: number): 'low' | 'medium' | 'high' {
  if (selectedCount < 3) return 'low';
  if (selectedCount <= 6) return 'medium';
  return 'high';
}

const BRAINCLAW_WRITE_ACTIONS: AuditAction[] = ['create', 'update', 'delete', 'accept', 'reject', 'trust_change', 'promote_direct', 'rollback'];

function buildSessionMetrics(input: {
  cwd: string;
  sessionId?: string;
  sessionStartedAt?: string;
  agentName?: string;
  agentId?: string;
  activeClaimsCount: number;
  runtimeNotes: ReturnType<typeof listRuntimeNotes>;
}): SessionMetricsSummary | undefined {
  if (!input.sessionId || !input.sessionStartedAt || !input.agentName) {
    return undefined;
  }

  const sessionId = input.sessionId;
  const startedAtMs = Date.parse(input.sessionStartedAt);
  if (!Number.isFinite(startedAtMs)) {
    return undefined;
  }

  const runtimeWrites = input.runtimeNotes
    .filter((note) =>
      note.agent === input.agentName
      && note.session_id === sessionId
      && ((note.note_type ?? 'observation') === 'observation'))
    .map((note) => note.created_at);
  const auditWrites = readAuditLog({ since: input.sessionStartedAt, actor: input.agentId ?? input.agentName }, input.cwd)
    .filter((entry) => belongsToSession(entry, sessionId))
    .filter((entry) => BRAINCLAW_WRITE_ACTIONS.includes(entry.action))
    .map((entry) => entry.timestamp);
  const lastBrainclawWrite = [...runtimeWrites, ...auditWrites].sort().at(-1);
  const editsSinceLastMemory = countChangedFilesSince(input.cwd, lastBrainclawWrite ?? input.sessionStartedAt);

  return {
    active_claims: input.activeClaimsCount,
    edits_since_last_memory: editsSinceLastMemory,
    session_duration_minutes: Math.max(0, Math.floor((Date.now() - startedAtMs) / 60_000)),
    last_brainclaw_write: lastBrainclawWrite,
  };
}

function belongsToSession(entry: AuditEntry, sessionId: string): boolean {
  return !entry.session_id || entry.session_id === sessionId;
}

function countChangedFilesSince(cwd: string, since: string): number {
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs)) {
    return 0;
  }

  try {
    const output = execSync('git status --porcelain --untracked-files=normal', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!output) {
      return 0;
    }

    const changedPaths = new Set<string>();
    for (const line of output.split(/\r?\n/)) {
      const rawPath = line.slice(3).trim();
      const resolvedPath = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() ?? rawPath : rawPath;
      if (resolvedPath && shouldCountEditedPath(resolvedPath)) {
        changedPaths.add(resolvedPath);
      }
    }

    let count = 0;
    for (const relativePath of changedPaths) {
      const absolutePath = path.join(cwd, relativePath);
      try {
        if (!fs.existsSync(absolutePath)) {
          count++;
          continue;
        }
        if (fs.statSync(absolutePath).mtimeMs >= sinceMs) {
          count++;
        }
      } catch {
        count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

function shouldCountEditedPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  return !normalized.startsWith('.brainclaw/') && !normalized.startsWith('.git/');
}

function summariseAgentTooling(
  snapshot: AgentToolingSnapshot,
): Pick<AgentToolingSnapshot, 'agents_md_present' | 'agents_md_title' | 'agents_rules' | 'skills' | 'mcp_servers'> {
  return {
    agents_md_present: snapshot.agents_md_present,
    agents_md_title: snapshot.agents_md_title,
    agents_rules: snapshot.agents_rules.slice(0, 5),
    skills: snapshot.skills.slice(0, 5),
    mcp_servers: snapshot.mcp_servers.slice(0, 5),
  };
}

function formatSkillSummary(skill: AgentToolingSnapshot['skills'][number]): string {
  const markers: string[] = [];
  if (skill.scripts_present) markers.push('scripts');
  if (skill.references_present) markers.push('references');
  if (skill.assets_present) markers.push('assets');
  const suffix = markers.length > 0 ? ` [${markers.join(', ')}]` : '';
  return `${skill.name}${skill.description ? `: ${skill.description}` : ''}${suffix}`;
}

function formatMcpServerSummary(server: AgentToolingSnapshot['mcp_servers'][number]): string {
  const availability = server.availability === 'missing_command'
    ? 'missing-command'
    : server.availability;
  return `${server.name} (${server.transport}, ${availability})`;
}

function isExecutionSensitiveTarget(target: string): boolean {
  const terms = target.toLowerCase();
  return [
    'package.json',
    'makefile',
    'pyproject',
    'cargo',
    'go.mod',
    'docker',
    'workflow',
    'github',
    'git',
    'npm',
    'pnpm',
    'python',
    'shell',
    'env',
    'mcp',
    'skill',
    'agent',
    'build',
    'test',
    'lint',
  ].some((token) => terms.includes(token));
}

function tokenise(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9_\/-]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function normalizeContextTarget(target: string | undefined, requestedCwd: string, contextCwd: string): string {
  const trimmed = target?.trim() ?? '';
  if (!trimmed) {
    return '';
  }

  if (path.resolve(requestedCwd) === path.resolve(contextCwd)) {
    return trimmed;
  }

  if (!(path.isAbsolute(trimmed) || trimmed.includes('/') || trimmed.includes('\\') || trimmed.startsWith('.'))) {
    return trimmed;
  }

  const absoluteTarget = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(requestedCwd, trimmed);

  const relativeToContext = path.relative(contextCwd, absoluteTarget);
  if (relativeToContext.startsWith('..') || path.isAbsolute(relativeToContext)) {
    return trimmed;
  }

  return relativeToContext.split(path.sep).join('/');
}

function matchesPath(pattern: string, target: string): boolean {
  if (pattern === target) return true;
  const regexStr = '^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex chars but keep globs intact
    .replace(/\*\*/g, '__GLOBSTAR__')
    .replace(/\*/g, '__GLOB__')
    .replace(/__GLOBSTAR__/g, '.*')
    .replace(/__GLOB__/g, '[^/]*') + '$';
  return new RegExp(regexStr).test(target);
}

function summariseScopedItem(item: { id: string; text: string; created_at: string }): ScopedActivityItemSummary {
  return {
    id: item.id,
    text: item.text,
    age_hours: Math.max(0, Math.floor((Date.now() - Date.parse(item.created_at)) / 3_600_000)),
  };
}

function isRecent(createdAt: string, hours: number): boolean {
  return Date.now() - Date.parse(createdAt) <= hours * 3_600_000;
}

function matchesScopeTarget(
  item: { text: string; tags: string[]; related_paths?: string[]; project?: string },
  target: string,
  project?: string,
): boolean {
  if (project && item.project && item.project !== project) {
    return false;
  }

  if (item.related_paths && item.related_paths.length > 0) {
    return item.related_paths.some((pattern) => matchesPath(pattern, target));
  }

  const terms = scopeTerms(target);
  if (terms.length === 0) {
    return false;
  }
  const haystack = `${item.text.toLowerCase()} ${(item.tags ?? []).join(' ').toLowerCase()}`;
  return terms.some((term) => haystack.includes(term));
}

function scopeTerms(target: string): string[] {
  const direct = tokenise(target);
  const segments = target
    .split(/[\\/]/)
    .flatMap((segment) => tokenise(segment));
  return [...new Set([...direct, ...segments])];
}

function computeRelevance(item: ContextItem, terms: string[], profile: string, target: string): {
  score: number;
  reasons: string[];
} {
  let score = 1;
  const reasons: string[] = ['base memory signal'];

  // Path filtering logic
  if (item.related_paths && item.related_paths.length > 0 && target) {
    const isMatch = item.related_paths.some(p => matchesPath(p, target));
    if (isMatch) {
      score += 10; // High boost for direct spatial match
      reasons.push('path match');
    } else {
      return { score: -1, reasons: ['filtered out: path mismatch'] };
    }
  }

  // Profile weighting
  // Plans are always highest priority (actionable items)
  if (item.section === 'plan') {
    score += 4;
    reasons.push('execution boost');
  }
  // Open handoffs are second-highest (pending transitions)
  if (item.section === 'handoff') {
    score += 3;
    reasons.push('open handoff signal');
  }
  if (item.section === 'runtime') {
    score += 1;
    reasons.push('runtime execution signal');
  }
  if (profile === 'dense') {
    // Dense profile: boost all actionable sections equally for maximum coverage
    if (item.section === 'decision' || item.section === 'trap' || item.section === 'candidate' || item.section === 'runtime') {
      score += 2;
      reasons.push('profile boost: dense');
    }
  }
  if (profile === 'dev' && (item.section === 'decision' || item.section === 'trap')) {
    score += 2;
    reasons.push('profile boost: dev');
  }
  if (profile === 'openclaw' && (item.section === 'constraint' || item.section === 'handoff' || item.section === 'runtime')) {
    score += 2;
    reasons.push('profile boost: openclaw');
  }
  if (profile === 'ops' && (item.section === 'constraint' || item.section === 'trap')) {
    score += 2;
    reasons.push('profile boost: ops');
  }
  if (profile === 'research' && (item.section === 'decision' || item.section === 'candidate')) {
    score += 2;
    reasons.push('profile boost: research');
  }
  if (profile === 'compact' && item.section === 'plan' && (item.extra ?? '').includes('in_progress')) {
    score += 3;
    reasons.push('profile boost: compact');
  }
  if (profile === 'copilot' && item.section === 'constraint') {
    score += 3;
    reasons.push('profile boost: copilot');
  }
  if (profile === 'quick' && item.section === 'constraint') {
    score += 4;
    reasons.push('profile boost: quick');
  }

  if (item.section === 'candidate') {
    const starMatch = (item.extra ?? '').match(/stars:(\d+)/);
    const useMatch = (item.extra ?? '').match(/uses:(\d+)/);
    const stars = starMatch ? parseInt(starMatch[1], 10) : 0;
    const uses = useMatch ? parseInt(useMatch[1], 10) : 0;
    if (stars > 0) {
      score += Math.min(stars, 3);
      reasons.push(`adoption signal:${stars} star(s)`);
    }
    if (uses > 0) {
      score += Math.min(uses * 2, 4);
      reasons.push(`reuse signal:${uses} use(s)`);
    }
  }

  if (terms.length === 0) return { score, reasons };

  const text = item.text.toLowerCase();
  const tags = item.tags.map((t) => t.toLowerCase());
  const extra = (item.extra ?? '').toLowerCase();

  for (const term of terms) {
    if (text.includes(term)) {
      score += 3;
      reasons.push(`text match:${term}`);
    }
    if (tags.some((tag) => tag.includes(term))) {
      score += 2;
      reasons.push(`tag match:${term}`);
    }
    if (extra.includes(term)) {
      score += 1;
      reasons.push(`metadata match:${term}`);
    }
  }

  return { score, reasons: uniqueReasons(reasons) };
}

function uniqueReasons(reasons: string[]): string[] {
  return [...new Set(reasons)];
}

function estimateItemChars(item: ContextItem): number {
  const tagsLen = item.tags.join(', ').length;
  const reasonsLen = item.reasons.join(', ').length;
  const extraLen = item.extra?.length ?? 0;
  return item.text.length + tagsLen + reasonsLen + extraLen + 32;
}

function applyCharBudget(items: ContextItem[], maxChars: number): ContextItem[] {
  let used = 0;
  const selected: ContextItem[] = [];

  for (const item of items) {
    const itemChars = estimateItemChars(item);
    if (selected.length > 0 && used + itemChars > maxChars) {
      break;
    }

    selected.push(item);
    used += itemChars;
  }

  return selected;
}

// --- Claim conflict detection ---

function detectClaimConflicts(myClaims: Claim[], otherClaims: Claim[]): ClaimConflict[] | undefined {
  if (myClaims.length === 0 || otherClaims.length === 0) return undefined;

  const conflicts: ClaimConflict[] = [];
  for (const mine of myClaims) {
    for (const other of otherClaims) {
      if (isClaimExpired(other)) continue;
      const overlap = scopesOverlap(mine.scope, other.scope);
      if (overlap) {
        conflicts.push({
          my_claim_id: mine.id,
          my_scope: mine.scope,
          other_claim_id: other.id,
          other_agent: other.agent,
          other_scope: other.scope,
          overlap_reason: overlap,
        });
      }
    }
  }
  return conflicts.length > 0 ? conflicts : undefined;
}

function scopesOverlap(a: string, b: string): string | null {
  const aParts = a.replace(/\\/g, '/').split(/\s+/);
  const bParts = b.replace(/\\/g, '/').split(/\s+/);

  for (const ap of aParts) {
    for (const bp of bParts) {
      if (ap === bp) return `exact match: ${ap}`;
      if (ap.startsWith(bp + '/') || bp.startsWith(ap + '/')) return `path overlap: ${ap} ↔ ${bp}`;
    }
  }
  return null;
}

// --- Active project resolution ---

function findActiveProjectInChain(contextCwd: string, _storeChain: StoreRef[]): ActiveProject | undefined {
  // 1. Session-scoped active project (per-agent, highest priority)
  const session = loadCurrentSession(contextCwd);
  if (session?.active_project) {
    return {
      path: session.active_project.path,
      name: session.active_project.name,
      switched_at: session.active_project.switched_at,
      switched_by: session.agent,
      source: 'session',
    };
  }

  // 2. Global active-project.json (walk up from contextCwd)
  let dir = path.resolve(contextCwd);
  const root = path.parse(dir).root;
  const home = process.env.HOME || process.env.USERPROFILE || root;
  while (dir !== root && dir !== home) {
    const ap = loadActiveProject(dir);
    if (ap) return { ...ap, source: 'global' };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

// --- Workflow hints ---

function buildWorkflowHints(
  myClaims: Claim[],
  openWork: OpenWorkSummary | undefined,
  plans: PlanItem[],
): string[] | undefined {
  const hints: string[] = [];

  // No claims — suggest claiming before editing
  if (myClaims.length === 0) {
    const todoPlans = plans.filter((p) => p.status === 'todo' && p.priority === 'high');
    if (todoPlans.length > 0) {
      hints.push(`${todoPlans.length} high-priority plan(s) available — consider claiming one with bclaw_claim`);
    }
  }

  // Multiple unclosed claims — suggest releasing finished ones
  if (myClaims.length > 2) {
    hints.push(`You have ${myClaims.length} active claims — consider releasing finished ones with bclaw_release_claim`);
  }

  // In-progress plans without claims
  if (openWork) {
    const unclaimedInProgress = openWork.in_progress_plans.filter(
      (p) => !openWork.active_claims.some((c) => c.plan_id === p.id)
    );
    if (unclaimedInProgress.length > 0) {
      hints.push(`${unclaimedInProgress.length} in-progress plan(s) without a claim — consider claiming the scope you're editing`);
    }
  }

  return hints.length > 0 ? hints : undefined;
}
