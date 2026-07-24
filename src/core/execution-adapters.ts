import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildClaimEnvPrefix, buildWorkerIdentityEnv } from './execution-profile.js';
import { getCapabilityProfile, type InvokeCommand } from './agent-capability.js';
import { nowISO } from './ids.js';
import {
  ensureRuntimeDirs,
  getRuntimeLogPath,
  getRuntimeSignalPath,
} from './runtime-signals.js';

/**
 * pln#520 step 4 — wrap a spawn command so the worker shell (a) touches the
 * pre-exec `ack` sentinel, (b) redirects the agent's stdout/stderr to per-
 * assignment log files AT THE SHELL LEVEL (fds are not inherited through the
 * cmd.exe → .cmd → node shim, which is why logs came back empty — can_f792cacd),
 * and (c) emits a `completed` / `failed` sentinel MECHANICALLY from the agent's
 * exit code so a dead wrapper pid is never misread as a silent failure.
 *
 * The agent command runs inside a group so it inherits the parent's stdin
 * (prompt delivery via the pipe is preserved); only stdout/stderr are
 * redirected.
 */
export interface AckWrapPaths {
  ackPath: string;
  completedPath: string;
  failedPath: string;
  stdoutLog: string;
  stderrLog: string;
}

/**
 * pln#630 PR2c — turn-attempt correlation echoed into the completion sentinel.
 * When present, the mechanical wrapper writes a turn-keyed JSON body (instead of
 * an empty presence marker) so the read-strict acceptance path can prove WHICH
 * attempt+generation finished. The wrapper is the COORDINATOR shell (not the
 * sandboxed agent), so it can always write the project-root sentinel. All three
 * values are `[A-Za-z0-9_-]` (tat_/run_ hex, uuid) → no shell metacharacters on
 * cmd.exe or POSIX. `at` is intentionally omitted (readCompletionSignal defaults
 * it) to keep the shell one-liner robust.
 */
export interface TurnEcho {
  turn_id: string;
  run_id: string;
  nonce: string;
}

export function buildAckWrapCommand(bashCommand: string, paths: AckWrapPaths, isWin32: boolean, turnEcho?: TurnEcho): string {
  const touch = isWin32
    ? (p: string) => `type nul > "${p}"`
    : (p: string) => `touch "${p}"`;
  // completed/failed marker: a turn-keyed JSON body when turnEcho is present,
  // else the legacy empty touch (byte-for-byte unchanged for non-turn-owned
  // spawns — full back-compat).
  const marker = (p: string, status: 'completed' | 'failed'): string => {
    if (!turnEcho) return touch(p);
    const body = JSON.stringify({ turn_id: turnEcho.turn_id, run_id: turnEcho.run_id, nonce: turnEcho.nonce, status });
    return isWin32 ? `echo ${body}>"${p}"` : `printf '%s' '${body}' > "${p}"`;
  };
  const redirected = `${bashCommand} > "${paths.stdoutLog}" 2> "${paths.stderrLog}"`;
  return (
    `${touch(paths.ackPath)} && ` +
    `( ${redirected} && ${marker(paths.completedPath, 'completed')} || ${marker(paths.failedPath, 'failed')} )`
  );
}

/**
 * Check if a binary is resolvable on the system PATH.
 * On Windows, `spawn({shell:true})` always succeeds (launches cmd.exe),
 * masking ENOENT for missing binaries. This pre-check catches that.
 */
export function resolveBinaryOnPath(binary: string): string | undefined {
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
  /**
   * pln#630 PR2c — when set, the ack-wrap writes a turn-keyed JSON completion
   * body (see {@link TurnEcho}) so a turn-owned run converges under read-strict
   * acceptance. Absent → legacy empty presence marker. Flows in from the
   * turn-owned dispatch path (PR2c-b).
   */
  turnEcho?: TurnEcho;
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

/**
 * Git author identity for a dispatched worker (pln#562 step 5). The email is
 * a deterministic non-routable address so `git log --author` can filter by
 * agent. Committer mirrors author so neither field lies about provenance.
 */
export function buildGitAttributionEnv(agent: string | undefined): Record<string, string> {
  const name = agent?.trim();
  if (!name) return {};
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  const display = `${name} (via brainclaw)`;
  const email = `${slug}@agents.brainclaw.dev`;
  return {
    GIT_AUTHOR_NAME: display,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: display,
    GIT_COMMITTER_EMAIL: email,
  };
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

    // F7 (trp_0e5150d3): route worker env through buildWorkerIdentityEnv so the
    // worker is an independent agent — coordinator identity (BRAINCLAW_AGENT*,
    // SESSION_ID, PROJECT) is scrubbed LAST and cannot be reintroduced by
    // invoke.env. pln#562 step 5 — truthful git attribution (worker authors its
    // own commits) is merged before the scrub. BRAINCLAW_CWD is preserved (D1a).
    const env = buildWorkerIdentityEnv(process.env, {
      agent: options.agent,
      claimId: options.claimId,
      extraEnv: { ...buildGitAttributionEnv(options.agent), ...(invoke.env ?? {}) },
    });

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

    // pln#520 step 4: when we ack-wrap, the SHELL redirects stdout/stderr to the
    // per-assignment log files (fds passed via stdio are NOT inherited through
    // the cmd.exe → .cmd → node shim — the empty-logs bug of can_f792cacd), and
    // the wrapper emits completed/failed sentinels mechanically. So the spawned
    // process just ignores stdout/stderr here. stdin stays a pipe when the
    // prompt is delivered that way (the grouped agent command inherits it).
    const useAckWrap = !!(options.assignmentId && (options.ackRoot ?? options.worktreePath));

    const stdinTarget: 'pipe' | 'ignore' = needsStdin ? 'pipe' : 'ignore';
    const stdio: ('pipe' | 'ignore')[] = [stdinTarget, 'ignore', 'ignore'];

    // pln#476 + pln#520 step 4: wrap the spawn so the worker shell touches the
    // pre-exec `ack` sentinel, redirects logs at the shell level, and emits a
    // completed/failed sentinel from the agent's exit code. waitForAssignmentHandshake
    // checks the ack file; the reconciler trusts the completed/failed/heartbeat
    // sentinels rather than the (untrustworthy) wrapper pid. When ackRoot/
    // assignmentId are omitted, we keep the original direct-binary spawn.
    let child;
    if (useAckWrap) {
      const signalRoot = options.ackRoot ?? options.worktreePath!;
      ensureRuntimeDirs(signalRoot);
      const wrappedCmd = buildAckWrapCommand(invoke.bashCommand, {
        ackPath: getRuntimeSignalPath(signalRoot, options.assignmentId!, 'ack'),
        completedPath: getRuntimeSignalPath(signalRoot, options.assignmentId!, 'completed'),
        failedPath: getRuntimeSignalPath(signalRoot, options.assignmentId!, 'failed'),
        stdoutLog: getRuntimeLogPath(signalRoot, options.assignmentId!, 'stdout'),
        stderrLog: getRuntimeLogPath(signalRoot, options.assignmentId!, 'stderr'),
      }, isWin32, options.turnEcho);
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
