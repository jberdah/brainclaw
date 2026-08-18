import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearCurrentSession,
  loadSessionById,
  resolveExplicitSessionId,
  saveCurrentSession,
} from '../../src/core/identity.js';
import { isSafeSessionId, sessionSnapshotRecordPaths } from '../../src/core/io.js';
import { startSession } from '../../src/commands/session-start.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import type { CurrentSessionState } from '../../src/core/schema.js';

/**
 * pln#672 — a session id arrives from the ENVIRONMENT and is interpolated into
 * a filename. Reproduced on disk on 2026-08-18 before the fix:
 * `BRAINCLAW_SESSION_ID='../../../ESCAPED'` made saveCurrentSession write
 * OUTSIDE the store root. These tests assert at the surface (trp#1292) that no
 * file can appear outside the store, for write, read and unlink alike.
 */
describe('session id boundary validation (pln#672)', () => {
  let workspace: TestWorkspace;
  let outside: string;

  // Each traversal escapes to a DIFFERENT depth so a single missed guard shows up.
  const TRAVERSALS = ['../escaped', '../../escaped', '..\\escaped-win', 'a/b/c', '/abs/escaped', '..', '.hidden'];

  const record = (id: string): CurrentSessionState => {
    const now = new Date().toISOString();
    return {
      schema_version: 2,
      session_id: id,
      started_at: now,
      last_seen_at: now,
      agent: workspace.currentAgent.agent_name,
      agent_id: workspace.currentAgent.agent_id,
      host_id: 'host-test',
      pid: process.pid,
    };
  };

  /** Every .json file anywhere under `dir`, relative — used to prove nothing escaped. */
  const jsonFilesUnder = (dir: string): string[] => {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (e.name.endsWith('.json')) out.push(path.relative(dir, full));
      }
    };
    walk(dir);
    return out;
  };

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-sessid-',
      projectId: 'prj_session_id_validation',
      currentAgent: 'claude-code',
    });
    // A sibling directory OUTSIDE the store: the traversals below aim here.
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-sessid-outside-'));
  });

  afterEach(() => {
    try { fs.rmSync(outside, { recursive: true, force: true }); } catch { /* best effort */ }
    workspace.cleanup();
  });

  it('saveCurrentSession REFUSES a traversal id, and nothing is written outside the store', () => {
    const before = jsonFilesUnder(outside);

    for (const id of TRAVERSALS) {
      assert.throws(
        () => saveCurrentSession(record(id), workspace.dir),
        /not a valid record identifier/,
        `traversal id ${JSON.stringify(id)} must be refused`,
      );
    }

    assert.deepEqual(jsonFilesUnder(outside), before, 'no record may appear outside the store');
    // The parent of the store must stay clean too (../escaped targets it).
    const parent = path.dirname(workspace.dir);
    assert.ok(!fs.existsSync(path.join(parent, 'escaped.json')), 'no record beside the store root');
  });

  it('loadSessionById answers "no such record" for a traversal id instead of reading outside', () => {
    // Plant a decoy where a traversal would land: a leak would return it.
    const parent = path.dirname(workspace.dir);
    const decoy = path.join(parent, 'decoy.json');
    fs.writeFileSync(decoy, JSON.stringify(record('decoy')));
    try {
      for (const id of ['../decoy', '../../decoy', ...TRAVERSALS]) {
        assert.equal(loadSessionById(id, workspace.dir), undefined, `read of ${JSON.stringify(id)} must not resolve`);
      }
    } finally {
      try { fs.unlinkSync(decoy); } catch { /* best effort */ }
    }
  });

  it('clearCurrentSession never unlinks through a traversal id', () => {
    const parent = path.dirname(workspace.dir);
    const victim = path.join(parent, 'victim.json');
    fs.writeFileSync(victim, JSON.stringify(record('victim')));
    try {
      for (const id of ['../victim', '../../victim', ...TRAVERSALS]) {
        clearCurrentSession(workspace.dir, id);
      }
      assert.ok(fs.existsSync(victim), 'a file outside the store must survive every traversal clear');
    } finally {
      try { fs.unlinkSync(victim); } catch { /* best effort */ }
    }
  });

  it('the snapshot path builder refuses a traversal id too', () => {
    for (const id of TRAVERSALS) {
      assert.throws(
        () => sessionSnapshotRecordPaths(id, workspace.dir),
        /not a valid record identifier/,
        `snapshot paths for ${JSON.stringify(id)} must be refused`,
      );
    }
  });

  it('resolveExplicitSessionId IGNORES an unsafe env value and keeps a valid one', () => {
    const saved = process.env.BRAINCLAW_SESSION_ID;
    try {
      for (const id of TRAVERSALS) {
        process.env.BRAINCLAW_SESSION_ID = id;
        assert.equal(resolveExplicitSessionId(), undefined, `env id ${JSON.stringify(id)} must be ignored`);
      }
      // Real-world shapes must keep working: brainclaw ids and agent UUIDs.
      for (const id of ['sess_1ec8f599', 'a53c805a-8b2e-4da5-b23b-be5f933ba7ea', 'sess_coordX', 'sess_step6_a']) {
        process.env.BRAINCLAW_SESSION_ID = id;
        assert.equal(resolveExplicitSessionId(), id, `legitimate id ${id} must be honoured`);
      }
    } finally {
      if (saved === undefined) delete process.env.BRAINCLAW_SESSION_ID;
      else process.env.BRAINCLAW_SESSION_ID = saved;
    }
  });

  it('the grammar accepts real ids and rejects filename-unsafe ones', () => {
    for (const ok of ['sess_1ec8f599', 'a53c805a-8b2e-4da5-b23b-be5f933ba7ea', 'A1', 'x'.repeat(128)]) {
      assert.equal(isSafeSessionId(ok), true, `${ok.slice(0, 20)}… must be accepted`);
    }
    for (const ko of ['', '.', '..', '.hidden', '../x', 'a/b', 'a\\b', 'C:/x', 'x'.repeat(129), 'a b', 'é']) {
      assert.equal(isSafeSessionId(ko), false, `${JSON.stringify(ko.slice(0, 20))} must be rejected`);
    }
  });

  it('startSession with a traversal env id writes NOTHING outside the store and runs under a safe id (codex P1)', async () => {
    // The reviewer's reproduction: sessionSnapshotPath was unguarded, so the
    // snapshot escaped BEFORE the current_session write refused — and the
    // later throw did not undo the escaped write.
    const saved = process.env.BRAINCLAW_SESSION_ID;
    const parent = path.dirname(workspace.dir);
    process.env.BRAINCLAW_SESSION_ID = '../../../ESCAPED';
    try {
      const snapshot = await startSession({ cwd: workspace.dir, maintenanceMode: 'fast' });

      assert.ok(!fs.existsSync(path.join(parent, 'ESCAPED.snapshot.json')), 'no snapshot may escape the store');
      assert.ok(!fs.existsSync(path.resolve(workspace.dir, '../../../ESCAPED.snapshot.json')), 'nor at the traversal target');
      assert.deepEqual(jsonFilesUnder(outside), [], 'nothing outside the store at all');
      // The session must run under a SAFE id, and say so rather than pretend.
      assert.notEqual(snapshot.session_id, '../../../ESCAPED');
      assert.equal(isSafeSessionId(snapshot.session_id), true);
      assert.ok(snapshot.invalid_session_id_ignored, 'the drop must be surfaced, never silent');
      assert.match(snapshot.invalid_session_id_ignored.message, /BRAINCLAW_SESSION_ID/);
      assert.ok(
        !JSON.stringify(snapshot.invalid_session_id_ignored).includes('ESCAPED'),
        'the raw attacker-influenced value must never be echoed back',
      );
    } finally {
      if (saved === undefined) delete process.env.BRAINCLAW_SESSION_ID;
      else process.env.BRAINCLAW_SESSION_ID = saved;
    }
  });

  it('Win32 device names are refused on every platform (codex P2)', () => {
    // `CON.json` opens the console device: stat says "file", the directory
    // stays empty, the record is silently lost.
    for (const device of ['CON', 'con', 'Con', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'CON.json', 'nul.anything']) {
      assert.equal(isSafeSessionId(device), false, `${device} must be refused`);
      assert.throws(() => saveCurrentSession(record(device), workspace.dir), /not a valid record identifier/);
    }
    // A name that merely CONTAINS a device word stays legitimate.
    for (const ok of ['console', 'conductor', 'com10', 'lpt0', 'nullify']) {
      assert.equal(isSafeSessionId(ok), true, `${ok} must stay accepted`);
    }
  });

  it('a snapshot slot is never overwritten by a different session id (codex P2 — case collision)', async () => {
    // On a case-insensitive filesystem `CaseSnapshot` and `casesnapshot` name
    // the SAME file. Proven cross-platform by planting a snapshot that names
    // another session at the exact path the second start would use.
    const saved = process.env.BRAINCLAW_SESSION_ID;
    process.env.BRAINCLAW_SESSION_ID = 'sess_collider';
    const canonical = path.join(workspace.dir, '.brainclaw', 'coordination', 'sessions');
    fs.mkdirSync(canonical, { recursive: true });
    const slot = path.join(canonical, 'sess_collider.snapshot.json');
    fs.writeFileSync(slot, JSON.stringify({
      schema_version: 2, session_id: 'sess_first_owner', agent: 'other', started_at: new Date().toISOString(),
    }));
    const original = fs.readFileSync(slot, 'utf-8');
    try {
      await assert.rejects(
        () => startSession({ cwd: workspace.dir, maintenanceMode: 'fast' }),
        /Refusing to overwrite the session_snapshot/,
      );
      assert.equal(fs.readFileSync(slot, 'utf-8'), original, "the first session's snapshot must survive");
    } finally {
      if (saved === undefined) delete process.env.BRAINCLAW_SESSION_ID;
      else process.env.BRAINCLAW_SESSION_ID = saved;
    }
  });

  it('a legitimate session still saves and loads normally (no collateral damage)', () => {
    saveCurrentSession(record('sess_legit_1ec8'), workspace.dir);
    assert.equal(loadSessionById('sess_legit_1ec8', workspace.dir)?.session_id, 'sess_legit_1ec8');
    clearCurrentSession(workspace.dir, 'sess_legit_1ec8');
    assert.equal(loadSessionById('sess_legit_1ec8', workspace.dir), undefined);
  });
});
