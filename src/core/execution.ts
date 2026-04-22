/**
 * E2E dispatch execution — spawn agent processes after claim+inbox delivery.
 *
 * This module bridges the gap between dispatch (claim + inbox + brief) and
 * actual agent execution. It detects whether the coordinator can spawn CLI
 * processes and, if so, launches the agent in a detached subprocess.
 *
 * @module
 */
import { getCapabilityProfile, type InvokeCommand } from './agent-capability.js';
import { appendAuditEntry } from './audit.js';
import { loadAllSessions } from './identity.js';
import { loadConfig } from './config.js';
import { loadAssignment } from './assignments.js';
import {
  defaultExecutionAdapter,
  type ExecutionAdapter,
  type SpawnCapability,
  type SpawnResult,
} from './execution-adapters.js';

// ── Types ───────────────────────────────────────────────────

export interface ExecutionResult {
  execution_status: 'delivered_and_started' | 'command_ready_manual' | 'inbox_only';
  pid?: number;
  command?: string;
  shell?: string;
  started_at?: string;
  error?: string;
  failure_kind?: 'spawn_no_handshake' | 'spawn_failed' | 'spawn_capacity';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAssignmentHandshake(
  assignmentId: string,
  cwd: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const assignment = loadAssignment(assignmentId, cwd);
    if (!assignment) return false;
    if (assignment.status !== 'created' && assignment.status !== 'offered') {
      return true;
    }
    await sleep(100);
  }
  const finalAssignment = loadAssignment(assignmentId, cwd);
  return !!finalAssignment && finalAssignment.status !== 'created' && finalAssignment.status !== 'offered';
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

  const activeSessions: string[] = [];
  for (const session of sessions) {
    if (session.agent !== agentName) continue;
    const lastSeen = new Date(session.last_seen_at).getTime();
    if (isNaN(lastSeen)) continue;
    if (now - lastSeen < SESSION_STALE_MS) {
      activeSessions.push(session.session_id);
    }
  }

  const profile = getCapabilityProfile(agentName);
  const maxAllowed = profile?.max_concurrent_tasks ?? 1;
  const activeCount = activeSessions.length;
  const canSpawnMore = activeCount < maxAllowed;

  return {
    active: !canSpawnMore, // backward compat: active=true means "cannot spawn more"
    canSpawnMore,
    activeCount,
    maxAllowed,
    reason: canSpawnMore
      ? `Agent ${agentName} has capacity (${activeCount}/${maxAllowed} slots used)`
      : `Agent ${agentName} at capacity (${activeCount}/${maxAllowed} slots used)`,
    activeSessions,
  };
}

// ── Spawn detection ─────────────────────────────────────────

/**
 * Check if the coordinator can spawn an agent as a CLI subprocess.
 *
 * Returns canSpawn=true when:
 * 1. The target agent has runtime.spawnable_cli = true in its profile
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
  },
): Promise<ExecutionResult> {
  const adapter = options.adapter ?? defaultExecutionAdapter;

  // No invoke command available (IDE-only agents, etc.)
  if (!invoke) {
    return { execution_status: 'inbox_only' };
  }

  const spawnCheck = adapter.canSpawn(options.agent);

  // Opt-out or can't spawn: return command for manual execution
  // Prepend BRAINCLAW_CLAIM_ID so manual copy-paste still routes correctly
  if (!options.autoExecute || !spawnCheck.canSpawn) {
    const manual = adapter.prepareManualCommand(invoke, options);
    return {
      execution_status: 'command_ready_manual',
      command: manual.command,
      shell: manual.shell,
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
      };
    }
  }

  // Attempt spawn (await handles both sync and async adapters)
  try {
    const result = await adapter.start(invoke, options);

    if (options.assignmentId && options.cwd) {
      const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5000;
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
    };
  }
}
