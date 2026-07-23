import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  reserve,
  commitReservation,
  abortReservation,
  assertDispatchable,
  isDispatchable,
  getReservation,
  listReservations,
  deriveChildIds,
  ReservationStateError,
  type ReserveInput,
} from '../../src/core/loops/attempt-reservation.js';

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-attempt-resv-'));
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  return dir;
}

function reserveInput(cwd: string, over: Partial<ReserveInput> = {}): ReserveInput {
  return {
    turn_id: over.turn_id ?? 'tat_0001',
    loop_id: over.loop_id ?? 'lop_abc',
    slot_id: over.slot_id ?? 'lsl_reviewer',
    target_slot_generation: over.target_slot_generation ?? 1,
    loop_version_at_reserve: over.loop_version_at_reserve ?? 3,
    agent: over.agent ?? 'codex',
    agent_id: over.agent_id,
    claim_id: over.claim_id ?? 'clm_xyz',
    phase: over.phase ?? 'findings',
    iteration: over.iteration ?? 0,
    store_root: over.store_root ?? cwd,
    cwd: over.cwd ?? cwd,
    lease_deadline: over.lease_deadline ?? new Date(Date.now() + 60_000).toISOString(),
    epoch: over.epoch,
  };
}

describe('attempt-reservation — child id derivation', () => {
  it('is deterministic and salt-distinct for a given turn_id', () => {
    const a = deriveChildIds('tat_deadbeef');
    const b = deriveChildIds('tat_deadbeef');
    assert.deepEqual(a, b, 'same turn_id yields identical child ids (idempotent recovery)');
    assert.match(a.assignment_id, /^asgn_[0-9a-f]{16}$/);
    assert.match(a.run_id, /^run_[0-9a-f]{16}$/);
    assert.notEqual(a.assignment_id.slice(5), a.run_id.slice(4), 'assignment/run salts differ');
  });

  it('differs across turn_ids', () => {
    assert.notDeepEqual(deriveChildIds('tat_1'), deriveChildIds('tat_2'));
  });
});

describe('attempt-reservation — decision CAS + dispatch guard', () => {
  let cwd: string;
  beforeEach(() => { cwd = makeWorkspace(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('reserve writes a prepared record that is NOT dispatchable', () => {
    const r = reserve(reserveInput(cwd), cwd);
    assert.equal(r.decision, 'prepared');
    assert.deepEqual(r.child_ids, deriveChildIds('tat_0001'), 'child ids derived from turn_id');
    assert.equal(r.completion_mode, 'file');
    assert.equal(isDispatchable('tat_0001', cwd), false);
    assert.throws(() => assertDispatchable('tat_0001', cwd), (e: unknown) =>
      e instanceof ReservationStateError && e.code === 'not_dispatchable');
  });

  it('reserve twice for the same turn_id throws reservation_exists (identity written once)', () => {
    reserve(reserveInput(cwd), cwd);
    assert.throws(() => reserve(reserveInput(cwd), cwd), (e: unknown) =>
      e instanceof ReservationStateError && e.code === 'reservation_exists');
  });

  it('commit: prepared → committed makes it dispatchable; commit is idempotent', () => {
    reserve(reserveInput(cwd), cwd);
    const committed = commitReservation('tat_0001', cwd);
    assert.equal(committed.decision, 'committed');
    assert.ok(committed.decided_at);
    assert.equal(isDispatchable('tat_0001', cwd), true);
    assert.doesNotThrow(() => assertDispatchable('tat_0001', cwd));
    // idempotent: committing again returns committed, no throw, no state change
    const again = commitReservation('tat_0001', cwd);
    assert.equal(again.decision, 'committed');
  });

  it('abort: prepared → aborted stays non-dispatchable; abort is idempotent', () => {
    reserve(reserveInput(cwd), cwd);
    const aborted = abortReservation('tat_0001', 'lease expired pre-launch', cwd);
    assert.equal(aborted.decision, 'aborted');
    assert.equal(aborted.abort_reason, 'lease expired pre-launch');
    assert.equal(isDispatchable('tat_0001', cwd), false);
    const again = abortReservation('tat_0001', 'second call', cwd);
    assert.equal(again.decision, 'aborted');
    assert.equal(again.abort_reason, 'lease expired pre-launch', 'reason not overwritten by idempotent re-abort');
  });

  it('CAS arbitration: a committed reservation can NEVER be aborted (no split-brain)', () => {
    reserve(reserveInput(cwd), cwd);
    commitReservation('tat_0001', cwd);
    assert.throws(() => abortReservation('tat_0001', 'too late', cwd), (e: unknown) =>
      e instanceof ReservationStateError && e.code === 'committed_not_abortable');
    // state unchanged: still committed + dispatchable
    assert.equal(getReservation('tat_0001', cwd)?.decision, 'committed');
    assert.equal(isDispatchable('tat_0001', cwd), true);
  });

  it('CAS arbitration: an aborted reservation can NEVER be committed (no phantom dispatch)', () => {
    reserve(reserveInput(cwd), cwd);
    abortReservation('tat_0001', 'recoverer aborted', cwd);
    assert.throws(() => commitReservation('tat_0001', cwd), (e: unknown) =>
      e instanceof ReservationStateError && e.code === 'aborted_not_committable');
    assert.equal(getReservation('tat_0001', cwd)?.decision, 'aborted');
    assert.equal(isDispatchable('tat_0001', cwd), false);
  });
});

describe('attempt-reservation — fault-injection (crash windows)', () => {
  let cwd: string;
  beforeEach(() => { cwd = makeWorkspace(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('reserve-then-crash-before-commit: attempt is never dispatchable, recoverer aborts, late resume cannot spawn', () => {
    // Coordinator reserves, then "crashes" (no commit).
    reserve(reserveInput(cwd), cwd);
    assert.equal(isDispatchable('tat_0001', cwd), false, 'uncommitted attempt must not dispatch');

    // A recoverer past the lease decides to abort (provably no launch in this slice).
    const aborted = abortReservation('tat_0001', 'reserved_never_launched', cwd);
    assert.equal(aborted.decision, 'aborted');

    // The stale original coordinator resumes and tries to commit → must fail closed.
    assert.throws(() => commitReservation('tat_0001', cwd), (e: unknown) =>
      e instanceof ReservationStateError && e.code === 'aborted_not_committable');
    assert.equal(isDispatchable('tat_0001', cwd), false, 'a never-committed attempt can never dispatch');
  });

  it('committed reservation survives a recovery abort attempt (repair-not-abort invariant)', () => {
    reserve(reserveInput(cwd), cwd);
    commitReservation('tat_0001', cwd);
    // A confused recoverer tries to abort the committed attempt → rejected; committed is always repairable.
    assert.throws(() => abortReservation('tat_0001', 'recovery confusion', cwd), (e: unknown) =>
      e instanceof ReservationStateError && e.code === 'committed_not_abortable');
    assert.equal(assertDispatchable('tat_0001', cwd).decision, 'committed');
  });

  it('guards on a missing reservation throw reservation_not_found (no silent dispatch)', () => {
    assert.throws(() => assertDispatchable('tat_missing', cwd), (e: unknown) =>
      e instanceof ReservationStateError && e.code === 'reservation_not_found');
    assert.throws(() => commitReservation('tat_missing', cwd), (e: unknown) =>
      e instanceof ReservationStateError && e.code === 'reservation_not_found');
    assert.throws(() => abortReservation('tat_missing', 'x', cwd), (e: unknown) =>
      e instanceof ReservationStateError && e.code === 'reservation_not_found');
    assert.equal(isDispatchable('tat_missing', cwd), false);
  });
});

describe('attempt-reservation — listing', () => {
  let cwd: string;
  beforeEach(() => { cwd = makeWorkspace(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('lists reservations and filters by decision', () => {
    reserve(reserveInput(cwd, { turn_id: 'tat_a' }), cwd);
    reserve(reserveInput(cwd, { turn_id: 'tat_b' }), cwd);
    reserve(reserveInput(cwd, { turn_id: 'tat_c' }), cwd);
    commitReservation('tat_b', cwd);
    abortReservation('tat_c', 'x', cwd);

    assert.equal(listReservations({}, cwd).length, 3);
    assert.deepEqual(listReservations({ decision: 'prepared' }, cwd).map((r) => r.turn_id), ['tat_a']);
    assert.deepEqual(listReservations({ decision: 'committed' }, cwd).map((r) => r.turn_id), ['tat_b']);
    assert.deepEqual(listReservations({ decision: 'aborted' }, cwd).map((r) => r.turn_id), ['tat_c']);
  });
});
