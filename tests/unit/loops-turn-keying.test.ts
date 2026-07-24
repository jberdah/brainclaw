import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LaneResultSchema, RuntimeEventSchema } from '../../src/core/schema.js';
import { LoopEventSchema, LoopSlotSchema } from '../../src/core/loops/types.js';
import {
  writeCompletionSignal,
  readCompletionSignal,
  readCompletionSignals,
  getRuntimeSignalPath,
  signalExists,
  ensureRuntimeDirs,
  type CompletionSignalBody,
} from '../../src/core/runtime-signals.js';

// pln#630 PR2b-a (§13 R2/R3) — additive turn-attempt correlation keys on the
// evidence channels. Dual-key on WRITE (keys optional so legacy records/lanes
// still parse); the read-STRICT acceptance path that requires them lands later.

describe('turn-keying — LANE-RESULT + runtime-signal schema deltas', () => {
  it('LaneResult accepts turn_id/run_id/nonce', () => {
    const r = LaneResultSchema.parse({
      assignment_id: 'asgn_1', status: 'completed', summary: 'done',
      turn_id: 'tat_1', run_id: 'run_1', nonce: 'tok_gen1',
    });
    assert.equal(r.turn_id, 'tat_1');
    assert.equal(r.run_id, 'run_1');
    assert.equal(r.nonce, 'tok_gen1');
  });

  it('LaneResult without the keys still parses (backward compat)', () => {
    const r = LaneResultSchema.parse({ assignment_id: 'asgn_1', status: 'blocked', summary: 'x' });
    assert.equal(r.turn_id, undefined);
    assert.equal(r.nonce, undefined);
  });

  it('RuntimeEvent accepts turn_id/nonce', () => {
    const e = RuntimeEventSchema.parse({
      id: 'evt_1', agent: 'codex', event_type: 'observation',
      created_at: new Date().toISOString(), text: 'x',
      turn_id: 'tat_2', nonce: 'tok_gen2',
    });
    assert.equal(e.turn_id, 'tat_2');
    assert.equal(e.nonce, 'tok_gen2');
  });

  it('RuntimeEvent without the keys still parses', () => {
    const e = RuntimeEventSchema.parse({
      id: 'evt_2', agent: 'codex', event_type: 'observation',
      created_at: new Date().toISOString(), text: 'x',
    });
    assert.equal(e.turn_id, undefined);
  });

  it('turn_reserved LoopEvent variant parses with its required fields', () => {
    const base = { event_id: 'lev_1', loop_id: 'lop_abc', seq: 1, at: new Date().toISOString(), mutation_id: 'mut_1' };
    const ev = LoopEventSchema.parse({ ...base, kind: 'turn_reserved', slot_id: 'lsl_r', phase: 'findings', turn_id: 'tat_1' });
    assert.equal(ev.kind, 'turn_reserved');
    assert.throws(() => LoopEventSchema.parse({ ...base, kind: 'turn_reserved', slot_id: 'lsl_r', phase: 'findings' }), 'turn_id is required');
  });

  it('LoopSlot round-trips current_turn_id and parses legacy slots without it', () => {
    const withPtr = LoopSlotSchema.parse({ slot_id: 'lsl_a', role: 'reviewer', status: 'open', current_turn_id: 'tat_9' });
    assert.equal(withPtr.current_turn_id, 'tat_9');
    const legacy = LoopSlotSchema.parse({ slot_id: 'lsl_b', role: 'reviewer', status: 'open' });
    assert.equal(legacy.current_turn_id, undefined);
  });
});

describe('turn-keying — typed completion-sentinel body (read-strict foundation)', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-turn-keying-'));
    ensureRuntimeDirs(root);
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('round-trips a turn-keyed completion body', () => {
    const body: CompletionSignalBody = { turn_id: 'tat_9', run_id: 'run_9', nonce: 'tok_gen9', status: 'completed', at: new Date().toISOString() };
    writeCompletionSignal(root, 'asgn_9', body);
    assert.equal(signalExists(root, 'asgn_9', 'completed'), true, 'presence semantics preserved');
    const read = readCompletionSignal(root, 'asgn_9');
    assert.deepEqual(read, body);
  });

  it('returns undefined for a LEGACY presence-only sentinel (empty file)', () => {
    // Simulate the shell `&& completed` wrapper: a bare, empty marker.
    const p = getRuntimeSignalPath(root, 'asgn_legacy', 'completed');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '', 'utf-8');
    assert.equal(signalExists(root, 'asgn_legacy', 'completed'), true, 'still a valid life-sign by presence');
    assert.equal(readCompletionSignal(root, 'asgn_legacy'), undefined, 'presence-only is NOT turn-keyed evidence');
  });

  it('returns undefined when a body is missing the correlation keys', () => {
    const p = getRuntimeSignalPath(root, 'asgn_partial', 'completed');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ status: 'completed', at: 'now' }), 'utf-8');
    assert.equal(readCompletionSignal(root, 'asgn_partial'), undefined);
  });

  it('returns undefined when no sentinel exists', () => {
    assert.equal(readCompletionSignal(root, 'asgn_absent'), undefined);
    assert.deepEqual(readCompletionSignals(root, 'asgn_absent'), {});
  });

  it('round-trips a failed body', () => {
    const body: CompletionSignalBody = { turn_id: 'tat_f', run_id: 'run_f', nonce: 'tok_f', status: 'failed', at: new Date().toISOString() };
    writeCompletionSignal(root, 'asgn_f', body);
    assert.deepEqual(readCompletionSignal(root, 'asgn_f'), body);
    assert.deepEqual(readCompletionSignals(root, 'asgn_f'), { failed: body });
  });

  it('surfaces a completed+failed contradiction (R4); singular prefers completed', () => {
    const completed: CompletionSignalBody = { turn_id: 'tat_c', run_id: 'run_c', nonce: 'tok_c', status: 'completed', at: 'c' };
    const failed: CompletionSignalBody = { turn_id: 'tat_c', run_id: 'run_c', nonce: 'tok_c', status: 'failed', at: 'f' };
    writeCompletionSignal(root, 'asgn_conflict', completed);
    writeCompletionSignal(root, 'asgn_conflict', failed);
    const both = readCompletionSignals(root, 'asgn_conflict');
    assert.deepEqual(both.completed, completed, 'completed sentinel surfaced');
    assert.deepEqual(both.failed, failed, 'failed sentinel ALSO surfaced (no silent collapse)');
    assert.deepEqual(readCompletionSignal(root, 'asgn_conflict'), completed, 'convenience reader prefers completed');
  });

  it('returns undefined for a non-JSON body (never throws)', () => {
    const p = getRuntimeSignalPath(root, 'asgn_junk', 'completed');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'not json at all {{{', 'utf-8');
    assert.equal(readCompletionSignal(root, 'asgn_junk'), undefined);
    assert.deepEqual(readCompletionSignals(root, 'asgn_junk'), {});
  });
});
