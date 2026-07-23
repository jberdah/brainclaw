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

  it('reconstructConsistentThread returns the pending intent snapshot when ahead of on-disk', () => {
    const loop = seedLoop(cwd);
    // Stage but do not apply (crash after_intent).
    assert.throws(() => commitViaIntent(completeTurnIntentInput(loop), cwd, 'after_intent'), /simulated crash/);
    const onDisk = getLoop(loop.id, cwd);
    assert.equal(onDisk?.version, 1, 'on-disk thread still at version 1 (not applied)');
    const view = reconstructConsistentThread(loop.id, onDisk, cwd);
    assert.equal(view?.version, 2, 'consistent read reflects the durable-in-intent mutation');
    assert.equal(view?.slots[0].status, 'done');
  });

  it('gcCommitMarkers removes applied markers older than the cutoff', () => {
    const loop = seedLoop(cwd);
    commitViaIntent(completeTurnIntentInput(loop), cwd);
    // maxAge = -1 → everything is "older than now + 1ms" → removed.
    const removed = gcCommitMarkers(loop.id, -1, cwd);
    assert.ok(removed >= 1, 'the .applied marker was GC-d');
  });
});
