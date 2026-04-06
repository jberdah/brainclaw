import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runDoctor } from '../../src/commands/doctor.js';
import { scanMigrationStatus } from '../../src/core/migration.js';
import type { InboxMessage } from '../../src/core/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function buildMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    schema_version: 2,
    id: 'msg_test0001',
    short_label: 'msg#1',
    from: 'claude-code',
    to: 'codex',
    type: 'assign',
    text: 'Check inbox migration',
    requires_ack: false,
    status: 'pending',
    created_at: '2026-04-06T09:00:00.000Z',
    updated_at: '2026-04-06T09:00:00.000Z',
    author: 'claude-code',
    tags: [],
    ...overrides,
  };
}

function writeJson(filepath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function captureDoctorJson(cwd: string): {
  ok: boolean;
  checks: Array<{ name: string; status: string; message: string; details?: unknown }>;
} {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const logs: string[] = [];

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.warn = () => {};
  console.error = () => {};

  try {
    runDoctor({ json: true, cwd });
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }

  assert.ok(logs.length > 0, 'doctor should emit JSON output');
  return JSON.parse(logs.at(-1) as string) as {
    ok: boolean;
    checks: Array<{ name: string; status: string; message: string; details?: unknown }>;
  };
}

describe('inbox migration and doctor', () => {
  let workspace: TestWorkspace | undefined;

  afterEach(() => {
    workspace?.cleanup();
    workspace = undefined;
  });

  it('finds per-agent inbox message files during migration scanning', () => {
    workspace = createTestWorkspace({ prefix: 'bclaw-inbox-migration-' });

    const inboxRoot = path.join(workspace.dir, '.brainclaw', 'coordination', 'inbox');
    writeJson(path.join(inboxRoot, 'codex', 'msg_current.json'), buildMessage());
    const legacyMessage = buildMessage({
      id: 'msg_legacy0001',
      short_label: 'msg#2',
      to: 'claude-code',
      updated_at: '2026-04-06T09:01:00.000Z',
    });
    const { schema_version: _schemaVersion, ...legacyWithoutVersion } = legacyMessage;
    writeJson(path.join(inboxRoot, 'claude-code', 'msg_legacy.json'), legacyWithoutVersion);

    const entries = scanMigrationStatus(workspace.dir).filter((entry) => entry.documentType === 'message');

    assert.equal(entries.length, 2);
    assert.ok(entries.some((entry) =>
      entry.path.endsWith('.brainclaw/coordination/inbox/codex/msg_current.json') &&
      entry.status === 'ok',
    ));
    assert.ok(entries.some((entry) =>
      entry.path.endsWith('.brainclaw/coordination/inbox/claude-code/msg_legacy.json') &&
      entry.status === 'outdated' &&
      entry.detectedVersion === 1,
    ));
  });

  it('reports invalid and orphaned inbox message files in doctor output', () => {
    workspace = createTestWorkspace({ prefix: 'bclaw-inbox-doctor-' });

    const inboxRoot = path.join(workspace.dir, '.brainclaw', 'coordination', 'inbox');
    writeJson(path.join(inboxRoot, 'codex', 'msg_valid.json'), buildMessage());
    fs.mkdirSync(path.join(inboxRoot, 'codex'), { recursive: true });
    fs.writeFileSync(path.join(inboxRoot, 'codex', 'msg_broken.json'), '{bad-json', 'utf-8');
    writeJson(path.join(inboxRoot, 'msg_orphan.json'), buildMessage({
      id: 'msg_orphan0001',
      short_label: 'msg#3',
    }));

    const parsed = captureDoctorJson(workspace.dir);
    const check = parsed.checks.find((entry) => entry.name === 'inbox_messages');

    assert.ok(check);
    assert.equal(check.status, 'error');
    assert.match(check.message, /1 invalid/);
    assert.match(check.message, /1 orphaned/);

    const details = check.details as {
      checked: number;
      invalid: Array<{ path: string }>;
      orphaned: Array<{ path: string }>;
    };
    assert.equal(details.checked, 1);
    assert.equal(details.invalid.length, 1);
    assert.equal(details.orphaned.length, 1);
    assert.ok(details.invalid[0]!.path.endsWith('.brainclaw/coordination/inbox/codex/msg_broken.json'));
    assert.ok(details.orphaned[0]!.path.endsWith('.brainclaw/coordination/inbox/msg_orphan.json'));
  });
});
