/**
 * Local dispatcher — Phase 2 of pln_59bddae5.
 *
 * The dispatcher is an agent-coordinator that reads the active sequence,
 * identifies ready lanes, generates briefs, and sends assignment messages
 * to target agents via the messaging system.
 *
 * Brainclaw is a passive coordination layer — the dispatcher is an agent
 * like any other, not an orchestrator that spawns processes.
 *
 * @module
 */
import { getActiveSequence } from './sequence.js';
import { loadState } from './state.js';
import { listClaims } from './claims.js';
import { listAgentIdentities } from './agent-registry.js';
import { sendMessage, hasActiveAssignment, type SendMessageInput } from './messaging.js';
import { buildContext, renderContextMarkdown } from './context.js';
import type { Sequence, SequenceItem, PlanItem, Handoff, Claim } from './schema.js';

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

export interface DispatchResult {
  messages_sent: Array<{
    agent: string;
    plan_id: string;
    message_id: string;
    lane?: string;
  }>;
  skipped: Array<{
    plan_id: string;
    reason: string;
  }>;
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
 * Generate a dispatch brief for an agent about to work on a plan.
 */
export function generateBrief(
  plan: PlanItem,
  item: SequenceItem,
  cwd: string,
): string {
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

  // Prior handoffs on this plan
  if (planHandoffs.length > 0) {
    parts.push('## Prior work on this plan');
    for (const h of planHandoffs.slice(0, 3)) {
      parts.push(`### Handoff from ${h.from} (${h.status})`);
      if (h.narrative) parts.push(h.narrative);
      else parts.push(h.text.slice(0, 500));
      parts.push('');
    }
  }

  // Context from dependency handoffs
  if (depHandoffs.length > 0) {
    parts.push('## Context from completed dependencies');
    for (const h of depHandoffs.slice(0, 3)) {
      parts.push(`### ${h.from} on ${h.plan_id}`);
      if (h.narrative) parts.push(h.narrative);
      else parts.push(h.text.slice(0, 300));
      parts.push('');
    }
  }

  // Instructions
  parts.push('## Protocol');
  parts.push('1. Read this brief and the plan description');
  parts.push('2. Call bclaw_claim to claim the scope before editing');
  parts.push('3. Work in the worktree created by the claim');
  parts.push('4. Call bclaw_session_end with a narrative when done');
  parts.push('5. Call bclaw_ack_message on this assignment');
  parts.push('');

  return parts.join('\n');
}

// ── Dispatch ────────────────────────────────────────────────

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
}

/**
 * Run a dispatch cycle: analyze the sequence, generate briefs, send assignments.
 */
export function dispatch(options: DispatchOptions, cwd: string): { analysis: DispatchAnalysis; result: DispatchResult } | null {
  const analysis = analyzeSequence(cwd);
  if (!analysis) return null;

  const result: DispatchResult = { messages_sent: [], skipped: [] };

  // Filter ready lanes
  let readyToAssign = analysis.ready;

  if (options.lanes?.length) {
    readyToAssign = readyToAssign.filter(r => r.lane && options.lanes!.includes(r.lane));
  }

  // Match ready items to available agents
  const agentPool = options.agents?.length
    ? options.agents
    : [...analysis.available_agents];

  const max = options.maxAssignments ?? readyToAssign.length;
  let assigned = 0;

  for (const readyItem of readyToAssign) {
    if (assigned >= max) break;

    // Pick agent: prefer plan assignee, then first available
    let targetAgent: string | undefined;

    if (readyItem.plan.assignee && agentPool.includes(readyItem.plan.assignee)) {
      targetAgent = readyItem.plan.assignee;
    } else if (agentPool.length > 0) {
      targetAgent = agentPool[0];
    }

    if (!targetAgent) {
      result.skipped.push({
        plan_id: readyItem.plan.id,
        reason: 'No available agent',
      });
      continue;
    }

    // Idempotency: skip if there's already a non-archived assign for this plan+agent
    if (!options.dryRun && hasActiveAssignment(targetAgent, readyItem.plan.id, cwd)) {
      result.skipped.push({
        plan_id: readyItem.plan.id,
        reason: `Already assigned to ${targetAgent} (existing message not archived)`,
      });
      continue;
    }

    // Generate brief
    const brief = generateBrief(readyItem.plan, readyItem.item, cwd);

    if (options.dryRun) {
      result.messages_sent.push({
        agent: targetAgent,
        plan_id: readyItem.plan.id,
        message_id: '(dry-run)',
        lane: readyItem.lane,
      });
      assigned++;
      // Remove agent from pool (one assignment per agent)
      const idx = agentPool.indexOf(targetAgent);
      if (idx >= 0) agentPool.splice(idx, 1);
      continue;
    }

    // Send assignment message
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
      },
      scope: readyItem.item.scope_hint,
      requires_ack: true,
      tags: ['dispatch', ...(readyItem.lane ? [`lane:${readyItem.lane}`] : [])],
      author_id: options.dispatcherAgentId,
      session_id: options.sessionId,
    }, cwd);

    result.messages_sent.push({
      agent: targetAgent,
      plan_id: readyItem.plan.id,
      message_id: msgResult.id,
      lane: readyItem.lane,
    });

    assigned++;
    // Remove agent from pool (one assignment per agent)
    const idx = agentPool.indexOf(targetAgent);
    if (idx >= 0) agentPool.splice(idx, 1);
  }

  return { analysis, result };
}
