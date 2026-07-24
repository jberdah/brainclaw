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
  revokeLaunchGrant,
  launchGrant,
  sweepExpiredLaunchGrants,
  evidenceMatchesAttempt,
  currentNonce,
  deriveChildIds,
  getReservation,
  LaunchFenceError,
  type ReserveInput,
} from '../../src/core/loops/attempt-reservation.js';

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-launch-grant-'));
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  return dir;
}

function reserveInput(cwd: string, turn_id: string): ReserveInput {
  return {
    turn_id,
    loop_id: 'lop_abc',
    slot_id: 'lsl_reviewer',
    target_slot_generation: 1,
    loop_version_at_reserve: 3,
    agent: 'codex',
    claim_id: 'clm_xyz',
    phase: 'findings',
    iteration: 0,
    store_root: cwd,
    cwd,
    lease_deadline: new Date(Date.now() + 60_000).toISOString(),
  };
}

function committed(cwd: string, turn_id = 'tat_1'): string {
  reserve(reserveInput(cwd, turn_id), cwd);
  commitReservation(turn_id, cwd);
  return turn_id;
}

const future = (): string => new Date(Date.now() + 60_000).toISOString();
const past = (): string => new Date(Date.now() - 1_000).toISOString();

describe('launch-grant fence — arm', () => {
  let cwd: string;
  beforeEach(() => { cwd = makeWorkspace(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('arms a committed reservation', () => {
    const t = committed(cwd);
    const r = armLaunch(t, { token: 'tok1', epoch: 1, lease_deadline: future() }, cwd);
    assert.equal(r.launch?.status, 'armed');
    assert.equal(r.launch?.token, 'tok1');
    assert.equal(r.launch?.epoch, 1);
  });

  it('refuses to arm a non-committed (prepared) reservation', () => {
    reserve(reserveInput(cwd, 'tat_p'), cwd); // prepared, not committed
    assert.throws(() => armLaunch('tat_p', { token: 't', epoch: 1, lease_deadline: future() }, cwd),
      (e: unknown) => e instanceof LaunchFenceError && e.code === 'not_committed');
  });

  it('refuses a second arm while a grant is armed', () => {
    const t = committed(cwd);
    armLaunch(t, { token: 'tok1', epoch: 1, lease_deadline: future() }, cwd);
    assert.throws(() => armLaunch(t, { token: 'tok2', epoch: 2, lease_deadline: future() }, cwd),
      (e: unknown) => e instanceof LaunchFenceError && e.code === 'already_armed');
  });
});

describe('launch-grant fence — consume (the atomic pre-exec gate)', () => {
  let cwd: string;
  beforeEach(() => { cwd = makeWorkspace(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('consume armed → crossed with the matching token+epoch (winner may spawn)', () => {
    const t = committed(cwd);
    armLaunch(t, { token: 'tok1', epoch: 1, lease_deadline: future() }, cwd);
    const r = consumeLaunchGrant(t, 'tok1', 1, cwd);
    assert.equal(r.reservation.launch?.status, 'crossed');
    assert.ok(r.reservation.launch?.crossed_at);
    assert.equal(r.wonTransition, true, 'the crossing invocation won → may spawn');
  });

  it('consume is idempotent, but a retry is ADOPTED not won (must not spawn — §13 R5)', () => {
    const t = committed(cwd);
    armLaunch(t, { token: 'tok1', epoch: 1, lease_deadline: future() }, cwd);
    const first = consumeLaunchGrant(t, 'tok1', 1, cwd);
    assert.equal(first.wonTransition, true);
    const again = consumeLaunchGrant(t, 'tok1', 1, cwd);
    assert.equal(again.reservation.launch?.status, 'crossed');
    assert.equal(again.wonTransition, false, 'a second consume adopted the crossed grant → double-spawn guard');
  });

  it('refuses a token or epoch mismatch (a stale supervisor cannot cross)', () => {
    const t = committed(cwd);
    armLaunch(t, { token: 'tok1', epoch: 1, lease_deadline: future() }, cwd);
    assert.throws(() => consumeLaunchGrant(t, 'WRONG', 1, cwd),
      (e: unknown) => e instanceof LaunchFenceError && e.code === 'token_mismatch');
    assert.throws(() => consumeLaunchGrant(t, 'tok1', 99, cwd),
      (e: unknown) => e instanceof LaunchFenceError && e.code === 'epoch_mismatch');
    assert.equal(launchGrant(t, cwd)?.status, 'armed', 'still armed after refused consumes');
  });

  it('refuses to consume an expired grant (→ MUST NOT spawn)', () => {
    const t = committed(cwd);
    armLaunch(t, { token: 'tok1', epoch: 1, lease_deadline: past() }, cwd);
    assert.throws(() => consumeLaunchGrant(t, 'tok1', 1, cwd),
      (e: unknown) => e instanceof LaunchFenceError && e.code === 'lease_expired');
  });
});

describe('launch-grant fence — the decidable race (consume XOR revoke)', () => {
  let cwd: string;
  beforeEach(() => { cwd = makeWorkspace(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('REVOKE wins: a revoked grant can never be consumed → no spawn after supersession', () => {
    const t = committed(cwd);
    armLaunch(t, { token: 'tok1', epoch: 1, lease_deadline: future() }, cwd);
    revokeLaunchGrant(t, 1, 'superseded by advance', cwd);
    assert.throws(() => consumeLaunchGrant(t, 'tok1', 1, cwd),
      (e: unknown) => e instanceof LaunchFenceError && e.code === 'revoked');
    assert.equal(launchGrant(t, cwd)?.status, 'revoked');
  });

  it('CONSUME wins: a crossed grant can never be revoked → old attempt is launch_attempted_unknown, never re-spawned', () => {
    const t = committed(cwd);
    armLaunch(t, { token: 'tok1', epoch: 1, lease_deadline: future() }, cwd);
    consumeLaunchGrant(t, 'tok1', 1, cwd);
    assert.throws(() => revokeLaunchGrant(t, 1, 'too late', cwd),
      (e: unknown) => e instanceof LaunchFenceError && e.code === 'crossed_not_revocable');
    assert.equal(launchGrant(t, cwd)?.status, 'crossed');
  });

  it('revoke is idempotent', () => {
    const t = committed(cwd);
    armLaunch(t, { token: 'tok1', epoch: 1, lease_deadline: future() }, cwd);
    revokeLaunchGrant(t, 1, 'r1', cwd);
    const again = revokeLaunchGrant(t, 1, 'r2', cwd);
    assert.equal(again.launch?.status, 'revoked');
    assert.equal(again.launch?.revoke_reason, 'r1', 'reason not overwritten by idempotent re-revoke');
  });

  it('re-arm is allowed after revoke, only with a strictly higher epoch', () => {
    const t = committed(cwd);
    armLaunch(t, { token: 'tok1', epoch: 1, lease_deadline: future() }, cwd);
    revokeLaunchGrant(t, 1, 'retry', cwd);
    // same/lower epoch refused
    assert.throws(() => armLaunch(t, { token: 'tok2', epoch: 1, lease_deadline: future() }, cwd),
      (e: unknown) => e instanceof LaunchFenceError && e.code === 'epoch_mismatch');
    // higher epoch OK (a fresh attempt generation)
    const r = armLaunch(t, { token: 'tok2', epoch: 2, lease_deadline: future() }, cwd);
    assert.equal(r.launch?.status, 'armed');
    assert.equal(r.launch?.epoch, 2);
  });
});

describe('launch-grant fence — expiry sweep (reserved_never_launched)', () => {
  let cwd: string;
  beforeEach(() => { cwd = makeWorkspace(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('sweeps armed+expired grants to revoked, leaving fresh and crossed grants alone', () => {
    const expired = committed(cwd, 'tat_exp');
    armLaunch(expired, { token: 'e', epoch: 1, lease_deadline: past() }, cwd);
    const fresh = committed(cwd, 'tat_fresh');
    armLaunch(fresh, { token: 'f', epoch: 1, lease_deadline: future() }, cwd);
    const crossed = committed(cwd, 'tat_cross');
    armLaunch(crossed, { token: 'c', epoch: 1, lease_deadline: future() }, cwd);
    consumeLaunchGrant(crossed, 'c', 1, cwd);

    const revoked = sweepExpiredLaunchGrants(cwd);
    assert.deepEqual(revoked, ['tat_exp'], 'only the armed+expired grant is swept');
    assert.equal(launchGrant('tat_exp', cwd)?.status, 'revoked');
    assert.equal(launchGrant('tat_exp', cwd)?.revoke_reason, 'reserved_never_launched');
    assert.equal(launchGrant('tat_fresh', cwd)?.status, 'armed', 'fresh grant untouched');
    assert.equal(launchGrant('tat_cross', cwd)?.status, 'crossed', 'crossed grant untouched');

    // A late supervisor for the swept attempt cannot spawn. The grant is both
    // expired AND revoked; consume checks expiry before claiming the decision,
    // so either refusal code proves it will not cross.
    assert.throws(() => consumeLaunchGrant('tat_exp', 'e', 1, cwd),
      (e: unknown) => e instanceof LaunchFenceError && (e.code === 'revoked' || e.code === 'lease_expired'));
  });
});

describe('PR2b-b — dispatch-lease gate + evidence matcher (pln#630 §13 R5/R3)', () => {
  let cwd: string;
  beforeEach(() => { cwd = makeWorkspace(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('arm REFUSES a committed reservation whose DISPATCH lease has passed (phantom-spawn guard)', () => {
    // A committed reservation cannot be aborted (repairable-only), so a stale
    // one is fenced at arm: a supervisor arriving after the dispatch lease
    // cannot arm a fresh grant and spawn.
    reserve({ ...reserveInput(cwd, 'tat_stale'), lease_deadline: past() }, cwd);
    commitReservation('tat_stale', cwd);
    assert.throws(() => armLaunch('tat_stale', { token: 'x', epoch: 1, lease_deadline: future() }, cwd),
      (e: unknown) => e instanceof LaunchFenceError && e.code === 'dispatch_lease_expired');
    assert.equal(launchGrant('tat_stale', cwd), undefined, 'never armed → never spawns');
  });

  it('arm still works while the dispatch lease is live', () => {
    const t = committed(cwd, 'tat_live'); // 60s future dispatch lease
    const r = armLaunch(t, { token: 'x', epoch: 1, lease_deadline: future() }, cwd);
    assert.equal(r.launch?.status, 'armed');
  });

  it('evidenceMatchesAttempt requires turn_id + derived run_id + current generation nonce', () => {
    const t = committed(cwd, 'tat_ev');
    armLaunch(t, { token: 'gen-tok-1', epoch: 1, lease_deadline: future() }, cwd);
    const r = getReservation(t, cwd)!;
    const runId = deriveChildIds(t).run_id;
    assert.equal(currentNonce(r), 'gen-tok-1');

    assert.equal(evidenceMatchesAttempt(r, { turn_id: t, run_id: runId, nonce: 'gen-tok-1' }), true);
    assert.equal(evidenceMatchesAttempt(r, { turn_id: t, run_id: runId, nonce: 'WRONG' }), false, 'stale/other generation nonce rejected');
    assert.equal(evidenceMatchesAttempt(r, { turn_id: 'tat_other', run_id: runId, nonce: 'gen-tok-1' }), false);
    assert.equal(evidenceMatchesAttempt(r, { turn_id: t, run_id: 'run_wrong', nonce: 'gen-tok-1' }), false);
    assert.equal(evidenceMatchesAttempt(r, { turn_id: t, run_id: runId }), false, 'bare assignment-keyed (no nonce) never matches');
  });

  it('evidenceMatchesAttempt is false for an unarmed or revoked generation (no live nonce)', () => {
    const t = committed(cwd, 'tat_unarmed');
    const unarmed = getReservation(t, cwd)!;
    assert.equal(evidenceMatchesAttempt(unarmed, { turn_id: t, run_id: deriveChildIds(t).run_id, nonce: 'anything' }), false);

    armLaunch(t, { token: 'g', epoch: 1, lease_deadline: future() }, cwd);
    revokeLaunchGrant(t, 1, 'superseded', cwd);
    const revoked = getReservation(t, cwd)!;
    assert.equal(evidenceMatchesAttempt(revoked, { turn_id: t, run_id: deriveChildIds(t).run_id, nonce: 'g' }), false, 'revoked generation never matches');
  });
});

// Fixes from the PR #103 symmetric review.
describe('launch-grant fence — review fixes (lease validation + epoch-before-token)', () => {
  let cwd: string;
  beforeEach(() => { cwd = makeWorkspace(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('arm rejects a non-parseable lease_deadline (an unbounded armed grant would defeat the expiry gate)', () => {
    const t = committed(cwd);
    assert.throws(() => armLaunch(t, { token: 'x', epoch: 1, lease_deadline: 'not-a-date' }, cwd),
      (e: unknown) => e instanceof LaunchFenceError && e.code === 'lease_invalid');
    assert.equal(launchGrant(t, cwd), undefined, 'no grant persisted for an invalid lease');
  });

  it('a stale-epoch consume after re-arm reports epoch_mismatch (not token_mismatch)', () => {
    const t = committed(cwd);
    armLaunch(t, { token: 'tokN', epoch: 1, lease_deadline: future() }, cwd);
    revokeLaunchGrant(t, 1, 'retry', cwd);
    armLaunch(t, { token: 'tokN1', epoch: 2, lease_deadline: future() }, cwd);
    // A stale supervisor from epoch 1 (old token + old epoch) must classify as epoch_mismatch.
    assert.throws(() => consumeLaunchGrant(t, 'tokN', 1, cwd),
      (e: unknown) => e instanceof LaunchFenceError && e.code === 'epoch_mismatch');
    assert.equal(launchGrant(t, cwd)?.status, 'armed', 'the epoch-2 grant is untouched by the stale consume');
  });
});

// PR #103 round 2 (BLOCKING): the XOR must survive a reaped holder. The decision
// is now an ATOMIC exclusive-create, so we can force the exact race
// deterministically by pre-committing the competitor's decision file (simulating
// a newer holder that won after this one was reaped) and asserting the stale
// caller LOSES — closing the TOCTOU the pre-write fence could not.
describe('launch-grant fence — atomic XOR survives a reap (deterministic race)', () => {
  let cwd: string;
  beforeEach(() => { cwd = makeWorkspace(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  function decisionPath(turnId: string, epoch: number): string {
    return path.join(cwd, '.brainclaw', 'loops', 'reservations', `${turnId}.launch-${epoch}.decision.json`);
  }

  it('a stale consume LOSES to an already-committed revoke decision → MUST NOT spawn', () => {
    const t = committed(cwd);
    armLaunch(t, { token: 'tok1', epoch: 1, lease_deadline: future() }, cwd);
    // A newer holder (after reaping this one) already committed `revoked`.
    fs.writeFileSync(decisionPath(t, 1), JSON.stringify({ decision: 'revoked', token: 'tok1', epoch: 1, at: new Date().toISOString(), reason: 'reaped-then-revoked' }));
    assert.throws(() => consumeLaunchGrant(t, 'tok1', 1, cwd),
      (e: unknown) => e instanceof LaunchFenceError && e.code === 'revoked');
    assert.equal(launchGrant(t, cwd)?.status, 'revoked', 'the committed revoke stands; no crossing');
  });

  it('a stale revoke LOSES to an already-committed crossed decision → attempt stays launch_attempted', () => {
    const t = committed(cwd);
    armLaunch(t, { token: 'tok1', epoch: 1, lease_deadline: future() }, cwd);
    fs.writeFileSync(decisionPath(t, 1), JSON.stringify({ decision: 'crossed', token: 'tok1', epoch: 1, at: new Date().toISOString() }));
    assert.throws(() => revokeLaunchGrant(t, 1, 'too late', cwd),
      (e: unknown) => e instanceof LaunchFenceError && e.code === 'crossed_not_revocable');
    assert.equal(launchGrant(t, cwd)?.status, 'crossed', 'the committed cross stands; never re-spawnable');
  });

  it('launchGrant reconciles from the authoritative decision file when the record projection is stale', () => {
    const t = committed(cwd);
    armLaunch(t, { token: 'tok1', epoch: 1, lease_deadline: future() }, cwd);
    // Winner committed the decision but "crashed" before updating the projection.
    fs.writeFileSync(decisionPath(t, 1), JSON.stringify({ decision: 'crossed', token: 'tok1', epoch: 1, at: new Date().toISOString() }));
    assert.equal(launchGrant(t, cwd)?.status, 'crossed', 'decision file wins over the stale armed projection');
  });
});
