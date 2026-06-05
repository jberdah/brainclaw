/**
 * Local dispatcher — claim-routed multi-instance coordination.
 *
 * ## Architecture (dec_39d59cab, Codex-reviewed)
 *
 * - **Agent type** = capability profile (what codex CAN do)
 * - **Claim** = routing key (exists before spawn, locks a scope)
 * - **Session** = observability metadata (adopted post-spawn)
 *
 * ## Dispatch pipeline
 *
 * 1. `analyzeSequence()` — categorize lanes, compute `agent_capacity` per agent
 * 2. `scoreAgents()` — 4-factor weighted scoring with capacity-aware utilization
 * 3. Claim-based capacity guard — agents stay in pool until claims >= max_concurrent_tasks
 * 4. `createCoordinatorClaim()` — scope lock is global (any active claim blocks)
 * 5. `sendMessage()` — inbox message with top-level `claim_id` for routing
 * 6. `attachAssignmentMessageToClaim()` — links claim → message for tracing
 * 7. `attemptExecution()` — spawn with `BRAINCLAW_CLAIM_ID` in env
 * 8. Instance calls `session_start` → adopts claim → filters inbox by `claim_id`
 *
 * ## Multi-instance support
 *
 * An agent type can run N parallel instances (max_concurrent_tasks in profile).
 * Each instance gets its own worktree, claim, and inbox messages. The dispatcher
 * scores by utilization (claims / max_tasks) and naturally load-balances across
 * agents and instances within a single dispatch cycle.
 *
 * ## Limits
 *
 * - Instruction files, hooks, MCP config remain per agent type (not per instance)
 * - Live companion refresh is global (last writer wins, deterministic)
 * - Copilot CLI is inbox/review-only (canBeSpawnedCli=false)
 *
 * @module
 */
import { buildClaimEnvPrefix } from './execution-profile.js';
import { getActiveSequence } from './sequence.js';
import { loadState, persistState } from './state.js';
import { listClaims, createCoordinatorClaim, attachAssignmentMessageToClaim, linkClaimToAssignment, assessClaimLiveness, type ClaimLivenessStatus } from './claims.js';
import { listAgentIdentities, ensureAgentRegisteredForDispatch } from './agent-registry.js';
import { sendMessage, hasActiveAssignment, type SendMessageInput } from './messaging.js';
import { memoryDir } from './io.js';
import { loadVersionedJsonFile } from './migration.js';
import fs from 'node:fs';
import path from 'node:path';
import { buildInvokeCommand, resolveBriefMode, getCapabilityProfile, resolveConcurrencyLimit, resolveResourceKey, resolveModel, serializeConcurrencyLimit, type BriefMode, type InvokeCommand } from './agent-capability.js';
import { getRuntimeSignalPath } from './runtime-signals.js';
import { attemptExecution, checkActiveInstance } from './execution.js';
import { createAssignment, transitionAssignment, generateAssignmentId, patchAssignmentMessageId } from './assignments.js';
import { createAgentRun, transitionAgentRun } from './agentruns.js';
import * as loopsModule from './loops/index.js';
import { sweepAssignments } from './assignment-sweeper.js';
import { InboxMessageSchema, type InboxMessage, type Sequence, type SequenceItem, type PlanItem, type Handoff, type Claim } from './schema.js';
import { generateId, nowISO } from './ids.js';
import { applyHandoffUpdates } from '../commands/update-handoff.js';

// ── Types ───────────────────────────────────────────────────

export interface ReadyLane {
  /** The sequence item that is ready */
  item: SequenceItem;
  /** The resolved plan */
  plan: PlanItem;
  /** Lane name (if any) */
  lane?: string;
  /** Why it's ready */
  reason: string;
}

export interface BlockedLane {
  item: SequenceItem;
  plan?: PlanItem;
  lane?: string;
  reason: string;
  /** Plan IDs that are blocking this lane */
  blocked_by: string[];
}

export interface ActiveLane {
  item: SequenceItem;
  plan: PlanItem;
  lane?: string;
  claim: Claim;
  agent: string;
  /** Session-aware liveness of the active claim — pln#388 stp_aa095668. */
  liveness?: ClaimLivenessStatus;
}

/** Per-agent capacity summary for multi-instance dispatch. */
export interface AgentCapacityEntry {
  agent: string;
  /** Number of active claims this agent has in the current sequence */
  active_claims: number;
  /** Resolved concurrency limit (pln#520 step 3). `null` = unlimited (no arbitrary cap). */
  max_tasks: number | null;
  /** Remaining slots: `max_tasks - active_claims`, or `null` when unlimited. */
  slots_remaining: number | null;
}

export interface DispatchAnalysis {
  sequence: Sequence;
  ready: ReadyLane[];
  active: ActiveLane[];
  blocked: BlockedLane[];
  done: SequenceItem[];
  /** Agents with remaining capacity for dispatch (slots_remaining > 0) */
  available_agents: string[];
  /** Full capacity breakdown per registered agent */
  agent_capacity: AgentCapacityEntry[];
}

export interface DispatchedItem {
  agent: string;
  plan_id: string;
  message_id: string;
  lane?: string;
  /** How the assignment was delivered */
  channel: 'inbox' | 'spawned_cli';
  claim_id?: string;
  /** Assignment ID from the Agent SDK runtime protocol */
  assignment_id?: string;
  /** E2E execution status */
  execution_status?: 'delivered_and_started' | 'command_ready_manual' | 'inbox_only';
  /** PID of spawned agent process (when execution_status is delivered_and_started) */
  pid?: number;
}

export interface DispatchResult {
  delivery_plan: DispatchedItem[];
  messages_sent: DispatchedItem[];
  commands: Array<{
    agent: string;
    lane?: string;
    command: string;
    shell: string;
  }>;
  skipped: Array<{
    plan_id: string;
    reason: string;
  }>;
  warnings: string[];
}

const MAX_INLINE_BRIEF_LENGTH = 4000;

/**
 * Build a cross-platform env prefix for BRAINCLAW_CLAIM_ID. Delegates to
 * the centralised buildClaimEnvPrefix in src/core/execution-profile.ts
 * (pln#496 step stp_a9afe59d) which speaks all five shells. The prior
 * Windows/POSIX-only branch lives there now as a hard-detected default.
 */
function buildEnvPrefix(claimId: string): string {
  return buildClaimEnvPrefix(claimId);
}

// ── Lane Analysis ───────────────────────────────────────────

/**
 * Analyze the active sequence and categorize each item as ready, active, blocked, or done.
 */
export function analyzeSequence(cwd: string): DispatchAnalysis | null {
  const sequence = getActiveSequence(cwd);
  if (!sequence) return null;

  const state = loadState(cwd);
  const claims = listClaims(cwd).filter(c => c.status === 'active');
  const agents = listAgentIdentities(cwd);

  // Index plans by ID for fast lookup
  const planIndex = new Map<string, PlanItem>();
  for (const p of state.plan_items) {
    planIndex.set(p.id, p);
    if (p.short_label) planIndex.set(p.short_label, p);
  }

  // Collect plan IDs that are done or dropped (terminal states)
  const terminalPlanIds = new Set<string>();
  for (const p of state.plan_items) {
    if (p.status === 'done' || p.status === 'dropped') {
      terminalPlanIds.add(p.id);
    }
  }

  // Collect plan IDs with active claims
  const claimedPlanIds = new Map<string, Claim>();
  for (const c of claims) {
    if (c.plan_id) claimedPlanIds.set(c.plan_id, c);
  }

  // Count ALL active claims per agent in the project (not just sequence-scoped).
  // An agent working on a claim outside the current sequence still has reduced capacity.
  const agentClaimCounts = new Map<string, number>();
  for (const c of claims) {
    agentClaimCounts.set(c.agent, (agentClaimCounts.get(c.agent) ?? 0) + 1);
  }

  const ready: ReadyLane[] = [];
  const active: ActiveLane[] = [];
  const blocked: BlockedLane[] = [];
  const done: SequenceItem[] = [];

  for (const item of sequence.items) {
    const plan = planIndex.get(item.planId);

    // Plan is done
    if (plan && (plan.status === 'done' || plan.status === 'dropped')) {
      done.push(item);
      continue;
    }

    // Plan has active claim — someone is working on it
    const activeClaim = claimedPlanIds.get(item.planId);
    if (activeClaim && plan) {
      active.push({
        item,
        plan,
        lane: item.lane,
        claim: activeClaim,
        agent: activeClaim.agent,
        liveness: assessClaimLiveness(activeClaim, { cwd }).status,
      });
      continue;
    }

    // Check hard dependencies
    const unmetHard = item.hard_after.filter(dep => !terminalPlanIds.has(dep));
    if (unmetHard.length > 0) {
      blocked.push({
        item,
        plan,
        lane: item.lane,
        reason: `Waiting on hard dependencies: ${unmetHard.join(', ')}`,
        blocked_by: unmetHard,
      });
      continue;
    }

    // Check soft dependencies (advisory — don't block, just note)
    const unmetSoft = item.soft_after.filter(dep => !terminalPlanIds.has(dep));
    const softNote = unmetSoft.length > 0
      ? ` (soft deps not yet done: ${unmetSoft.join(', ')})`
      : '';

    if (!plan) {
      blocked.push({
        item,
        plan: undefined,
        lane: item.lane,
        reason: `Plan ${item.planId} not found`,
        blocked_by: [],
      });
      continue;
    }

    ready.push({
      item,
      plan,
      lane: item.lane,
      reason: `All hard dependencies met${softNote}`,
    });
  }

  // Build capacity summary per agent (multi-instance aware)
  const allAgentNames = agents
    .filter(a => a.kind !== 'human')
    .map(a => a.agent_name);

  const agent_capacity: AgentCapacityEntry[] = allAgentNames.map(agent => {
    const active_claims = agentClaimCounts.get(agent) ?? 0;
    // pln#520 step 3: limit is resolved (default unlimited for parallelizable
    // CLI agents), not the per-name structural constant.
    const limit = resolveConcurrencyLimit(agent);
    const slots = Number.isFinite(limit) ? Math.max(0, limit - active_claims) : Infinity;
    return {
      agent,
      active_claims,
      max_tasks: serializeConcurrencyLimit(limit),
      slots_remaining: serializeConcurrencyLimit(slots),
    };
  });

  // Available agents: unlimited (null) or with remaining capacity (> 0).
  const available_agents = agent_capacity
    .filter(a => a.slots_remaining === null || a.slots_remaining > 0)
    .map(a => a.agent);

  return { sequence, ready, active, blocked, done, available_agents, agent_capacity };
}

// ── Brief Generation ────────────────────────────────────────

/**
 * Protocol + Available tools section, shared between generateBrief (plan-based)
 * and generateDispatchBrief (task-based / coordinate).
 *
 * Only emitted for 'full' briefMode — agents in 'compact' or 'task_card' mode
 * either lack MCP access entirely (nanoclaw / nemoclaw / zeroclaw) or are
 * IDE-only (Cursor / Windsurf / Roo) where the human pastes the task. Both
 * cases ignore the protocol-side instructions, so emitting them is noise.
 *
 * pln#496 Phase 1.b note: codex and mistral-vibe USED TO get 'compact'
 * because they are task-based, but they also have hasMcp=true, so the
 * Protocol section IS useful to them — `resolveBriefMode` was updated to
 * return 'full' for that combination.
 */
/**
 * pln#520 step 5 — the liveness section of a generated brief. An imperative
 * "do this first" instruction telling the worker to write its `work_loop_reached`
 * heartbeat to an ABSOLUTE, writable signals path BEFORE any other action, then
 * refresh it periodically. Zero-MCP (a plain shell redirect) so even sandboxed
 * agents without the brainclaw MCP can comply. Completion is recorded
 * mechanically by the spawn wrapper (step 4), so the agent only owns the
 * heartbeat. This is the worker-side half of the liveness contract whose
 * engine-side floor is the wrapper + reconciler (steps 4 + 1).
 */
export function buildLivenessSection(cwd: string, assignmentId: string): string {
  const hbPath = getRuntimeSignalPath(cwd, assignmentId, 'heartbeat');
  const isWin = process.platform === 'win32';
  const writeCmd = isWin
    ? `echo work_loop_reached ${assignmentId} > "${hbPath}"`
    : `printf 'work_loop_reached ${assignmentId} %s' "$(date +%s)" > "${hbPath}"`;
  return [
    '## Liveness — DO THIS FIRST (step 0)',
    'Before ANY other action, prove you reached your work loop by writing a heartbeat,',
    'then refresh it every few minutes while you work. brainclaw uses this to tell',
    '"alive and working" from "spawned but dead" — a missing/stale heartbeat marks the',
    'run stalled. Completion is recorded automatically by the spawn wrapper; you do NOT',
    'need to write a completed/failed signal.',
    '',
    '```sh',
    writeCmd,
    '```',
    `Heartbeat file (absolute, writable): ${hbPath}`,
    '',
  ].join('\n');
}

export function buildProtocolSection(options?: { claimId?: string; worktreePath?: string; assignmentId?: string }): string {
  const parts: string[] = [];

  parts.push('## Protocol');
  if (options?.claimId) {
    parts.push(`Your scope has been pre-claimed by the coordinator (claim: ${options.claimId}).`);
  }
  if (options?.assignmentId) {
    parts.push(`Assignment: ${options.assignmentId}`);
  }
  if (options?.worktreePath) {
    parts.push(`Worktree: ${options.worktreePath}`);
    // pln#523: tell the worker how dependencies are provisioned so it does not
    // stall trying to install them. node_modules (and per-package node_modules in
    // monorepos) are junction-linked from the main repo — run builds/typecheck
    // directly. If they are missing, do NOT `npm install` in the worktree: check
    // `.brainclaw-worktree.json` → `symlink_warnings` (a link may have failed,
    // e.g. cross-volume) and validate the build centrally with the coordinator.
    parts.push('Dependencies: node_modules is linked from the main repo (incl. monorepo per-package). Build/typecheck directly; if deps are missing, do NOT npm install here — see .brainclaw-worktree.json symlink_warnings and validate centrally.');
  }
  parts.push('');

  // Assignment lifecycle protocol (Agent SDK)
  if (options?.assignmentId) {
    parts.push(`1. Call bclaw_assignment_update(assignment_id: "${options.assignmentId}", status: "accepted")`);
    if (options.worktreePath) {
      parts.push(`2. cd into the worktree: ${options.worktreePath}`);
    }
    parts.push(`${options.worktreePath ? '3' : '2'}. Call bclaw_assignment_update(assignment_id: "${options.assignmentId}", status: "started")`);
    parts.push(`${options.worktreePath ? '4' : '3'}. Work on the assigned scope`);
    parts.push(`${options.worktreePath ? '5' : '4'}. Periodically call bclaw_assignment_update(status: "progress", message: "...") as heartbeat`);
    parts.push(`${options.worktreePath ? '6' : '5'}. When done: bclaw_assignment_update(status: "completed", artifacts: [...])`);
    const claimRef = options?.claimId ? `id: "${options.claimId}"` : 'id: "<claim_id>"';
    parts.push(`${options.worktreePath ? '7' : '6'}. Release the claim: bclaw_release_claim(${claimRef}, planStatus: "done") — required for hard_after gating to unblock downstream tasks`);
    parts.push(`${options.worktreePath ? '8' : '7'}. If blocked: bclaw_assignment_update(status: "blocked", blocker: "...")`);
    parts.push(`${options.worktreePath ? '9' : '8'}. If failed: bclaw_assignment_update(status: "failed", error_message: "...")`);
    // pln#526: standard fallback channel — works even when MCP is unreachable
    // (sandboxed agents). The coordinator ingests it with `brainclaw harvest`.
    parts.push(`Final fallback (if bclaw_assignment_update / MCP is unavailable, e.g. a sandboxed agent): write LANE-RESULT.json at the worktree root — {"assignment_id":"${options.assignmentId}","status":"completed|blocked|failed","summary":"<what you did>","files_changed":["..."],"artifacts":["..."]}. The coordinator harvests it via \`brainclaw harvest ${options.assignmentId}\`.`);
  } else if (options?.claimId) {
    parts.push('1. Call bclaw_session_start to register your session');
    if (options.worktreePath) {
      parts.push(`2. cd into the worktree: ${options.worktreePath}`);
    }
    parts.push(`${options.worktreePath ? '3' : '2'}. Work on the assigned scope (claim already active)`);
    parts.push(`${options.worktreePath ? '4' : '3'}. Release the claim: bclaw_release_claim(id: "${options.claimId}", planStatus: "done") — required for hard_after gating to unblock downstream tasks`);
    parts.push(`${options.worktreePath ? '5' : '4'}. Call bclaw_session_end with a narrative when done`);
  } else {
    parts.push('1. Call bclaw_session_start to register your session');
    parts.push('2. Call bclaw_claim to claim the scope before editing');
    parts.push('3. Work in the worktree created by the claim');
    parts.push('4. Release the claim when done: bclaw_release_claim(id: "clm_xxx", planStatus: "done") — required for hard_after sequence gating to unlock the next step');
    parts.push('5. Call bclaw_session_end with a narrative when done');
  }
  parts.push('');

  parts.push('## Available tools');
  if (options?.assignmentId) {
    parts.push('- bclaw_assignment_update (report lifecycle: accepted/started/progress/completed/failed/blocked)');
  }
  parts.push('- bclaw_session_start, bclaw_session_end (session lifecycle)');
  if (!options?.claimId) {
    parts.push('- bclaw_claim, bclaw_release_claim (scope ownership)');
  }
  parts.push('- bclaw_context(kind: "memory") — or bclaw_work(intent: "consult") for the facade shape (project memory)');
  parts.push('- bclaw_find/get/create/update/transition — canonical CRUD on any brainclaw entity');
  parts.push('- bclaw_write_note, bclaw_quick_capture (capture decisions/traps)');
  parts.push('');

  return parts.join('\n');
}

/**
 * Generate a dispatch brief for an agent about to work on a plan.
 * The brief content adapts to the agent's capabilities via briefMode:
 * - 'full': complete brief with Protocol + Available tools (MCP-capable agents)
 * - 'compact': task + steps + constraints only (sandboxed agents like Codex)
 * - 'task_card': ultra-short human-readable card (IDE-only agents)
 */
export function generateBrief(
  plan: PlanItem,
  item: SequenceItem,
  cwd: string,
  briefMode?: BriefMode,
  options?: { claimId?: string; worktreePath?: string; assignmentId?: string; agent?: string },
): string {
  const mode = briefMode ?? 'full';

  // ── task_card: ultra-short for IDE agents ──────────────────
  // Includes claim_id and worktree_path so inbox-only agents (e.g. Copilot)
  // can see the pre-created artifacts even without the full protocol section.
  if (mode === 'task_card') {
    const parts: string[] = [];
    parts.push(`Task: ${plan.text}`);
    parts.push(`Plan: ${plan.id}${plan.short_label ? ` (${plan.short_label})` : ''}`);
    parts.push(`Priority: ${plan.priority}`);
    if (item.lane) parts.push(`Lane: ${item.lane}`);
    if (item.scope_hint) parts.push(`Scope: ${item.scope_hint}`);
    if (options?.claimId) parts.push(`Claim: ${options.claimId} (pre-claimed by coordinator)`);
    if (options?.worktreePath) parts.push(`Worktree: ${options.worktreePath}`);
    if (plan.steps?.length) {
      parts.push('');
      for (const step of plan.steps) {
        const check = step.status === 'done' ? '[x]' : '[ ]';
        parts.push(`${check} ${step.text}`);
      }
    }
    return parts.join('\n');
  }

  const state = loadState(cwd);

  // Find relevant handoffs (previous work on this plan or related plans)
  const planHandoffs = state.open_handoffs
    .filter(h => h.plan_id === plan.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  // Find handoffs from hard_after plans (prior lane context)
  const depHandoffs = state.open_handoffs
    .filter(h => h.plan_id && item.hard_after.includes(h.plan_id))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  const parts: string[] = [];

  // Header
  parts.push(`# Assignment: ${plan.text}`);
  parts.push('');
  parts.push(`Plan: ${plan.id}${plan.short_label ? ` (${plan.short_label})` : ''}`);
  parts.push(`Priority: ${plan.priority}`);
  if (plan.assignee) parts.push(`Assignee: ${plan.assignee}`);
  if (item.lane) parts.push(`Lane: ${item.lane}`);
  if (plan.tags?.length) parts.push(`Tags: ${plan.tags.join(', ')}`);
  if (plan.estimated_effort) parts.push(`Estimated effort: ${plan.estimated_effort} minutes`);
  parts.push('');

  // pln#520 step 5 — liveness heartbeat instruction, first actionable block so
  // the worker writes work_loop_reached before anything else. Only when an
  // assignment id is known (the heartbeat is keyed by it).
  if (options?.assignmentId) {
    parts.push(buildLivenessSection(cwd, options.assignmentId));
  }

  // Steps if any
  if (plan.steps?.length) {
    parts.push('## Steps');
    for (const step of plan.steps) {
      const check = step.status === 'done' ? '[x]' : '[ ]';
      parts.push(`- ${check} ${step.text}`);
    }
    parts.push('');
  }

  // Rationale from sequence
  if (item.rationale) {
    parts.push(`## Rationale`);
    parts.push(item.rationale);
    parts.push('');
  }

  // Scope hint
  if (item.scope_hint) {
    parts.push(`## Scope hint`);
    parts.push(item.scope_hint);
    parts.push('');
  }

  // Prior handoffs on this plan (compact: shorter excerpts)
  const handoffSliceLen = mode === 'compact' ? 200 : 500;
  if (planHandoffs.length > 0) {
    parts.push('## Prior work on this plan');
    for (const h of planHandoffs.slice(0, mode === 'compact' ? 1 : 3)) {
      parts.push(`### Handoff from ${h.from} (${h.status})`);
      if (h.narrative) parts.push(h.narrative.slice(0, handoffSliceLen));
      else parts.push(h.text.slice(0, handoffSliceLen));
      parts.push('');
    }
  }

  // Context from dependency handoffs
  if (depHandoffs.length > 0) {
    parts.push('## Context from completed dependencies');
    for (const h of depHandoffs.slice(0, mode === 'compact' ? 1 : 3)) {
      parts.push(`### ${h.from} on ${h.plan_id}`);
      if (h.narrative) parts.push(h.narrative.slice(0, handoffSliceLen));
      else parts.push(h.text.slice(0, handoffSliceLen));
      parts.push('');
    }
  }

  // Protocol and Available tools — only for 'full' mode.
  // Compact mode is now reserved for task-based agents WITHOUT MCP access
  // (nanoclaw / nemoclaw / zeroclaw). Codex and Mistral Vibe — both
  // task-based with MCP — receive the full Protocol section since
  // pln#496 Phase 1.b, so they actually call
  // bclaw_assignment_update(status: 'completed') at end and the loop
  // converges. See agent-capability.ts:resolveBriefMode for the rule.
  if (mode === 'full') {
    parts.push(buildProtocolSection(options));
  }

  // Codex-specific constraints: focus and speed guidance for sandboxed runs.
  // Gated on agent identity (not brief mode) so future non-codex compact consumers
  // don't inherit sandbox-specific wording. (Codex review cnd#561)
  if (options?.agent === 'codex') {
    parts.push('## Constraints');
    parts.push('- Focus on specified files only — do not explore the broader codebase');
    parts.push('- Produce output quickly; if blocked, capture as trap candidate and move on');
    parts.push('- Sandbox blocks MCP writes: use filesystem writes for candidates, coordinator harvests');
    parts.push('');
  }

  return parts.join('\n');
}

/**
 * Generate a dispatch brief from a raw task description (no plan/sequence required).
 * Used by bclaw_coordinate and other callers that don't have a full PlanItem.
 *
 * This is the canonical brief generator for task-based dispatch — it produces
 * the same protocol section as generateBrief() but accepts a plain task string.
 */
export interface DispatchBriefOptions {
  /** The task description */
  task: string;
  /** Target agent name (determines brief mode) */
  agent: string;
  /** Pre-created claim ID */
  claimId?: string;
  /** Pre-created assignment ID for Agent SDK runtime protocol. */
  assignmentId?: string;
  /** Scope string */
  scope?: string;
  /** Pre-created worktree path */
  worktreePath?: string;
}

export function generateDispatchBrief(options: DispatchBriefOptions): string {
  const briefMode = resolveBriefMode(options.agent);
  const parts: string[] = [];

  parts.push(`# Assignment: ${options.task}`);
  parts.push('');
  if (options.scope) parts.push(`Scope: ${options.scope}`);
  if (options.claimId) parts.push(`Claim: ${options.claimId} (pre-claimed by coordinator)`);
  if (options.worktreePath) parts.push(`Worktree: ${options.worktreePath}`);
  parts.push('');

  if (briefMode === 'full') {
    parts.push(buildProtocolSection({
      claimId: options.claimId,
      worktreePath: options.worktreePath,
      assignmentId: options.assignmentId,
    }));
  }

  // Codex-specific constraints: focus and speed guidance for sandboxed runs
  if (options.agent === 'codex') {
    parts.push('## Constraints');
    parts.push('- Focus on specified files only — do not explore the broader codebase');
    parts.push('- Produce output quickly; if blocked, capture as trap candidate and move on');
    parts.push('- Sandbox blocks MCP writes: use filesystem writes for candidates, coordinator harvests');
    parts.push('');
  }

  return parts.join('\n');
}

// ── Agent Scoring ──────────────────────────────────────────

/**
 * 4-factor weighted scoring for agent selection (ported from cloud dispatcher).
 *
 * Factors:
 *   1. **Preference** (weight 40): Is the agent the plan's explicit assignee?
 *   2. **Capability** (weight 30): Does the agent's role_capabilities include 'execute'?
 *   3. **Availability** (weight 20): Is the agent in the available pool (no active claims)?
 *   4. **Load balance** (weight 10): Fewer active claims = higher score.
 *
 * Returns agents sorted by score (highest first). Agents not in the pool are excluded.
 */
export interface AgentScore {
  agent: string;
  score: number;
  factors: {
    preference: number;
    capability: number;
    availability: number;
    load_balance: number;
  };
}

export function scoreAgents(
  agentPool: string[],
  plan: PlanItem,
  activeClaims: Claim[],
  cycleAssignments?: Map<string, number>,
): AgentScore[] {
  const W_PREFERENCE = 40;
  const W_CAPABILITY = 30;
  const W_AVAILABILITY = 20;
  const W_LOAD_BALANCE = 10;

  // Count active claims per agent for load balancing
  const claimCounts = new Map<string, number>();
  for (const claim of activeClaims) {
    claimCounts.set(claim.agent, (claimCounts.get(claim.agent) ?? 0) + 1);
  }
  const maxClaims = Math.max(1, ...claimCounts.values());

  return agentPool.map(agent => {
    // Factor 1: Preference — is this the plan's assignee?
    const preference = (plan.assignee === agent) ? 1.0 : 0.0;

    // Factor 2: Capability — can this agent execute tasks?
    const profile = getCapabilityProfile(agent);
    const canExecute = profile?.role_capabilities.includes('execute') ?? false;
    const canSpawn = profile?.runtime.canBeSpawnedCli ?? false;
    const capability = canExecute ? (canSpawn ? 1.0 : 0.5) : 0.1;

    // Factor 3 & 4: Availability + load balance.
    // pln#520 step 3: these are based on the agent's RAW load (active claims +
    // in-cycle assignments), decoupled from any concurrency cap. Dividing by the
    // cap (as before) made every agent look identically idle once concurrency
    // went unlimited, collapsing load-balancing — work piled onto the single
    // top-scored agent. A cap-independent load fraction keeps spreading work to
    // the least-busy agent whether or not a cap is set. The hard cap is enforced
    // separately by the capacity guard in the dispatch loop.
    const agentClaims = (claimCounts.get(agent) ?? 0) + (cycleAssignments?.get(agent) ?? 0);
    const loadFraction = agentClaims / (agentClaims + 1); // 0 when idle, →1 as load grows
    const availability = 1.0 - loadFraction * 0.5; // range (0.5, 1.0]
    const load_balance = 1.0 - loadFraction;       // range (0, 1]

    const score =
      preference * W_PREFERENCE +
      capability * W_CAPABILITY +
      availability * W_AVAILABILITY +
      load_balance * W_LOAD_BALANCE;

    return { agent, score, factors: { preference, capability, availability, load_balance } };
  }).sort((a, b) => b.score - a.score);
}

// Re-export checkActiveInstance for consumers who import from dispatcher
export { checkActiveInstance, type ActiveInstanceCheck } from './execution.js';

// ── Dispatch ──────────────────────────────────────────────

export interface DispatchOptions {
  /** Only dispatch to specific agents */
  agents?: string[];
  /** Only dispatch items in specific lanes */
  lanes?: string[];
  /** Max assignments to make in one dispatch (default: all ready) */
  maxAssignments?: number;
  /** Dry run — analyze but don't send messages */
  dryRun?: boolean;
  /** Dispatcher agent identity */
  dispatcherAgent: string;
  dispatcherAgentId?: string;
  sessionId?: string;
  /** Attempt to spawn agents after delivery (default: true). When false, always return command_ready_manual. */
  autoExecute?: boolean;
  /** Test/ops override for assignment startup acknowledgement. */
  handshakeTimeoutMs?: number;
  /**
   * pln#520 step 3 — opt-in concurrency cap, enforced per host-binary resource
   * (not per agent identity). Omitted → unlimited for parallelizable CLI agents.
   */
  maxConcurrency?: number;
  /**
   * pln#520 step 3 — model override, decoupled from agent identity. Injected
   * into the invoke command for agents that declare a `model_flag` (e.g.
   * `claude-code --model sonnet`). Highest-priority link in the model chain.
   */
  model?: string;
}

/**
 * pln#520 step 3 — sum in-cycle assignments across every agent identity that
 * shares the same host-binary resource (e.g. claude-code + claude-sonnet both
 * map to `claude`). Pairs with `resolveResourceKey` so a concurrency cap pools
 * by binary, not by agent name.
 */
function countCycleByResource(cycleAssignments: Map<string, number>, resourceKey: string): number {
  let total = 0;
  for (const [agent, count] of cycleAssignments) {
    if (resolveResourceKey(agent) === resourceKey) total += count;
  }
  return total;
}

export interface WorktreeBaseSelection {
  baseRef?: string;
  resetExistingBranch?: boolean;
  reason?: string;
}

export function selectWorktreeBaseForReadyLane(
  item: SequenceItem,
  analysis: DispatchAnalysis,
): WorktreeBaseSelection {
  const hardAfter = item.hard_after ?? [];
  if (hardAfter.length === 0) return {};

  const donePlanIds = new Set(analysis.done.map((entry) => entry.planId));
  const allHardDepsDone = hardAfter.every((planId) => donePlanIds.has(planId));
  if (!allHardDepsDone) return {};

  return {
    baseRef: 'HEAD',
    resetExistingBranch: true,
    reason: `hard_after dependencies already integrated: ${hardAfter.join(', ')}`,
  };
}

/**
 * Run a dispatch cycle: analyze the sequence, generate briefs, send assignments.
 */
export async function dispatch(options: DispatchOptions, cwd: string): Promise<{ analysis: DispatchAnalysis; result: DispatchResult } | null> {
  // Run assignment sweeper before dispatch to detect stuck/expired work
  try { sweepAssignments(cwd, { actor: options.dispatcherAgent }); } catch { /* best-effort */ }

  const analysis = analyzeSequence(cwd);
  if (!analysis) return null;

  const result: DispatchResult = { delivery_plan: [], messages_sent: [], commands: [], skipped: [], warnings: [] };

  // Filter ready lanes
  let readyToAssign = analysis.ready;

  if (options.lanes?.length) {
    readyToAssign = readyToAssign.filter(r => r.lane && options.lanes!.includes(r.lane));
  }

  // Match ready items to available agents
  // Normalize: options.agents may arrive as a single string from some MCP clients
  const rawAgents = options.agents;
  const normalizedAgents = rawAgents
    ? (Array.isArray(rawAgents) ? rawAgents : [rawAgents]) as string[]
    : undefined;
  const agentPool = normalizedAgents?.length
    ? [...normalizedAgents]
    : [...analysis.available_agents];

  // Collect all active claims for scoring
  const allActiveClaims = listClaims(cwd).filter(c => c.status === 'active');

  const max = options.maxAssignments ?? readyToAssign.length;
  let assigned = 0;
  // Track assignments per agent in this dispatch cycle (for multi-slot capacity)
  const cycleAssignments = new Map<string, number>();
  // Track invoke commands + worktree paths for E2E execution phase
  const preparedEntries: Array<{ deliveryEntry: DispatchedItem; invokeCmd: InvokeCommand | undefined; worktreePath?: string }> = [];

  for (const readyItem of readyToAssign) {
    if (assigned >= max) break;

    // Pick agent using 4-factor scoring — iterate through ranked agents
    // to find the first one that passes all guards (idempotency + active instance).
    const scored = scoreAgents(agentPool, readyItem.plan, allActiveClaims, cycleAssignments);
    let targetAgent: string | undefined;

    for (const candidate of scored) {
      // Idempotency: skip if there's already a non-archived assign for this plan+agent
      // BUT allow re-dispatch if the linked claim has been released (stale assignment)
      if (!options.dryRun && hasActiveAssignment(candidate.agent, readyItem.plan.id, cwd)) {
        const hasClaim = allActiveClaims.some(c => c.agent === candidate.agent && c.plan_id === readyItem.plan.id);
        if (hasClaim) continue; // truly active — skip
        // Claim released but message not archived: stale assignment, allow re-dispatch
      }

      // Claim-based capacity guard (pln#520 step 3): count usage per host-binary
      // resource (claude-code + claude-sonnet share `claude`), compare against the
      // resolved limit (default unlimited — no arbitrary per-identity throttle).
      // This is the authoritative capacity check — covers both options.agents and
      // analysis.available_agents paths.
      const resourceKey = resolveResourceKey(candidate.agent);
      const existingClaims = allActiveClaims.filter(c => resolveResourceKey(c.agent) === resourceKey).length;
      const inCycleCount = countCycleByResource(cycleAssignments, resourceKey);
      const limit = resolveConcurrencyLimit(candidate.agent, { override: options.maxConcurrency });
      if (existingClaims + inCycleCount >= limit) {
        result.warnings.push(`${candidate.agent}: at capacity (${existingClaims + inCycleCount}/${limit} ${resourceKey} slots)`);
        continue; // try next agent
      }

      targetAgent = candidate.agent;
      break;
    }

    if (!targetAgent) {
      result.skipped.push({
        plan_id: readyItem.plan.id,
        reason: scored.length === 0
          ? 'No available agent'
          : `All ${scored.length} candidate(s) rejected by guards (active session or existing assignment)`,
      });
      continue;
    }

    // Ensure target agent is registered before creating claims/messages
    ensureAgentRegisteredForDispatch(targetAgent, cwd);

    // Coordinator-owned claim: create before sending the brief (with worktree isolation)
    const claimScope = readyItem.item.scope_hint ?? readyItem.plan.id;
    let claimId = '(dry-run)';
    let worktreePath: string | undefined;
    if (!options.dryRun) {
      const worktreeBase = selectWorktreeBaseForReadyLane(readyItem.item, analysis);
      const claimResult = createCoordinatorClaim({
        agent: targetAgent,
        scope: claimScope,
        description: readyItem.plan.text,
        planId: readyItem.plan.id,
        dispatcherAgent: options.dispatcherAgent,
        sessionId: options.sessionId,
        cwd,
        worktreeBaseRef: worktreeBase.baseRef,
        resetExistingWorktreeBranch: worktreeBase.resetExistingBranch,
      });
      // Scope conflict: a different agent holds this scope — skip this plan
      if (claimResult.scopeConflict) {
        result.skipped.push({
          plan_id: readyItem.plan.id,
          reason: `Scope '${claimScope}' is locked by ${claimResult.conflictAgent} (claim ${claimResult.claimId})`,
        });
        continue;
      }
      claimId = claimResult.claimId;
      worktreePath = claimResult.worktreePath;
      if (claimResult.worktreeWarning) {
        result.warnings.push(`${targetAgent}/${claimScope}: ${claimResult.worktreeWarning}`);
      }
    }

    // --- Dry-run path: skip assignment creation and message sending ---
    if (options.dryRun) {
      const briefMode = resolveBriefMode(targetAgent);
      const brief = generateBrief(readyItem.plan, readyItem.item, cwd, briefMode, { claimId, worktreePath });
      const invokeCmd = buildInvokeCommand(targetAgent, brief, { model: resolveModel(targetAgent, { override: options.model }) });
      if (invokeCmd) {
        const cmdPrefix = buildEnvPrefix(claimId);
        result.commands.push({ agent: targetAgent, lane: readyItem.lane, command: `${cmdPrefix}${invokeCmd.bashCommand}`, shell: process.platform === 'win32' ? 'cmd' : (invokeCmd.shell ? 'bash' : 'sh') });
      }
      const deliveryEntry: DispatchedItem = { agent: targetAgent, plan_id: readyItem.plan.id, message_id: '(dry-run)', lane: readyItem.lane, channel: 'inbox', claim_id: claimId };
      result.delivery_plan.push(deliveryEntry);
      result.messages_sent.push(deliveryEntry);
      assigned++;
      cycleAssignments.set(targetAgent, (cycleAssignments.get(targetAgent) ?? 0) + 1);
      const dryResourceKey = resolveResourceKey(targetAgent);
      const dryExisting = allActiveClaims.filter(c => resolveResourceKey(c.agent) === dryResourceKey).length;
      const dryCycle = countCycleByResource(cycleAssignments, dryResourceKey);
      const dryMax = resolveConcurrencyLimit(targetAgent, { override: options.maxConcurrency });
      if (dryExisting + dryCycle >= dryMax) {
        const idx = agentPool.indexOf(targetAgent);
        if (idx >= 0) agentPool.splice(idx, 1);
      }
      continue;
    }

    // --- Live path: create assignment FIRST, then brief, then message ---

    // Step 1: Create Assignment entity (Agent SDK runtime protocol)
    let assignmentId: string | undefined;
    try {
      const preId = generateAssignmentId(cwd);
      const assignment = createAssignment({
        id: preId.id,
        short_label: preId.short_label,
        claim_id: claimId,
        plan_id: readyItem.plan.id,
        sequence_id: analysis.sequence.id,
        agent: targetAgent,
        dispatcher_agent: options.dispatcherAgent,
        dispatcher_session_id: options.sessionId,
        scope: readyItem.item.scope_hint ?? readyItem.plan.id,
        description: readyItem.plan.text,
        lane: readyItem.lane,
        worktree_path: worktreePath,
        tags: ['dispatch', ...(readyItem.lane ? [`lane:${readyItem.lane}`] : [])],
      }, cwd);
      assignmentId = assignment.id;
    } catch (err) {
      result.warnings.push(`Assignment creation failed for ${readyItem.plan.id}: ${err instanceof Error ? err.message : String(err)}`);
      // Continue without assignment — brief will use legacy protocol
    }

    // Step 2: Generate brief (includes assignment_id only if creation succeeded)
    const briefMode = resolveBriefMode(targetAgent);
    const brief = generateBrief(readyItem.plan, readyItem.item, cwd, briefMode, {
      claimId,
      worktreePath,
      assignmentId, // undefined if creation failed → legacy protocol in brief
      agent: targetAgent,
    });

    // Step 3: Build invoke command
    const invokeCmd = buildInvokeCommand(targetAgent, brief, { model: resolveModel(targetAgent, { override: options.model }) });
    if (invokeCmd) {
      const cmdPrefix = buildEnvPrefix(claimId);
      result.commands.push({
        agent: targetAgent,
        lane: readyItem.lane,
        command: `${cmdPrefix}${invokeCmd.bashCommand}`,
        shell: process.platform === 'win32' ? 'cmd' : (invokeCmd.shell ? 'bash' : 'sh'),
      });
    }

    // Step 4: Send assignment message with assignment_id in payload
    let msgResult;
    try {
      msgResult = sendMessage({
        from: options.dispatcherAgent,
        to: targetAgent,
        type: 'assign',
        text: brief,
        ref: readyItem.plan.id,
        payload: {
          plan_id: readyItem.plan.id,
          plan_short_label: readyItem.plan.short_label,
          sequence_id: analysis.sequence.id,
          lane: readyItem.lane,
          rank: readyItem.item.rank,
          priority: readyItem.plan.priority,
          claim_id: claimId,
          worktree_path: worktreePath,
          ...(assignmentId ? { assignment_id: assignmentId } : {}),
        },
        scope: readyItem.item.scope_hint,
        requires_ack: true,
        claim_id: claimId,
        assignment_id: assignmentId,
        tags: ['dispatch', ...(readyItem.lane ? [`lane:${readyItem.lane}`] : [])],
        author_id: options.dispatcherAgentId,
        session_id: options.sessionId,
      }, cwd);
    } catch (msgErr) {
      // If message send fails, transition assignment to failed to avoid zombie
      if (assignmentId) {
        try { transitionAssignment(assignmentId, 'offered', { actor: options.dispatcherAgent }, cwd); } catch { /* ignore */ }
        try { transitionAssignment(assignmentId, 'expired', { actor: options.dispatcherAgent, status_reason: `Message delivery failed: ${msgErr instanceof Error ? msgErr.message : String(msgErr)}` }, cwd); } catch { /* ignore */ }
      }
      result.warnings.push(`Message send failed for ${readyItem.plan.id}: ${msgErr instanceof Error ? msgErr.message : String(msgErr)}`);
      continue;
    }

    // Step 5: Link claim → message and claim → assignment
    if (claimId !== '(dry-run)') {
      try { attachAssignmentMessageToClaim(claimId, msgResult.id, cwd); } catch { /* best-effort */ }
      if (assignmentId) {
        try { linkClaimToAssignment(claimId, assignmentId, cwd); } catch { /* best-effort */ }
      }
    }

    // Step 6: Transition assignment to offered + attach message_id
    if (assignmentId) {
      try {
        transitionAssignment(assignmentId, 'offered', { actor: options.dispatcherAgent }, cwd);
        // Attach message_id to the assignment (wasn't available at creation time)
        patchAssignmentMessageId(assignmentId, msgResult.id, cwd);
      } catch { /* best-effort */ }
    }

    const deliveryEntry: DispatchedItem = {
      agent: targetAgent,
      plan_id: readyItem.plan.id,
      message_id: msgResult.id,
      lane: readyItem.lane,
      channel: 'inbox',
      claim_id: claimId,
      assignment_id: assignmentId,
    };
    result.delivery_plan.push(deliveryEntry);
    result.messages_sent.push(deliveryEntry);
    preparedEntries.push({ deliveryEntry, invokeCmd, worktreePath });

    assigned++;
    // Track assignments this cycle for multi-slot capacity
    cycleAssignments.set(targetAgent, (cycleAssignments.get(targetAgent) ?? 0) + 1);
    // Remove agent from pool only when at capacity, counted per host-binary
    // resource against the resolved limit (pln#520 step 3).
    const liveResourceKey = resolveResourceKey(targetAgent);
    const existingClaims = allActiveClaims.filter(c => resolveResourceKey(c.agent) === liveResourceKey).length;
    const cycleCount = countCycleByResource(cycleAssignments, liveResourceKey);
    const maxTasks = resolveConcurrencyLimit(targetAgent, { override: options.maxConcurrency });
    if (existingClaims + cycleCount >= maxTasks) {
      const idx = agentPool.indexOf(targetAgent);
      if (idx >= 0) agentPool.splice(idx, 1);
    }
  }

  // E2E execution phase: attempt to spawn assigned agents (skip in dry run)
  if (!options.dryRun) {
    const autoExecute = options.autoExecute !== false; // default true
    for (const prepared of preparedEntries) {
      const entry = prepared.deliveryEntry;
      const execResult = await attemptExecution(prepared.invokeCmd, {
        agent: entry.agent,
        autoExecute,
        worktreePath: prepared.worktreePath,
        claimId: entry.claim_id,
        assignmentId: entry.assignment_id,
        dispatcherAgent: options.dispatcherAgent,
        dispatcherAgentId: options.dispatcherAgentId,
        cwd,
        handshakeTimeoutMs: options.handshakeTimeoutMs,
      });
      entry.execution_status = execResult.execution_status;
      if (execResult.pid) entry.pid = execResult.pid;
      if (execResult.execution_status === 'delivered_and_started') {
        entry.channel = 'spawned_cli';
      }
      if (execResult.error) result.warnings.push(execResult.error);

      if (entry.assignment_id && entry.claim_id) {
        if (execResult.failure_kind === 'spawn_no_handshake') {
          try {
            const run = createAgentRun({
              assignment_id: entry.assignment_id,
              claim_id: entry.claim_id,
              message_id: entry.message_id,
              plan_id: entry.plan_id,
              sequence_id: analysis.sequence.id,
              agent: entry.agent,
              transport: 'cli_spawn',
              status: 'launching',
              scope: prepared.worktreePath ?? entry.plan_id,
              description: `Execution attempt for ${entry.plan_id}`,
              worktree_path: prepared.worktreePath,
              command: execResult.command,
              shell: execResult.shell,
              pid: execResult.pid,
              status_reason: 'CLI spawn launched by dispatcher',
              tags: ['dispatch-run', ...(entry.lane ? [`lane:${entry.lane}`] : [])],
            }, cwd);
            transitionAgentRun(run.id, 'failed', {
              actor: options.dispatcherAgent,
              actor_id: options.dispatcherAgentId,
              pid: execResult.pid,
              status_reason: execResult.error,
              error_message: execResult.error,
            }, cwd);
          } catch (runErr) {
            result.warnings.push(`AgentRun creation failed for ${entry.assignment_id}: ${runErr instanceof Error ? runErr.message : String(runErr)}`);
          }

          try {
            transitionAssignment(entry.assignment_id, 'failed', {
              actor: options.dispatcherAgent,
              actor_id: options.dispatcherAgentId,
              error_message: execResult.error,
              status_reason: execResult.error,
              syncAgentRun: false,
            }, cwd);
          } catch (assignmentErr) {
            result.warnings.push(`Assignment failure transition failed for ${entry.assignment_id}: ${assignmentErr instanceof Error ? assignmentErr.message : String(assignmentErr)}`);
          }
          continue;
        }

        try {
          const run = createAgentRun({
            assignment_id: entry.assignment_id,
            claim_id: entry.claim_id,
            message_id: entry.message_id,
            plan_id: entry.plan_id,
            sequence_id: analysis.sequence.id,
            agent: entry.agent,
            transport: execResult.execution_status === 'delivered_and_started'
              ? 'cli_spawn'
              : execResult.execution_status === 'command_ready_manual'
                ? 'manual_command'
                : 'inbox_only',
            scope: prepared.worktreePath ?? entry.plan_id,
            description: `Execution attempt for ${entry.plan_id}`,
            worktree_path: prepared.worktreePath,
            command: execResult.command,
            shell: execResult.shell,
            pid: execResult.pid,
            status_reason: execResult.error,
            tags: ['dispatch-run', ...(entry.lane ? [`lane:${entry.lane}`] : [])],
          }, cwd);

          if (execResult.execution_status === 'delivered_and_started') {
            transitionAgentRun(run.id, 'launching', {
              actor: options.dispatcherAgent,
              actor_id: options.dispatcherAgentId,
              pid: execResult.pid,
              status_reason: 'CLI spawn launched by dispatcher',
            }, cwd);
            transitionAgentRun(run.id, 'running', {
              actor: options.dispatcherAgent,
              actor_id: options.dispatcherAgentId,
              pid: execResult.pid,
              status_reason: 'CLI process started',
            }, cwd);
          } else if (execResult.execution_status === 'command_ready_manual') {
            transitionAgentRun(run.id, 'waiting_input', {
              actor: options.dispatcherAgent,
              actor_id: options.dispatcherAgentId,
              status_reason: execResult.error ?? 'Awaiting manual command execution',
            }, cwd);
          } else {
            transitionAgentRun(run.id, 'waiting_input', {
              actor: options.dispatcherAgent,
              actor_id: options.dispatcherAgentId,
              status_reason: 'Awaiting inbox pickup by assigned agent',
            }, cwd);
          }
        } catch (runErr) {
          result.warnings.push(`AgentRun creation failed for ${entry.assignment_id}: ${runErr instanceof Error ? runErr.message : String(runErr)}`);
        }
      }
    }
  }

  return { analysis, result };
}

// ── Invoke Command Building (delegates to agent-capability.ts) ──────────

// ── Review Dispatch ─────────────────────────────────────────

export interface ReviewableHandoff {
  handoff: Handoff;
  plan?: PlanItem;
}

/**
 * Find handoffs that are ready for review:
 * - Status is 'accepted' or 'open' (not closed)
 * - Linked to a plan that is done
 * - No existing non-archived review message for this handoff
 */
export function findReviewableHandoffs(cwd: string): ReviewableHandoff[] {
  const state = loadState(cwd);
  const result: ReviewableHandoff[] = [];

  for (const handoff of state.open_handoffs) {
    if (handoff.status === 'closed') continue;

    // Must have a linked plan
    if (!handoff.plan_id) continue;
    const plan = state.plan_items.find(p => p.id === handoff.plan_id);
    if (!plan) continue;
    if (plan.status !== 'done') continue;

    // Check no existing review message for this handoff
    if (hasActiveReviewMessage(handoff.id, cwd)) continue;

    result.push({ handoff, plan });
  }

  return result;
}

/**
 * Check if there's already a non-archived review message for a handoff.
 */
function hasActiveReviewMessage(handoffId: string, cwd: string): boolean {
  const baseDir = path.join(memoryDir(cwd), 'coordination', 'inbox');
  if (!fs.existsSync(baseDir)) return false;

  const agents = fs.readdirSync(baseDir).filter(f => {
    try { return fs.statSync(path.join(baseDir, f)).isDirectory(); } catch { return false; }
  });

  for (const agent of agents) {
    const agentDir = path.join(baseDir, agent);
    if (!fs.existsSync(agentDir)) continue;
    const files = fs.readdirSync(agentDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const result = loadVersionedJsonFile<InboxMessage>('message', path.join(agentDir, file));
        const msg = InboxMessageSchema.parse(result.document);
        if (msg.type === 'review' && msg.ref === handoffId && msg.status !== 'archived') {
          return true;
        }
      } catch { /* skip invalid */ }
    }
  }
  return false;
}

/**
 * Generate a structured review brief from a handoff.
 */
export function generateReviewBrief(handoff: Handoff, plan?: PlanItem): string {
  const parts: string[] = [];

  parts.push('# Code Review Request');
  parts.push('');
  parts.push(`Handoff: ${handoff.id}${handoff.short_label ? ` (${handoff.short_label})` : ''}`);
  parts.push(`Author: ${handoff.from}`);
  if (plan) {
    parts.push(`Plan: ${plan.id}${plan.short_label ? ` (${plan.short_label})` : ''}`);
    parts.push(`Plan description: ${plan.text}`);
  }
  parts.push('');

  // Narrative (the human-readable summary of what was done)
  if (handoff.narrative) {
    parts.push('## What was done');
    parts.push(handoff.narrative);
    parts.push('');
  }

  // Commits
  if (handoff.text) {
    parts.push('## Commits and changes');
    parts.push(handoff.text.slice(0, 2000));
    parts.push('');
  }

  // Diff snapshot
  if (handoff.snapshot?.diff) {
    parts.push('## Diff');
    parts.push('```');
    parts.push(handoff.snapshot.diff.slice(0, 5000));
    parts.push('```');
    parts.push('');
  }

  // Contract
  if (handoff.contract) {
    if (handoff.contract.pre_conditions?.length) {
      parts.push('## Pre-conditions');
      for (const c of handoff.contract.pre_conditions) {
        parts.push(`- ${c}`);
      }
      parts.push('');
    }
    if (handoff.contract.files_touched?.length) {
      parts.push('## Files touched');
      for (const f of handoff.contract.files_touched) {
        parts.push(`- ${f}`);
      }
      parts.push('');
    }
    if (handoff.contract.post_conditions?.length) {
      parts.push('## Post-conditions to verify');
      for (const c of handoff.contract.post_conditions) {
        parts.push(`- ${c}`);
      }
      parts.push('');
    }
    if (handoff.contract.tests_to_verify?.length) {
      parts.push('## Tests to verify');
      for (const t of handoff.contract.tests_to_verify) {
        parts.push(`- ${t}`);
      }
      parts.push('');
    }
    if (handoff.contract.linked_plans?.length) {
      parts.push('## Linked plans');
      for (const lp of handoff.contract.linked_plans) {
        parts.push(`- ${lp}`);
      }
      parts.push('');
    }
  }

  // Plan steps (for checking completeness)
  if (plan?.steps?.length) {
    parts.push('## Plan steps');
    for (const step of plan.steps) {
      const check = step.status === 'done' ? '[x]' : '[ ]';
      parts.push(`- ${check} ${step.text}`);
    }
    parts.push('');
  }

  // Review criteria
  parts.push('## Review criteria');
  parts.push('Evaluate this work on the following criteria. Be direct and critical.');
  parts.push('');
  parts.push('1. **Scope**: Does the work match the plan description? Are there out-of-scope changes?');
  parts.push('2. **Bugs/Regressions**: Any potential bugs, regressions, or logic errors in the changes?');
  parts.push('3. **Completeness**: Are all plan steps addressed? Any missing pieces?');
  parts.push('4. **Tests**: Are the changes adequately tested? Do the tests actually verify the behavior?');
  parts.push('5. **Handoff quality**: Is the narrative clear enough for another agent to continue the work?');
  parts.push('');
  parts.push('## Output format');
  parts.push('Respond with:');
  parts.push('- **Verdict**: APPROVE or REQUEST_CHANGES');
  parts.push('- **Blocking issues**: (list, or "none")');
  parts.push('- **Non-blocking suggestions**: (list, or "none")');
  parts.push('- **Summary**: 2-3 sentence overall assessment');
  parts.push('');

  return parts.join('\n');
}

export interface DispatchReviewOptions {
  /** Specific handoff ID to review (otherwise auto-detect) */
  handoffId?: string;
  /** Specific reviewer agent (otherwise pick from available) */
  reviewer?: string;
  /** Dry run */
  dryRun?: boolean;
  /** Dispatcher identity */
  dispatcherAgent: string;
  dispatcherAgentId?: string;
  sessionId?: string;
  /**
   * When true (default), each reviewable handoff also gets a review Loop
   * opened via the Loop engine: author slot = handoff.from, reviewer slot =
   * resolved reviewer, handoff linked as change_summary artifact, advance to
   * `findings` + turn dispatched. Pass false to keep the legacy inbox-only
   * behavior. See pln#395 §Automation.
   */
  openLoop?: boolean;
  /** Review mode when openLoop is true. Default 'asymmetric'. */
  reviewMode?: 'asymmetric' | 'symmetric';
}

export interface DispatchReviewResult {
  reviews_sent: Array<{
    handoff_id: string;
    plan_id?: string;
    reviewer: string;
    message_id: string;
    thread_id?: string;
    channel: 'inbox';
    loop_id?: string;
  }>;
  skipped: Array<{
    handoff_id: string;
    reason: string;
  }>;
}

/**
 * Dispatch code reviews for completed handoffs.
 */
export function dispatchReview(options: DispatchReviewOptions, cwd: string): DispatchReviewResult {
  const result: DispatchReviewResult = { reviews_sent: [], skipped: [] };
  const state = loadState(cwd);

  // Find reviewable handoffs
  let reviewable: ReviewableHandoff[];
  if (options.handoffId) {
    const handoff = state.open_handoffs.find(h => h.id === options.handoffId || h.short_label === options.handoffId);
    if (!handoff) {
      result.skipped.push({ handoff_id: options.handoffId, reason: 'Handoff not found' });
      return result;
    }
    if (handoff.status === 'closed') {
      result.skipped.push({ handoff_id: handoff.id, reason: 'Handoff is closed' });
      return result;
    }
    if (!handoff.plan_id) {
      result.skipped.push({ handoff_id: handoff.id, reason: 'Handoff has no linked plan' });
      return result;
    }
    const plan = state.plan_items.find(p => p.id === handoff.plan_id);
    if (!plan) {
      result.skipped.push({ handoff_id: handoff.id, reason: 'Linked plan not found' });
      return result;
    }
    if (plan.status !== 'done') {
      result.skipped.push({ handoff_id: handoff.id, reason: 'Linked plan is not done' });
      return result;
    }
    if (hasActiveReviewMessage(handoff.id, cwd)) {
      result.skipped.push({ handoff_id: handoff.id, reason: 'Active review already exists' });
      return result;
    }
    reviewable = [{ handoff, plan }];
  } else {
    reviewable = state.open_handoffs
      .filter((handoff) => {
        if (handoff.status === 'closed') return false;
        if (!handoff.plan_id) return false;
        const plan = state.plan_items.find((entry) => entry.id === handoff.plan_id);
        if (!plan || plan.status !== 'done') return false;
        if (hasActiveReviewMessage(handoff.id, cwd)) return false;
        return true;
      })
      .map((handoff) => ({
        handoff,
        plan: state.plan_items.find((entry) => entry.id === handoff.plan_id)!,
      }));
  }

  if (reviewable.length === 0) return result;

  // Find reviewer agent
  const agents = listAgentIdentities(cwd);
  const availableReviewers = agents
    .filter(a => a.kind !== 'human')
    .map(a => a.agent_name);

  for (const { handoff, plan } of reviewable) {
    // Pick reviewer: prefer explicit, then any available that isn't the author
    let reviewer = options.reviewer;
    if (!reviewer) {
      reviewer = availableReviewers.find(a => a !== handoff.from);
    }
    if (!reviewer) {
      result.skipped.push({ handoff_id: handoff.id, reason: 'No available reviewer (all agents are the author)' });
      continue;
    }

    const brief = generateReviewBrief(handoff, plan);

    if (options.dryRun) {
      result.reviews_sent.push({
        handoff_id: handoff.id,
        plan_id: plan?.id,
        reviewer,
        message_id: '(dry-run)',
        thread_id: handoff.review?.thread_id,
        channel: 'inbox',
      });
      continue;
    }

    const reviewThreadId = handoff.review?.thread_id ?? generateId('thread');

    // Send review message
    const msgResult = sendMessage({
      from: options.dispatcherAgent,
      to: reviewer,
      type: 'review',
      text: brief,
      ref: handoff.id,
      thread_id: reviewThreadId,
      payload: {
        handoff_id: handoff.id,
        plan_id: plan?.id,
        author: handoff.from,
      },
      requires_ack: true,
      tags: ['review', 'auto-review'],
      author_id: options.dispatcherAgentId,
      session_id: options.sessionId,
    }, cwd);

    applyHandoffUpdates(handoff, {
      requester: options.dispatcherAgent,
      reviewer,
      requested_at: nowISO(),
      review_thread_id: reviewThreadId,
      review_message_id: msgResult.id,
    });
    persistState(state, cwd);

    // Open a review Loop on top of the handoff unless the caller opts out.
    // Best-effort: a loop failure must not break the legacy review dispatch
    // (inbox message already sent, handoff updates already persisted).
    let loopId: string | undefined;
    if (options.openLoop !== false) {
      try {
        const authorIdentity = listAgentIdentities(cwd).find((a) => a.agent_name === handoff.from);
        const reviewerIdentity = listAgentIdentities(cwd).find((a) => a.agent_name === reviewer)
          ?? ensureAgentRegisteredForDispatch(reviewer, cwd);
        const creatorActor = options.dispatcherAgentId ?? options.dispatcherAgent;
        const loop = loopsModule.openLoop(
          {
            kind: 'review',
            title: `Review of ${handoff.short_label ?? handoff.id}`,
            created_by: creatorActor,
            mode: options.reviewMode ?? 'asymmetric',
            linked: plan?.id ? { plan_ids: [plan.id] } : undefined,
            slots: [
              {
                role: 'author',
                agent: handoff.from,
                ...(authorIdentity?.agent_id ? { agent_id: authorIdentity.agent_id } : {}),
              },
              {
                role: 'reviewer',
                agent: reviewer,
                ...(reviewerIdentity?.agent_id ? { agent_id: reviewerIdentity.agent_id } : {}),
              },
            ],
          },
          cwd,
        );
        loopId = loop.id;
        loopsModule.add_artifact(
          {
            id: loop.id,
            actor: creatorActor,
            artifact: {
              phase: 'change_summary',
              type: 'change_summary',
              ref: { kind: 'handoff', id: handoff.id },
            },
          },
          cwd,
        );
        const advanced = loopsModule.advance({ id: loop.id, actor: creatorActor }, cwd);
        const reviewerSlot = advanced.loop.slots.find((s) => s.role === 'reviewer');
        if (reviewerSlot) {
          loopsModule.turn(
            {
              id: loop.id,
              slot_id: reviewerSlot.slot_id,
              actor: creatorActor,
              assignment_id: msgResult.id,
            },
            cwd,
          );
        }
      } catch {
        // Loop failure doesn't break legacy review dispatch. The handoff +
        // inbox message stand on their own as the v0 review artifact.
        loopId = undefined;
      }
    }

    result.reviews_sent.push({
      handoff_id: handoff.id,
      plan_id: plan?.id,
      reviewer,
      message_id: msgResult.id,
      thread_id: reviewThreadId,
      channel: 'inbox',
      ...(loopId ? { loop_id: loopId } : {}),
    });
  }

  return result;
}
