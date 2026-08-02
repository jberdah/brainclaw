/**
 * E2E dispatch execution — spawn agent processes after claim+inbox delivery.
 *
 * This module bridges the gap between dispatch (claim + inbox + brief) and
 * actual agent execution. It detects whether the coordinator can spawn CLI
 * processes and, if so, launches the agent in a detached subprocess.
 *
 * @module
 */
import fs from 'node:fs';
import { resolveConcurrencyLimit, resolveResourceKey, type InvokeCommand } from './agent-capability.js';
import { getRuntimeSignalPath } from './runtime-signals.js';
import { appendAuditEntry } from './audit.js';
import { loadAllSessions } from './identity.js';
import { loadConfig } from './config.js';
import { loadAssignment } from './assignments.js';
import {
  defaultExecutionAdapter,
  type ExecutionAdapter,
  type SpawnCapability,
  type SpawnResult,
  type TurnEcho,
} from './execution-adapters.js';

// ── Types ───────────────────────────────────────────────────

export interface ExecutionResult {
  execution_status: 'delivered_and_started' | 'command_ready_manual' | 'inbox_only';
  pid?: number;
  command?: string;
  shell?: string;
  started_at?: string;
  error?: string;
  failure_kind?: 'spawn_no_handshake' | 'spawn_failed' | 'spawn_capacity' | 'spawn_no_worktree' | 'not_spawnable';
  /**
   * Machine-readable reason this execution ended in its status (pln#626
   * Phase 1). Set on every non-`delivered_and_started` outcome so a
   * `command_ready_manual` is never silent about WHY it did not spawn.
   * Distinct from `failure_kind`: `auto_execute_disabled` is a deliberate
   * manual handoff (not a failure and carries no `failure_kind`), whereas
   * `not_spawnable` et al. ARE failures of an autoExecute intent.
   */
  execution_reason?:
    | 'auto_execute_disabled'
    | 'not_spawnable'
    | 'spawn_no_worktree'
    | 'spawn_capacity'
    | 'spawn_no_handshake'
    | 'spawn_failed'
    | 'no_invoke_command'
    | 'intent_inbox_only';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute the brief-ack sentinel file path for an assignment.
 *
 * pln#476 — half-2 of trp#59. The dispatcher prefixes the spawn command
 * with a shell `touch`/`type nul >` step that creates this file BEFORE
 * the agent binary executes. Its existence proves the spawn actually
 * started doing work — independent of whether the agent has the
 * brainclaw MCP wired (codex spawned without MCP cannot call
 * bclaw_assignment_update; the ack file lets us recognize a healthy
 * spawn anyway).
 */
export function getAssignmentAckPath(cwd: string, assignmentId: string): string {
  return getRuntimeSignalPath(cwd, assignmentId, 'ack');
}

function isAssignmentAcked(assignmentId: string, cwd: string): boolean {
  // Fast path: the brief-ack sentinel was written by the worker shell.
  if (fs.existsSync(getAssignmentAckPath(cwd, assignmentId))) return true;
  // Standard path: the worker called bclaw_assignment_update via MCP and
  // moved the assignment past the offered/created state.
  const assignment = loadAssignment(assignmentId, cwd);
  return !!assignment && assignment.status !== 'created' && assignment.status !== 'offered';
}

async function waitForAssignmentHandshake(
  assignmentId: string,
  cwd: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isAssignmentAcked(assignmentId, cwd)) return true;
    await sleep(100);
  }
  return isAssignmentAcked(assignmentId, cwd);
}

// ── Helpers ────────────────────────────────────────────────

/** Parse a duration string like '4h', '30m', '1d' to milliseconds. */
function parseDurationMs(value: string): number {
  const match = /^(\d+)([mhd])$/i.exec(value.trim());
  if (!match) return 4 * 3_600_000; // default 4h
  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (unit === 'm') return amount * 60_000;
  if (unit === 'h') return amount * 3_600_000;
  return amount * 86_400_000;
}

// ── Check Before Spawn Guard ──────────────────────────────

/**
 * Check agent capacity for spawning — capacity-aware, multi-instance safe.
 *
 * Counts active sessions (non-stale) for the agent type and compares to
 * max_concurrent_tasks from the capability profile. Returns canSpawnMore=true
 * if there are remaining slots.
 */
export interface ActiveInstanceCheck {
  /** @deprecated Use canSpawnMore instead */
  active: boolean;
  canSpawnMore: boolean;
  activeCount: number;
  maxAllowed: number;
  reason: string;
  activeSessions: string[];
}

export function checkActiveInstance(agentName: string, cwd: string): ActiveInstanceCheck {
  const sessions = loadAllSessions(cwd);
  let ttlStr = '4h';
  try { ttlStr = loadConfig(cwd).implicit_session_ttl ?? '4h'; } catch { /* use default */ }
  const SESSION_STALE_MS = parseDurationMs(ttlStr);
  const now = Date.now();

  // pln#520 step 3: pool active sessions by host-binary resource so all
  // identities of one binary (e.g. claude-code + claude-sonnet → `claude`)
  // count together against a shared cap.
  const targetResource = resolveResourceKey(agentName);
  const activeSessions: string[] = [];
  for (const session of sessions) {
    if (resolveResourceKey(session.agent) !== targetResource) continue;
    const lastSeen = new Date(session.last_seen_at).getTime();
    if (isNaN(lastSeen)) continue;
    if (now - lastSeen < SESSION_STALE_MS) {
      activeSessions.push(session.session_id);
    }
  }

  // Limit resolved from the chain (default unlimited for parallelizable CLI
  // agents; structural floor for non-spawnable IDE agents). Infinity → no cap.
  const maxAllowed = resolveConcurrencyLimit(agentName);
  const activeCount = activeSessions.length;
  const canSpawnMore = activeCount < maxAllowed;
  const capLabel = Number.isFinite(maxAllowed) ? String(maxAllowed) : '∞';

  return {
    active: !canSpawnMore, // backward compat: active=true means "cannot spawn more"
    canSpawnMore,
    activeCount,
    maxAllowed,
    reason: canSpawnMore
      ? `Agent ${agentName} has capacity (${activeCount}/${capLabel} slots used)`
      : `Agent ${agentName} at capacity (${activeCount}/${capLabel} slots used)`,
    activeSessions,
  };
}

// ── Spawn detection ─────────────────────────────────────────

/**
 * Check if the coordinator can spawn an agent as a CLI subprocess.
 *
 * Returns canSpawn=true when:
 * 1. The target agent has runtime.canBeSpawnedCli = true in its profile
 * 2. The current process is NOT running inside an MCP stdio sandbox
 *    (heuristic: stdin is a TTY, or BRAINCLAW_CAN_SPAWN env is set)
 */
export function canSpawnAgent(agentName: string): SpawnCapability {
  return defaultExecutionAdapter.canSpawn(agentName);
}

// ── Process spawning ────────────────────────────────────────

/**
 * Spawn an agent CLI process in a detached, fire-and-forget mode.
 *
 * The spawned process is fully detached from the parent — it won't block
 * the coordinator and survives parent exit. The PID is returned for
 * tracking purposes.
 */
export function executeDispatchedCommand(
  invoke: InvokeCommand,
  options: { worktreePath?: string; claimId?: string; agent: string },
): SpawnResult {
  return defaultExecutionAdapter.start(invoke, options);
}

// ── Execution orchestrator ──────────────────────────────────

/**
 * Attempt E2E execution after dispatch delivery.
 *
 * This is the main entry point called by bclaw_coordinate and bclaw_dispatch
 * after claim+inbox+brief delivery is complete.
 *
 * - If autoExecute=true and agent is spawnable: spawn and return delivered_and_started
 * - If autoExecute=false or not spawnable: return command_ready_manual with command string
 * - If spawn fails: log warning, fallback to command_ready_manual
 *
 * pln#638 PR-6 — lifecycle boundary (the other half lives on
 * buildProtocolSection in dispatcher.ts): the wrapper spawned here emits
 * ack/heartbeat/completed/failed sentinels MECHANICALLY from the process exit
 * code. That is TRANSPORT completion only. It never opens or closes sessions
 * (lanes have none), never releases the lane's claim, and never triggers a
 * review — business completion is proven exclusively by the coordinator's
 * harvest/report path reading LANE-RESULT or bclaw_assignment_update.
 */
export async function attemptExecution(
  invoke: InvokeCommand | undefined,
  options: {
    agent: string;
    autoExecute: boolean;
    worktreePath?: string;
    claimId?: string;
    assignmentId?: string;
    dispatcherAgent: string;
    dispatcherAgentId?: string;
    cwd?: string;
    handshakeTimeoutMs?: number;
    adapter?: ExecutionAdapter;
    /**
     * pln#531 — isolation invariant. When true (set by real worker-dispatch
     * callers), refuse to spawn if no worktree is present rather than fall back
     * to the integration cwd. Off by default so non-isolated/test spawns are
     * unaffected.
     */
    requireWorktree?: boolean;
    /**
     * pln#630 PR2c — turn-attempt correlation for the ack-wrap completion
     * sentinel (turn-owned dispatch). Flows to the adapter's buildAckWrapCommand.
     */
    turnEcho?: TurnEcho;
  },
): Promise<ExecutionResult> {
  const adapter = options.adapter ?? defaultExecutionAdapter;

  // No invoke command available (IDE-only agents, etc.)
  if (!invoke) {
    return { execution_status: 'inbox_only', execution_reason: 'no_invoke_command' };
  }

  const spawnCheck = adapter.canSpawn(options.agent);

  // pln#626 Phase 1 — split the old `(!autoExecute || !spawnCheck.canSpawn)`
  // branch, which collapsed two very different outcomes into one silent
  // command_ready_manual (no reason, no failure_kind — it even discarded
  // spawnCheck.reason). Callers could not tell "you didn't ask me to spawn"
  // apart from "I tried and can't".

  // (1) autoExecute explicitly disabled: a deliberate manual handoff, NOT a
  // failure. Prepend BRAINCLAW_CLAIM_ID so manual copy-paste still routes.
  if (!options.autoExecute) {
    const manual = adapter.prepareManualCommand(invoke, options);
    return {
      execution_status: 'command_ready_manual',
      command: manual.command,
      shell: manual.shell,
      execution_reason: 'auto_execute_disabled',
    };
  }

  // (2) autoExecute requested but the agent cannot be spawned here: this IS a
  // failure of the caller's intent. Surface spawnCheck.reason (previously
  // dropped) instead of returning a bare manual command.
  if (!spawnCheck.canSpawn) {
    const manual = adapter.prepareManualCommand(invoke, options);
    return {
      execution_status: 'command_ready_manual',
      command: manual.command,
      shell: manual.shell,
      error: spawnCheck.reason,
      failure_kind: 'not_spawnable',
      execution_reason: 'not_spawnable',
    };
  }

  // pln#531 — isolation invariant: a spawned worker MUST run in its own
  // worktree. If a worktree was required but none exists (creation failed, or a
  // claim was reused/re-dispatched without one), REFUSE to spawn instead of
  // falling back to options.cwd — which is the integration repo, where the
  // worker would edit the main tree directly (dangerous for an autonomous fleet,
  // a cross-project field debrief). Return the command for manual, isolated execution.
  if (options.requireWorktree && !options.worktreePath) {
    appendAuditEntry({
      actor: options.dispatcherAgent,
      actor_id: options.dispatcherAgentId,
      action: 'spawn_failed',
      item_id: options.claimId,
      item_type: 'claim',
      scope: options.agent,
      after: { reason: 'no_worktree', refused: true },
    }, options.cwd);
    const manual = adapter.prepareManualCommand(invoke, options);
    return {
      execution_status: 'command_ready_manual',
      command: manual.command,
      shell: manual.shell,
      error: 'Refusing to spawn without an isolated worktree: with no worktree the worker would run in the integration repo and edit the main tree. Fix worktree creation (see claim worktreeWarning) or run the command manually inside a worktree.',
      failure_kind: 'spawn_no_worktree',
      execution_reason: 'spawn_no_worktree',
    };
  }

  // Capacity guard: skip if agent is at max concurrent tasks
  if (options.cwd) {
    const instanceCheck = checkActiveInstance(options.agent, options.cwd);
    if (!instanceCheck.canSpawnMore) {
      appendAuditEntry({
        actor: options.dispatcherAgent,
        actor_id: options.dispatcherAgentId,
        action: 'spawn_failed',
        item_id: options.claimId,
        item_type: 'claim',
        scope: options.agent,
        after: { reason: instanceCheck.reason, active_sessions: instanceCheck.activeSessions, skipped: true },
      }, options.cwd);

      const manual = adapter.prepareManualCommand(invoke, options);
      return {
        execution_status: 'command_ready_manual',
        command: manual.command,
        shell: manual.shell,
        error: `Spawn skipped: ${instanceCheck.reason}. Use the command manually.`,
        failure_kind: 'spawn_capacity',
        execution_reason: 'spawn_capacity',
      };
    }
  }

  // Attempt spawn (await handles both sync and async adapters)
  try {
    // pln#476: pass ackRoot=options.cwd so the spawn wrap writes the
    // brief-ack sentinel under the project's coordination dir (not the
    // worktree's local store), where waitForAssignmentHandshake reads.
    const result = await adapter.start(invoke, { ...options, ackRoot: options.cwd });

    if (options.assignmentId && options.cwd) {
      // pln#475: TTL bumped from 5000 → 30000ms. Real workers (claude-code,
      // codex) take 8–15s to load the runtime + open the inbox + call
      // bclaw_assignment_update(accepted). 5s caused legitimate spawns to be
      // marked failed (trp#59 — observed during P1 dispatch on 2026-04-25).
      // Override with BRAINCLAW_HANDSHAKE_TIMEOUT_MS for very fast / very slow
      // environments. options.handshakeTimeoutMs (programmatic) wins over env.
      const envTimeout = process.env.BRAINCLAW_HANDSHAKE_TIMEOUT_MS;
      const parsedEnvTimeout = envTimeout ? Number.parseInt(envTimeout, 10) : NaN;
      const handshakeTimeoutMs =
        options.handshakeTimeoutMs ??
        (Number.isFinite(parsedEnvTimeout) && parsedEnvTimeout > 0 ? parsedEnvTimeout : 30_000);
      const handshakeOk = await waitForAssignmentHandshake(options.assignmentId, options.cwd, handshakeTimeoutMs);
      if (!handshakeOk) {
        appendAuditEntry({
          actor: options.dispatcherAgent,
          actor_id: options.dispatcherAgentId,
          action: 'spawn_failed',
          item_id: options.claimId,
          item_type: 'claim',
          scope: options.agent,
          after: { reason: `No assignment handshake within ${handshakeTimeoutMs}ms`, pid: result.pid, command: invoke.bashCommand },
        }, options.cwd);

        const manual = adapter.prepareManualCommand(invoke, options);
        return {
          execution_status: 'command_ready_manual',
          command: manual.command,
          shell: manual.shell,
          error: `Spawn launched (pid ${result.pid}) but assignment ${options.assignmentId} did not acknowledge within ${handshakeTimeoutMs}ms`,
          failure_kind: 'spawn_no_handshake',
          execution_reason: 'spawn_no_handshake',
          pid: result.pid,
        };
      }
    }

    // Audit success
    appendAuditEntry({
      actor: options.dispatcherAgent,
      actor_id: options.dispatcherAgentId,
      action: 'agent_spawned',
      item_id: options.claimId,
      item_type: 'claim',
      scope: options.agent,
      after: { pid: result.pid, command: invoke.bashCommand, worktree_path: options.worktreePath },
    }, options.cwd);

    return {
      execution_status: 'delivered_and_started',
      pid: result.pid,
      command: invoke.bashCommand,
      started_at: result.started_at,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    // Audit failure
    appendAuditEntry({
      actor: options.dispatcherAgent,
      actor_id: options.dispatcherAgentId,
      action: 'spawn_failed',
      item_id: options.claimId,
      item_type: 'claim',
      scope: options.agent,
      after: { error: errorMsg, command: invoke.bashCommand },
    }, options.cwd);

    // Graceful fallback — include BRAINCLAW_CLAIM_ID for manual routing
    const manual = adapter.prepareManualCommand(invoke, options);
    return {
      execution_status: 'command_ready_manual',
      command: manual.command,
      shell: manual.shell,
      error: `Spawn failed (${errorMsg}), falling back to manual execution`,
      failure_kind: 'spawn_failed',
      execution_reason: 'spawn_failed',
    };
  }
}
