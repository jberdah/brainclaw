/**
 * pln#566 Inc0 slice 1 — journal-derived checkpoints.
 *
 * Proves the checkpoint is journal-faithful and journal-bound: a checkpoint +
 * its sealed tail reproduces exactly what a full journal replay produces, the
 * gap (events appended after the checkpoint) is replayed, and a tampered /
 * lineage-diverged / wrong-store checkpoint is rejected by verification (so the
 * read path falls back). No projection files are consulted anywhere here.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureMemoryDir } from '../../src/core/io.js';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import { forceAppendJournalRecords, journalDir, readJournalRecords } from '../../src/core/events/journal.js';
import { materializeMemoryStateFromJournal } from '../../src/core/events/materialize.js';
import {
  createCheckpoint, verifyCheckpoint, loadLatestCheckpointManifest, materializeStateFromCheckpoint,
} from '../../src/core/events/checkpoint.js';

/** Append a raw v2 record line carrying an externalized payload_ref (the API
 * does not expose payload_ref) to the active segment, to exercise the F4 guard. */
function appendPayloadRefRecord(dir: string): void {
  const segDir = journalDir(dir);
  const seg = fs.readdirSync(segDir).filter(f => f.startsWith('seg-') && f.endsWith('.jsonl')).sort().pop()!;
  const nextSeq = Math.max(0, ...readJournalRecords(dir).map(r => r.seq)) + 1;
  const rec = {
    v: 2, seq: nextSeq, ts: '2026-06-12T01:00:00.000Z', writer: 'w_test-0000', agent: 'system',
    action: 'create', item_type: 'decision', item_id: 'dec_ext',
    payload_ref: { sha256: 'a'.repeat(64), bytes: 123 },
  };
  fs.appendFileSync(path.join(segDir, seg), JSON.stringify(rec) + '\n');
}

function tmpStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-checkpoint-'));
  ensureMemoryDir(dir);
  saveConfig(defaultConfig('checkpoint-test', { projectId: 'prj_ckpt' }), dir);
  return dir;
}

function decision(i: number): Record<string, unknown> {
  return {
    id: `dec_${i}`, short_label: `dec#${i}`, text: `decision ${i}`,
    created_at: `2026-06-12T00:00:${String(i).padStart(2, '0')}.000Z`,
    author: 'tester', tags: [], schema_version: 2,
  };
}
function appendCreate(dir: string, i: number): void {
  forceAppendJournalRecords([{ action: 'create', item_type: 'decision', item_id: `dec_${i}`, agent: 'system', payload: decision(i) }], dir);
}

const cleanupDirs: string[] = [];
afterEach(() => { while (cleanupDirs.length) fs.rmSync(cleanupDirs.pop() as string, { recursive: true, force: true }); });

describe('journal-derived checkpoints (pln#566 Inc0 s1)', () => {
  it('checkpoint + tail reproduces full-journal materialization, and replays the gap', () => {
    const dir = tmpStore();
    cleanupDirs.push(dir);

    for (let i = 1; i <= 4; i++) appendCreate(dir, i);
    // mutate + delete to exercise post-image-wins + tombstone
    forceAppendJournalRecords([{ action: 'update', item_type: 'decision', item_id: 'dec_2', agent: 'system', payload: { ...decision(2), text: 'decision 2 EDITED' } }], dir);
    forceAppendJournalRecords([{ action: 'delete', item_type: 'decision', item_id: 'dec_3', agent: 'system' }], dir);

    const res = createCheckpoint(dir);
    assert.equal(res.created, true);
    assert.ok(res.manifest && res.manifest.head_seq > 0);

    // checkpoint (no tail yet) == full journal
    assert.deepEqual(materializeStateFromCheckpoint(dir), materializeMemoryStateFromJournal(dir), 'checkpoint == full journal at head');

    // append a gap AFTER the checkpoint
    appendCreate(dir, 5);
    forceAppendJournalRecords([{ action: 'delete', item_type: 'decision', item_id: 'dec_1', agent: 'system' }], dir);

    // checkpoint + sealed tail == full journal (gap replayed)
    const fromCkpt = materializeStateFromCheckpoint(dir);
    const fromJournal = materializeMemoryStateFromJournal(dir);
    assert.deepEqual(fromCkpt, fromJournal, 'checkpoint+tail == full journal after the gap');
    // sanity on the actual content: dec_1 + dec_3 deleted, dec_2 edited, dec_4 + dec_5 present
    const ids = fromJournal!.recent_decisions.map(d => d.id).sort();
    assert.deepEqual(ids, ['dec_2', 'dec_4', 'dec_5']);
    assert.equal(fromJournal!.recent_decisions.find(d => d.id === 'dec_2')!.text, 'decision 2 EDITED');
  });

  it('rejects a tampered snapshot (sha mismatch) → falls back (null)', () => {
    const dir = tmpStore();
    cleanupDirs.push(dir);
    for (let i = 1; i <= 3; i++) appendCreate(dir, i);
    const res = createCheckpoint(dir);
    assert.ok(res.created);

    // tamper the snapshot blob
    const snap = fs.readdirSync(path.join(journalDir(dir), 'checkpoints')).find(f => f.endsWith('.snapshot.json'))!;
    const snapPath = path.join(journalDir(dir), 'checkpoints', snap);
    fs.writeFileSync(snapPath, JSON.stringify([{ item_type: 'decision', item_id: 'dec_HACKED', payload: decision(99) }]));

    const manifest = loadLatestCheckpointManifest(dir)!;
    assert.equal(verifyCheckpoint(manifest, fs.readFileSync(snapPath, 'utf-8'), dir).valid, false, 'tampered snapshot must fail verification');
    assert.equal(materializeStateFromCheckpoint(dir), null, 'tampered checkpoint → null (caller falls back)');
  });

  it('rejects a checkpoint bound to a different store_id', () => {
    const dir = tmpStore();
    cleanupDirs.push(dir);
    for (let i = 1; i <= 2; i++) appendCreate(dir, i);
    createCheckpoint(dir);
    const manifest = loadLatestCheckpointManifest(dir)!;
    const snap = fs.readFileSync(path.join(journalDir(dir), 'checkpoints', `${String(manifest.head_seq).padStart(12, '0')}.snapshot.json`), 'utf-8');

    const forged = { ...manifest, store_id: 'prj_SOMEONE_ELSE' };
    assert.equal(verifyCheckpoint(forged, snap, dir).valid, false, 'wrong store_id must fail');
  });

  it('F4 guard: refuses to build or serve a checkpoint when the journal has externalized payload_ref', () => {
    const dir = tmpStore();
    cleanupDirs.push(dir);
    for (let i = 1; i <= 2; i++) appendCreate(dir, i);
    assert.equal(createCheckpoint(dir).created, true, 'builds while payloads are inline');

    // an externalized-payload record arrives (materialize cannot deref it yet)
    appendPayloadRefRecord(dir);
    assert.equal(createCheckpoint(dir).created, false, 'refuses to build with externalized payload_ref present');
    assert.equal(materializeStateFromCheckpoint(dir), null, 'refuses to serve (fall back to projections)');
  });

  it('rejects when the covered head record is no longer in the journal (lineage diverged)', () => {
    const dir = tmpStore();
    cleanupDirs.push(dir);
    for (let i = 1; i <= 2; i++) appendCreate(dir, i);
    createCheckpoint(dir);
    const manifest = loadLatestCheckpointManifest(dir)!;
    const snap = fs.readFileSync(path.join(journalDir(dir), 'checkpoints', `${String(manifest.head_seq).padStart(12, '0')}.snapshot.json`), 'utf-8');

    const forged = { ...manifest, head_seq: manifest.head_seq + 999 };
    assert.equal(verifyCheckpoint(forged, snap, dir).valid, false, 'missing head record must fail');
  });
});
