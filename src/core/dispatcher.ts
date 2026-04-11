/**
 * Local dispatcher — coordinator/worker model for multi-agent coordination.
 *
 * ## Dispatch mode (decision 2026-04-11)
 *
 * `bclaw_dispatch(spawn=true)` is the **official dispatch mode**. The dispatcher:
 * 1. Analyzes the active sequence and identifies ready lanes
 * 2. Creates coordinator-owned claims with worktree isolation
 * 3. Generates adaptive briefs per agent capability (full/compact/task_card)
 * 4. Sends assignment messages to agent inboxes
 * 5. Attempts E2E spawn via `attemptExecution()` (detached CLI subprocess)
 *
 * **Fallback**: When spawn fails (sandbox constraints, missing binary, etc.),
 * the dispatcher gracefully returns `command_ready_manual` with a copy-pasteable
 * bash command. The Sprint 5 bash pattern (`cd repo && codex exec ...`) remains
 * valid as a manual fallback — it is NOT the primary mode.
 *
 * Agent spawn support: Codex (stdin_pipe), Claude CLI (temp_file), Cline (inline_arg).
 * Copilot CLI is inbox/review-only (no shell execution permissions).
 *
 * @module
 */
import { getActiveSequence } from './sequence.js';
import { loadState } from './state.js';
import { listClaims, createCoordinatorClaim } from './claims.js';
import { listAgentIdentities, ensureAgentRegisteredForDispatch } from './agent-registry.js';
import { sendMessage, hasActiveAssignment, type SendMessageInput } from './messaging.js';
import { memoryDir } from './io.js';
import { loadVersionedJsonFile } from './migration.js';
import fs from 'node:fs';
import path from 'node:path';
import { buildInvokeCommand, resolveBriefMode, getCapabilityProfile, type BriefMode, type InvokeCommand } from './agent-capability.js';
import { attemptExecution, checkActiveInstance } from './execution.js';
import { InboxMessageSchema, type InboxMessage, type Sequence, type SequenceItem, type PlanItem, type Handoff, type Claim } from './schema.js';

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

export interface DispatchAnalysis {
  sequence: Sequence;
  ready: ReadyLane[];
  active: ActiveLane[];
  blocked: BlockedLane[];
  done: SequenceItem[];
  /** Agents registered and not currently working on a lane */
  available_agents: string[];
}

export interface DispatchedItem {
  agent: string;
  plan_id: string;
  message_id: string;
  lane?: string;
  /** How the assignment was delivered */
  channel: 'inbox' | 'spawned_cli';
  claim_id?: string;
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

  // Agents currently working (have active claims in this sequence)
  const busyAgents = new Set<string>();
  for (const c of claims) {
    if (c.plan_id && sequence.items.some(i => i.planId === c.plan_id)) {
      busyAgents.add(c.agent);
    }
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

  // Available agents: registered non-human agents not currently busy
  const allAgentNames = agents
    .filter(a => a.kind !== 'human')
    .map(a => a.agent_name);
  const available_agents = allAgentNames.filter(a => !busyAgents.has(a));

  return { sequence, ready, active, blocked, done, available_agents };
}

// ── Brief Generation ────────────────────────────────────────

/**
 * Protocol + Available tools section, shared between generateBrief (plan-based)
 * and generateDispatchBrief (task-based / coordinate).
 *
 * Only emitted for 'full' briefMode — compact/task_card agents run in sandboxes
 * without MCP access, so the protocol section would be noise.
 */
export function buildProtocolSection(options?: { claimId?: string; worktreePath?: string }): string {
  const parts: string[] = [];

  parts.push('## Protocol');
  if (options?.claimId) {
    parts.push(`Your scope has been pre-claimed by the coordinator (claim: ${options.claimId}).`);
    if (options.worktreePath) {
      parts.push(`Worktree: ${options.worktreePath}`);
      parts.push('');
      parts.push('1. Read this brief and the plan description');
      parts.push(`2. cd into the worktree: ${options.worktreePath}`);
      parts.push('3. Call bclaw_session_start to register your session');
      parts.push('4. Work on the assigned scope (claim already active)');
      parts.push('5. Call bclaw_session_end with a narrative when done');
      parts.push('6. Call bclaw_ack_message on this assignment');
    } else {
      parts.push('1. Read this brief and the plan description');
      parts.push('2. Call bclaw_session_start to register your session');
      parts.push('3. Work on the assigned scope (claim already active)');
      parts.push('4. Call bclaw_session_end with a narrative when done');
      parts.push('5. Call bclaw_ack_message on this assignment');
    }
  } else {
    parts.push('1. Read this brief and the plan description');
    parts.push('2. Call bclaw_session_start to register your session');
    parts.push('3. Call bclaw_claim to claim the scope before editing');
    parts.push('4. Work in the worktree created by the claim');
    parts.push('5. Call bclaw_session_end with a narrative when done');
    parts.push('6. Call bclaw_ack_message on this assignment');
  }
  parts.push('');

  parts.push('## Available tools');
  parts.push('- bclaw_session_start, bclaw_session_end (session lifecycle)');
  if (!options?.claimId) {
    parts.push('- bclaw_claim, bclaw_release_claim (scope ownership)');
  }
  parts.push('- bclaw_get_context (project memory)');
  parts.push('- bclaw_check_policy (pre-edit verification)');
  parts.push('- bclaw_write_note, bclaw_quick_capture (capture decisions/traps)');
  parts.push('- bclaw_ack_message (acknowledge assignment)');
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
  options?: { claimId?: string; worktreePath?: string },
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

    // Factor 3: Availability — is the agent in the pool (not busy)?
    // All agents in agentPool are available by definition, but we can
    // give a small bonus to agents without any claims at all.
    const agentClaims = claimCounts.get(agent) ?? 0;
    const availability = agentClaims === 0 ? 1.0 : 0.5;

    // Factor 4: Load balance — fewer claims = higher score
    const load_balance = 1.0 - (agentClaims / maxClaims);

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
  const analysis = analyzeSequence(cwd);
  if (!analysis) return null;

  const result: DispatchResult = { delivery_plan: [], messages_sent: [], commands: [], skipped: [], warnings: [] };

  // Filter ready lanes
  let readyToAssign = analysis.ready;

  if (options.lanes?.length) {
    readyToAssign = readyToAssign.filter(r => r.lane && options.lanes!.includes(r.lane));
  }

  // Match ready items to available agents
  const agentPool = options.agents?.length
    ? options.agents
    : [...analysis.available_agents];

  // Collect all active claims for scoring
  const allActiveClaims = listClaims(cwd).filter(c => c.status === 'active');

  const max = options.maxAssignments ?? readyToAssign.length;
  let assigned = 0;
  // Track invoke commands + worktree paths for E2E execution phase
  const preparedEntries: Array<{ deliveryEntry: DispatchedItem; invokeCmd: InvokeCommand | undefined; worktreePath?: string }> = [];

  for (const readyItem of readyToAssign) {
    if (assigned >= max) break;

    // Pick agent using 4-factor scoring — iterate through ranked agents
    // to find the first one that passes all guards (idempotency + active instance).
    const scored = scoreAgents(agentPool, readyItem.plan, allActiveClaims);
    let targetAgent: string | undefined;

    for (const candidate of scored) {
      // Idempotency: skip if there's already a non-archived assign for this plan+agent
      if (!options.dryRun && hasActiveAssignment(candidate.agent, readyItem.plan.id, cwd)) {
        continue; // try next agent
      }

      // Check-before-spawn guard: skip agent if it already has an active instance
      if (!options.dryRun) {
        const instanceCheck = checkActiveInstance(candidate.agent, cwd);
        if (instanceCheck.active) {
          result.warnings.push(`${candidate.agent}: skipped — ${instanceCheck.reason}`);
          continue; // try next agent
        }
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
      claimId = claimResult.claimId;
      worktreePath = claimResult.worktreePath;
      if (claimResult.worktreeWarning) {
        result.warnings.push(`${targetAgent}/${claimScope}: ${claimResult.worktreeWarning}`);
      }
    }

    // Generate brief with pre-created claim_id and worktree path
    const briefMode = resolveBriefMode(targetAgent);
    const brief = generateBrief(readyItem.plan, readyItem.item, cwd, briefMode, { claimId, worktreePath });

    // Build invoke command (if agent is CLI-spawnable)
    const invokeCmd = buildInvokeCommand(targetAgent, brief);
    if (invokeCmd) {
      result.commands.push({
        agent: targetAgent,
        lane: readyItem.lane,
        command: invokeCmd.bashCommand,
        shell: invokeCmd.shell ? 'bash' : 'sh',
      });
    }

    if (options.dryRun) {
      const deliveryEntry: DispatchedItem = {
        agent: targetAgent,
        plan_id: readyItem.plan.id,
        message_id: '(dry-run)',
        lane: readyItem.lane,
        channel: 'inbox',
        claim_id: claimId,
      };
      result.delivery_plan.push(deliveryEntry);
      result.messages_sent.push(deliveryEntry);
      assigned++;
      const idx = agentPool.indexOf(targetAgent);
      if (idx >= 0) agentPool.splice(idx, 1);
      continue;
    }

    // Send assignment message (always — serves as audit trail)
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
      },
      scope: readyItem.item.scope_hint,
      requires_ack: true,
      tags: ['dispatch', ...(readyItem.lane ? [`lane:${readyItem.lane}`] : [])],
      author_id: options.dispatcherAgentId,
      session_id: options.sessionId,
    }, cwd);

    const deliveryEntry: DispatchedItem = {
      agent: targetAgent,
      plan_id: readyItem.plan.id,
      message_id: msgResult.id,
      lane: readyItem.lane,
      channel: 'inbox',
      claim_id: claimId,
    };
    result.delivery_plan.push(deliveryEntry);
    result.messages_sent.push(deliveryEntry);
    preparedEntries.push({ deliveryEntry, invokeCmd, worktreePath });

    assigned++;
    const idx = agentPool.indexOf(targetAgent);
    if (idx >= 0) agentPool.splice(idx, 1);
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

  // Find reviewable handoffs
  let reviewable: ReviewableHandoff[];
  if (options.handoffId) {
    const state = loadState(cwd);
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
    reviewable = findReviewableHandoffs(cwd);
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
        channel: 'inbox',
      });
      continue;
    }

    // Send review message
    const msgResult = sendMessage({
      from: options.dispatcherAgent,
      to: reviewer,
      type: 'review',
      text: brief,
      ref: handoff.id,
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

    result.reviews_sent.push({
      handoff_id: handoff.id,
      plan_id: plan?.id,
      reviewer,
      message_id: msgResult.id,
      channel: 'inbox',
    });
  }

  return result;
}
