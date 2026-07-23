import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openLoop, getLoop, listLoopEvents } from '../../src/core/loops/index.js';
import { appendEvent } from '../../src/core/loops/store.js';
import type { LoopEvent, LoopThread } from '../../src/core/loops/types.js';
import {
  commitViaIntent,
  applyIntent,
  writeIntent,
  recoverPendingIntents,
  reconstructConsistentThread,
  hasPendingIntent,
  gcCommitMarkers,
  IntentConflictError,
  type LoopCommitIntent,
} from '../../src/core/loops/commit-intent.js';

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-commit-intent-'));
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  return dir;
}

function seedLoop(cwd: string): LoopThread {
  return openLoop(
    { kind: 'review', title: 'commit-intent test', slots: [{ role: 'reviewer', agent: 'codex' }], created_by: 'agt_test' },
    cwd,
  );
}

/** Build a complete_turn-style intent input on top of a version-1 loop (opened at seq 1). */
function completeTurnIntentInput(loop: LoopThread): Omit<LoopCommitIntent, 'intent_id' | 'kind' | 'created_at'> {
  const mutation_id = crypto.randomUUID().replace(/-/g, '');
  const now = '2026-07-23T20:30:00.000Z';
  const artifactId = `art_${crypto.randomBytes(6).toString('hex')}`;
  const slot = loop.slots[0];
  const events: LoopEvent[] = [
    {
      event_id: crypto.randomUUID(),
      loop_id: loop.id,
      seq: 2,
      at: now,
      by: 'agt_test',
      mutation_id,
      kind: 'artifact_added',
      artifact_id: artifactId,
      phase: loop.current_phase,
      type: 'verdict',
      produced_by: slot.slot_id,
    },
    {
      event_id: crypto.randomUUID(),
      loop_id: loop.id,
      seq: 3,
      at: now,
      by: 'agt_test',
      mutation_id,
      kind: 'turn_completed',
      slot_id: slot.slot_id,
      phase: loop.current_phase,
      artifact_id: artifactId,
      outcome: 'done',
    },
  ];
  const thread_snapshot: LoopThread = {
    ...loop,
    version: 2,
    mutation_id,
    slots: loop.slots.map((s) => (s.slot_id === slot.slot_id ? { ...s, status: 'done' } : s)),
    artifacts: [
      ...loop.artifacts,
      { artifact_id: artifactId, phase: loop.current_phase, type: 'verdict', body: 'accepted: LGTM', produced_by: slot.slot_id, produced_at: now },
    ],
    updated_at: now,
  };
  return { loop_id: loop.id, base_version: 1, events, thread_snapshot };
}

describe('commit-intent — happy path + idempotency', () => {
  let cwd: string;
  beforeEach(() => { cwd = makeWorkspace(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('commitViaIntent appends events, updates thread, renames intent to .applied', () => {
    const loop = seedLoop(cwd);
    commitViaIntent(completeTurnIntentInput(loop), cwd);

    const events = listLoopEvents(loop.id, cwd);
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3], 'journal has opened + artifact + completion');
    assert.equal(events[2].kind, 'turn_completed');
    const t = getLoop(loop.id, cwd);
    assert.equal(t?.version, 2);
    assert.equal(t?.slots[0].status, 'done');
    assert.ok(t?.artifacts.some((a) => a.type === 'verdict'));
    assert.equal(hasPendingIntent(loop.id, cwd), false, 'intent renamed to .applied, none pending');
  });

  it('applyIntent is idempotent — re-applying does not duplicate events or corrupt the thread', () => {
    const loop = seedLoop(cwd);
    const intent = writeIntent(completeTurnIntentInput(loop), cwd);
    applyIntent(intent, cwd);
    // A second apply of the SAME intent object (e.g. a racing recovery) must be a no-op.
    applyIntent(intent, cwd);
    const events = listLoopEvents(loop.id, cwd);
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3], 'no duplicate events on re-apply');
    assert.equal(getLoop(loop.id, cwd)?.version, 2);
  });
});

describe('commit-intent — fault injection (crash at each step → recover converges)', () => {
  let cwd: string;
  beforeEach(() => { cwd = makeWorkspace(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  function crashThenRecover(faultAt: 'after_intent' | 'after_journal' | 'after_thread' | 'before_marker'): void {
    const loop = seedLoop(cwd);
    assert.throws(() => commitViaIntent(completeTurnIntentInput(loop), cwd, faultAt), /simulated crash/);
    // Before recovery the intent is still pending (the mutation is durable in the intent).
    assert.equal(hasPendingIntent(loop.id, cwd), true, `intent pending after crash ${faultAt}`);

    // Simulate restart: recover at lock entry.
    const res = recoverPendingIntents(loop.id, cwd);
    assert.equal(res.conflicted, 0);
    assert.equal(res.applied, 1);

    // Converged: journal + thread both reflect the completed turn exactly once.
    const events = listLoopEvents(loop.id, cwd);
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3], `no dup/hole after recover from ${faultAt}`);
    const t = getLoop(loop.id, cwd);
    assert.equal(t?.version, 2);
    assert.equal(t?.slots[0].status, 'done');
    assert.equal(hasPendingIntent(loop.id, cwd), false, 'intent renamed .applied after recovery');
  }

  it('crash after_intent (nothing applied yet) → recovery applies the whole mutation', () => crashThenRecover('after_intent'));
  it('crash after_journal (events durable, thread stale) → recovery writes the thread', () => crashThenRecover('after_journal'));
  it('crash after_thread (journal+thread durable, marker pending) → recovery renames marker', () => crashThenRecover('after_thread'));
  it('crash before_marker → recovery is a no-op apply + marker rename', () => crashThenRecover('before_marker'));
});

describe('commit-intent — foreign-overlap conflict (stale intent, no seq>max blind append)', () => {
  let cwd: string;
  beforeEach(() => { cwd = makeWorkspace(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('a foreign writer occupying the planned seq range makes the intent a CONFLICT (not applied)', () => {
    const loop = seedLoop(cwd);
    const input = completeTurnIntentInput(loop);
    const intent = writeIntent(input, cwd);

    // A bypassing writer advances the journal into the planned seq range (seq 2)
    // AFTER the intent was staged — the exact hazard "seq > max" replay would miss.
    appendEvent(loop.id, {
      event_id: crypto.randomUUID(),
      loop_id: loop.id,
      seq: 2,
      at: '2026-07-23T20:31:00.000Z',
      by: 'foreign',
      mutation_id: crypto.randomUUID().replace(/-/g, ''),
      kind: 'paused',
      reason: 'foreign',
    } as LoopEvent, cwd);

    assert.throws(() => applyIntent(intent, cwd), (e: unknown) => e instanceof IntentConflictError);
    // The stale intent is quarantined; the foreign event is untouched; no plan event appended.
    const events = listLoopEvents(loop.id, cwd);
    assert.deepEqual(events.map((e) => e.seq), [1, 2]);
    assert.equal(events[1].kind, 'paused', 'foreign seq-2 event preserved, plan not appended over it');
    assert.equal(hasPendingIntent(loop.id, cwd), false, 'intent moved to .conflict');
  });

  it('recoverPendingIntents quarantines a conflicting intent without blocking a clean one', () => {
    const loop = seedLoop(cwd);
    // Stage a stale intent, then poison its seq range.
    const stale = writeIntent(completeTurnIntentInput(loop), cwd);
    appendEvent(loop.id, {
      event_id: crypto.randomUUID(), loop_id: loop.id, seq: 2, at: '2026-07-23T20:31:00.000Z',
      by: 'foreign', mutation_id: crypto.randomUUID().replace(/-/g, ''), kind: 'paused', reason: 'foreign',
    } as LoopEvent, cwd);
    void stale;
    const res = recoverPendingIntents(loop.id, cwd);
    assert.equal(res.conflicted, 1);
    assert.equal(res.applied, 0);
    assert.equal(hasPendingIntent(loop.id, cwd), false);
  });
});

describe('commit-intent — consistent reads + GC', () => {
  let cwd: string;
  beforeEach(() => { cwd = makeWorkspace(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('getLoop reconstructs the pending intent snapshot when the on-disk thread is behind', () => {
    const loop = seedLoop(cwd);
    // Stage but do not apply (crash after_intent).
    assert.throws(() => commitViaIntent(completeTurnIntentInput(loop), cwd, 'after_intent'), /simulated crash/);

    // The raw thread FILE is still at version 1 — the intent was staged (durable)
    // but not yet applied to the projection.
    const rawPath = path.join(cwd, '.brainclaw', 'loops', 'threads', `${loop.id}.json`);
    assert.equal(JSON.parse(fs.readFileSync(rawPath, 'utf8')).version, 1, 'raw on-disk thread not yet applied');

    // getLoop now returns the reconstructed consistent view (PR1b wiring): the
    // mutation is durable in the intent, so the read reflects version 2.
    const view = getLoop(loop.id, cwd);
    assert.equal(view?.version, 2, 'getLoop reflects the durable-in-intent mutation');
    assert.equal(view?.slots[0].status, 'done');

    // Direct unit-level check of the reconstruction primitive too.
    assert.equal(reconstructConsistentThread(loop.id, undefined, cwd)?.version, 2);
  });

  it('gcCommitMarkers removes applied markers older than the cutoff', () => {
    const loop = seedLoop(cwd);
    commitViaIntent(completeTurnIntentInput(loop), cwd);
    // maxAge = -1 → everything is "older than now + 1ms" → removed.
    const removed = gcCommitMarkers(loop.id, -1, cwd);
    assert.ok(removed >= 1, 'the .applied marker was GC-d');
  });
});

// Hardening from the PR #102 symmetric review (torn append, malformed intent,
// divergent projection identity).
describe('commit-intent — crash-safety hardening (review round 1 fixes)', () => {
  let cwd: string;
  beforeEach(() => { cwd = makeWorkspace(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('a torn trailing journal fragment is repaired, then the intent applies cleanly', () => {
    const loop = seedLoop(cwd);
    const jp = path.join(cwd, '.brainclaw', 'loops', 'events', `${loop.id}.jsonl`);
    // Simulate a power loss mid-append: a non-empty, unparseable trailing line
    // with no newline (the exact torn-append the review flagged as unrecoverable).
    fs.appendFileSync(jp, '{"event_id":"torn","seq":2,"kind":"turn_completed"');

    const intent = writeIntent(completeTurnIntentInput(loop), cwd);
    applyIntent(intent, cwd); // must repair the torn tail, then append seq 2,3.

    const events = listLoopEvents(loop.id, cwd);
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3], 'torn fragment dropped, plan applied contiguously');
    assert.equal(events[2].kind, 'turn_completed');
    assert.equal(getLoop(loop.id, cwd)?.version, 2);
    assert.equal(hasPendingIntent(loop.id, cwd), false);
  });

  it('listLoopEvents tolerates a torn trailing fragment (seq allocation never wedges)', () => {
    const loop = seedLoop(cwd);
    const jp = path.join(cwd, '.brainclaw', 'loops', 'events', `${loop.id}.jsonl`);
    fs.appendFileSync(jp, '{"event_id":"torn","seq":2,"partial');
    const events = listLoopEvents(loop.id, cwd);
    assert.deepEqual(events.map((e) => e.seq), [1], 'torn tail dropped on read, no throw');
  });

  it('a malformed intent file is quarantined to .corrupt (visible), not silently skipped', () => {
    const loop = seedLoop(cwd);
    const dir = path.join(cwd, '.brainclaw', 'loops', 'commits', loop.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'deadbeef.intent.json'), '{ this is not valid json');

    const res = recoverPendingIntents(loop.id, cwd);
    assert.equal(res.corrupt, 1, 'malformed intent counted as corrupt');
    assert.equal(res.applied, 0);
    assert.equal(hasPendingIntent(loop.id, cwd), false, 'malformed intent moved out of the pending set');
    assert.ok(fs.existsSync(path.join(dir, 'deadbeef.corrupt.json')), 'quarantined to .corrupt');
  });

  it('a divergent on-disk projection at the same version is a CONFLICT, not a silent skip', () => {
    const loop = seedLoop(cwd);
    const intent = writeIntent(completeTurnIntentInput(loop), cwd);
    // A foreign writer advances the thread to version 2 with a DIFFERENT
    // mutation_id (divergent projection) before the intent applies.
    const tp = path.join(cwd, '.brainclaw', 'loops', 'threads', `${loop.id}.json`);
    const divergent = { ...JSON.parse(fs.readFileSync(tp, 'utf8')), version: 2, mutation_id: 'ffffffffffffffffffffffffffffffff' };
    fs.writeFileSync(tp, JSON.stringify(divergent, null, 2));

    assert.throws(() => applyIntent(intent, cwd), (e: unknown) => e instanceof IntentConflictError);
    assert.equal(hasPendingIntent(loop.id, cwd), false, 'intent quarantined to .conflict');
  });
});

// Hardening from the PR #102 symmetric review ROUND 2 (unconditional tail
// repair, strict cross-loop intent validation).
describe('commit-intent — crash-safety hardening (review round 2 fixes)', () => {
  let cwd: string;
  beforeEach(() => { cwd = makeWorkspace(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('recoverPendingIntents repairs a torn tail even with NO pending intent, so a later normal append survives', () => {
    const loop = seedLoop(cwd);
    const jp = path.join(cwd, '.brainclaw', 'loops', 'events', `${loop.id}.jsonl`);
    // Ordinary appendEvent crash: a torn fragment with NO pending intent.
    fs.appendFileSync(jp, '{"event_id":"torn","seq":2,"partial');

    // Lock-entry recovery must repair the tail unconditionally.
    const res = recoverPendingIntents(loop.id, cwd);
    assert.equal(res.applied, 0);
    assert.equal(res.corrupt, 0);
    assert.deepEqual(listLoopEvents(loop.id, cwd).map((e) => e.seq), [1], 'torn tail repaired without any pending intent');

    // A subsequent normal append lands cleanly (not fused with the torn fragment,
    // so the legitimate event is never hidden/lost).
    appendEvent(loop.id, {
      event_id: crypto.randomUUID(), loop_id: loop.id, seq: 2, at: '2026-07-23T21:00:00.000Z',
      by: 'x', mutation_id: crypto.randomUUID().replace(/-/g, ''), kind: 'paused', reason: 'x',
    } as LoopEvent, cwd);
    assert.deepEqual(listLoopEvents(loop.id, cwd).map((e) => e.seq), [1, 2], 'legitimate post-repair event survives');
  });

  it('a valid intent for a DIFFERENT loop placed in this loop dir is quarantined, never applied', () => {
    const loopA = seedLoop(cwd);
    const loopB = openLoop(
      { kind: 'review', title: 'B', slots: [{ role: 'reviewer', agent: 'codex' }], created_by: 'agt_test' },
      cwd,
    );
    // A structurally-VALID intent for loop B, misplaced into loop A's commits dir.
    const intentB = {
      ...completeTurnIntentInput(loopB),
      intent_id: 'xloop',
      kind: 'complete_turn' as const,
      created_at: '2026-07-23T21:00:00.000Z',
    };
    const dirA = path.join(cwd, '.brainclaw', 'loops', 'commits', loopA.id);
    fs.mkdirSync(dirA, { recursive: true });
    fs.writeFileSync(path.join(dirA, 'xloop.intent.json'), JSON.stringify(intentB));

    const res = recoverPendingIntents(loopA.id, cwd);
    assert.equal(res.corrupt, 1, 'cross-loop intent quarantined');
    assert.equal(res.applied, 0);
    assert.equal(getLoop(loopB.id, cwd)?.version, 1, 'loop B was NOT advanced by the misplaced intent');
    assert.ok(fs.existsSync(path.join(dirA, 'xloop.corrupt.json')), 'quarantined to .corrupt');
    // A read of loop A must not surface B's snapshot either.
    assert.equal(getLoop(loopA.id, cwd)?.id, loopA.id);
  });
});
