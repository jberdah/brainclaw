import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentCapabilityProfile } from './agent-capability.js';
import { buildInvokeCommand, type InvokeCommand } from './agent-capability.js';

export type DeliveryChannel = 'mcp_direct' | 'spawn_cli' | 'inbox';

/** Structured result from building a delivery command — no side effects. */
export interface DeliveryResult {
  /** Resolved delivery channel for this profile */
  channel: DeliveryChannel;
  /** Ready-to-run bash command string (set for spawn_cli channel) */
  bashCommand: string;
  /** Structured invoke command (only for spawn_cli channel) */
  invokeCommand?: InvokeCommand;
  /** Path to inbox task file (only for inbox channel) */
  inboxPath?: string;
}

/** Determine the best delivery channel for the given agent profile. */
export function resolveDeliveryChannel(profile: AgentCapabilityProfile): DeliveryChannel {
  if (profile.runtime.mcp_direct) return 'mcp_direct';
  if (profile.runtime.spawnable_cli) return 'spawn_cli';
  return 'inbox';
}

/**
 * Build a DeliveryResult for the given profile and prompt WITHOUT executing anything.
 * For spawn_cli channel: constructs a structured InvokeCommand via agent-capability.
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
    return { channel, bashCommand: '' };
  }

  const tempFilePath = options?.tempFilePath ?? path.join(
    os.tmpdir(),
    'brainclaw-delivery',
    `prompt-${Date.now()}.md`,
  );

  const invokeCommand = buildInvokeCommand(profile.name, prompt, { tempFilePath });

  if (!invokeCommand) {
    return { channel, bashCommand: '' };
  }

  return {
    channel,
    bashCommand: invokeCommand.bashCommand,
    invokeCommand,
  };
}

/**
 * Deliver a prompt to an agent.
 * - inbox: writes task file to coordination/inbox/<agent>/
 * - spawn_cli: returns DeliveryResult with bashCommand (caller runs it)
 * - mcp_direct: returns DeliveryResult (caller handles MCP push)
 * - dryRun: returns result without writing any files
 *
 * NOTE: This function no longer spawns processes. The caller is responsible
 * for executing the returned bashCommand if needed.
 */
export function deliverPrompt(
  profile: AgentCapabilityProfile,
  prompt: string,
  options?: { cwd?: string; outputFile?: string; dryRun?: boolean },
): DeliveryResult {
  const result = buildDeliveryCommand(profile, prompt, { cwd: options?.cwd });

  if (options?.dryRun) return result;

  // Inbox delivery: write the task file
  if (result.channel === 'inbox' && result.inboxPath) {
    const inboxDir = path.dirname(result.inboxPath);
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(result.inboxPath, prompt, 'utf-8');
  }

  // Write temp file if invoke command needs it
  if (result.invokeCommand?.env?.BCLAW_PROMPT_FILE) {
    const promptFile = result.invokeCommand.env.BCLAW_PROMPT_FILE;
    fs.mkdirSync(path.dirname(promptFile), { recursive: true });
    fs.writeFileSync(promptFile, prompt, 'utf-8');
  }

  return result;
}
