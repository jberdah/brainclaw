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
import { getCapabilityProfile, type InvokeCommand } from './agent-capability.js';
import { appendAuditEntry } from './audit.js';
import { nowISO } from './ids.js';

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

  // Sandbox detection: MCP server processes have stdin piped (not TTY)
  // Allow override via env var for agents that know they can spawn
  if (process.env.BRAINCLAW_CAN_SPAWN === '1') {
    return { canSpawn: true, reason: 'BRAINCLAW_CAN_SPAWN override' };
  }

  if (!process.stdin.isTTY) {
    return { canSpawn: false, reason: 'running in MCP stdio context (stdin is not TTY)' };
  }

  return { canSpawn: true, reason: 'TTY context, agent is spawnable' };
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

  // Build spawn args based on delivery method
  let child;
  if (invoke.shell) {
    // Shell mode: run bashCommand via shell
    const shellCmd = isWin32 ? 'cmd' : 'bash';
    const shellArgs = isWin32 ? ['/c', invoke.bashCommand] : ['-c', invoke.bashCommand];
    child = spawn(shellCmd, shellArgs, {
      detached: true,
      stdio: 'ignore',
      cwd: options.worktreePath,
      env,
    });
  } else {
    // Direct mode: run executable with args
    child = spawn(invoke.executable, invoke.args, {
      detached: true,
      stdio: 'ignore',
      cwd: options.worktreePath,
      env,
    });
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
  if (!options.autoExecute || !spawnCheck.canSpawn) {
    return {
      execution_status: 'command_ready_manual',
      command: invoke.bashCommand,
      shell: invoke.shell ? 'bash' : invoke.executable,
    };
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

    // Graceful fallback
    return {
      execution_status: 'command_ready_manual',
      command: invoke.bashCommand,
      shell: invoke.shell ? 'bash' : invoke.executable,
      error: `Spawn failed (${errorMsg}), falling back to manual execution`,
    };
  }
}
