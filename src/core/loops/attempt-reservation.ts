import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { memoryDir, writeFileAtomic } from '../io.js';
import { nowISO } from '../ids.js';
import { acquireLock } from './lock.js';

/**
 * Turn-attempt reservation authority (pln#630, spec v2 §1/§3).
 *
 * This is the first primitive on the path Codex validated across four
 * adversarial reviews of the loop-executor contract: the durable record that
 * OWNS a dispatched turn attempt's identity and its commit decision, so that
 * recovery is decision-driven (never marker-presence-driven) and dispatch is
 * gated on an explicit `committed` state.
 *
 * INVARIANT (r3/r4): the decision is a single atomic CAS on ONE record. Two
 * recoverers cannot disagree — one wins the CAS, the other observes the settled
 * state. `committed` is never abortable; `aborted` is never committable; an
 * attempt is dispatchable ONLY when `committed`. Absent-commit therefore means
 * "never dispatch", which is what closes the double-spawn / phantom-launch class.
 *
 * SCOPE (review-only slice): this module owns the reservation record + its
 * decision CAS + the dispatch guard. Wiring the real assignment/run/slot
 * projections onto a committed reservation is a later PR; the child ids are
 * derived deterministically here so that repair is idempotent when it lands.
 */

export type ReservationDecision = 'prepared' | 'committed' | 'aborted';

/**
 * An artifact the attempt's worker is expected to produce (spec §2 / §13 R1).
 * Brainclaw generates the canonical target; `worker_path` is worker-relative and
 * MUST be realpath-containment-validated before any read (invariant #7, wired in
 * a later PR). `sha256` is filled at harvest and validated before state mutation.
 */
export const ExpectedArtifactSchema = z.object({
  logical_name: z.string().min(1),
  worker_path: z.string().min(1),
  loop_artifact_type: z.string().min(1),
  schema_id: z.string().optional(),
  completion_policy: z.enum(['required', 'optional']).default('required'),
  sha256: z.string().optional(),
});
export type ExpectedArtifact = z.infer<typeof ExpectedArtifactSchema>;

export const TurnReservationSchema = z.object({
  turn_id: z.string().min(1),
  epoch: z.number().int().nonnegative(),
  loop_id: z.string().min(1),
  slot_id: z.string().min(1),
  target_slot_generation: z.number().int().nonnegative(),
  loop_version_at_reserve: z.number().int().nonnegative(),
  agent: z.string().min(1),
  agent_id: z.string().optional(),
  claim_id: z.string().min(1),
  child_ids: z.object({
    assignment_id: z.string().min(1),
    run_id: z.string().min(1),
  }),
  phase: z.string().min(1),
  iteration: z.number().int().nonnegative(),
  // pln#630 PR2b-a (§13 R1): widened from z.literal('file'). The EFFECTIVE
  // resolved policy for this attempt (§5). Default 'file' keeps PR1 records
  // parsing; mcp/either are wired later.
  completion_mode: z.enum(['file', 'mcp', 'either']).default('file'),
  // pln#630 PR2b-a (§13 R1): artifacts this attempt's worker must produce.
  // Default [] so PR1 on-disk records (which predate the field) still parse.
  expected_artifacts: z.array(ExpectedArtifactSchema).default([]),
  store_root: z.string().min(1),
  cwd: z.string().min(1),
  lease_deadline: z.string().min(1),
  decision: z.enum(['prepared', 'committed', 'aborted']),
  created_at: z.string().min(1),
  decided_at: z.string().optional(),
  abort_reason: z.string().optional(),
  // pln#630 PR2a (dec#138) — the LAUNCH-GRANT fence. The decidable, atomic
  // gate between "a committed attempt may spawn" and "a worker crossed into
  // exec". The pre-exec supervisor CONSUMES the grant (armed→crossed) before
  // invoking the worker; advance/close/reroute REVOKES it (armed→revoked). The
  // two are mutually exclusive CAS transitions on ONE record, so an old token
  // can never spawn after supersession, and a crossed grant is never re-spawned.
  launch: z.object({
    status: z.enum(['armed', 'crossed', 'revoked']),
    token: z.string().min(1),
    epoch: z.number().int().nonnegative(),
    lease_deadline: z.string().min(1),
    armed_at: z.string().min(1),
    crossed_at: z.string().optional(),
    revoked_at: z.string().optional(),
    revoke_reason: z.string().optional(),
  }).optional(),
});

export type TurnReservation = z.infer<typeof TurnReservationSchema>;

export interface ReserveInput {
  turn_id: string;
  loop_id: string;
  slot_id: string;
  target_slot_generation: number;
  loop_version_at_reserve: number;
  agent: string;
  agent_id?: string;
  claim_id: string;
  phase: string;
  iteration: number;
  store_root: string;
  cwd: string;
  lease_deadline: string;
  /** Defaults to 0; only bumps if a turn_id is ever re-reserved (never in practice). */
  epoch?: number;
  /** pln#630 PR2b-a — artifacts the worker must produce (default []). */
  expected_artifacts?: ExpectedArtifact[];
  /** pln#630 PR2b-a — effective completion policy for this attempt (default 'file'). */
  completion_mode?: 'file' | 'mcp' | 'either';
}

/** Raised when a decision CAS is attempted from an incompatible terminal state. */
export class ReservationStateError extends Error {
  constructor(
    public readonly turn_id: string,
    public readonly code:
      | 'reservation_not_found'
      | 'reservation_exists'
      | 'committed_not_abortable'
      | 'aborted_not_committable'
      | 'not_dispatchable',
    message: string,
  ) {
    super(message);
    this.name = 'ReservationStateError';
  }
}

/** Raised when a launch-grant CAS (arm/consume/revoke) is refused. */
export class LaunchFenceError extends Error {
  constructor(
    public readonly turn_id: string,
    public readonly code:
      | 'not_committed'
      | 'already_armed'
      | 'not_armed'
      | 'lease_invalid'
      | 'token_mismatch'
      | 'epoch_mismatch'
      | 'lease_expired'
      | 'revoked'
      | 'crossed_not_revocable',
    message: string,
  ) {
    super(message);
    this.name = 'LaunchFenceError';
  }
}

/* ============================ path resolution ============================= */

function reservationsDir(cwd?: string): string {
  return path.join(memoryDir(cwd ?? process.cwd()), 'loops', 'reservations');
}

function reservationLocksDir(cwd?: string): string {
  return path.join(reservationsDir(cwd), 'locks');
}

function reservationPath(turnId: string, cwd?: string): string {
  return path.join(reservationsDir(cwd), `${turnId}.json`);
}

function reservationLockPath(turnId: string, cwd?: string): string {
  return path.join(reservationLocksDir(cwd), `${turnId}.lock`);
}

// PR2a review round 2 (BLOCKING): the consume-XOR-revoke decision is committed
// via ATOMIC exclusive-create (`wx`) of ONE per-(turn,epoch) decision file — not
// a lock-guarded read-modify-write, which leaves a check-then-write TOCTOU a
// reaped holder can exploit. The FIRST writer to create the file wins; the loser
// gets EEXIST and reads the winner's verdict. This is the "one conditional
// durable mutation" the fence requires (dec#138), and it is race-free by
// construction — no lock needed for the decision itself.
interface LaunchDecisionFile {
  decision: 'crossed' | 'revoked';
  token: string;
  epoch: number;
  at: string;
  reason?: string;
}

function launchDecisionPath(turnId: string, epoch: number, cwd?: string): string {
  return path.join(reservationsDir(cwd), `${turnId}.launch-${epoch}.decision.json`);
}

function readLaunchDecision(turnId: string, epoch: number, cwd?: string): LaunchDecisionFile | undefined {
  const p = launchDecisionPath(turnId, epoch, cwd);
  if (!fs.existsSync(p)) return undefined;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as LaunchDecisionFile; } catch { return undefined; }
}

/** Atomically claim the decision via exclusive-create. Returns the committed
 * decision (this caller's if it won, or the incumbent's if it lost). */
function claimLaunchDecision(turnId: string, decision: LaunchDecisionFile, cwd?: string): LaunchDecisionFile {
  ensureDirs(cwd);
  const p = launchDecisionPath(turnId, decision.epoch, cwd);
  const body = `${JSON.stringify(decision, null, 2)}\n`;
  try {
    // 'wx' = O_CREAT | O_EXCL — atomic; fails with EEXIST if a decision exists.
    const fd = fs.openSync(p, 'wx');
    try {
      const buf = Buffer.from(body, 'utf8');
      let off = 0;
      while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return decision; // won
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const incumbent = readLaunchDecision(turnId, decision.epoch, cwd);
    if (!incumbent) throw err; // decision file vanished mid-race — surface it
    return incumbent; // lost — the incumbent decision stands
  }
}

function ensureDirs(cwd?: string): void {
  for (const dir of [reservationsDir(cwd), reservationLocksDir(cwd)]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

/* ============================ child id derivation ========================= */

/**
 * Deterministic child ids from the turn_id. Deterministic so a crashed reserve
 * is repairable idempotently: a recoverer re-derives the exact same ids and can
 * complete the projection without minting a second assignment/run (r3/r4 fix #1).
 */
export function deriveChildIds(turnId: string): { assignment_id: string; run_id: string } {
  const h = (salt: string): string =>
    crypto.createHash('sha256').update(`${turnId}:${salt}`).digest('hex').slice(0, 16);
  return { assignment_id: `asgn_${h('assignment')}`, run_id: `run_${h('run')}` };
}

/* ============================ persistence ================================= */

function readReservation(turnId: string, cwd?: string): TurnReservation | undefined {
  const filePath = reservationPath(turnId, cwd);
  if (!fs.existsSync(filePath)) return undefined;
  return TurnReservationSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function writeReservation(record: TurnReservation, cwd?: string): void {
  const parsed = TurnReservationSchema.parse(record);
  ensureDirs(cwd);
  writeFileAtomic(reservationPath(parsed.turn_id, cwd), `${JSON.stringify(parsed, null, 2)}\n`);
}

/**
 * Run `fn` under the per-reservation exclusive lock. Reuses the loop lock
 * primitive (stale-reaping, O_EXCL, fencing) so the decision CAS is atomic
 * across processes — two racing writers cannot both mutate the decision.
 */
function withReservationLock<R>(turnId: string, agentId: string, fn: (fence: () => void) => R, cwd?: string): R {
  ensureDirs(cwd);
  const lock = acquireLock({
    lockPath: reservationLockPath(turnId, cwd),
    agentId,
    intent: 'reservation',
    maxMutationDurationMs: 30_000,
  });
  try {
    // PR2a review (BLOCKING): the callback MUST invoke `fence()` immediately
    // before any durable write. If this lock was reaped (holder suspended past
    // the hard deadline) and re-acquired by another writer, fenceCheck throws
    // LockLostError so a stale holder can never overwrite the other terminal
    // transition — the consume-XOR-revoke fence stays durable across recovery.
    return fn(lock.fenceCheck);
  } finally {
    lock.release();
  }
}

/* ============================ public API ================================== */

export function getReservation(turnId: string, cwd?: string): TurnReservation | undefined {
  return readReservation(turnId, cwd);
}

/**
 * Write a fresh `prepared` reservation. Throws `reservation_exists` if one is
 * already on disk for this turn_id (identity is written once).
 */
export function reserve(input: ReserveInput, cwd?: string): TurnReservation {
  const agentId = input.agent_id ?? input.agent;
  return withReservationLock(
    input.turn_id,
    agentId,
    (fence) => {
      const existing = readReservation(input.turn_id, cwd);
      if (existing) {
        throw new ReservationStateError(
          input.turn_id,
          'reservation_exists',
          `reserve: turn_id ${input.turn_id} already reserved (decision=${existing.decision})`,
        );
      }
      const record: TurnReservation = {
        turn_id: input.turn_id,
        epoch: input.epoch ?? 0,
        loop_id: input.loop_id,
        slot_id: input.slot_id,
        target_slot_generation: input.target_slot_generation,
        loop_version_at_reserve: input.loop_version_at_reserve,
        agent: input.agent,
        agent_id: input.agent_id,
        claim_id: input.claim_id,
        child_ids: deriveChildIds(input.turn_id),
        phase: input.phase,
        iteration: input.iteration,
        completion_mode: input.completion_mode ?? 'file',
        expected_artifacts: input.expected_artifacts ?? [],
        store_root: input.store_root,
        cwd: input.cwd,
        lease_deadline: input.lease_deadline,
        decision: 'prepared',
        created_at: nowISO(),
      };
      fence();
      writeReservation(record, cwd);
      return record;
    },
    cwd,
  );
}

/**
 * CAS `prepared → committed`. Idempotent when already `committed`. Throws
 * `aborted_not_committable` if the reservation was aborted — an aborted
 * reservation can NEVER become dispatchable (closes the "recoverer aborted,
 * stale reserver resumes and commits" split-brain).
 */
export function commitReservation(turnId: string, cwd?: string, agentId = 'system'): TurnReservation {
  return withReservationLock(
    turnId,
    agentId,
    (fence) => {
      const record = readReservation(turnId, cwd);
      if (!record) {
        throw new ReservationStateError(turnId, 'reservation_not_found', `commitReservation: unknown turn_id ${turnId}`);
      }
      if (record.decision === 'committed') return record; // idempotent
      if (record.decision === 'aborted') {
        throw new ReservationStateError(
          turnId,
          'aborted_not_committable',
          `commitReservation: turn_id ${turnId} is aborted and cannot be committed`,
        );
      }
      const next: TurnReservation = { ...record, decision: 'committed', decided_at: nowISO() };
      fence();
      writeReservation(next, cwd);
      return next;
    },
    cwd,
  );
}

/**
 * CAS `prepared → aborted`. Idempotent when already `aborted`. Throws
 * `committed_not_abortable` if the reservation was committed — a committed
 * reservation is always REPAIRABLE (never abortable), so recovery of a
 * committed decision only ever completes its projections (r4 §3).
 */
export function abortReservation(turnId: string, reason: string, cwd?: string, agentId = 'system'): TurnReservation {
  return withReservationLock(
    turnId,
    agentId,
    (fence) => {
      const record = readReservation(turnId, cwd);
      if (!record) {
        throw new ReservationStateError(turnId, 'reservation_not_found', `abortReservation: unknown turn_id ${turnId}`);
      }
      if (record.decision === 'aborted') return record; // idempotent
      if (record.decision === 'committed') {
        throw new ReservationStateError(
          turnId,
          'committed_not_abortable',
          `abortReservation: turn_id ${turnId} is committed and cannot be aborted`,
        );
      }
      const next: TurnReservation = { ...record, decision: 'aborted', decided_at: nowISO(), abort_reason: reason };
      fence();
      writeReservation(next, cwd);
      return next;
    },
    cwd,
  );
}

/**
 * Dispatch guard (spec §2 T2 / §3): dispatch may proceed ONLY for a `committed`
 * reservation. Throws `not_dispatchable` for prepared/aborted/missing — this is
 * the single choke point that prevents dispatching an uncommitted attempt.
 */
export function assertDispatchable(turnId: string, cwd?: string): TurnReservation {
  const record = readReservation(turnId, cwd);
  if (!record) {
    throw new ReservationStateError(turnId, 'reservation_not_found', `assertDispatchable: unknown turn_id ${turnId}`);
  }
  if (record.decision !== 'committed') {
    throw new ReservationStateError(
      turnId,
      'not_dispatchable',
      `assertDispatchable: turn_id ${turnId} is ${record.decision}, not committed — dispatch refused`,
    );
  }
  return record;
}

export function isDispatchable(turnId: string, cwd?: string): boolean {
  const record = readReservation(turnId, cwd);
  return record?.decision === 'committed';
}

export function listReservations(filter: { decision?: ReservationDecision } = {}, cwd?: string): TurnReservation[] {
  const dir = reservationsDir(cwd);
  if (!fs.existsSync(dir)) return [];
  const out: TurnReservation[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const record = TurnReservationSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
      if (filter.decision && record.decision !== filter.decision) continue;
      out.push(record);
    } catch {
      // Skip malformed files; recovery diagnostics surface elsewhere.
    }
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/* ============================ launch-grant fence (PR2a, dec#138) ========== */

export interface ArmLaunchInput {
  token: string;
  epoch: number;
  lease_deadline: string;
}

/**
 * Arm the launch grant on a COMMITTED reservation. The pre-exec supervisor
 * later CONSUMES it (armed→crossed) immediately before invoking the worker;
 * advance/close/reroute (or the expiry sweep) REVOKE it (armed→revoked).
 * Re-arming is allowed only after a prior grant was revoked, and only with a
 * strictly higher epoch (a fresh attempt generation).
 */
export function armLaunch(turnId: string, input: ArmLaunchInput, cwd?: string, agentId = 'system'): TurnReservation {
  return withReservationLock(turnId, agentId, (fence) => {
    const record = readReservation(turnId, cwd);
    if (!record) throw new ReservationStateError(turnId, 'reservation_not_found', `armLaunch: unknown turn_id ${turnId}`);
    if (record.decision !== 'committed') {
      throw new LaunchFenceError(turnId, 'not_committed', `armLaunch: turn_id ${turnId} is ${record.decision}, not committed`);
    }
    if (record.launch && record.launch.status !== 'revoked') {
      throw new LaunchFenceError(turnId, 'already_armed', `armLaunch: turn_id ${turnId} already has a ${record.launch.status} grant (epoch ${record.launch.epoch})`);
    }
    if (record.launch && input.epoch <= record.launch.epoch) {
      throw new LaunchFenceError(turnId, 'epoch_mismatch', `armLaunch: re-arm epoch ${input.epoch} must exceed prior ${record.launch.epoch}`);
    }
    // PR2a review (BLOCKING): reject a non-parseable lease at arm time — an
    // invalid string makes Date.parse NaN and `now > NaN` false, so the grant
    // would never expire and a matching supervisor could cross it unbounded.
    if (!Number.isFinite(Date.parse(input.lease_deadline))) {
      throw new LaunchFenceError(turnId, 'lease_invalid', `armLaunch: lease_deadline "${input.lease_deadline}" is not a parseable timestamp`);
    }
    const next: TurnReservation = {
      ...record,
      launch: { status: 'armed', token: input.token, epoch: input.epoch, lease_deadline: input.lease_deadline, armed_at: nowISO() },
    };
    fence();
    writeReservation(next, cwd);
    return next;
  }, cwd);
}

/**
 * CONSUME the grant (armed→crossed) — the atomic fence the pre-exec supervisor
 * runs immediately before invoking the worker. Idempotent when already crossed
 * by the same token+epoch (a supervisor retry). Refused if revoked, expired, or
 * the token/epoch do not match — the supervisor MUST NOT spawn on refusal.
 */
export function consumeLaunchGrant(turnId: string, token: string, epoch: number, cwd?: string, agentId = 'system'): TurnReservation {
  return withReservationLock(turnId, agentId, (fence) => {
    const record = readReservation(turnId, cwd);
    if (!record) throw new ReservationStateError(turnId, 'reservation_not_found', `consumeLaunchGrant: unknown turn_id ${turnId}`);
    const g = record.launch;
    if (!g) throw new LaunchFenceError(turnId, 'not_armed', `consumeLaunchGrant: turn_id ${turnId} has no launch grant`);
    // Epoch/token/lease validated against the immutable grant fields (set once
    // at arm). Epoch BEFORE token so a stale generation reports epoch_mismatch.
    if (g.epoch !== epoch) throw new LaunchFenceError(turnId, 'epoch_mismatch', `consumeLaunchGrant: epoch ${epoch} != grant epoch ${g.epoch}`);
    if (g.token !== token) throw new LaunchFenceError(turnId, 'token_mismatch', `consumeLaunchGrant: token mismatch for ${turnId}`);
    // Expiry is inclusive (now >= deadline) — the SAME rule the sweep uses.
    if (Date.parse(nowISO()) >= Date.parse(g.lease_deadline)) {
      throw new LaunchFenceError(turnId, 'lease_expired', `consumeLaunchGrant: grant for ${turnId} expired at ${g.lease_deadline}`);
    }
    // ATOMIC XOR — claim the decision via exclusive-create. If a revoke already
    // won (even from a newer holder after this one was reaped), we LOSE here and
    // must not spawn. No TOCTOU: the create, not a prior check, is the commit.
    const committed = claimLaunchDecision(turnId, { decision: 'crossed', token, epoch, at: nowISO() }, cwd);
    if (committed.decision === 'revoked') {
      throw new LaunchFenceError(turnId, 'revoked', `consumeLaunchGrant: grant for ${turnId} was revoked — MUST NOT spawn`);
    }
    // Won (or idempotently already crossed). Update the record projection.
    const next: TurnReservation = { ...record, launch: { ...g, status: 'crossed', crossed_at: committed.at } };
    fence();
    writeReservation(next, cwd);
    return next;
  }, cwd);
}

/**
 * REVOKE the grant (armed→revoked) — prevents a still-armed token from ever
 * crossing. Idempotent when already revoked (same epoch). Refused once CROSSED:
 * a crossed grant means the worker launched, so the caller must treat the
 * attempt as launch_attempted_unknown and never re-spawn.
 */
export function revokeLaunchGrant(turnId: string, epoch: number, reason: string, cwd?: string, agentId = 'system'): TurnReservation {
  return withReservationLock(turnId, agentId, (fence) => {
    const record = readReservation(turnId, cwd);
    if (!record) throw new ReservationStateError(turnId, 'reservation_not_found', `revokeLaunchGrant: unknown turn_id ${turnId}`);
    const g = record.launch;
    if (!g) throw new LaunchFenceError(turnId, 'not_armed', `revokeLaunchGrant: turn_id ${turnId} has no launch grant`);
    if (g.epoch !== epoch) throw new LaunchFenceError(turnId, 'epoch_mismatch', `revokeLaunchGrant: epoch ${epoch} != grant epoch ${g.epoch}`);
    // ATOMIC XOR — claim the decision. If a consume already crossed (even from a
    // newer holder), we LOSE: the worker launched, so the attempt is
    // launch_attempted_unknown and must never be treated as re-spawnable.
    const committed = claimLaunchDecision(turnId, { decision: 'revoked', token: g.token, epoch, at: nowISO(), reason }, cwd);
    if (committed.decision === 'crossed') {
      throw new LaunchFenceError(turnId, 'crossed_not_revocable', `revokeLaunchGrant: grant for ${turnId} already crossed — worker launched, cannot revoke`);
    }
    const next: TurnReservation = { ...record, launch: { ...g, status: 'revoked', revoked_at: committed.at, revoke_reason: committed.reason ?? reason } };
    fence();
    writeReservation(next, cwd);
    return next;
  }, cwd);
}

export function launchGrant(turnId: string, cwd?: string): TurnReservation['launch'] | undefined {
  const g = readReservation(turnId, cwd)?.launch;
  if (!g) return undefined;
  // The decision file is AUTHORITATIVE — a winner may have crashed after the
  // atomic exclusive-create but before updating the record projection, so
  // reconcile the status from the decision file when one exists.
  const d = readLaunchDecision(turnId, g.epoch, cwd);
  if (!d) return g;
  return d.decision === 'crossed'
    ? { ...g, status: 'crossed', crossed_at: d.at }
    : { ...g, status: 'revoked', revoked_at: d.at, revoke_reason: d.reason };
}

/**
 * The evidence nonce for the CURRENT launch generation (§13 R2). Because
 * `deriveChildIds` is epoch-invariant, only the consumed launch token uniquely
 * identifies the generation that actually spawned — so THIS is what the worker
 * must echo (in LANE-RESULT / signals / artifact metadata) and what the
 * read-strict acceptance path (PR2b-c) matches on. `undefined` until armed.
 */
export function currentNonce(reservation: TurnReservation): string | undefined {
  return reservation.launch?.token;
}

/** Derived attempt status (spec §2) projected from the two shipped axes
 *  (`decision` + `launch.status`) plus an optional run status. Single source
 *  of truth — the flat `status` enum is NOT stored (§13 R1). */
export type AttemptStatus =
  | 'reserved' | 'launching' | 'running' | 'waiting_input'
  | 'completed' | 'failed' | 'cancelled';

export function attemptStatus(reservation: TurnReservation, runStatus?: string): AttemptStatus {
  if (reservation.decision === 'aborted') return 'cancelled';
  const launch = reservation.launch;
  if (launch?.status === 'revoked') return 'cancelled';
  if (launch?.status === 'crossed') {
    if (runStatus === 'completed') return 'completed';
    if (runStatus === 'failed') return 'failed';
    if (runStatus === 'waiting_input') return 'waiting_input';
    return 'running';
  }
  // no grant yet, or armed-but-not-crossed
  return reservation.decision === 'committed' ? 'launching' : 'reserved';
}

/**
 * Revoke every armed grant whose lease has expired (reserved_never_launched).
 * The single non-GET sweep owner (dec#138). Skips crossed/revoked grants.
 * Returns the turn_ids revoked.
 */
export function sweepExpiredLaunchGrants(cwd?: string, agentId = 'system'): string[] {
  const now = Date.parse(nowISO());
  const revoked: string[] = [];
  for (const r of listReservations({}, cwd)) {
    const g = launchGrant(r.turn_id, cwd); // authoritative status (decision-file reconciled)
    if (!g || g.status !== 'armed') continue;
    // Expired ⟺ now >= deadline (inclusive), matching consumeLaunchGrant.
    if (Date.parse(g.lease_deadline) > now) continue;
    try {
      revokeLaunchGrant(r.turn_id, g.epoch, 'reserved_never_launched', cwd, agentId);
      revoked.push(r.turn_id);
    } catch { /* raced to crossed/revoked — skip */ }
  }
  return revoked;
}
