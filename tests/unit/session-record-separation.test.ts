import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startSession, loadSessionSnapshot, migrateLegacySnapshotNames } from '../../src/commands/session-start.js';
import { loadCurrentSession, loadAllSessions, saveCurrentSession, gcStaleSessions } from '../../src/core/identity.js';
import { sessionSnapshotRecordPaths } from '../../src/core/io.js';
import { saveVersionedJsonFile } from '../../src/core/migration.js';
import { SessionSnapshotSchema, type SessionSnapshot } from '../../src/core/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

// pln#670 — session_snapshot and current_session share the `sessions` directory
// family AND the same session_id; only the `<id>.snapshot.json` suffix keeps them
// apart. Every assertion here is against the DISK (trp#1292): the two record
// types must be able to coexist anywhere without clobbering or cross-adoption.
describe('session record namespace separation (pln#670)', () => {
  let workspace: TestWorkspace;

  const legacySessionsDir = () => path.join(workspace.dir, '.brainclaw', 'sessions');
  const canonicalSessionsDir = () => path.join(workspace.dir, '.brainclaw', 'coordination', 'sessions');

  const writeSnapshotFixture = (filePath: string, sessionId: string) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    saveVersionedJsonFile('session_snapshot', filePath, SessionSnapshotSchema.parse({
      schema_version: 2,
      session_id: sessionId,
      agent: workspace.currentAgent.agent_name,
      agent_id: workspace.currentAgent.agent_id,
      started_at: new Date().toISOString(),
    } satisfies SessionSnapshot));
  };

  const writeCurrentSessionFixture = (sessionId: string, overrides: { last_seen_at?: string } = {}) => {
    const now = new Date().toISOString();
    saveCurrentSession({
      schema_version: 2,
      session_id: sessionId,
      started_at: now,
      last_seen_at: overrides.last_seen_at ?? now,
      agent: workspace.currentAgent.agent_name,
      agent_id: workspace.currentAgent.agent_id,
      host_id: 'host-test',
      pid: process.pid,
    }, workspace.dir);
  };

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-session-split-',
      projectId: 'prj_session_split',
      currentAgent: 'claude-code',
    });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('startSession lands the snapshot in the canonical dir with the type suffix, even when the legacy sessions dir already has content', async () => {
    // Reproduces the pre-fix contamination setup: legacy `.brainclaw/sessions/`
    // exists WITH content, canonical `coordination/sessions/` does not exist yet.
    // The 'read'-mode resolution used to send the snapshot write into the legacy
    // dir, where saveCurrentSession then clobbered it (same `<id>.json`).
    writeCurrentSessionFixture('sess_preexisting');
    fs.rmSync(canonicalSessionsDir(), { recursive: true, force: true });
    assert.ok(fs.existsSync(legacySessionsDir()));
    assert.ok(!fs.existsSync(canonicalSessionsDir()));

    const snapshot = await startSession({ cwd: workspace.dir, maintenanceMode: 'fast' });

    const snapshotFile = path.join(canonicalSessionsDir(), `${snapshot.session_id}.snapshot.json`);
    const currentFile = path.join(legacySessionsDir(), `${snapshot.session_id}.json`);
    assert.ok(fs.existsSync(snapshotFile), 'snapshot must land in coordination/sessions with the .snapshot.json suffix');
    assert.ok(fs.existsSync(currentFile), 'current_session record must keep its own <id>.json in the legacy dir');
    assert.equal(loadSessionSnapshot(snapshot.session_id, workspace.dir)?.session_id, snapshot.session_id);
    assert.equal(loadCurrentSession(workspace.dir)?.session_id, snapshot.session_id);
  });

  it('both record types coexist for the SAME id in the SAME directory without clobbering', () => {
    // The exact failure mode that closed PR #210: unified directory, one id,
    // two writers. With type-suffixed names the second write cannot erase the first.
    writeCurrentSessionFixture('sess_shared');
    writeSnapshotFixture(path.join(legacySessionsDir(), 'sess_shared.snapshot.json'), 'sess_shared');

    assert.equal(loadCurrentSession(workspace.dir)?.session_id, 'sess_shared');
    const snapshot = loadSessionSnapshot('sess_shared', workspace.dir);
    assert.equal(snapshot?.session_id, 'sess_shared');
    assert.ok(!('last_seen_at' in (snapshot ?? {})), 'snapshot reader must return the snapshot record, not the current_session one');
  });

  it('current_session scanners ignore .snapshot.json files', () => {
    writeSnapshotFixture(path.join(legacySessionsDir(), 'sess_stray.snapshot.json'), 'sess_stray');

    assert.equal(loadCurrentSession(workspace.dir), undefined);
    assert.equal(loadAllSessions(workspace.dir).length, 0);
  });

  it('gcStaleSessions removes expired current_session records but never touches snapshot files, parseable or not', () => {
    const expired = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
    writeCurrentSessionFixture('sess_expired', { last_seen_at: expired });
    writeSnapshotFixture(path.join(legacySessionsDir(), 'sess_keep.snapshot.json'), 'sess_keep');
    const garbageSnapshot = path.join(legacySessionsDir(), 'sess_garbage.snapshot.json');
    fs.writeFileSync(garbageSnapshot, 'not json at all');

    const removed = gcStaleSessions(workspace.dir, '4h');

    assert.equal(removed, 1, 'only the expired current_session record is collected');
    assert.ok(!fs.existsSync(path.join(legacySessionsDir(), 'sess_expired.json')));
    assert.ok(fs.existsSync(path.join(legacySessionsDir(), 'sess_keep.snapshot.json')));
    assert.ok(fs.existsSync(garbageSnapshot), 'gc must not delete unparseable snapshot-named files');
  });

  it('dual-read still serves pre-split snapshots stored as <id>.json in the canonical dir', () => {
    writeSnapshotFixture(path.join(canonicalSessionsDir(), 'sess_legacy.json'), 'sess_legacy');

    assert.equal(loadSessionSnapshot('sess_legacy', workspace.dir)?.session_id, 'sess_legacy');
  });

  it('loadSessionSnapshot never adopts a current_session record for the same id', () => {
    // No snapshot exists at all — only the current_session <id>.json, which the
    // non-strict SessionSnapshotSchema would happily parse. The last_seen_at
    // discriminant must reject it.
    writeCurrentSessionFixture('sess_only_current');

    assert.equal(loadSessionSnapshot('sess_only_current', workspace.dir), undefined);
  });

  it('migrateLegacySnapshotNames renames pre-split snapshots and leaves current_session-shaped records alone', () => {
    writeSnapshotFixture(path.join(canonicalSessionsDir(), 'sess_old_a.json'), 'sess_old_a');
    writeSnapshotFixture(path.join(canonicalSessionsDir(), 'sess_old_b.json'), 'sess_old_b');
    // A current_session-shaped record parked in the canonical dir (worst-case
    // contamination) must never be renamed into a snapshot.
    const now = new Date().toISOString();
    fs.writeFileSync(
      path.join(canonicalSessionsDir(), 'sess_impostor.json'),
      JSON.stringify({ schema_version: 2, session_id: 'sess_impostor', started_at: now, last_seen_at: now, agent: 'x', agent_id: 'agt_x', host_id: 'h' }),
    );

    const renamed = migrateLegacySnapshotNames(workspace.dir);

    assert.equal(renamed, 2);
    assert.ok(fs.existsSync(path.join(canonicalSessionsDir(), 'sess_old_a.snapshot.json')));
    assert.ok(fs.existsSync(path.join(canonicalSessionsDir(), 'sess_old_b.snapshot.json')));
    assert.ok(!fs.existsSync(path.join(canonicalSessionsDir(), 'sess_old_a.json')));
    assert.ok(fs.existsSync(path.join(canonicalSessionsDir(), 'sess_impostor.json')), 'current_session-shaped record must stay untouched');
    assert.ok(!fs.existsSync(path.join(canonicalSessionsDir(), 'sess_impostor.snapshot.json')));
    // Renamed records stay readable through the primary probe.
    assert.equal(loadSessionSnapshot('sess_old_a', workspace.dir)?.session_id, 'sess_old_a');
  });

  it('sessionSnapshotRecordPaths probes the suffixed name before every legacy layout', () => {
    const probes = sessionSnapshotRecordPaths('sess_x', workspace.dir);
    assert.ok(probes[0].endsWith(`${path.sep}sess_x.snapshot.json`));
    assert.ok(probes.some((p) => p.endsWith(`${path.sep}sess_x.json`)), 'legacy <id>.json layouts must stay probed');
    const suffixIndex = probes.findIndex((p) => p.endsWith('.snapshot.json'));
    const legacyIndex = probes.findIndex((p) => p.endsWith(`${path.sep}sess_x.json`));
    assert.ok(suffixIndex < legacyIndex, 'suffixed probes come first');
  });
});
