import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getCapabilityProfile, type InvokeCommand } from './agent-capability.js';
import { nowISO } from './ids.js';

/**
 * Check if a binary is resolvable on the system PATH.
 * On Windows, `spawn({shell:true})` always succeeds (launches cmd.exe),
 * masking ENOENT for missing binaries. This pre-check catches that.
 */
function isBinaryOnPath(binary: string): boolean {
  // Absolute or relative path — check directly
  if (binary.includes('/') || binary.includes('\\')) {
    return fs.existsSync(binary);
  }
  try {
    if (process.platform === 'win32') {
      execFileSync('where', [binary], { stdio: 'ignore', timeout: 5000 });
    } else {
      execFileSync('which', [binary], { stdio: 'ignore', timeout: 5000 });
    }
    return true;
  } catch {
    return false;
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
  if (!claimId) return '';
  if (process.platform === 'win32') {
    return `set BRAINCLAW_CLAIM_ID=${claimId} && `;
  }
  return `BRAINCLAW_CLAIM_ID=${claimId} `;
}

export class CliExecutionAdapter implements ExecutionAdapter {
  readonly id = 'cli';

  canSpawn(agentName: string): SpawnCapability {
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
    if (isWin32 && !isBinaryOnPath(invoke.executable)) {
      throw new Error(
        `Cannot spawn agent ${options.agent}: binary '${invoke.executable}' not found on PATH`,
      );
    }

    const needsStdin = invoke.promptDelivery === 'stdin_pipe' && invoke.promptText;
    const stdio = needsStdin ? ['pipe' as const, 'ignore' as const, 'ignore' as const] : 'ignore' as const;

    const child = spawn(invoke.executable, invoke.args, {
      // Windows: detached is unreliable with shell:true — child stays in parent's process group.
      // POSIX: detached lets the child survive parent exit.
      detached: !isWin32,
      shell: isWin32,
      stdio,
      cwd: options.worktreePath,
      env,
      windowsHide: true,
    });

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
