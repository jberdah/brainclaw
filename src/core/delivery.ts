import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentCapabilityProfile } from './agent-capability.js';
import { buildInvokeCommand, type InvokeCommand } from './agent-capability.js';

export type DeliveryChannel = 'mcp_direct' | 'spawn_cli' | 'inbox' | 'human_fallback';

/** Structured result from building a delivery command — no side effects. */
export interface DeliveryResult {
  /** Resolved delivery channel for this profile */
  channel: DeliveryChannel;
  /**
   * Human-readable bash command string.
   * Set for spawn_cli channel; empty string for inbox/mcp_direct/human_fallback.
   */
  bashCommand: string;
  /** Structured invoke command (only for spawn_cli channel) */
  invokeCommand?: InvokeCommand;
  /** Path to written inbox task file (only for inbox channel) */
  inboxPath?: string;
}

/** Determine the best delivery channel for the given agent profile. */
export function resolveDeliveryChannel(profile: AgentCapabilityProfile): DeliveryChannel {
  if (profile.runtime.mcp_direct) return 'mcp_direct';
  if (profile.runtime.spawnable_cli) return 'spawn_cli';
  if (profile.runtime.inbox) return 'inbox';
  return 'human_fallback';
}

/**
 * Build the complete shell command to invoke an agent with a given prompt file.
 * Handles stdin_pipe (cat | binary -) and inline_arg/temp_file ($(cat file) substitution).
 * @deprecated Use buildDeliveryCommand() for structured output.
 */
export function buildSpawnCommand(profile: AgentCapabilityProfile, promptFile: string): string {
  const template = profile.invoke_template ?? `"${profile.invoke_binary ?? 'unknown'}" "{prompt}"`;
  if (profile.prompt_delivery.preferred === 'stdin_pipe') {
    const cmd = template.replace('"{prompt}"', '-').replace('{prompt}', '-');
    return `cat "${promptFile}" | ${cmd}`;
  }
  return template.replace('{prompt}', `$(cat "${promptFile}")`);
}

/**
 * Build a DeliveryResult for the given profile and prompt WITHOUT executing anything.
 * For spawn_cli channel: writes the prompt to a temp file and constructs the structured
 * InvokeCommand using buildInvokeCommand() from agent-capability.
 * For inbox channel: resolves the inbox path but does NOT write the file.
 */
export function buildDeliveryCommand(
  profile: AgentCapabilityProfile,
  prompt: string,
  options?: { cwd?: string; tempFilePath?: string },
): DeliveryResult {
  const channel = resolveDeliveryChannel(profile);

  if (channel === 'inbox' || profile.prompt_delivery.preferred === 'inbox_structured') {
    const inboxPath = path.join(
      options?.cwd ?? '.',
      'coordination',
      'inbox',
      profile.name,
      `task-${Date.now()}.md`,
    );
    return { channel: 'inbox', bashCommand: '', inboxPath };
  }

  if (channel !== 'spawn_cli') {
    // mcp_direct or human_fallback — no shell command to build
    return { channel, bashCommand: '' };
  }

  // Determine temp file path (caller may supply one for deterministic testing)
  const tempFilePath = options?.tempFilePath ?? path.join(
    os.tmpdir(),
    'brainclaw-delivery',
    `prompt-${Date.now()}.md`,
  );

  const invokeCommand = buildInvokeCommand(profile.name, prompt, { tempFilePath });

  if (!invokeCommand) {
    // Profile has no invoke template despite spawnable_cli — fall back gracefully
    const fallbackCmd = buildSpawnCommand(profile, tempFilePath);
    return { channel, bashCommand: fallbackCmd };
  }

  return {
    channel,
    bashCommand: invokeCommand.bashCommand,
    invokeCommand,
  };
}

/**
 * Deliver a prompt to an agent using its preferred method.
 * - inbox_structured: writes to coordination/inbox/<agent>/
 * - inline_arg: truncates to max_inline_length, substitutes directly in template
 * - temp_file / stdin_pipe: writes prompt to tmp file, delegates to buildSpawnCommand
 * If outputFile is set, stdout is captured to that path (mirrors codev-rounds.ts pattern).
 * If dryRun is true, returns the DeliveryResult without spawning or writing any files.
 */
export function deliverPrompt(
  profile: AgentCapabilityProfile,
  prompt: string,
  options?: { cwd?: string; outputFile?: string; dryRun?: boolean },
): DeliveryResult | void {
  const method = profile.prompt_delivery.preferred;

  // Inbox delivery: write task file, no process spawn needed
  if (method === 'inbox_structured') {
    const inboxDir = path.join(options?.cwd ?? '.', 'coordination', 'inbox', profile.name);
    const inboxPath = path.join(inboxDir, `task-${Date.now()}.md`);
    const result: DeliveryResult = { channel: 'inbox', bashCommand: '', inboxPath };
    if (options?.dryRun) return result;
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(inboxPath, prompt, 'utf-8');
    return;
  }

  // Write prompt to temp file (used by temp_file and stdin_pipe; inline_arg keeps it for cleanup)
  const tmpDir = path.join(os.tmpdir(), 'brainclaw-delivery');
  const promptFile = path.join(tmpDir, `prompt-${Date.now()}.md`);

  // Build structured delivery result
  const result = buildDeliveryCommand(profile, prompt, { cwd: options?.cwd, tempFilePath: promptFile });

  if (options?.dryRun) return result;

  // --- side-effecting path below ---

  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(promptFile, prompt, 'utf-8');

  let shellCmd: string;
  if (method === 'inline_arg') {
    const maxLen = profile.prompt_delivery.max_inline_length ?? 4000;
    const text = prompt.length > maxLen ? prompt.slice(0, maxLen) + '...' : prompt;
    const tmpl = profile.invoke_template ?? `"${profile.invoke_binary ?? 'unknown'}" "{prompt}"`;
    shellCmd = tmpl.replace('{prompt}', text.replace(/"/g, '\\"')) + ` ; rm -f "${promptFile}"`;
  } else {
    shellCmd = buildSpawnCommand(profile, promptFile) + ` ; rm -f "${promptFile}"`;
  }

  let outFd: number | undefined;
  if (options?.outputFile) {
    fs.mkdirSync(path.dirname(options.outputFile), { recursive: true });
    outFd = fs.openSync(options.outputFile, 'w');
  }

  // OS-aware shell: use cmd /c on Windows, sh -c elsewhere
  const isWindows = process.platform === 'win32';
  const shellBin = isWindows ? 'cmd' : 'sh';
  const shellFlag = isWindows ? '/c' : '-c';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const child = spawn(shellBin, [shellFlag, shellCmd], {
    detached: true,
    stdio: ['ignore', outFd ?? 'inherit', 'ignore'] as any,
    cwd: options?.cwd,
  });
  child.on('error', (err) => console.warn(`[delivery] ${profile.name}: ${(err as Error).message}`));
  if (outFd !== undefined) {
    child.on('exit', () => { try { fs.closeSync(outFd!); } catch { /**/ } });
  }
}

/*
 * Basic inline test (manual verification):
 *
 * import { DEFAULT_CAPABILITY_PROFILES } from './agent-capability.js';
 * const codex = DEFAULT_CAPABILITY_PROFILES['codex'];
 * console.assert(resolveDeliveryChannel(codex) === 'mcp_direct');   // mcp_direct=true wins
 * const cmd = buildSpawnCommand(codex, '/tmp/p.md');
 * console.assert(cmd.startsWith('cat "/tmp/p.md"'), 'stdin_pipe: cat prefix');
 * console.assert(cmd.includes('--full-auto'), 'stdin_pipe: template preserved');
 * const opencode = DEFAULT_CAPABILITY_PROFILES['opencode'];
 * console.assert(resolveDeliveryChannel(opencode) === 'mcp_direct'); // mcp_direct=true
 * // opencode has spawn_cli too — test buildDeliveryCommand with it (no mcp_direct short-circuit)
 * const nano = DEFAULT_CAPABILITY_PROFILES['nanoclaw'];
 * console.assert(resolveDeliveryChannel(nano) === 'spawn_cli');      // no mcp, has cli
 * const result = buildDeliveryCommand(nano, 'hello', { tempFilePath: '/tmp/p.md' });
 * console.assert(result.channel === 'spawn_cli');
 * // nanoclaw has no invoke_template, so invokeCommand will be undefined (fallback bashCommand used)
 * console.assert(result.bashCommand.length > 0);
 * console.log('delivery: all assertions passed');
 */
