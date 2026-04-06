import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sendMessage, readInbox, ackMessage, archiveMessage, getThread, countPending, countActionable, hasActiveAssignment } from '../../src/core/messaging.js';
import type { MessageType } from '../../src/core/schema.js';

function createTestStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-msg-test-'));
  const brainclawDir = path.join(dir, '.brainclaw');
  fs.mkdirSync(path.join(brainclawDir, 'coordination', 'inbox'), { recursive: true });
  // Create minimal config and state for mutation pipeline
  fs.writeFileSync(path.join(brainclawDir, 'config.yaml'), 'project_id: prj_test\n');
  return dir;
}

function cleanupTestStore(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('core/messaging', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestStore();
  });

  afterEach(() => {
    cleanupTestStore(testDir);
  });

  describe('sendMessage', () => {
    it('creates a message in the target agent inbox', () => {
      const result = sendMessage({
        from: 'claude-code',
        to: 'codex',
        type: 'assign',
        text: 'Implement feature X on src/core/foo.ts',
        ref: 'pln_12345678',
        tags: ['sprint-5'],
      }, testDir);

      assert.ok(result.id.startsWith('msg_'));
      assert.ok(result.shortLabel.startsWith('msg#'));
      assert.equal(result.to, 'codex');
      assert.equal(result.type, 'assign');

      // Verify file exists on disk
      const inboxPath = path.join(testDir, '.brainclaw', 'coordination', 'inbox', 'codex');
      assert.ok(fs.existsSync(inboxPath));
      const files = fs.readdirSync(inboxPath).filter(f => f.endsWith('.json'));
      assert.equal(files.length, 1);
    });

    it('supports all message types', () => {
      const types: MessageType[] = ['assign', 'review', 'rfc', 'info', 'reply'];
      for (const type of types) {
        const result = sendMessage({
          from: 'claude-code',
          to: 'codex',
          type,
          text: `Test ${type} message`,
        }, testDir);
        assert.equal(result.type, type);
      }
    });

    it('creates separate inbox dirs per agent', () => {
      sendMessage({ from: 'claude-code', to: 'codex', type: 'info', text: 'msg1' }, testDir);
      sendMessage({ from: 'claude-code', to: 'cursor', type: 'info', text: 'msg2' }, testDir);

      const inboxBase = path.join(testDir, '.brainclaw', 'coordination', 'inbox');
      const dirs = fs.readdirSync(inboxBase).filter(f =>
        fs.statSync(path.join(inboxBase, f)).isDirectory()
      );
      assert.ok(dirs.includes('codex'));
      assert.ok(dirs.includes('cursor'));
    });
  });

  describe('readInbox', () => {
    it('returns messages for a specific agent', () => {
      sendMessage({ from: 'claude-code', to: 'codex', type: 'assign', text: 'Task 1' }, testDir);
      sendMessage({ from: 'claude-code', to: 'codex', type: 'review', text: 'Review this' }, testDir);
      sendMessage({ from: 'claude-code', to: 'cursor', type: 'info', text: 'Not for codex' }, testDir);

      const result = readInbox({ agent: 'codex', markAsRead: false }, testDir);
      assert.equal(result.total, 2);
      assert.equal(result.messages.length, 2);
    });

    it('filters by status', () => {
      sendMessage({ from: 'claude-code', to: 'codex', type: 'assign', text: 'Task 1' }, testDir);
      const msg2 = sendMessage({ from: 'claude-code', to: 'codex', type: 'assign', text: 'Task 2' }, testDir);
      ackMessage(msg2.id, 'codex', testDir);

      const pending = readInbox({ agent: 'codex', status: 'pending', markAsRead: false }, testDir);
      assert.equal(pending.total, 1);
      assert.equal(pending.messages[0]!.text, 'Task 1');
    });

    it('filters by type', () => {
      sendMessage({ from: 'claude-code', to: 'codex', type: 'assign', text: 'Task' }, testDir);
      sendMessage({ from: 'claude-code', to: 'codex', type: 'review', text: 'Review' }, testDir);

      const assigns = readInbox({ agent: 'codex', type: 'assign', markAsRead: false }, testDir);
      assert.equal(assigns.total, 1);
      assert.equal(assigns.messages[0]!.type, 'assign');
    });

    it('marks messages as read when markAsRead is true', () => {
      sendMessage({ from: 'claude-code', to: 'codex', type: 'assign', text: 'Task 1' }, testDir);

      readInbox({ agent: 'codex', markAsRead: true }, testDir);
      const after = readInbox({ agent: 'codex', status: 'pending', markAsRead: false }, testDir);
      assert.equal(after.total, 0);

      const allRead = readInbox({ agent: 'codex', status: 'read', markAsRead: false }, testDir);
      assert.equal(allRead.total, 1);
    });

    it('paginates results', () => {
      for (let i = 0; i < 5; i++) {
        sendMessage({ from: 'claude-code', to: 'codex', type: 'info', text: `Msg ${i}` }, testDir);
      }

      const page1 = readInbox({ agent: 'codex', limit: 2, offset: 0, markAsRead: false }, testDir);
      assert.equal(page1.total, 5);
      assert.equal(page1.messages.length, 2);

      const page2 = readInbox({ agent: 'codex', limit: 2, offset: 2, markAsRead: false }, testDir);
      assert.equal(page2.messages.length, 2);

      const page3 = readInbox({ agent: 'codex', limit: 2, offset: 4, markAsRead: false }, testDir);
      assert.equal(page3.messages.length, 1);
    });

    it('returns empty for agent with no messages', () => {
      const result = readInbox({ agent: 'nonexistent', markAsRead: false }, testDir);
      assert.equal(result.total, 0);
      assert.equal(result.messages.length, 0);
    });
  });

  describe('ackMessage', () => {
    it('sets status to acknowledged', () => {
      const sent = sendMessage({ from: 'claude-code', to: 'codex', type: 'assign', text: 'Task', requires_ack: true }, testDir);
      const result = ackMessage(sent.id, 'codex', testDir);

      assert.equal(result.id, sent.id);
      assert.equal(result.status, 'acknowledged');

      const inbox = readInbox({ agent: 'codex', status: 'acknowledged', markAsRead: false }, testDir);
      assert.equal(inbox.total, 1);
      assert.ok(inbox.messages[0]!.ack_at);
    });

    it('throws for unknown message', () => {
      assert.throws(() => ackMessage('msg_nonexistent', 'codex', testDir), /not found/);
    });

    it('resolves by short label', () => {
      const sent = sendMessage({ from: 'claude-code', to: 'codex', type: 'assign', text: 'Task' }, testDir);
      const result = ackMessage(sent.shortLabel, 'codex', testDir);
      assert.equal(result.id, sent.id);
    });
  });

  describe('archiveMessage', () => {
    it('sets status to archived', () => {
      const sent = sendMessage({ from: 'claude-code', to: 'codex', type: 'info', text: 'FYI' }, testDir);
      const result = archiveMessage(sent.id, 'codex', testDir);

      assert.equal(result.status, 'archived');

      const inbox = readInbox({ agent: 'codex', status: 'archived', markAsRead: false }, testDir);
      assert.equal(inbox.total, 1);
    });
  });

  describe('getThread', () => {
    it('returns all messages in a thread across agents', () => {
      const threadId = 'thread_test123';

      sendMessage({ from: 'claude-code', to: 'codex', type: 'rfc', text: 'Draft proposal', thread_id: threadId }, testDir);
      sendMessage({ from: 'codex', to: 'claude-code', type: 'reply', text: 'Looks good, but...', thread_id: threadId }, testDir);
      sendMessage({ from: 'claude-code', to: 'codex', type: 'reply', text: 'Good point, adjusted', thread_id: threadId }, testDir);
      // Unrelated message
      sendMessage({ from: 'claude-code', to: 'codex', type: 'info', text: 'Unrelated' }, testDir);

      const thread = getThread(threadId, testDir);
      assert.equal(thread.length, 3);
      assert.equal(thread[0]!.type, 'rfc');
      assert.equal(thread[1]!.from, 'codex');
      assert.equal(thread[2]!.text, 'Good point, adjusted');
    });

    it('returns empty for unknown thread', () => {
      const thread = getThread('thread_nonexistent', testDir);
      assert.equal(thread.length, 0);
    });
  });

  describe('countPending', () => {
    it('counts only pending messages', () => {
      sendMessage({ from: 'claude-code', to: 'codex', type: 'assign', text: 'Task 1' }, testDir);
      sendMessage({ from: 'claude-code', to: 'codex', type: 'assign', text: 'Task 2' }, testDir);
      const msg3 = sendMessage({ from: 'claude-code', to: 'codex', type: 'info', text: 'Info' }, testDir);
      ackMessage(msg3.id, 'codex', testDir);

      assert.equal(countPending('codex', testDir), 2);
    });

    it('returns 0 for agent with no messages', () => {
      assert.equal(countPending('nonexistent', testDir), 0);
    });
  });

  describe('thread_id filtering in readInbox', () => {
    it('filters by thread_id', () => {
      sendMessage({ from: 'claude-code', to: 'codex', type: 'rfc', text: 'RFC 1', thread_id: 'thread_a' }, testDir);
      sendMessage({ from: 'claude-code', to: 'codex', type: 'reply', text: 'Reply to RFC 1', thread_id: 'thread_a' }, testDir);
      sendMessage({ from: 'claude-code', to: 'codex', type: 'rfc', text: 'RFC 2', thread_id: 'thread_b' }, testDir);

      const threadA = readInbox({ agent: 'codex', thread_id: 'thread_a', markAsRead: false }, testDir);
      assert.equal(threadA.total, 2);
    });
  });

  describe('countActionable', () => {
    it('counts pending messages', () => {
      sendMessage({ from: 'claude-code', to: 'codex', type: 'assign', text: 'Task 1' }, testDir);
      assert.equal(countActionable('codex', testDir), 1);
    });

    it('counts read-but-requires-ack messages as actionable', () => {
      sendMessage({ from: 'claude-code', to: 'codex', type: 'assign', text: 'Task 1', requires_ack: true }, testDir);
      // Mark as read
      readInbox({ agent: 'codex', markAsRead: true }, testDir);
      // Still actionable because requires_ack and not yet acked
      assert.equal(countActionable('codex', testDir), 1);
      assert.equal(countPending('codex', testDir), 0);
    });

    it('does not count read messages without requires_ack', () => {
      sendMessage({ from: 'claude-code', to: 'codex', type: 'info', text: 'FYI' }, testDir);
      readInbox({ agent: 'codex', markAsRead: true }, testDir);
      assert.equal(countActionable('codex', testDir), 0);
    });

    it('does not count acknowledged messages', () => {
      const msg = sendMessage({ from: 'claude-code', to: 'codex', type: 'assign', text: 'Task', requires_ack: true }, testDir);
      ackMessage(msg.id, 'codex', testDir);
      assert.equal(countActionable('codex', testDir), 0);
    });
  });

  describe('hasActiveAssignment', () => {
    it('returns true when non-archived assign exists for plan+agent', () => {
      sendMessage({ from: 'coordinator', to: 'codex', type: 'assign', text: 'Task', ref: 'pln_abc' }, testDir);
      assert.equal(hasActiveAssignment('codex', 'pln_abc', testDir), true);
    });

    it('returns false when no assign for that plan', () => {
      sendMessage({ from: 'coordinator', to: 'codex', type: 'assign', text: 'Task', ref: 'pln_other' }, testDir);
      assert.equal(hasActiveAssignment('codex', 'pln_abc', testDir), false);
    });

    it('returns false after archiving the assignment', () => {
      const msg = sendMessage({ from: 'coordinator', to: 'codex', type: 'assign', text: 'Task', ref: 'pln_abc' }, testDir);
      archiveMessage(msg.id, 'codex', testDir);
      assert.equal(hasActiveAssignment('codex', 'pln_abc', testDir), false);
    });

    it('returns true even if message is read or acked (not archived)', () => {
      const msg = sendMessage({ from: 'coordinator', to: 'codex', type: 'assign', text: 'Task', ref: 'pln_abc' }, testDir);
      ackMessage(msg.id, 'codex', testDir);
      assert.equal(hasActiveAssignment('codex', 'pln_abc', testDir), true);
    });
  });
});
