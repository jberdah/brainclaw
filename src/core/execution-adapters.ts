import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildClaimEnvPrefix } from './execution-profile.js';
import { getCapabilityProfile, type InvokeCommand } from './agent-capability.js';
import { nowISO } from './ids.js';

/**
 * Check if a binary is resolvable on the system PATH.
 * On Windows, `spawn({shell:true})` always succeeds (launches cmd.exe),
 * masking ENOENT for missing binaries. This pre-check catches that.
 */
function resolveBinaryOnPath(binary: string): string | undefined {
  // Absolute or relative path — check directly
  if (binary.includes('/') || binary.includes('\\')) {
    return fs.existsSync(binary) ? binary : undefined;
  }
  try {
    if (process.platform === 'win32') {
      const output = execFileSync('where', [binary], { encoding: 'utf-8', timeout: 5000 });
      const matches = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (matches.length === 0) return undefined;
      return (
        matches.find((candidate) => /\.(exe|com)$/i.test(candidate)) ??
        matches.find((candidate) => /\.(cmd|bat)$/i.test(candidate)) ??
        matches[0]
      );
    } else {
      const output = execFileSync('which', [binary], { encoding: 'utf-8', timeout: 5000 }).trim();
      return output || undefined;
    }
  } catch {
    return undefined;
  }
}

export interface SpawnCapability {
  canSpawn: boolean;
  reason: string;
}

export interface SpawnResult {
  pid: number;
  started_at: string;
  status: 'started';
}

export interface ManualExecutionCommand {
  command: string;
  shell: string;
}

export interface ExecutionAdapterStartOptions {
  worktreePath?: string;
  claimId?: string;
  agent: string;
  /**
   * Assignment id to wire the brief-ack file (pln#476). When set, the
   * spawn command is wrapped to `touch` the sentinel at
   * `.brainclaw/coordination/runtime/ack/<assignmentId>.ack` BEFORE the
   * agent binary executes. The dispatcher's waitForAssignmentHandshake
   * then accepts the ack file as evidence the worker is alive — needed
   * for agents (codex) spawned without brainclaw MCP wired.
   */
  assignmentId?: string;
  /**
   * Project root used to compute the absolute ack path. Defaults to
   * worktreePath when omitted, but the dispatcher passes the parent
   * project cwd because the ack file lives in the project's
   * coordination dir, not in the worktree's local store.
   */
  ackRoot?: string;
}

export interface ExecutionAdapter {
  id: string;
  canSpawn(agentName: string): SpawnCapability;
  prepareManualCommand(invoke: InvokeCommand, options: ExecutionAdapterStartOptions): ManualExecutionCommand;
  start(invoke: InvokeCommand, options: ExecutionAdapterStartOptions): SpawnResult | Promise<SpawnResult>;
  status?(runId: string): Promise<unknown> | unknown;
  interrupt?(runId: string, reason?: string): Promise<unknown> | unknown;
  cancel?(runId: string, reason?: string): Promise<unknown> | unknown;
  collectArtifacts?(runId: string): Promise<unknown> | unknown;
}

function buildManualEnvPrefix(claimId?: string): string {
  // pln#496 step stp_a9afe59d: the cross-platform / cross-shell logic
  // now lives in execution-profile.ts:buildClaimEnvPrefix. Keep this
  // wrapper for symmetry with the dispatcher's buildEnvPrefix.
  return buildClaimEnvPrefix(claimId);
}

export class CliExecutionAdapter implements ExecutionAdapter {
  readonly id = 'cli';

  canSpawn(agentName: string): SpawnCapability {
    const profile = getCapabilityProfile(agentName);
    if (!profile) {
      return { canSpawn: false, reason: `unknown agent profile: ${agentName}` };
    }
    if (!profile.runtime.canBeSpawnedCli) {
      return { canSpawn: false, reason: `agent ${agentName} is not CLI-spawnable` };
    }
    if (!profile.invoke_template || !profile.invoke_binary) {
      return { canSpawn: false, reason: `agent ${agentName} has no invoke template` };
    }

    if (process.env.BRAINCLAW_NO_SPAWN === '1') {
      return { canSpawn: false, reason: 'BRAINCLAW_NO_SPAWN is set' };
    }

    return { canSpawn: true, reason: 'agent has spawnable profile' };
  }

  prepareManualCommand(invoke: InvokeCommand, options: ExecutionAdapterStartOptions): ManualExecutionCommand {
    const envPrefix = buildManualEnvPrefix(options.claimId);
    return {
      command: `${envPrefix}${invoke.bashCommand}`,
      shell: process.platform === 'win32' ? 'cmd' : (invoke.shell ? 'bash' : 'sh'),
    };
  }

  start(invoke: InvokeCommand, options: ExecutionAdapterStartOptions): SpawnResult {
    const isWin32 = process.platform === 'win32';

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...(invoke.env ?? {}),
      ...(options.claimId ? { BRAINCLAW_CLAIM_ID: options.claimId } : {}),
    };

    if (invoke.promptDelivery === 'temp_file' && invoke.tempFilePath && invoke.promptText) {
      const dir = path.dirname(invoke.tempFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(invoke.tempFilePath, invoke.promptText, 'utf-8');
    }

    // Pre-check: on Windows shell:true masks ENOENT (cmd.exe spawns OK, exits 1 silently)
    const resolvedExecutable = isWin32
      ? resolveBinaryOnPath(invoke.executable)
      : invoke.executable;

    if (isWin32 && !resolvedExecutable) {
      throw new Error(
        `Cannot spawn agent ${options.agent}: binary '${invoke.executable}' not found on PATH`,
      );
    }

    const spawnExecutable = resolvedExecutable ?? invoke.executable;
    const useShell = isWin32 && /\.(cmd|bat)$/i.test(spawnExecutable);

    const needsStdin = invoke.promptDelivery === 'stdin_pipe' && invoke.promptText;

    // pln#504: open per-assignment log files for stdout/stderr capture so silent
    // worker deaths (trp#292) become diagnosable. Previously stdio used 'ignore'
    // for stdout+stderr — anything the worker said vanished. Best-effort: on
    // failure to open log files we fall back to the legacy 'ignore' behaviour
    // rather than abort the spawn.
    const useAckWrap = !!(options.assignmentId && (options.ackRoot ?? options.worktreePath));
    let logFds: { stdout: number; stderr: number } | undefined;
    if (useAckWrap) {
      try {
        const logRoot = options.ackRoot ?? options.worktreePath!;
        const logDir = path.join(logRoot, '.brainclaw', 'coordination', 'runtime', 'log');
        fs.mkdirSync(logDir, { recursive: true });
        logFds = {
          stdout: fs.openSync(path.join(logDir, `${options.assignmentId!}.stdout.log`), 'a'),
          stderr: fs.openSync(path.join(logDir, `${options.assignmentId!}.stderr.log`), 'a'),
        };
      } catch {
        // Log capture is best-effort — never block the spawn on logging issues.
        logFds = undefined;
      }
    }

    const stdinTarget: 'pipe' | 'ignore' = needsStdin ? 'pipe' : 'ignore';
    const stdoutTarget: number | 'ignore' = logFds ? logFds.stdout : 'ignore';
    const stderrTarget: number | 'ignore' = logFds ? logFds.stderr : 'ignore';
    const stdio: ('pipe' | 'ignore' | number)[] = [stdinTarget, stdoutTarget, stderrTarget];

    // pln#476: wrap the spawn command with a brief-ack step so the worker
    // shell touches a sentinel file BEFORE the agent binary runs.
    // waitForAssignmentHandshake checks that file as evidence the spawn
    // executed — needed for codex (which lacks the brainclaw MCP context
    // to call bclaw_assignment_update). When ackRoot/assignmentId are
    // omitted, we keep the original direct-binary spawn.
    let child;
    if (useAckWrap) {
      const ackRoot = options.ackRoot ?? options.worktreePath!;
      const ackDir = path.join(ackRoot, '.brainclaw', 'coordination', 'runtime', 'ack');
      const ackPath = path.join(ackDir, `${options.assignmentId!}.ack`);
      fs.mkdirSync(ackDir, { recursive: true });
      const ackStep = isWin32
        ? `type nul > "${ackPath}"`
        : `touch "${ackPath}"`;
      const wrappedCmd = `${ackStep} && ${invoke.bashCommand}`;
      child = spawn(wrappedCmd, [], {
        detached: !isWin32,
        shell: true,
        stdio,
        cwd: options.worktreePath,
        env,
        windowsHide: true,
      });
    } else {
      child = spawn(spawnExecutable, invoke.args, {
        // Windows: detached is unreliable with shell:true — child stays in parent's process group.
        // POSIX: detached lets the child survive parent exit.
        detached: !isWin32,
        shell: useShell,
        stdio,
        cwd: options.worktreePath,
        env,
        windowsHide: true,
      });
    }

    // Swallowed to prevent unhandled 'error' event crash.
    // On POSIX ENOENT: pid is undefined → the throw below handles it.
    // On Windows shell:true: this never fires for ENOENT (cmd.exe succeeds);
    // the isBinaryOnPath pre-check above catches that case instead.
    child.on('error', () => { /* intentionally swallowed */ });

    if (needsStdin && child.stdin) {
      child.stdin.write(invoke.promptText!);
      child.stdin.end();
    }

    child.unref();

    // Close the parent's copies of the log file descriptors. The child has its
    // own dup'd copies and will keep writing to them after we return.
    if (logFds) {
      try { fs.closeSync(logFds.stdout); } catch { /* best-effort */ }
      try { fs.closeSync(logFds.stderr); } catch { /* best-effort */ }
    }

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
}

export const defaultExecutionAdapter = new CliExecutionAdapter();
