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
 * - Copilot CLI is inbox/review-only (spawnable_cli=false)
 *
 * @module
 */
import { getActiveSequence } from './sequence.js';
import { loadState, persistState } from './state.js';
import { listClaims, createCoordinatorClaim, attachAssignmentMessageToClaim, linkClaimToAssignment } from './claims.js';
import { listAgentIdentities, ensureAgentRegisteredForDispatch } from './agent-registry.js';
import { sendMessage, hasActiveAssignment, type SendMessageInput } from './messaging.js';
import { memoryDir } from './io.js';
import { loadVersionedJsonFile } from './migration.js';
import fs from 'node:fs';
import path from 'node:path';
import { buildInvokeCommand, resolveBriefMode, getCapabilityProfile, type BriefMode, type InvokeCommand } from './agent-capability.js';
import { attemptExecution, checkActiveInstance } from './execution.js';
import { createAssignment, transitionAssignment, generateAssignmentId, patchAssignmentMessageId } from './assignments.js';
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
}

/** Per-agent capacity summary for multi-instance dispatch. */
export interface AgentCapacityEntry {
  agent: string;
  /** Number of active claims this agent has in the current sequence */
  active_claims: number;
  /** Max concurrent tasks from agent capability profile */
  max_tasks: number;
  /** Remaining slots: max_tasks - active_claims */
  slots_remaining: number;
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
 * Build a cross-platform env prefix for BRAINCLAW_CLAIM_ID.
 * POSIX: `BRAINCLAW_CLAIM_ID=clm_xxx `
 * Windows (cmd): `set BRAINCLAW_CLAIM_ID=clm_xxx && `
 */
function buildEnvPrefix(claimId: string): string {
  if (!claimId || claimId === '(dry-run)') return '';
  if (process.platform === 'win32') {
    return `set BRAINCLAW_CLAIM_ID=${claimId} && `;
  }
  return `BRAINCLAW_CLAIM_ID=${claimId} `;
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
    const profile = getCapabilityProfile(agent);
    const max_tasks = profile?.max_concurrent_tasks ?? 1;
    return { agent, active_claims, max_tasks, slots_remaining: Math.max(0, max_tasks - active_claims) };
  });

  // Available agents: those with remaining capacity (slots_remaining > 0)
  const available_agents = agent_capacity
    .filter(a => a.slots_remaining > 0)
    .map(a => a.agent);

  return { sequence, ready, active, blocked, done, available_agents, agent_capacity };
}

// ── Brief Generation ────────────────────────────────────────

/**
 * Protocol + Available tools section, shared between generateBrief (plan-based)
 * and generateDispatchBrief (task-based / coordinate).
 *
 * Only emitted for 'full' briefMode — compact/task_card agents run in sandboxes
 * without MCP access, so the protocol section would be noise.
 */
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
    parts.push(`${options.worktreePath ? '7' : '6'}. If blocked: bclaw_assignment_update(status: "blocked", blocker: "...")`);
    parts.push(`${options.worktreePath ? '8' : '7'}. If failed: bclaw_assignment_update(status: "failed", error_message: "...")`);
  } else if (options?.claimId) {
    parts.push('1. Call bclaw_session_start to register your session');
    if (options.worktreePath) {
      parts.push(`2. cd into the worktree: ${options.worktreePath}`);
    }
    parts.push(`${options.worktreePath ? '3' : '2'}. Work on the assigned scope (claim already active)`);
    parts.push(`${options.worktreePath ? '4' : '3'}. Call bclaw_session_end with a narrative when done`);
  } else {
    parts.push('1. Call bclaw_session_start to register your session');
    parts.push('2. Call bclaw_claim to claim the scope before editing');
    parts.push('3. Work in the worktree created by the claim');
    parts.push('4. Call bclaw_session_end with a narrative when done');
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
  parts.push('- bclaw_get_context (project memory)');
  parts.push('- bclaw_check_policy (pre-edit verification)');
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
  options?: { claimId?: string; worktreePath?: string; assignmentId?: string },
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

  // Protocol and Available tools — only for 'full' mode
  // Compact mode agents (Codex) run in sandboxes without MCP access
  if (mode === 'full') {
    parts.push(buildProtocolSection(options));
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
    }));
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
    const canSpawn = profile?.runtime.spawnable_cli ?? false;
    const capability = canExecute ? (canSpawn ? 1.0 : 0.5) : 0.1;

    // Factor 3: Availability — graduated by utilization (claims / max_concurrent_tasks)
    // Include in-cycle assignments so load-balance works within a single dispatch call
    const agentClaims = (claimCounts.get(agent) ?? 0) + (cycleAssignments?.get(agent) ?? 0);
    const maxTasks = profile?.max_concurrent_tasks ?? 1;
    const utilization = Math.min(1.0, agentClaims / maxTasks);
    const availability = 1.0 - (utilization * 0.5); // range [0.5, 1.0]

    // Factor 4: Load balance — normalized by agent's capacity, not raw claim count
    const load_balance = 1.0 - utilization;

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
}

/**
 * Run a dispatch cycle: analyze the sequence, generate briefs, send assignments.
 */
export function dispatch(options: DispatchOptions, cwd: string): { analysis: DispatchAnalysis; result: DispatchResult } | null {
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

      // Claim-based capacity guard: check claims (existing + this cycle) against max_concurrent_tasks.
      // This is the authoritative capacity check — covers both options.agents and analysis.available_agents paths.
      const existingClaims = allActiveClaims.filter(c => c.agent === candidate.agent).length;
      const inCycleCount = cycleAssignments.get(candidate.agent) ?? 0;
      const maxTasks = getCapabilityProfile(candidate.agent)?.max_concurrent_tasks ?? 1;
      if (existingClaims + inCycleCount >= maxTasks) {
        result.warnings.push(`${candidate.agent}: at capacity (${existingClaims + inCycleCount}/${maxTasks} claims)`);
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
      const claimResult = createCoordinatorClaim({
        agent: targetAgent,
        scope: claimScope,
        description: readyItem.plan.text,
        planId: readyItem.plan.id,
        dispatcherAgent: options.dispatcherAgent,
        sessionId: options.sessionId,
        cwd,
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
      const invokeCmd = buildInvokeCommand(targetAgent, brief);
      if (invokeCmd) {
        const cmdPrefix = buildEnvPrefix(claimId);
        result.commands.push({ agent: targetAgent, lane: readyItem.lane, command: `${cmdPrefix}${invokeCmd.bashCommand}`, shell: process.platform === 'win32' ? 'cmd' : (invokeCmd.shell ? 'bash' : 'sh') });
      }
      const deliveryEntry: DispatchedItem = { agent: targetAgent, plan_id: readyItem.plan.id, message_id: '(dry-run)', lane: readyItem.lane, channel: 'inbox', claim_id: claimId };
      result.delivery_plan.push(deliveryEntry);
      result.messages_sent.push(deliveryEntry);
      assigned++;
      cycleAssignments.set(targetAgent, (cycleAssignments.get(targetAgent) ?? 0) + 1);
      const dryExisting = allActiveClaims.filter(c => c.agent === targetAgent).length;
      const dryCycle = cycleAssignments.get(targetAgent) ?? 0;
      const dryMax = getCapabilityProfile(targetAgent)?.max_concurrent_tasks ?? 1;
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
    });

    // Step 3: Build invoke command
    const invokeCmd = buildInvokeCommand(targetAgent, brief);
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
    const msgResult = sendMessage({
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
      tags: ['dispatch', ...(readyItem.lane ? [`lane:${readyItem.lane}`] : [])],
      author_id: options.dispatcherAgentId,
      session_id: options.sessionId,
    }, cwd);

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
    // Remove agent from pool only when at capacity (existing claims + this cycle's assignments)
    const existingClaims = allActiveClaims.filter(c => c.agent === targetAgent).length;
    const cycleCount = cycleAssignments.get(targetAgent) ?? 0;
    const maxTasks = getCapabilityProfile(targetAgent)?.max_concurrent_tasks ?? 1;
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
      const execResult = attemptExecution(prepared.invokeCmd, {
        agent: entry.agent,
        autoExecute,
        worktreePath: prepared.worktreePath,
        claimId: entry.claim_id,
        dispatcherAgent: options.dispatcherAgent,
        dispatcherAgentId: options.dispatcherAgentId,
        cwd,
      });
      entry.execution_status = execResult.execution_status;
      if (execResult.pid) entry.pid = execResult.pid;
      if (execResult.execution_status === 'delivered_and_started') {
        entry.channel = 'spawned_cli';
      }
      if (execResult.error) result.warnings.push(execResult.error);
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
}

export interface DispatchReviewResult {
  reviews_sent: Array<{
    handoff_id: string;
    plan_id?: string;
    reviewer: string;
    message_id: string;
    thread_id?: string;
    channel: 'inbox';
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

    result.reviews_sent.push({
      handoff_id: handoff.id,
      plan_id: plan?.id,
      reviewer,
      message_id: msgResult.id,
      thread_id: reviewThreadId,
      channel: 'inbox',
    });
  }

  return result;
}
