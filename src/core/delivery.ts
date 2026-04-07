import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentCapabilityProfile } from './agent-capability.js';

export type DeliveryChannel = 'mcp_direct' | 'spawn_cli' | 'inbox' | 'human_fallback';

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
 * Deliver a prompt to an agent using its preferred method.
 * - inbox_structured: writes to coordination/inbox/<agent>/
 * - inline_arg: truncates to max_inline_length, substitutes directly in template
 * - temp_file / stdin_pipe: writes prompt to tmp file, delegates to buildSpawnCommand
 * If outputFile is set, stdout is captured to that path (mirrors codev-rounds.ts pattern).
 */
export function deliverPrompt(
  profile: AgentCapabilityProfile,
  prompt: string,
  options?: { cwd?: string; outputFile?: string },
): void {
  const method = profile.prompt_delivery.preferred;

  // Inbox delivery: write task file, no process spawn needed
  if (method === 'inbox_structured') {
    const inboxDir = path.join('coordination', 'inbox', profile.name);
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(path.join(inboxDir, `task-${Date.now()}.md`), prompt, 'utf-8');
    return;
  }

  // Write prompt to temp file (used by temp_file and stdin_pipe; inline_arg keeps it for cleanup)
  const tmpDir = path.join(os.tmpdir(), 'brainclaw-delivery');
  fs.mkdirSync(tmpDir, { recursive: true });
  const promptFile = path.join(tmpDir, `prompt-${Date.now()}.md`);
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const child = spawn('sh', ['-c', shellCmd], {
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
 * const nano = DEFAULT_CAPABILITY_PROFILES['nanoclaw'];
 * console.assert(resolveDeliveryChannel(nano) === 'spawn_cli');      // no mcp, has cli
 * console.log('delivery: all assertions passed');
 */
