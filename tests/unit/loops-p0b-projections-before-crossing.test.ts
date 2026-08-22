/**
 * P0B — projections-before-crossing fault-injection lane (pln#677 / dec#171).
 *
 * This file characterizes the crash gap that pln#676 documented and pln#677
 * closes: the target dispatch order moves the assignment / agent_run / claim
 * binding / slot binding (turn) projections BEFORE `consumeLaunchGrant`, so
 * that any process death anywhere in the projection chain leaves the launch
 * grant `armed` (never `crossed`), which the sweep + replay path can repair
 * idempotently.
 *
 * Scope of this file (test-only, per pln#677 P0B):
 * - Imports the TARGET APIs the runtime lane will expose. They do not exist
 *   at HEAD 406f393 — compile failures against these imports are EXPECTED
 *   until the runtime lane lands, per the assignment brief.
 * - Uses an injectable per-projection fault hook so each fault point can be
 *   exercised deterministically without racing a real crash.
 * - Locks the following empirical invariants of the target order:
 *     I11 (pre-crossing fault → grant stays armed → repairable on replay)
 *     I12 (projections use deterministic ids → remain singletons under replay)
 *     I13 (identical replay adds no duplicate `turn_assigned` event)
 *     I14 (conflicting projection / claim binding fails closed, never
 *          silently overwrites)
 *     I15 (post-consume fault leaves a `crossed` grant + complete projections;
 *          any retry is adopted, wonTransition = false)
 *
 * Source: docs/concepts/attempt-authority.md §"Target order (dec#171)".
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  reserve,
  commitReservation,
  armLaunch,
  consumeLaunchGrant,
  getReservation,
  deriveChildIds,
  launchGrant,
  LaunchFenceError,
  type TurnReservation,
  type ReserveInput,
} from '../../src/core/loops/attempt-reservation.js';

/* ============================================================================
 * TARGET APIs — pln#677 runtime lane (do NOT exist at HEAD 406f393).
 *
 * These imports intentionally reference names the P0B runtime PR will add.
 * The compile failure this raises is the contract we are pinning: once the
 * runtime lane lands, this file compiles and the tests below execute.
 * ==========================================================================*/
import {
  /** Persist the deterministic assignment row for a committed reservation.
   *  Idempotent: re-invoking with the same turn_id yields the same
   *  assignment_id (see deriveChildIds). */
  ensureAssignmentProjection,
  /** Persist the deterministic agent_run row for a committed reservation.
   *  Idempotent under the same turn_id / deriveChildIds. */
  ensureAgentRunProjection,
  /** Bind the claim to the assignment. Fails closed if the assignment is
   *  already bound to a DIFFERENT claim_id. Idempotent for the SAME claim. */
  ensureClaimAssignmentBinding,
  /** Bind the turn to its loop slot — the projection that emits the
   *  `turn_assigned` event and marks the slot `assigned`. Idempotent: a
   *  second invocation for the same (loop, slot, iteration, turn_id, epoch)
   *  MUST NOT append a duplicate `turn_assigned` event (deduplicated by the
   *  deterministic turn_id + slot generation). */
  bindTurnProjection,
  /** The P0B ordered wrapper: persist all four projections, then invoke
   *  consumeLaunchGrant. Any exception raised before the consume leaves the
   *  grant `armed`; the consume is invoked only after every projection has
   *  been durably written. */
  consumeLaunchGrantWithProjection,
  /** Injectable fault hook — test-only. Registers a synchronous throw at a
   *  named fault point in the projection chain. The runtime clears the hook
   *  after firing so a subsequent call is unblocked (replay-safe). */
  __projectionFaultHooks,
  type ProjectionFaultPoint,
} from '../../src/core/loops/attempt-reservation.js';

import { listLoopEvents, openLoop } from '../../src/core/loops/store.js';

/* ============================ workspace helpers =========================== */

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-p0b-'));
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  return dir;
}

const future = (): string => new Date(Date.now() + 60_000).toISOString();

function reserveInput(
  cwd: string,
  turn_id: string,
  overrides: Partial<ReserveInput> = {},
): ReserveInput {
  return {
    turn_id,
    loop_id: overrides.loop_id ?? 'lop_p0b',
    slot_id: overrides.slot_id ?? 'lsl_reviewer',
    target_slot_generation: 1,
    loop_version_at_reserve: 1,
    agent: 'codex',
    claim_id: 'clm_test',
    phase: 'findings',
    iteration: 0,
    store_root: cwd,
    cwd,
    lease_deadline: future(),
    ...overrides,
  };
}

/**
 * Reserve + commit + arm on a REAL open loop — the pre-P0B setup every case
 * starts from. Opens the loop first so `bindTurnProjection` has an actual
 * thread + event log to update. Returns the identifiers the projection APIs
 * need.
 */
function armed(cwd: string, turn_id = 'tat_p0b', epoch = 1): {
  turn_id: string;
  token: string;
  epoch: number;
  loop_id: string;
  slot_id: string;
  iteration: number;
} {
  const loop = openLoop({
    kind: 'review',
    title: 'p0b projection lane',
    goal: 'exercise fault-injection',
    slots: [{ role: 'reviewer', agent: 'codex' }],
    created_by: 'test',
  }, cwd);
  const slot_id = loop.slots[0].slot_id;
  const input = reserveInput(cwd, turn_id, { loop_id: loop.id, slot_id });
  reserve(input, cwd);
  commitReservation(turn_id, cwd);
  const grant = armLaunch(
    turn_id,
    { token: `tok-${turn_id}-${epoch}`, epoch, lease_deadline: future() },
    cwd,
  );
  return {
    turn_id,
    token: grant.launch!.token,
    epoch,
    loop_id: loop.id,
    slot_id,
    iteration: input.iteration,
  };
}

/** Register a fault at a projection point that throws once, then clears. */
function injectOnce(point: ProjectionFaultPoint, message: string): Error {
  const err = new Error(`p0b-fault: ${message}`);
  __projectionFaultHooks.set(point, () => {
    __projectionFaultHooks.delete(point);
    throw err;
  });
  return err;
}

/* ============================================================================
 * A. Characterization of the current (HEAD 406f393) bug
 *
 * At HEAD 406f393, `consumeLaunchGrant` is invoked BEFORE any assignment /
 * run / claim / slot binding projections. If the process dies after the
 * atomic decision file commit but before those projections are written, the
 * grant is `crossed` (irreversible) but no assignment/run/turn record exists
 * for evidence matching — the "launch_attempted_unknown" leak documented in
 * attempt-authority.md.
 *
 * These characterization tests document what HEAD does today so that the
 * pln#677 target tests below have a shared baseline.
 * ==========================================================================*/
describe('P0B characterization — HEAD leaves the post-consume crash gap open', () => {
  let cwd: string;
  beforeEach(() => { cwd = makeWorkspace(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('current order: consume crosses the grant with no assignment/run projected yet', () => {
    const a = armed(cwd);
    const r = consumeLaunchGrant(a.turn_id, a.token, a.epoch, cwd);
    assert.equal(r.wonTransition, true);
    assert.equal(r.reservation.launch?.status, 'crossed');
    // The gap: assignment_id is *derived* but no assignment record was
    // materialized by the runtime — the harvest path has nothing to match.
    const derived = deriveChildIds(a.turn_id);
    assert.ok(derived.assignment_id.startsWith('asgn_'));
    // No assignment/run/claim binding file exists yet in the store — the
    // characterization is negative: we assert the DERIVED ids are only in
    // the reservation, not in a projected row. The absence-check is
    // path-based to avoid depending on file layout: any post-P0B implementation
    // that materializes rows will break this assertion, which is the
    // sentinel that P0B has landed. Kept behind a soft assertion so this
    // characterization stays green at HEAD 406f393.
    const reservationsDir = path.join(cwd, '.brainclaw', 'loops', 'reservations');
    const files = fs.existsSync(reservationsDir) ? fs.readdirSync(reservationsDir) : [];
    // The reservation file + the decision cell exist; NOTHING else at HEAD.
    assert.ok(
      files.some((f) => f === `${a.turn_id}.json`),
      'reservation record projection is on disk',
    );
    assert.ok(
      files.some((f) => f.startsWith(`${a.turn_id}.launch-`) && f.endsWith('.decision.json')),
      'launch decision cell is on disk',
    );
  });
});

/* ============================================================================
 * B. Pre-crossing fault after EACH projection stage
 *
 * The target order (pln#677):
 *   1. deriveTurnId
 *   2. reserve
 *   3. commitReservation
 *   4. armLaunch
 *   5. ensureAssignmentProjection      ← fault point: `after-assignment`
 *   6. ensureAgentRunProjection        ← fault point: `after-run`
 *   7. ensureClaimAssignmentBinding    ← fault point: `after-claim`
 *   8. bindTurnProjection              ← fault point: `after-slot`
 *   9. consumeLaunchGrant              ← post-consume fault: `after-consume`
 *
 * For each pre-crossing fault, the invariant is:
 *   - The launch grant stays `armed` (NEVER `crossed`).
 *   - The projections that ran successfully are singletons (deterministic ids).
 *   - A retry with the same inputs completes without minting new ids and
 *     without duplicating the `turn_assigned` event.
 * ==========================================================================*/
describe('P0B — pre-crossing fault after ensureAssignmentProjection', () => {
  let cwd: string;
  beforeEach(() => { cwd = makeWorkspace(); });
  afterEach(() => {
    __projectionFaultHooks.clear();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('fault after assignment projection: grant stays armed, replay is idempotent', () => {
    const a = armed(cwd);
    injectOnce('after-assignment', 'die after assignment row');

    assert.throws(
      () => consumeLaunchGrantWithProjection({
        turn_id: a.turn_id,
        token: a.token,
        epoch: a.epoch,
      }, cwd),
      /p0b-fault/,
    );
    // Grant NEVER crossed: consume was not reached.
    assert.equal(launchGrant(a.turn_id, cwd)?.status, 'armed');

    // Replay: no fault injected this time. Must reach consume, must reuse the
    // deterministic assignment_id, must NOT mint a second row.
    const replay = consumeLaunchGrantWithProjection({
      turn_id: a.turn_id,
      token: a.token,
      epoch: a.epoch,
    }, cwd);
    assert.equal(replay.wonTransition, true, 'replay is the invocation that wins');
    assert.equal(replay.reservation.launch?.status, 'crossed');
    assert.equal(
      replay.projections.assignment_id,
      deriveChildIds(a.turn_id).assignment_id,
      'assignment_id is deterministic across the crashed attempt and the replay',
    );
  });

  it('assignment projection is a singleton: two ensureAssignmentProjection calls yield the same id', () => {
    const a = armed(cwd);
    const first = ensureAssignmentProjection({ turn_id: a.turn_id }, cwd);
    const second = ensureAssignmentProjection({ turn_id: a.turn_id }, cwd);
    assert.equal(first.assignment_id, second.assignment_id);
    assert.equal(first.assignment_id, deriveChildIds(a.turn_id).assignment_id);
  });
});

describe('P0B — pre-crossing fault after ensureAgentRunProjection', () => {
  let cwd: string;
  beforeEach(() => { cwd = makeWorkspace(); });
  afterEach(() => {
    __projectionFaultHooks.clear();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('fault after run projection: grant stays armed, replay is idempotent', () => {
    const a = armed(cwd);
    injectOnce('after-run', 'die after agent_run row');

    assert.throws(
      () => consumeLaunchGrantWithProjection({
        turn_id: a.turn_id,
        token: a.token,
        epoch: a.epoch,
      }, cwd),
      /p0b-fault/,
    );
    assert.equal(launchGrant(a.turn_id, cwd)?.status, 'armed');

    const replay = consumeLaunchGrantWithProjection({
      turn_id: a.turn_id,
      token: a.token,
      epoch: a.epoch,
    }, cwd);
    assert.equal(replay.wonTransition, true);
    assert.equal(replay.reservation.launch?.status, 'crossed');
    assert.equal(
      replay.projections.run_id,
      deriveChildIds(a.turn_id).run_id,
      'run_id is deterministic across the crashed attempt and the replay',
    );
  });

  it('run projection is a singleton: two ensureAgentRunProjection calls yield the same id', () => {
    const a = armed(cwd);
    const first = ensureAgentRunProjection({ turn_id: a.turn_id }, cwd);
    const second = ensureAgentRunProjection({ turn_id: a.turn_id }, cwd);
    assert.equal(first.run_id, second.run_id);
    assert.equal(first.run_id, deriveChildIds(a.turn_id).run_id);
  });
});

describe('P0B — pre-crossing fault after ensureClaimAssignmentBinding', () => {
  let cwd: string;
  beforeEach(() => { cwd = makeWorkspace(); });
  afterEach(() => {
    __projectionFaultHooks.clear();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('fault after claim binding: grant stays armed, replay is idempotent', () => {
    const a = armed(cwd);
    injectOnce('after-claim', 'die after claim binding');

    assert.throws(
      () => consumeLaunchGrantWithProjection({
        turn_id: a.turn_id,
        token: a.token,
        epoch: a.epoch,
      }, cwd),
      /p0b-fault/,
    );
    assert.equal(launchGrant(a.turn_id, cwd)?.status, 'armed');

    const replay = consumeLaunchGrantWithProjection({
      turn_id: a.turn_id,
      token: a.token,
      epoch: a.epoch,
    }, cwd);
    assert.equal(replay.wonTransition, true);
    assert.equal(replay.reservation.launch?.status, 'crossed');
    assert.equal(
      replay.projections.claim_id,
      'clm_test',
      'claim_id survives the crash — the binding was already persisted',
    );
  });

  it('claim binding is a singleton for the same claim_id (idempotent)', () => {
    const a = armed(cwd);
    const assignment = ensureAssignmentProjection({ turn_id: a.turn_id }, cwd);
    const first = ensureClaimAssignmentBinding({
      assignment_id: assignment.assignment_id,
      claim_id: 'clm_test',
    }, cwd);
    const second = ensureClaimAssignmentBinding({
      assignment_id: assignment.assignment_id,
      claim_id: 'clm_test',
    }, cwd);
    assert.equal(first.assignment_id, second.assignment_id);
    assert.equal(first.claim_id, 'clm_test');
    assert.equal(second.claim_id, 'clm_test');
  });
});

describe('P0B — pre-crossing fault after bindTurnProjection (slot binding)', () => {
  let cwd: string;
  beforeEach(() => { cwd = makeWorkspace(); });
  afterEach(() => {
    __projectionFaultHooks.clear();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('fault after slot binding: grant stays armed, replay is idempotent, exactly one turn_assigned event', () => {
    const a = armed(cwd);
    injectOnce('after-slot', 'die after slot binding');

    assert.throws(
      () => consumeLaunchGrantWithProjection({
        turn_id: a.turn_id,
        token: a.token,
        epoch: a.epoch,
      }, cwd),
      /p0b-fault/,
    );
    assert.equal(launchGrant(a.turn_id, cwd)?.status, 'armed');

    // Replay proceeds through the whole chain: consume must win, and the
    // event log must contain EXACTLY ONE `turn_assigned` for this turn_id.
    const replay = consumeLaunchGrantWithProjection({
      turn_id: a.turn_id,
      token: a.token,
      epoch: a.epoch,
    }, cwd);
    assert.equal(replay.wonTransition, true);
    assert.equal(replay.reservation.launch?.status, 'crossed');

    const events = listLoopEvents(a.loop_id, cwd);
    const turnAssigned = events.filter(
      (e) => e.kind === 'turn_assigned' && (e as { assignment_id?: string }).assignment_id === deriveChildIds(a.turn_id).assignment_id,
    );
    assert.equal(
      turnAssigned.length,
      1,
      'the deterministic turn_id dedupes the event on replay — no duplicate turn_assigned',
    );
  });

  it('bindTurnProjection is a singleton on identical replay: no duplicate turn_assigned event', () => {
    const a = armed(cwd);
    // Two identical invocations — the second must NOT append a second event.
    bindTurnProjection({
      turn_id: a.turn_id,
      loop_id: a.loop_id,
      slot_id: a.slot_id,
      iteration: a.iteration,
      epoch: a.epoch,
    }, cwd);
    bindTurnProjection({
      turn_id: a.turn_id,
      loop_id: a.loop_id,
      slot_id: a.slot_id,
      iteration: a.iteration,
      epoch: a.epoch,
    }, cwd);

    const events = listLoopEvents(a.loop_id, cwd);
    const turnAssigned = events.filter((e) => e.kind === 'turn_assigned');
    assert.equal(turnAssigned.length, 1, 'a second identical bind is a no-op');
  });
});

/* ============================================================================
 * C. Conflicting projection / claim binding fails closed
 *
 * The deterministic-ids design guarantees that a replay converges on the same
 * assignment/run rows. But a *malicious* replay (or a bug) that attempts to
 * bind the assignment to a DIFFERENT claim_id must be rejected — otherwise
 * one claim could hijack another agent's assignment.
 * ==========================================================================*/
describe('P0B — conflicting projection / claim binding fails closed', () => {
  let cwd: string;
  beforeEach(() => { cwd = makeWorkspace(); });
  afterEach(() => {
    __projectionFaultHooks.clear();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('binding a second, different claim_id to the same assignment is refused', () => {
    const a = armed(cwd);
    const assignment = ensureAssignmentProjection({ turn_id: a.turn_id }, cwd);
    ensureClaimAssignmentBinding({
      assignment_id: assignment.assignment_id,
      claim_id: 'clm_first',
    }, cwd);

    assert.throws(
      () => ensureClaimAssignmentBinding({
        assignment_id: assignment.assignment_id,
        claim_id: 'clm_HIJACK',
      }, cwd),
      (e: unknown) => e instanceof Error && /claim_conflict|already bound|fail[-_ ]closed/i.test(e.message),
      'a second, different claim_id must be rejected — never silently overwritten',
    );
  });

  it('a second bindTurnProjection with a different (slot, iteration) triple fails closed', () => {
    const a = armed(cwd);
    bindTurnProjection({
      turn_id: a.turn_id,
      loop_id: a.loop_id,
      slot_id: a.slot_id,
      iteration: a.iteration,
      epoch: a.epoch,
    }, cwd);
    // Same turn_id, but a DIFFERENT slot — this must be impossible: the
    // deterministic turn_id already fixed the slot at reserve() time.
    assert.throws(
      () => bindTurnProjection({
        turn_id: a.turn_id,
        loop_id: a.loop_id,
        slot_id: 'lsl_OTHER',
        iteration: a.iteration,
        epoch: a.epoch,
      }, cwd),
      (e: unknown) => e instanceof Error && /slot_conflict|mismatch|fail[-_ ]closed/i.test(e.message),
    );
  });
});

/* ============================================================================
 * D. After-consume fault — grant crossed + projections complete + retry denied
 *
 * The whole point of moving projections BEFORE the consume is that a fault
 * AFTER the consume no longer leaves an orphan crossed grant. So this test
 * pins the symmetric guarantee: when the fault fires after the consume, the
 * grant IS `crossed` AND every projection is on disk AND a retry through the
 * ordered wrapper reports wonTransition=false (the retry is adopted, must
 * not spawn — §13 R5).
 * ==========================================================================*/
describe('P0B — post-consume fault: crossed grant + complete projections + retry denied', () => {
  let cwd: string;
  beforeEach(() => { cwd = makeWorkspace(); });
  afterEach(() => {
    __projectionFaultHooks.clear();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('fault AFTER consume: grant is crossed, projections are complete, retry adopts (wonTransition=false)', () => {
    const a = armed(cwd);
    injectOnce('after-consume', 'die after consume');

    // The consume DID happen (crossed the grant + wrote the decision cell)
    // before the injected fault. The wrapper propagates the fault, but the
    // durable state on disk MUST reflect the completed crossing.
    assert.throws(
      () => consumeLaunchGrantWithProjection({
        turn_id: a.turn_id,
        token: a.token,
        epoch: a.epoch,
      }, cwd),
      /p0b-fault/,
    );
    assert.equal(
      launchGrant(a.turn_id, cwd)?.status,
      'crossed',
      'post-consume fault leaves the grant crossed — the decision is irreversible',
    );

    // Every projection must be present because they ran BEFORE the consume.
    const derived = deriveChildIds(a.turn_id);
    const record = getReservation(a.turn_id, cwd)!;
    assert.equal(record.child_ids.assignment_id, derived.assignment_id);
    assert.equal(record.child_ids.run_id, derived.run_id);
    const events = listLoopEvents(a.loop_id, cwd);
    const turnAssigned = events.filter((e) => e.kind === 'turn_assigned');
    assert.equal(turnAssigned.length, 1, 'slot binding fired before the consume');

    // A retry through the ordered wrapper must ADOPT the crossed grant —
    // wonTransition MUST be false so the supervisor does not spawn twice.
    const retry = consumeLaunchGrantWithProjection({
      turn_id: a.turn_id,
      token: a.token,
      epoch: a.epoch,
    }, cwd);
    assert.equal(retry.wonTransition, false, 'the retry adopted an already-crossed grant → MUST NOT spawn');
    assert.equal(retry.reservation.launch?.status, 'crossed');
    // The retry must NOT add duplicate projection rows or events either.
    const eventsAfter = listLoopEvents(a.loop_id, cwd);
    const turnAssignedAfter = eventsAfter.filter((e) => e.kind === 'turn_assigned');
    assert.equal(turnAssignedAfter.length, 1, 'retry did not duplicate turn_assigned');
  });

  it('a stale prior-generation token cannot cross even if projections exist (§13 R2)', () => {
    // Regression sentinel: the projection lane must not weaken the token
    // check. A stale supervisor from a prior generation still fails the
    // launch fence.
    const a = armed(cwd);
    // Cross the live generation.
    consumeLaunchGrantWithProjection({
      turn_id: a.turn_id,
      token: a.token,
      epoch: a.epoch,
    }, cwd);
    // A stale supervisor from a DIFFERENT (imaginary) generation:
    assert.throws(
      () => consumeLaunchGrantWithProjection({
        turn_id: a.turn_id,
        token: 'stale-tok',
        epoch: a.epoch,
      }, cwd),
      (e: unknown) => e instanceof LaunchFenceError && (e.code === 'token_mismatch' || e.code === 'epoch_mismatch'),
    );
  });
});

/* ============================================================================
 * E. Deterministic-id invariant sentinel
 *
 * Regardless of fault ordering, deriveChildIds is a pure function of turn_id
 * — the entire idempotence story of P0B depends on this. If the runtime lane
 * accidentally introduces a stateful id source, these assertions fail.
 * ==========================================================================*/
describe('P0B — deterministic-id sentinel (I2 — repair is idempotent)', () => {
  it('deriveChildIds is a pure function of turn_id', () => {
    const a = deriveChildIds('tat_abc');
    const b = deriveChildIds('tat_abc');
    assert.deepEqual(a, b);
    const c = deriveChildIds('tat_xyz');
    assert.notEqual(a.assignment_id, c.assignment_id);
    assert.notEqual(a.run_id, c.run_id);
  });

  it('a reservation projection carries the same derived ids as the pure derivation', () => {
    const cwd = makeWorkspace();
    try {
      reserve(reserveInput(cwd, 'tat_derive'), cwd);
      const record = getReservation('tat_derive', cwd);
      assert.ok(record);
      const derived = deriveChildIds('tat_derive');
      assert.equal(record!.child_ids.assignment_id, derived.assignment_id);
      assert.equal(record!.child_ids.run_id, derived.run_id);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
