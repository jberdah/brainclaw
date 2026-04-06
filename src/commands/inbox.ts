/**
 * CLI command: brainclaw inbox
 *
 * Subcommands:
 *   brainclaw inbox                — list pending messages
 *   brainclaw inbox --all          — list all messages
 *   brainclaw inbox ack <id>       — acknowledge a message
 *   brainclaw inbox send <to> <text> — send a message
 *
 * @module
 */
import { memoryExists } from '../core/io.js';
import { readInbox, ackMessage, archiveMessage, sendMessage, countPending, getThread } from '../core/messaging.js';
import { resolveCurrentAgentName } from '../core/agent-registry.js';
import type { MessageType, MessageStatus } from '../core/schema.js';

export interface InboxListOptions {
  agent?: string;
  status?: string;
  type?: string;
  thread?: string;
  all?: boolean;
  json?: boolean;
  cwd?: string;
}

export function runInboxList(options: InboxListOptions): void {
  const cwd = options.cwd;
  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const effectiveCwd = cwd ?? process.cwd();
  const agent = options.agent ?? resolveCurrentAgentName(effectiveCwd) ?? 'unknown';
  const status = options.all ? undefined : (options.status as MessageStatus | undefined) ?? 'pending';

  const result = readInbox({
    agent,
    status,
    type: options.type as MessageType | undefined,
    thread_id: options.thread,
    markAsRead: false,
  }, effectiveCwd);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const label = status ? `${status} messages` : 'all messages';
  console.log(`\n📬 Inbox for ${agent} — ${result.total} ${label}\n`);

  if (result.messages.length === 0) {
    console.log('  (no messages)');
  }

  for (const msg of result.messages) {
    const ack = msg.requires_ack ? ' [ACK required]' : '';
    const thread = msg.thread_id ? ` thread:${msg.thread_id}` : '';
    const ref = msg.ref ? ` ref:${msg.ref}` : '';
    console.log(`  [${msg.short_label ?? msg.id}] ${msg.type} from ${msg.from} (${msg.status})${ack}${thread}${ref}`);
    console.log(`    ${msg.text.slice(0, 120)}${msg.text.length > 120 ? '...' : ''}`);
    console.log('');
  }
}

export interface InboxAckOptions {
  agent?: string;
  json?: boolean;
  cwd?: string;
}

export function runInboxAck(messageId: string, options: InboxAckOptions): void {
  const cwd = options.cwd;
  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const effectiveCwd = cwd ?? process.cwd();
  const agent = options.agent ?? resolveCurrentAgentName(effectiveCwd) ?? 'unknown';

  try {
    const result = ackMessage(messageId, agent, effectiveCwd);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`✔ Message acknowledged: [${result.id}]`);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

export interface InboxArchiveOptions {
  agent?: string;
  json?: boolean;
  cwd?: string;
}

export function runInboxArchive(messageId: string, options: InboxArchiveOptions): void {
  const cwd = options.cwd;
  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const effectiveCwd = cwd ?? process.cwd();
  const agent = options.agent ?? resolveCurrentAgentName(effectiveCwd) ?? 'unknown';

  try {
    const result = archiveMessage(messageId, agent, effectiveCwd);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`✔ Message archived: [${result.id}]`);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

export interface InboxSendOptions {
  type?: string;
  ref?: string;
  scope?: string;
  thread?: string;
  ack?: boolean;
  agent?: string;
  json?: boolean;
  cwd?: string;
}

export function runInboxSend(to: string, text: string, options: InboxSendOptions): void {
  const cwd = options.cwd;
  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const effectiveCwd = cwd ?? process.cwd();
  const from = options.agent ?? resolveCurrentAgentName(effectiveCwd) ?? 'unknown';
  const msgType = (options.type ?? 'info') as MessageType;

  try {
    const result = sendMessage({
      from,
      to,
      type: msgType,
      text,
      ref: options.ref,
      scope: options.scope,
      thread_id: options.thread,
      requires_ack: options.ack,
    }, effectiveCwd);

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`✔ Message sent: [${result.shortLabel}] ${result.type} → ${result.to}`);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

export interface InboxThreadOptions {
  json?: boolean;
  cwd?: string;
}

export function runInboxThread(threadId: string, options: InboxThreadOptions): void {
  const cwd = options.cwd;
  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const effectiveCwd = cwd ?? process.cwd();
  const messages = getThread(threadId, effectiveCwd);

  if (options.json) {
    console.log(JSON.stringify({ thread_id: threadId, total: messages.length, messages }, null, 2));
    return;
  }

  console.log(`\nThread ${threadId} — ${messages.length} message(s)\n`);
  for (const msg of messages) {
    console.log(`  [${msg.short_label ?? msg.id}] ${msg.from} → ${msg.to} (${msg.type}, ${msg.status})`);
    console.log(`    ${msg.text.slice(0, 120)}${msg.text.length > 120 ? '...' : ''}`);
    console.log('');
  }
}
