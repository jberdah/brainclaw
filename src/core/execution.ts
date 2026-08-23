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
import { getRuntimeSignalPath, readContractAck } from './runtime-signals.js';
import { appendAuditEntry } from './audit.js';
import { loadAllSessions } from './identity.js';
import { loadConfig } from './config.js';
import { loadAssignment } from './assignments.js';
import { recordExecutionContractAnomaly } from './agentruns.js';
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
  failure_kind?: 'spawn_no_handshake' | 'spawn_failed' | 'spawn_capacity' | 'spawn_no_worktree' | 'not_spawnable' | 'contract_acceptance_anomaly';
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
    | 'contract_acceptance_anomaly'
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
export function getAssignmentAckPath(cwd: string, assignmentId: string, runId?: string): string {
  return getRuntimeSignalPath(cwd, assignmentId, 'ack', runId);
}

function isAssignmentAcked(assignmentId: string, cwd: string, runId?: string): boolean {
  // Fast path: the brief-ack sentinel was written by the worker shell.
  if (fs.existsSync(getAssignmentAckPath(cwd, assignmentId, runId))) return true;
  // A v2 generation must acknowledge its own run-scoped bootstrap. The stable
  // Assignment may already be running/completed because of a prior epoch.
  if (runId) return false;
  // Standard path: the worker called bclaw_assignment_update via MCP and
  // moved the assignment past the offered/created state.
  const assignment = loadAssignment(assignmentId, cwd);
  return !!assignment && assignment.status !== 'created' && assignment.status !== 'offered';
}

async function waitForAssignmentHandshake(
  assignmentId: string,
  cwd: string,
  timeoutMs: number,
  runId?: string,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isAssignmentAcked(assignmentId, cwd, runId)) return true;
    await sleep(100);
  }
  return isAssignmentAcked(assignmentId, cwd, runId);
}

function normalizeWorkspacePath(value: string): string | undefined {
  try {
    const resolved = fs.realpathSync.native(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  } catch {
    return undefined;
  }
}

function contractAckMatches(
  assignmentId: string,
  cwd: string,
  turnEcho: TurnEcho,
  expectedWorkspacePath?: string,
): boolean {
  if (!turnEcho.contract_hash || !turnEcho.capability_snapshot_hash) return true;
  const parsed = readContractAck(cwd, assignmentId, turnEcho.run_id);
  const expectedWorkspace = expectedWorkspacePath ? normalizeWorkspacePath(expectedWorkspacePath) : undefined;
  return parsed?.status === 'accepted'
    && parsed.turn_id === turnEcho.turn_id
    && parsed.run_id === turnEcho.run_id
    && parsed.nonce === turnEcho.nonce
    && parsed.contract_hash === turnEcho.contract_hash
    && parsed.capability_snapshot_hash === turnEcho.capability_snapshot_hash
    && (turnEcho.attempt_epoch === undefined || parsed.attempt_epoch === turnEcho.attempt_epoch)
    && (turnEcho.workspace_digest === undefined || parsed.workspace_digest === turnEcho.workspace_digest)
    && (!expectedWorkspace || parsed.cwd === expectedWorkspace);
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
  const contracted = Boolean(options.turnEcho?.contract_hash && options.turnEcho.capability_snapshot_hash);
  const fenceContractedGeneration = (
    reason: string,
    processInfo?: { pid?: number; started_at?: string },
  ): ExecutionResult => {
    if (options.turnEcho) {
      try {
        recordExecutionContractAnomaly(options.turnEcho.run_id, {
          source: 'bootstrap_ack',
          reason,
        }, options.cwd);
      } catch { /* a rejected/missing ack remains the fallback fence */ }
    }
    return {
      execution_status: processInfo?.pid ? 'delivered_and_started' : 'inbox_only',
      pid: processInfo?.pid,
      started_at: processInfo?.started_at,
      error: `${reason}; contracted generation is fenced and MUST NOT be respawned`,
      failure_kind: 'contract_acceptance_anomaly',
      execution_reason: 'contract_acceptance_anomaly',
    };
  };
  const prepareManual = (): ReturnType<ExecutionAdapter['prepareManualCommand']> | undefined => {
    // A custom adapter cannot self-attest that its opaque command contains the
    // native bootstrap/env/sentinel fence. Until the adapter contract becomes
    // declarative, only the core adapter may emit contracted manual launches.
    if (contracted && adapter !== defaultExecutionAdapter) return undefined;
    const manual = adapter.prepareManualCommand(invoke!, { ...options, ackRoot: options.cwd });
    if (contracted && !manual.contractWrapped) return undefined;
    return manual;
  };

  // No invoke command available (IDE-only agents, etc.)
  if (!invoke) {
    if (contracted) return fenceContractedGeneration('no contract-capable invoke command is available after crossing');
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
    const manual = prepareManual();
    if (!manual) return fenceContractedGeneration('execution adapter cannot produce a contract-wrapped manual command');
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
    const manual = prepareManual();
    if (!manual) return fenceContractedGeneration(`agent is not spawnable and the adapter cannot produce a contract-wrapped manual command: ${spawnCheck.reason}`);
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
    const manual = prepareManual();
    if (!manual) return fenceContractedGeneration('worktree is missing and the adapter cannot produce a contract-wrapped manual command');
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

      const manual = prepareManual();
      if (!manual) return fenceContractedGeneration(`capacity is exhausted and the adapter cannot produce a contract-wrapped manual command: ${instanceCheck.reason}`);
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
      const handshakeOk = await waitForAssignmentHandshake(
        options.assignmentId,
        options.cwd,
        handshakeTimeoutMs,
        options.turnEcho?.run_id,
      );
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

        if (contracted) {
          return fenceContractedGeneration(
            `spawn launched but contract bootstrap did not acknowledge within ${handshakeTimeoutMs}ms`,
            { pid: result.pid, started_at: result.started_at },
          );
        }
        const manual = prepareManual()!;
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
      if (options.turnEcho && !contractAckMatches(
        options.assignmentId,
        options.cwd,
        options.turnEcho,
        options.worktreePath,
      )) {
        const accepted = readContractAck(options.cwd, options.assignmentId, options.turnEcho.run_id);
        let anomalyPersistenceError: string | undefined;
        try {
          recordExecutionContractAnomaly(options.turnEcho.run_id, {
            source: 'bootstrap_ack',
            reason: 'bootstrap rejected, omitted or changed the immutable execution contract',
            accepted_contract_hash: accepted?.contract_hash,
            accepted_capability_snapshot_hash: accepted?.capability_snapshot_hash,
          }, options.cwd);
        } catch (error) {
          anomalyPersistenceError = error instanceof Error ? error.message : String(error);
        }
        appendAuditEntry({
          actor: options.dispatcherAgent,
          actor_id: options.dispatcherAgentId,
          action: 'spawn_failed',
          item_id: options.assignmentId,
          item_type: 'agent_run',
          scope: options.agent,
          after: {
            reason: 'post-crossing execution-contract acceptance mismatch or missing ack; respawn=false',
            pid: result.pid,
            accepted,
            anomaly_persistence_error: anomalyPersistenceError,
          },
        }, options.cwd);
        return {
          execution_status: 'delivered_and_started',
          started_at: result.started_at,
          pid: result.pid,
          error: `Worker/bootstrap did not acknowledge execution contract ${options.turnEcho.contract_hash ?? 'legacy'} exactly; run is anomalous and MUST NOT be respawned`,
          failure_kind: 'contract_acceptance_anomaly',
          execution_reason: 'contract_acceptance_anomaly',
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

    // Once a contracted generation crossed, an uncertain spawn outcome can
    // never degrade to a second/manual launch. Legacy dispatch keeps fallback.
    if (contracted) {
      return fenceContractedGeneration(`spawn failed after the launch fence crossed (${errorMsg})`);
    }
    const manual = prepareManual()!;
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
