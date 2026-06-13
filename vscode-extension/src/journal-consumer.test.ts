/**
 * pln#560 step 2 slice 1 — observer journal consumer.
 * Pure reducer + tail + cursor, per docs/concepts/observer-protocol.md §2–§5.
 */
import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  applyRecord, applyTail, tailRecords, tailStartIndex, classifyAction, projectSections,
  type Projection, type JournalRecord,
} from './journal-consumer.js';

function tmpEvents(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-obs-'));
  fs.mkdirSync(path.join(dir, 'events'), { recursive: true });
  return path.join(dir, 'events');
}
function rec(seq: number, action: string, item_type: string, item_id: string, payload?: Record<string, unknown>): string {
  const r: JournalRecord = { v: 2, seq, ts: '2026-06-13T00:00:00Z', writer: 'w', agent: 'a', action, item_type, item_id, ...(payload ? { payload } : {}) };
  return JSON.stringify(r);
}
function writeSeg(eventsDir: string, firstSeq: number, lines: string[]): void {
  fs.writeFileSync(path.join(eventsDir, `seg-${String(firstSeq).padStart(8, '0')}.jsonl`), lines.join('\n') + '\n');
}

const cleanup: string[] = [];
afterEach(() => { while (cleanup.length) { try { fs.rmSync(path.dirname(cleanup.pop()!), { recursive: true, force: true }); } catch { /* ignore */ } } });

describe('observer journal consumer (pln#560 s2)', () => {
  it('classifies by table + prefix + unknown', () => {
    assert.equal(classifyAction('create'), 'entity-state');
    assert.equal(classifyAction('delete'), 'tombstone');
    assert.equal(classifyAction('session_start'), 'observability');
    assert.equal(classifyAction('assignment_completed'), 'registry-lifecycle');
    assert.equal(classifyAction('run_running'), 'registry-lifecycle');
    assert.equal(classifyAction('some_future_verb'), undefined);
  });

  it('tails from cursor, upserts/last-write-wins, tombstone removes, advances cursor', () => {
    const ev = tmpEvents(); cleanup.push(ev + '/x');
    writeSeg(ev, 1, [
      rec(1, 'create', 'decision', 'dec_1', { id: 'dec_1', text: 'one' }),
      rec(2, 'create', 'decision', 'dec_2', { id: 'dec_2', text: 'two' }),
      rec(3, 'update', 'decision', 'dec_1', { id: 'dec_1', text: 'one-edited' }),
      rec(4, 'delete', 'decision', 'dec_2'),
    ]);
    const proj: Projection = new Map();
    const r = applyTail(proj, ev, { seq: 0, checkpoint_seq: 0 });
    assert.equal(r.applied, 4);
    assert.equal(r.cursor.seq, 4);
    assert.deepEqual([...proj.keys()], ['decision:dec_1']);
    assert.equal(proj.get('decision:dec_1')!.payload.text, 'one-edited');
    assert.deepEqual([...r.affectedTypes], ['decision']);
  });

  it('cursor filter: records at/below cursor.seq are not re-applied', () => {
    const ev = tmpEvents(); cleanup.push(ev + '/x');
    writeSeg(ev, 1, [rec(1, 'create', 'plan', 'pln_1', { id: 'pln_1' }), rec(2, 'create', 'plan', 'pln_2', { id: 'pln_2' })]);
    const proj: Projection = new Map();
    const r = applyTail(proj, ev, { seq: 1, checkpoint_seq: 0 });
    assert.equal(r.applied, 1);
    assert.deepEqual([...proj.keys()], ['plan:pln_2']);
  });

  it('forward-compatible: unknown action with payload+item_id upserts; observability/payload-less ignored', () => {
    const proj: Projection = new Map();
    assert.equal(applyRecord(proj, { v: 2, seq: 1, action: 'some_future_verb', item_type: 'decision', item_id: 'dec_x', payload: { id: 'dec_x' } }), 'decision');
    assert.equal(proj.has('decision:dec_x'), true);
    // observability never upserts state
    assert.equal(applyRecord(proj, { v: 2, seq: 2, action: 'session_start', item_type: 'session', item_id: 'sess_1', payload: { id: 'sess_1' } }), undefined);
    assert.equal(proj.has('session:sess_1'), false);
    // unknown without payload → ignored
    assert.equal(applyRecord(proj, { v: 2, seq: 3, action: 'mystery', item_type: 'thing', item_id: 't1' }), undefined);
  });

  it('skips a torn tail line, never throws, still applies the good records', () => {
    const ev = tmpEvents(); cleanup.push(ev + '/x');
    fs.writeFileSync(path.join(ev, 'seg-00000001.jsonl'),
      rec(1, 'create', 'trap', 'trp_1', { id: 'trp_1' }) + '\n' + '{"v":2,"seq":2,"action":"create","item_ty');
    const proj: Projection = new Map();
    const r = applyTail(proj, ev, { seq: 0, checkpoint_seq: 0 });
    assert.equal(r.applied, 1);
    assert.deepEqual([...proj.keys()], ['trap:trp_1']);
  });

  it('ignores malformed (non-8-digit) segment filenames + rejects a corrupt fractional seq (cursor not advanced past valid records)', () => {
    const ev = tmpEvents(); cleanup.push(ev + '/x');
    // malformed segment name (not 8-digit) must be ignored entirely
    fs.writeFileSync(path.join(ev, 'seg-2.jsonl'), rec(99, 'create', 'plan', 'p_bad', { id: 'p_bad' }) + '\n');
    // canonical segment with a corrupt fractional seq line + a valid line
    writeSeg(ev, 1, [
      '{"v":2,"seq":2.5,"action":"create","item_type":"plan","item_id":"p_frac","payload":{"id":"p_frac"}}',
      rec(2, 'create', 'plan', 'p_ok', { id: 'p_ok' }),
    ]);
    const proj: Projection = new Map();
    const r = applyTail(proj, ev, { seq: 0, checkpoint_seq: 0 });
    assert.deepEqual([...proj.keys()], ['plan:p_ok'], 'only the valid record from the canonical segment applies');
    assert.equal(r.cursor.seq, 2, 'cursor advances to the valid seq, not the corrupt fractional one');
  });

  it('projectSections groups by item_type', () => {
    const proj: Projection = new Map();
    applyRecord(proj, { v: 2, seq: 1, action: 'create', item_type: 'decision', item_id: 'd1', payload: { id: 'd1' } });
    applyRecord(proj, { v: 2, seq: 2, action: 'create', item_type: 'trap', item_id: 't1', payload: { id: 't1' } });
    applyRecord(proj, { v: 2, seq: 3, action: 'create', item_type: 'decision', item_id: 'd2', payload: { id: 'd2' } });
    const sections = projectSections(proj);
    assert.equal(sections.get('decision')!.length, 2);
    assert.equal(sections.get('trap')!.length, 1);
  });

  it('trims oversized payload fields for the projection (memory cap) but keeps small fields intact', () => {
    const proj: Projection = new Map();
    applyRecord(proj, { v: 2, seq: 1, action: 'create', item_type: 'handoff', item_id: 'h1', entity_rev: 9, payload: {
      id: 'h1', from: 'a', to: 'b', status: 'open',
      text: 'x'.repeat(50_000),                       // giant narrative → truncated
      related_paths: Array.from({ length: 600 }, (_, i) => `p${i}`), // debris array → capped
      tags: ['t1', 't2'],                              // small array → untouched
      snapshot: { huge: 'y'.repeat(100_000), nested: { a: 1 } }, // nested object → dropped
      count: 7, done: false, parent: null,             // scalars → kept (incl. null)
    }});
    const entry = proj.get('handoff:h1')!;
    assert.equal(entry.entity_rev, 9, 'entity_rev is preserved outside the trimmed payload');
    const p = entry.payload as any;
    assert.equal(p.from, 'a'); assert.equal(p.to, 'b'); assert.equal(p.status, 'open');
    assert.equal(p.text.length, 4096, 'long string truncated to the cap');
    assert.equal(p.related_paths.length, 100, 'large array capped');
    assert.deepEqual(p.tags, ['t1', 't2'], 'small array untouched');
    assert.equal('snapshot' in p, false, 'nested object field dropped (never rendered)');
    assert.equal(p.count, 7); assert.equal(p.done, false); assert.equal(p.parent, null);
  });

  it('tailStartIndex skips fully-applied rolled segments (reads from the segment holding fromSeq+1)', () => {
    const segs = ['seg-00000001.jsonl', 'seg-00000876.jsonl']; // ranges 1..875, 876..
    assert.equal(tailStartIndex(segs, 0), 0, 'cold start reads all segments');
    assert.equal(tailStartIndex(segs, 874), 0, 'fromSeq inside seg1 (needs 875) reads from seg1');
    assert.equal(tailStartIndex(segs, 875), 1, 'fromSeq at seg1 boundary (next is 876) skips seg1');
    assert.equal(tailStartIndex(segs, 1475), 1, 'fromSeq deep in active segment skips the rolled seg1');
    assert.equal(tailStartIndex([], 5), 0, 'no segments → 0');
    assert.equal(tailStartIndex(['seg-00000001.jsonl'], 875), 0, 'single active segment is always read');
  });

  it('warm tail past a rolled segment does not re-read it, yet stays correct', () => {
    const ev = tmpEvents(); cleanup.push(ev + '/x');
    writeSeg(ev, 1, [rec(1, 'create', 'plan', 'p1', { id: 'p1' }), rec(2, 'create', 'plan', 'p2', { id: 'p2' })]);
    writeSeg(ev, 3, [rec(3, 'create', 'plan', 'p3', { id: 'p3' })]);
    // Cursor past the first (rolled) segment: only seg-3's record is returned,
    // and the start index proves seg-1 is skipped entirely.
    assert.equal(tailStartIndex(['seg-00000001.jsonl', 'seg-00000003.jsonl'], 2), 1);
    const tail = tailRecords(ev, 2);
    assert.deepEqual(tail.map((r) => r.item_id), ['p3']);
  });

  it('warm tail reads a freshly rolled active segment whose first seq is the next wanted seq', () => {
    const ev = tmpEvents(); cleanup.push(ev + '/x');
    writeSeg(ev, 1, [rec(1, 'create', 'plan', 'p1', { id: 'p1' }), rec(2, 'create', 'plan', 'p2', { id: 'p2' })]);
    writeSeg(ev, 3, [rec(3, 'create', 'plan', 'p3', { id: 'p3' }), rec(4, 'create', 'plan', 'p4', { id: 'p4' })]);
    assert.equal(tailStartIndex(['seg-00000001.jsonl', 'seg-00000003.jsonl'], 2), 1);
    assert.deepEqual(tailRecords(ev, 2).map((r) => r.seq), [3, 4]);
  });

  it('multi-segment tail in (segment, file-line) order', () => {
    const ev = tmpEvents(); cleanup.push(ev + '/x');
    writeSeg(ev, 1, [rec(1, 'create', 'plan', 'p1', { id: 'p1', n: 1 })]);
    writeSeg(ev, 2, [rec(2, 'update', 'plan', 'p1', { id: 'p1', n: 2 })]);
    assert.equal(tailRecords(ev, 0).length, 2);
    const proj: Projection = new Map();
    applyTail(proj, ev, { seq: 0, checkpoint_seq: 0 });
    assert.equal(proj.get('plan:p1')!.payload.n, 2);
  });
});
