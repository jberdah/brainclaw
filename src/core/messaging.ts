/**
 * Inter-agent messaging operations.
 *
 * Messages are stored per-recipient agent in:
 *   .brainclaw/coordination/inbox/{agent_name}/{msg_id}.json
 *
 * No console.log, no process.exit, no MCP formatting.
 * Both CLI commands and MCP handlers call these functions.
 *
 * @module
 */
import fs from 'node:fs';
import path from 'node:path';
import { generateIdWithLabel, generateId, nowISO } from './ids.js';
import { memoryDir } from './io.js';
import { mutate } from './mutation-pipeline.js';
import { loadVersionedJsonFile, saveVersionedJsonFile, type VersionedDocumentType } from './migration.js';
import { InboxMessageSchema, type InboxMessage, type MessageType, type MessageStatus } from './schema.js';
import { commitMemoryChange } from './memory-git.js';
import { resolveAgentAlias } from './agent-capability.js';

// ── Paths ───────────────────────────────────────────────────

function inboxDir(cwd: string): string {
  return path.join(memoryDir(cwd), 'coordination', 'inbox');
}

function agentInboxDir(agent: string, cwd: string): string {
  // Resolve aliases (e.g. 'copilot' → 'github-copilot') then normalise for filesystem
  const canonical = resolveAgentAlias(agent.toLowerCase());
  const safe = canonical.replace(/[^a-z0-9_-]/g, '_');
  return path.join(inboxDir(cwd), safe);
}

function ensureAgentInboxDir(agent: string, cwd: string): string {
  const dir = agentInboxDir(agent, cwd);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Load helpers ────────────────────────────────────────────

function loadMessagesFromDir(dirPath: string): InboxMessage[] {
  if (!fs.existsSync(dirPath)) return [];
  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
  const items: InboxMessage[] = [];
  for (const file of files) {
    try {
      const result = loadVersionedJsonFile<InboxMessage>('message' as VersionedDocumentType, path.join(dirPath, file));
      items.push(InboxMessageSchema.parse(result.document));
    } catch {
      // skip invalid files
    }
  }
  return items.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// ── Send Message ────────────────────────────────────────────

export interface SendMessageInput {
  from: string;
  to: string;
  type: MessageType;
  text: string;
  ref?: string;
  payload?: Record<string, unknown>;
  scope?: string;
  requires_ack?: boolean;
  thread_id?: string;
  tags?: string[];
  author_id?: string;
  model?: string;
  project_id?: string;
  host_id?: string;
  session_id?: string;
  /** Top-level claim_id for dispatch routing. Authoritative over payload.claim_id. */
  claim_id?: string;
}

export interface SendMessageResult {
  id: string;
  shortLabel: string;
  to: string;
  type: MessageType;
}

export function sendMessage(input: SendMessageInput, cwd: string): SendMessageResult {
  return mutate({ cwd }, () => {
    const { id, short_label } = generateIdWithLabel('inbox_messages', cwd);
    const timestamp = nowISO();
    const resolvedTo = resolveAgentAlias(input.to);

    const message: InboxMessage = {
      id,
      short_label,
      from: input.from,
      to: resolvedTo,
      type: input.type,
      text: input.text,
      ref: input.ref,
      payload: input.payload,
      scope: input.scope,
      requires_ack: input.requires_ack ?? false,
      thread_id: input.thread_id,
      status: 'pending',
      created_at: timestamp,
      updated_at: timestamp,
      author: input.from,
      author_id: input.author_id,
      model: input.model,
      project_id: input.project_id,
      host_id: input.host_id,
      session_id: input.session_id,
      claim_id: input.claim_id,
      tags: input.tags ?? [],
    };

    const dir = ensureAgentInboxDir(input.to, cwd);
    saveVersionedJsonFile('message' as VersionedDocumentType, path.join(dir, `${id}.json`), message);
    commitMemoryChange(`message ${id} sent to ${resolvedTo}`, cwd);

    return { id, shortLabel: short_label, to: resolvedTo, type: input.type };
  });
}

// ── Read Inbox ──────────────────────────────────────────────

export interface ReadInboxInput {
  agent: string;
  status?: MessageStatus;
  type?: MessageType;
  thread_id?: string;
  /** Filter by claim_id (top-level or payload.claim_id). For multi-instance dispatch routing. */
  claimId?: string;
  limit?: number;
  offset?: number;
  markAsRead?: boolean;
}

export interface ReadInboxResult {
  total: number;
  offset: number;
  limit: number;
  messages: InboxMessage[];
}

/** Apply all inbox filters (status, type, thread_id, claim_id) to a message list. */
function applyInboxFilters(messages: InboxMessage[], input: ReadInboxInput): InboxMessage[] {
  let filtered = messages;
  if (input.status) filtered = filtered.filter(m => m.status === input.status);
  if (input.type) filtered = filtered.filter(m => m.type === input.type);
  if (input.thread_id) filtered = filtered.filter(m => m.thread_id === input.thread_id);
  if (input.claimId) {
    filtered = filtered.filter(m =>
      m.claim_id === input.claimId ||
      (m.payload as Record<string, unknown> | undefined)?.claim_id === input.claimId,
    );
  }
  return filtered;
}

export function readInbox(input: ReadInboxInput, cwd: string): ReadInboxResult {
  const dir = agentInboxDir(input.agent, cwd);

  // If markAsRead, do everything under a single lock to avoid race conditions.
  // Re-read from disk inside the lock to get fresh state.
  if (input.markAsRead) {
    return mutate({ cwd }, () => {
      // Fresh read inside lock
      let messages = applyInboxFilters(loadMessagesFromDir(dir), input);

      const total = messages.length;
      const offset = input.offset ?? 0;
      const limit = input.limit ?? 20;
      const page = messages.slice(offset, offset + limit);

      const timestamp = nowISO();
      for (const msg of page) {
        if (msg.status === 'pending') {
          msg.status = 'read';
          msg.read_at = timestamp;
          msg.updated_at = timestamp;
          saveVersionedJsonFile('message' as VersionedDocumentType, path.join(dir, `${msg.id}.json`), msg);
        }
      }
      commitMemoryChange(`inbox read by ${input.agent}`, cwd);
      return { total, offset, limit, messages: page };
    });
  }

  // Read-only path: no lock needed
  let messages = applyInboxFilters(loadMessagesFromDir(dir), input);

  const total = messages.length;
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 20;
  const page = messages.slice(offset, offset + limit);

  return { total, offset, limit, messages: page };
}

// ── Acknowledge Message ─────────────────────────────────────

export interface AckMessageResult {
  id: string;
  status: MessageStatus;
}

export function ackMessage(messageId: string, agent: string, cwd: string): AckMessageResult {
  return mutate({ cwd }, () => {
    const dir = agentInboxDir(agent, cwd);
    const messages = loadMessagesFromDir(dir);
    const msg = messages.find(m => m.id === messageId || m.short_label === messageId);
    if (!msg) {
      throw new Error(`Message '${messageId}' not found in ${agent}'s inbox.`);
    }

    const timestamp = nowISO();
    msg.status = 'acknowledged';
    msg.ack_at = timestamp;
    msg.updated_at = timestamp;
    saveVersionedJsonFile('message' as VersionedDocumentType, path.join(dir, `${msg.id}.json`), msg);
    commitMemoryChange(`message ${msg.id} acknowledged by ${agent}`, cwd);

    return { id: msg.id, status: msg.status };
  });
}

// ── Archive Message ─────────────────────────────────────────

export function archiveMessage(messageId: string, agent: string, cwd: string): AckMessageResult {
  return mutate({ cwd }, () => {
    const dir = agentInboxDir(agent, cwd);
    const messages = loadMessagesFromDir(dir);
    const msg = messages.find(m => m.id === messageId || m.short_label === messageId);
    if (!msg) {
      throw new Error(`Message '${messageId}' not found in ${agent}'s inbox.`);
    }

    msg.status = 'archived';
    msg.updated_at = nowISO();
    saveVersionedJsonFile('message' as VersionedDocumentType, path.join(dir, `${msg.id}.json`), msg);
    commitMemoryChange(`message ${msg.id} archived by ${agent}`, cwd);

    return { id: msg.id, status: msg.status };
  });
}

// ── Get Thread ──────────────────────────────────────────────

export function getThread(threadId: string, cwd: string, options?: { truncateText?: number }): InboxMessage[] {
  // Search across all agent inboxes for messages in this thread
  const baseDir = inboxDir(cwd);
  if (!fs.existsSync(baseDir)) return [];

  const agents = fs.readdirSync(baseDir).filter(f => {
    try { return fs.statSync(path.join(baseDir, f)).isDirectory(); } catch { return false; }
  });

  const allMessages: InboxMessage[] = [];
  for (const agent of agents) {
    const agentDir = path.join(baseDir, agent);
    const messages = loadMessagesFromDir(agentDir);
    allMessages.push(...messages.filter(m => m.thread_id === threadId));
  }

  const sorted = allMessages.sort((a, b) => a.created_at.localeCompare(b.created_at));

  if (options?.truncateText) {
    const limit = options.truncateText;
    for (const msg of sorted) {
      if (msg.text && msg.text.length > limit) {
        msg.text = msg.text.slice(0, limit) + '\n[...truncated]';
      }
    }
  }

  return sorted;
}

/**
 * Lightweight thread message count — reads file content as raw strings
 * and checks for the thread_id without full JSON parsing. Used for polling
 * to avoid OOM from repeated full-message loads.
 */
export function getThreadCount(threadId: string, cwd: string): number {
  const baseDir = inboxDir(cwd);
  if (!fs.existsSync(baseDir)) return 0;

  let agents: string[];
  try {
    agents = fs.readdirSync(baseDir).filter(f => {
      try { return fs.statSync(path.join(baseDir, f)).isDirectory(); } catch { return false; }
    });
  } catch { return 0; }

  let count = 0;
  const needle = `"thread_id":"${threadId}"`;
  const needleSpaced = `"thread_id": "${threadId}"`;

  for (const agent of agents) {
    const agentDir = path.join(baseDir, agent);
    let files: string[];
    try {
      files = fs.readdirSync(agentDir).filter(f => f.endsWith('.json'));
    } catch { continue; }

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(agentDir, file), 'utf-8');
        if (raw.includes(needle) || raw.includes(needleSpaced)) {
          count++;
        }
      } catch {
        // skip unreadable files
      }
    }
  }

  return count;
}

// ── Count Pending ───────────────────────────────────────────

export function countPending(agent: string, cwd: string): number {
  const dir = agentInboxDir(agent, cwd);
  const messages = loadMessagesFromDir(dir);
  return messages.filter(m => m.status === 'pending').length;
}

/**
 * Count actionable messages: pending + read-but-requires-ack (not yet acknowledged).
 * This is the correct metric for board/session_start — a message that has been
 * read but not acked is still actionable.
 */
export function countActionable(agent: string, cwd: string): number {
  const dir = agentInboxDir(agent, cwd);
  const messages = loadMessagesFromDir(dir);
  return messages.filter(m =>
    m.status === 'pending' ||
    (m.status === 'read' && m.requires_ack)
  ).length;
}

/**
 * Check if there's already a non-archived assign message for a given plan+agent combo.
 * Used by dispatcher to avoid duplicate assignments.
 */
export function hasActiveAssignment(agent: string, planId: string, cwd: string): boolean {
  const dir = agentInboxDir(agent, cwd);
  const messages = loadMessagesFromDir(dir);
  return messages.some(m =>
    m.type === 'assign' &&
    m.ref === planId &&
    m.status !== 'archived'
  );
}
