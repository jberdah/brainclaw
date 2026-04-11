/**
 * E2E dispatch execution — spawn agent processes after claim+inbox delivery.
 *
 * This module bridges the gap between dispatch (claim + inbox + brief) and
 * actual agent execution. It detects whether the coordinator can spawn CLI
 * processes and, if so, launches the agent in a detached subprocess.
 *
 * @module
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getCapabilityProfile, type InvokeCommand } from './agent-capability.js';
import { appendAuditEntry } from './audit.js';
import { nowISO } from './ids.js';
import { loadAllSessions } from './identity.js';
import { loadConfig } from './config.js';

// ── Types ───────────────────────────────────────────────────

export interface SpawnCapability {
  canSpawn: boolean;
  reason: string;
}

export interface SpawnResult {
  pid: number;
  started_at: string;
  status: 'started';
}

export interface ExecutionResult {
  execution_status: 'delivered_and_started' | 'command_ready_manual' | 'inbox_only';
  pid?: number;
  command?: string;
  shell?: string;
  started_at?: string;
  error?: string;
}

// ── Helpers ────────────────────────────────────────────────

/**
 * Build a cross-platform env prefix for BRAINCLAW_CLAIM_ID in manual commands.
 * POSIX: `BRAINCLAW_CLAIM_ID=clm_xxx `
 * Windows (cmd): `set BRAINCLAW_CLAIM_ID=clm_xxx && `
 */
function buildManualEnvPrefix(claimId?: string): string {
  if (!claimId) return '';
  if (process.platform === 'win32') {
    return `set BRAINCLAW_CLAIM_ID=${claimId} && `;
  }
  return `BRAINCLAW_CLAIM_ID=${claimId} `;
}

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
  const profile = getCapabilityProfile(agentName);
  if (!profile) {
    return { canSpawn: false, reason: `unknown agent profile: ${agentName}` };
  }
  if (!profile.runtime.spawnable_cli) {
    return { canSpawn: false, reason: `agent ${agentName} is not CLI-spawnable` };
  }
  if (!profile.invoke_template || !profile.invoke_binary) {
    return { canSpawn: false, reason: `agent ${agentName} has no invoke template` };
  }

  // Explicit opt-out via env var (e.g. true sandbox environments)
  if (process.env.BRAINCLAW_NO_SPAWN === '1') {
    return { canSpawn: false, reason: 'BRAINCLAW_NO_SPAWN is set' };
  }

  // Default: allow spawn. MCP stdio servers CAN spawn detached processes —
  // the old TTY check was overly conservative. If a true sandbox blocks
  // the spawn (e.g. Codex --full-auto), attemptExecution() catches the
  // error and falls back to command_ready_manual gracefully.
  return { canSpawn: true, reason: 'agent has spawnable profile' };
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
  const isWin32 = process.platform === 'win32';

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    ...(invoke.env ?? {}),
    ...(options.claimId ? { BRAINCLAW_CLAIM_ID: options.claimId } : {}),
  };

  // Pre-write prompt to temp file when using temp_file delivery.
  // buildInvokeCommand generates the path but does NOT write the file —
  // the bashCommand embeds a printf for manual copy-paste, but spawn()
  // in direct mode bypasses the shell, so we must write it ourselves.
  if (invoke.promptDelivery === 'temp_file' && invoke.tempFilePath && invoke.promptText) {
    const dir = path.dirname(invoke.tempFilePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(invoke.tempFilePath, invoke.promptText, 'utf-8');
  }

  // Decide stdio mode: stdin_pipe needs a writable stdin
  const needsStdin = invoke.promptDelivery === 'stdin_pipe' && invoke.promptText;
  const stdio = needsStdin ? ['pipe' as const, 'ignore' as const, 'ignore' as const] : 'ignore' as const;

  // Always use direct mode (shell: false) — the args are pre-interpolated
  const child = spawn(invoke.executable, invoke.args, {
    detached: true,
    stdio,
    cwd: options.worktreePath,
    env,
    windowsHide: true,
  });

  // For stdin_pipe delivery, write the prompt to stdin then close
  if (needsStdin && child.stdin) {
    child.stdin.write(invoke.promptText!);
    child.stdin.end();
  }

  // Detach from parent process
  child.unref();

  const pid = child.pid;
  if (!pid) {
    throw new Error(`Failed to spawn agent ${options.agent}: no PID returned`);
  }

  return {
    pid,
    started_at: nowISO(),
    status: 'started',
  };
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
export function attemptExecution(
  invoke: InvokeCommand | undefined,
  options: {
    agent: string;
    autoExecute: boolean;
    worktreePath?: string;
    claimId?: string;
    dispatcherAgent: string;
    dispatcherAgentId?: string;
    cwd?: string;
  },
): ExecutionResult {
  // No invoke command available (IDE-only agents, etc.)
  if (!invoke) {
    return { execution_status: 'inbox_only' };
  }

  const spawnCheck = canSpawnAgent(options.agent);

  // Opt-out or can't spawn: return command for manual execution
  // Prepend BRAINCLAW_CLAIM_ID so manual copy-paste still routes correctly
  if (!options.autoExecute || !spawnCheck.canSpawn) {
    const envPrefix = buildManualEnvPrefix(options.claimId);
    return {
      execution_status: 'command_ready_manual',
      command: `${envPrefix}${invoke.bashCommand}`,
      shell: invoke.shell ? 'bash' : invoke.executable,
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

      const envPrefix2 = buildManualEnvPrefix(options.claimId);
      return {
        execution_status: 'command_ready_manual',
        command: `${envPrefix2}${invoke.bashCommand}`,
        shell: invoke.shell ? 'bash' : invoke.executable,
        error: `Spawn skipped: ${instanceCheck.reason}. Use the command manually.`,
      };
    }
  }

  // Attempt spawn
  try {
    const result = executeDispatchedCommand(invoke, {
      worktreePath: options.worktreePath,
      claimId: options.claimId,
      agent: options.agent,
    });

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
    const envPrefix3 = buildManualEnvPrefix(options.claimId);
    return {
      execution_status: 'command_ready_manual',
      command: `${envPrefix3}${invoke.bashCommand}`,
      shell: invoke.shell ? 'bash' : invoke.executable,
      error: `Spawn failed (${errorMsg}), falling back to manual execution`,
    };
  }
}
