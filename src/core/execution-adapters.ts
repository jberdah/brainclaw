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
 * The agent command runs inside a group. POSIX workers can inherit the parent
 * stdin pipe. Windows ack-wrapped workers instead redirect stdin from a
 * per-run file: cmd.exe does not reliably propagate EOF from its own stdin to
 * a native grandchild (notably `codex.exe`), which can otherwise deadlock.
 */
export interface AckWrapPaths {
  ackPath: string;
  completedPath: string;
  failedPath: string;
  stdoutLog: string;
  stderrLog: string;
  /** Optional prompt file redirected to worker stdin and removed by the wrapper. */
  stdinFilePath?: string;
  /** Child-process bootstrap that attests the effective environment before exec. */
  contractBootstrapPath?: string;
  /** Workspace in which the worker must actually execute. */
  expectedWorkspacePath?: string;
}

const CONTRACT_BOOTSTRAP_SOURCE = `'use strict';
const fs = require('node:fs');
const [ackPath, turnId, runId, nonce, expectedContractHash, expectedSnapshotHash, attemptEpoch, workspaceDigest, expectedWorkspaceB64] = process.argv.slice(2);
const contractHash = process.env.BRAINCLAW_EXECUTION_CONTRACT_HASH || '';
const snapshotHash = process.env.BRAINCLAW_CAPABILITY_SNAPSHOT_HASH || '';
const normalize = (value) => {
  let resolved = fs.realpathSync.native(value);
  if (process.platform === 'win32') resolved = resolved.toLowerCase();
  return resolved;
};
const expectedWorkspace = Buffer.from(expectedWorkspaceB64 || '', 'base64url').toString('utf8');
const actualCwd = normalize(process.cwd());
const accepted = contractHash === expectedContractHash
  && snapshotHash === expectedSnapshotHash
  && expectedWorkspace !== ''
  && actualCwd === normalize(expectedWorkspace);
let fd;
try {
  fd = fs.openSync(ackPath, 'wx');
} catch (error) {
  if (error && error.code === 'EEXIST') process.exit(79);
  throw error;
}
try {
  fs.writeFileSync(fd, JSON.stringify({
    status: accepted ? 'accepted' : 'rejected',
    turn_id: turnId,
    run_id: runId,
    nonce,
    ...(attemptEpoch ? { attempt_epoch: Number(attemptEpoch) } : {}),
    ...(workspaceDigest ? { workspace_digest: workspaceDigest } : {}),
    contract_hash: contractHash,
    capability_snapshot_hash: snapshotHash,
    cwd: actualCwd,
  }));
} finally {
  fs.closeSync(fd);
}
if (!accepted) process.exitCode = 78;
`;

/** Materialize the tiny child bootstrap used by both cmd.exe and POSIX shells. */
export function writeContractBootstrapScript(scriptPath: string): void {
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  try {
    if (fs.readFileSync(scriptPath, 'utf8') === CONTRACT_BOOTSTRAP_SOURCE) return;
  } catch { /* create or replace below */ }
  fs.writeFileSync(scriptPath, CONTRACT_BOOTSTRAP_SOURCE, 'utf8');
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
  /** Present for ExecutionContract v1 attempts; omitted for legacy reservations. */
  contract_hash?: string;
  capability_snapshot_hash?: string;
  /** AttemptAuthority v2 full-fence coordinates. */
  attempt_epoch?: number;
  workspace_digest?: string;
}

// The turn-echo values are raw-embedded into a shell one-liner (see marker()),
// so the `[A-Za-z0-9_-]` safety invariant documented on TurnEcho is LOAD-BEARING,
// not cosmetic. A stray `"` desyncs cmd.exe quote-parity (no sentinel file is
// written → the turn-owned run never converges under read-strict acceptance —
// exactly the §13 D2 non-convergence this feature prevents); a `'` breaks out of
// the POSIX `printf '…'` wrapper. All real sources (deriveTurnId/deriveChildIds
// hex, crypto.randomUUID nonce) satisfy it, so this guard never fires in
// production — it exists to turn a future out-of-class caller's SILENT corruption
// into a loud, fast failure at the embed site.
const TURN_ECHO_SAFE = /^[A-Za-z0-9_-]+$/;

export function buildAckWrapCommand(bashCommand: string, paths: AckWrapPaths, isWin32: boolean, turnEcho?: TurnEcho): string {
  if (turnEcho) {
    for (const [field, value] of Object.entries(turnEcho)) {
      if (value === undefined) continue;
      if (!TURN_ECHO_SAFE.test(String(value))) {
        throw new Error(
          `buildAckWrapCommand: turnEcho.${field} must match ${TURN_ECHO_SAFE} to be shell-safe for the completion sentinel (got ${JSON.stringify(value)})`,
        );
      }
    }
  }
  const touch = isWin32
    ? (p: string) => `type nul > "${p}"`
    : (p: string) => `touch "${p}"`;
  // completed/failed marker: a turn-keyed JSON body when turnEcho is present,
  // else the legacy empty touch (byte-for-byte unchanged for non-turn-owned
  // spawns — full back-compat).
  const marker = (p: string, status: 'completed' | 'failed'): string => {
    if (!turnEcho) return touch(p);
    const body = JSON.stringify({
      turn_id: turnEcho.turn_id,
      run_id: turnEcho.run_id,
      nonce: turnEcho.nonce,
      ...(turnEcho.contract_hash ? { contract_hash: turnEcho.contract_hash } : {}),
      ...(turnEcho.capability_snapshot_hash ? { capability_snapshot_hash: turnEcho.capability_snapshot_hash } : {}),
      ...(turnEcho.attempt_epoch !== undefined ? { attempt_epoch: turnEcho.attempt_epoch } : {}),
      ...(turnEcho.workspace_digest ? { workspace_digest: turnEcho.workspace_digest } : {}),
      status,
    });
    return isWin32 ? `echo ${body}>"${p}"` : `printf '%s' '${body}' > "${p}"`;
  };
  const ack = (() => {
    if (!turnEcho?.contract_hash || !turnEcho.capability_snapshot_hash) return touch(paths.ackPath);
    if (!paths.contractBootstrapPath) {
      throw new Error('buildAckWrapCommand: contracted turn requires contractBootstrapPath');
    }
    // This child reads the EFFECTIVE environment it received. It writes the
    // actual values and exits non-zero on mismatch, so `&&` prevents worker exec.
    if (!paths.expectedWorkspacePath) {
      throw new Error('buildAckWrapCommand: contracted turn requires expectedWorkspacePath');
    }
    const expectedWorkspaceB64 = Buffer.from(paths.expectedWorkspacePath, 'utf8').toString('base64url');
    return `"${process.execPath}" "${paths.contractBootstrapPath}" "${paths.ackPath}" "${turnEcho.turn_id}" "${turnEcho.run_id}" "${turnEcho.nonce}" "${turnEcho.contract_hash}" "${turnEcho.capability_snapshot_hash}" "${turnEcho.attempt_epoch ?? ''}" "${turnEcho.workspace_digest ?? ''}" "${expectedWorkspaceB64}"`;
  })();
  const stdinRedirect = paths.stdinFilePath ? ` < "${paths.stdinFilePath}"` : '';
  const redirected = `${bashCommand}${stdinRedirect} > "${paths.stdoutLog}" 2> "${paths.stderrLog}"`;
  const cleanup = paths.stdinFilePath
    ? isWin32
      ? ` & del /q "${paths.stdinFilePath}" > nul 2>&1`
      : `; rm -f -- "${paths.stdinFilePath}"`
    : '';
  return (
    `${ack} && ` +
    `( ${redirected} && ${marker(paths.completedPath, 'completed')} || ${marker(paths.failedPath, 'failed')} )` +
    cleanup
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
  /** True when a contracted manual launch has the same bootstrap/sentinel fence as auto-spawn. */
  contractWrapped?: boolean;
}

/** Raw transport facts only; HarnessAdapter owns semantic parsing. */
export interface TransportObservation {
  exit_code?: number;
  stdout: string;
  stderr: string;
  timed_out?: boolean;
  cancelled?: boolean;
  started_at?: string;
  completed_at?: string;
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
  collectObservation?(runId: string): Promise<TransportObservation> | TransportObservation;
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

/**
 * Make the isolated worktree the explicit Codex workspace root. Relying only
 * on child_process.cwd is insufficient for non-interactive Windows launches:
 * the Codex sandbox can retain the coordinator workspace and apply_patch then
 * refuses writes in ~/.brainclaw/worktrees even when NTFS grants access.
 * `--cd` defines the primary root. Do not redundantly add the same path with
 * `--add-dir`: the unelevated Windows sandbox cannot enforce split writable
 * root sets and refuses to prepare its wrapper in that configuration.
 */
export function withCodexWorkspaceRoot(
  invoke: InvokeCommand,
  agent: string,
  worktreePath: string | undefined,
  isWin32 = process.platform === 'win32',
): InvokeCommand {
  if (agent.trim().toLowerCase() !== 'codex' || !worktreePath) return invoke;
  const args = [...invoke.args];
  const subcommandIndex = args.indexOf('exec');
  const insertAt = subcommandIndex >= 0 ? subcommandIndex : 0;
  args.splice(insertAt, 0, '--cd', worktreePath);
  const quote = (value: string): string => isWin32
    ? `"${value.replace(/"/g, '""')}"`
    : `'${value.replace(/'/g, `'\\''`)}'`;
  const flags = `--cd ${quote(worktreePath)}`;
  const prefix = invoke.executable;
  const suffix = invoke.bashCommand.startsWith(`${prefix} `)
    ? invoke.bashCommand.slice(prefix.length + 1)
    : invoke.bashCommand;
  return { ...invoke, args, bashCommand: `${prefix} ${flags} ${suffix}` };
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
    const isWin32 = process.platform === 'win32';
    invoke = withCodexWorkspaceRoot(invoke, options.agent, options.worktreePath, isWin32);
    const shell = isWin32 ? 'cmd' : (invoke.shell ? 'bash' : 'sh');
    if (
      options.turnEcho?.contract_hash
      && options.turnEcho.capability_snapshot_hash
      && options.assignmentId
      && (options.ackRoot ?? options.worktreePath)
    ) {
      const signalRoot = options.ackRoot ?? options.worktreePath!;
      ensureRuntimeDirs(signalRoot);
      const runtimeRunId = options.turnEcho?.run_id;
      const ackPath = getRuntimeSignalPath(signalRoot, options.assignmentId, 'ack', runtimeRunId);
      const contractBootstrapPath = `${ackPath}.bootstrap.cjs`;
      writeContractBootstrapScript(contractBootstrapPath);
      const stdinFilePath = isWin32 && invoke.promptDelivery === 'stdin_pipe' && invoke.promptText
        ? `${ackPath}.stdin`
        : undefined;
      if (stdinFilePath && invoke.promptText) {
        fs.writeFileSync(stdinFilePath, invoke.promptText, { encoding: 'utf8', mode: 0o600 });
      }
      const wrapped = buildAckWrapCommand(invoke.bashCommand, {
        ackPath,
        completedPath: getRuntimeSignalPath(signalRoot, options.assignmentId, 'completed', runtimeRunId),
        failedPath: getRuntimeSignalPath(signalRoot, options.assignmentId, 'failed', runtimeRunId),
        stdoutLog: getRuntimeLogPath(signalRoot, options.assignmentId, 'stdout', runtimeRunId),
        stderrLog: getRuntimeLogPath(signalRoot, options.assignmentId, 'stderr', runtimeRunId),
        stdinFilePath,
        contractBootstrapPath,
        expectedWorkspacePath: options.worktreePath,
      }, isWin32, options.turnEcho);
      const contractEnv = isWin32
        ? [
          options.claimId && options.claimId !== '(dry-run)' ? `set BRAINCLAW_CLAIM_ID=${options.claimId}` : undefined,
          `set BRAINCLAW_EXECUTION_CONTRACT_HASH=${options.turnEcho.contract_hash}`,
          `set BRAINCLAW_CAPABILITY_SNAPSHOT_HASH=${options.turnEcho.capability_snapshot_hash}`,
        ].filter((item): item is string => Boolean(item)).join(' && ') + ' && '
        : `export ${[
          options.claimId && options.claimId !== '(dry-run)' ? `BRAINCLAW_CLAIM_ID="${options.claimId}"` : undefined,
          `BRAINCLAW_EXECUTION_CONTRACT_HASH="${options.turnEcho.contract_hash}"`,
          `BRAINCLAW_CAPABILITY_SNAPSHOT_HASH="${options.turnEcho.capability_snapshot_hash}"`,
        ].filter((item): item is string => Boolean(item)).join(' ')}; `;
      return { command: `${contractEnv}${wrapped}`, shell, contractWrapped: true };
    }
    const envPrefix = buildManualEnvPrefix(options.claimId);
    return {
      command: `${envPrefix}${invoke.bashCommand}`,
      shell,
    };
  }

  start(invoke: InvokeCommand, options: ExecutionAdapterStartOptions): SpawnResult {
    const isWin32 = process.platform === 'win32';
    invoke = withCodexWorkspaceRoot(invoke, options.agent, options.worktreePath, isWin32);

    // F7 (trp_0e5150d3): route worker env through buildWorkerIdentityEnv so the
    // worker is an independent agent — coordinator identity (BRAINCLAW_AGENT*,
    // SESSION_ID, PROJECT) is scrubbed LAST and cannot be reintroduced by
    // invoke.env. pln#562 step 5 — truthful git attribution (worker authors its
    // own commits) is merged before the scrub. BRAINCLAW_CWD is preserved (D1a).
    const env = buildWorkerIdentityEnv(process.env, {
      agent: options.agent,
      claimId: options.claimId,
      extraEnv: {
        ...buildGitAttributionEnv(options.agent),
        ...(invoke.env ?? {}),
        // Contract identity wins over any agent/invoke-provided environment.
        // The child bootstrap independently verifies these effective values.
        ...(options.turnEcho?.contract_hash ? { BRAINCLAW_EXECUTION_CONTRACT_HASH: options.turnEcho.contract_hash } : {}),
        ...(options.turnEcho?.capability_snapshot_hash
          ? { BRAINCLAW_CAPABILITY_SNAPSHOT_HASH: options.turnEcho.capability_snapshot_hash }
          : {}),
      },
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
    const useWindowsStdinFile = isWin32 && useAckWrap && Boolean(needsStdin);

    const stdinTarget: 'pipe' | 'ignore' = needsStdin && !useWindowsStdinFile ? 'pipe' : 'ignore';
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
      const runtimeRunId = options.turnEcho?.run_id;
      const ackPath = getRuntimeSignalPath(signalRoot, options.assignmentId!, 'ack', runtimeRunId);
      const contractBootstrapPath = `${ackPath}.bootstrap.cjs`;
      if (options.turnEcho?.contract_hash && options.turnEcho.capability_snapshot_hash) {
        writeContractBootstrapScript(contractBootstrapPath);
      }
      const stdinFilePath = useWindowsStdinFile ? `${ackPath}.stdin` : undefined;
      if (stdinFilePath) {
        fs.writeFileSync(stdinFilePath, invoke.promptText!, { encoding: 'utf8', mode: 0o600 });
      }
      const wrappedCmd = buildAckWrapCommand(invoke.bashCommand, {
        ackPath,
        completedPath: getRuntimeSignalPath(signalRoot, options.assignmentId!, 'completed', runtimeRunId),
        failedPath: getRuntimeSignalPath(signalRoot, options.assignmentId!, 'failed', runtimeRunId),
        stdoutLog: getRuntimeLogPath(signalRoot, options.assignmentId!, 'stdout', runtimeRunId),
        stderrLog: getRuntimeLogPath(signalRoot, options.assignmentId!, 'stderr', runtimeRunId),
        stdinFilePath,
        contractBootstrapPath,
        expectedWorkspacePath: options.worktreePath,
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

    if (needsStdin && !useWindowsStdinFile && child.stdin) {
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
