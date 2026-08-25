import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { memoryDir, writeFileAtomic } from '../io.js';
import { nowISO } from '../ids.js';
import {
  CapabilitySnapshotSchema,
  assertExecutionContractIntegrity,
  ExecutionContractRefSchema,
  ExecutionContractSchema,
  type CapabilitySnapshot,
  type ExecutionContract,
  type ExecutionContractRef,
} from '../execution-contract.js';
import { ExpectedArtifactSchema, type ExpectedArtifact } from './artifact-contract.js';
import { acquireLock } from './lock.js';
import {
  readLaunchDecision as readV2LaunchDecision,
  readInitialGeneration,
  listAttemptGenerations,
  resolveTurnGenerationChain,
  type AttemptGeneration,
} from './attempt-generations.js';

export { ExpectedArtifactSchema, type ExpectedArtifact } from './artifact-contract.js';

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
 * SCOPE: this module owns the kind-neutral reservation record + its decision
 * CAS + launch guard. `attempt-authority.ts` is the functional facade and
 * `turn-execution.ts` materializes Assignment/Run/claim/slot projections before
 * crossing. The child ids stay deterministic so repair is idempotent.
 */

export type ReservationDecision = 'prepared' | 'committed' | 'aborted';

/**
 * An artifact the attempt's worker is expected to produce (spec §2 / §13 R1).
 * Brainclaw generates the canonical target; `worker_path` is worker-relative and
 * MUST be realpath-containment-validated before any read (invariant #7, wired in
 * a later PR). `sha256` is filled at harvest and validated before state mutation.
 */
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
  /** P1: complete immutable launch contract. Optional for pre-P1 reservations. */
  execution_contract: ExecutionContractSchema.optional(),
  execution_contract_ref: ExecutionContractRefSchema.optional(),
  capability_snapshot: CapabilitySnapshotSchema.optional(),
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
  /** P1 immutable contract fields. Omitted only by legacy/direct callers. */
  execution_contract?: ExecutionContract;
  execution_contract_ref?: ExecutionContractRef;
  capability_snapshot?: CapabilitySnapshot;
}

/** Raised when a decision CAS is attempted from an incompatible terminal state. */
export class ReservationStateError extends Error {
  constructor(
    public readonly turn_id: string,
    public readonly code:
      | 'reservation_not_found'
      | 'reservation_exists'
      | 'invalid_lease_deadline'
      | 'invalid_execution_contract'
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
      | 'dispatch_lease_expired'
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
function claimLaunchDecision(turnId: string, decision: LaunchDecisionFile, cwd?: string): { decision: LaunchDecisionFile; won: boolean } {
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
    return { decision, won: true }; // THIS call performed the atomic create
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const incumbent = readLaunchDecision(turnId, decision.epoch, cwd);
    if (!incumbent) throw err; // decision file vanished mid-race — surface it
    return { decision: incumbent, won: false }; // lost — the incumbent decision stands (adopted)
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

/**
 * DETERMINISTIC turn_id from (loop_id, slot_id, iteration) — pln#630 PR2c (§13
 * A2). A duplicate dispatch of the same slot in the same iteration re-derives
 * the SAME turn_id, so reserve() hits `reservation_exists` and the caller adopts
 * the existing attempt instead of minting a second one — the closure for
 * double-spawn-per-slot (a random turn_id would let two concurrent dispatches
 * both reserve+arm+consume+spawn the same slot). `tat_` prefix matches the
 * attempt-id convention.
 */
export function deriveTurnId(loopId: string, slotId: string, iteration: number): string {
  const h = crypto.createHash('sha256').update(`${loopId}:${slotId}:${iteration}`).digest('hex').slice(0, 16);
  return `tat_${h}`;
}

/**
 * Versioned identity used only when the legacy `(loop, slot, iteration)` cell
 * is already owned by another phase. Keeping this a separate derivation makes
 * existing turn ids and crash-replay fixtures stable while allowing one slot
 * to execute several worker phases in the same protocol iteration.
 */
export function derivePhaseQualifiedTurnId(
  loopId: string,
  slotId: string,
  phase: string,
  iteration: number,
): string {
  const identity = JSON.stringify(['brainclaw-turn-identity-v2', loopId, slotId, phase, iteration]);
  const h = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16);
  return `tat_${h}`;
}

export interface ResolveTurnIdInput {
  loop_id: string;
  slot_id: string;
  phase: string;
  iteration: number;
  /** Persisted slot pointer, when projection already crossed or needs repair. */
  current_turn_id?: string;
}

function reservationMatchesTurnIdentity(
  reservation: TurnReservation | undefined,
  input: ResolveTurnIdInput,
): reservation is TurnReservation {
  return reservation !== undefined
    && reservation.loop_id === input.loop_id
    && reservation.slot_id === input.slot_id
    && reservation.phase === input.phase
    && reservation.iteration === input.iteration;
}

/**
 * Resolve the durable turn cell without breaking pre-phase-qualified stores.
 *
 * Resolution order is deliberately conservative:
 *  1. adopt the slot's current compatible reservation (projection/crash replay),
 *  2. preserve the compatible legacy three-tuple reservation,
 *  3. adopt an existing compatible phase-qualified reservation,
 *  4. use the legacy id while that cell is absent,
 *  5. only then fall back to the phase-qualified id for a real phase collision.
 *
 * Compatibility intentionally covers identity fields only. Agent/claim/contract
 * mismatches remain the responsibility of prepareAttempt's fail-closed checks;
 * they must never cause this resolver to mint a parallel authority cell.
 */
export function resolveTurnId(input: ResolveTurnIdInput, cwd?: string): string {
  const legacyTurnId = deriveTurnId(input.loop_id, input.slot_id, input.iteration);
  const phaseTurnId = derivePhaseQualifiedTurnId(
    input.loop_id,
    input.slot_id,
    input.phase,
    input.iteration,
  );

  if (input.current_turn_id) {
    const current = getReservation(input.current_turn_id, cwd);
    if (reservationMatchesTurnIdentity(current, input)) return input.current_turn_id;
  }

  const legacy = getReservation(legacyTurnId, cwd);
  if (reservationMatchesTurnIdentity(legacy, input)) return legacyTurnId;

  const phaseQualified = getReservation(phaseTurnId, cwd);
  if (reservationMatchesTurnIdentity(phaseQualified, input)) return phaseTurnId;

  return legacy === undefined ? legacyTurnId : phaseTurnId;
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
 * primitive (generation-fenced dead-owner reaping, exclusive hard-link
 * creation, fencing) so the decision CAS is atomic across processes — two
 * racing writers cannot both mutate the decision.
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
    // before any durable write. If a proven-dead owner's generation was reaped
    // and re-acquired by another writer, fenceCheck throws LockLostError so a
    // stale holder can never overwrite the other terminal transition — the
    // consume-XOR-revoke fence stays durable across recovery.
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
  // Fail-CLOSED at the boundary (review PR2b-b #1): an unparseable dispatch
  // lease must be rejected here, so no committed reservation can ever carry a
  // garbage lease that the armLaunch dispatch-lease gate would then skip.
  if (!Number.isFinite(Date.parse(input.lease_deadline))) {
    throw new ReservationStateError(input.turn_id, 'invalid_lease_deadline', `reserve: lease_deadline "${input.lease_deadline}" is not a parseable timestamp`);
  }
  const contractFieldCount = [
    input.execution_contract,
    input.execution_contract_ref,
    input.capability_snapshot,
  ].filter((value) => value !== undefined).length;
  if (contractFieldCount !== 0 && contractFieldCount !== 3) {
    throw new ReservationStateError(
      input.turn_id,
      'invalid_execution_contract',
      'reserve: execution_contract, execution_contract_ref and capability_snapshot must be supplied together',
    );
  }
  if (input.execution_contract && input.execution_contract_ref && input.capability_snapshot) {
    try {
      assertExecutionContractIntegrity(
        input.execution_contract,
        input.execution_contract_ref,
        input.capability_snapshot,
        { agent: input.agent, agent_id: input.agent_id },
      );
    } catch (error) {
      throw new ReservationStateError(
        input.turn_id,
        'invalid_execution_contract',
        `reserve: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
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
        execution_contract: input.execution_contract,
        execution_contract_ref: input.execution_contract_ref,
        capability_snapshot: input.capability_snapshot,
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

/**
 * Find the turn-attempt reservation that OWNS a given agent_run, if any
 * (pln#630 PR2b-c). The link is the deterministic `deriveChildIds(turn_id)` —
 * a reservation owns `run_id` iff `child_ids.run_id === runId`. Used by the
 * reconciler to decide whether a run is turn-owned (→ read-strict acceptance)
 * or legacy (→ presence-based acceptance). Returns undefined for legacy runs.
 */
export function findReservationByRunId(runId: string, cwd?: string): TurnReservation | undefined {
  return listReservations({}, cwd).find((reservation) => {
    if (reservation.child_ids.run_id === runId) return true;
    try {
      const root = cwd ?? reservation.store_root;
      const initial = readInitialGeneration(root, reservation.turn_id);
      return initial ? listAttemptGenerations(root, initial).some((generation) => generation.run_id === runId) : false;
    } catch {
      return false;
    }
  });
}

/**
 * Find the turn-attempt reservation that OWNS a given assignment, if any
 * (pln#630 PR3a). Mirror of {@link findReservationByRunId} keyed on the
 * deterministic `child_ids.assignment_id`. The harvest path uses this to decide
 * whether a completed LANE-RESULT is turn-owned — the lane always carries its
 * `assignment_id`, whereas a real reviewer lane does NOT echo run_id/turn_id/nonce
 * (the review brief never asks for them), so assignment_id is the reliable
 * discriminator. Returns undefined for legacy assignments.
 */
export function findReservationByAssignmentId(assignmentId: string, cwd?: string): TurnReservation | undefined {
  // decision:'committed' is load-bearing (review #5): only a COMMITTED reservation ever
  // coexists with a real LANE-RESULT (dispatch commits before spawn). Filtering here makes
  // the turn-owned discriminator explicit — a `prepared`/`aborted` reservation must never
  // route a lane to reconcileTurn (it has no live launch generation to accept evidence for).
  return listReservations({ decision: 'committed' }, cwd).find((reservation) => {
    if (reservation.child_ids.assignment_id === assignmentId) return true;
    try {
      const root = cwd ?? reservation.store_root;
      const initial = readInitialGeneration(root, reservation.turn_id);
      return initial
        ? listAttemptGenerations(root, initial).some((generation) => generation.assignment_id === assignmentId)
        : false;
    } catch {
      return false;
    }
  });
}

/** Run-scoping key for runtime evidence; undefined preserves legacy assignment-scoped paths. */
export function currentAttemptRunIdForAssignment(assignmentId: string, cwd?: string): string | undefined {
  const reservation = findReservationByAssignmentId(assignmentId, cwd);
  if (!reservation) return undefined;
  return resolveTurnGenerationChain(reservation.store_root, reservation.turn_id)?.latest_generation.run_id;
}

/* ============================ launch-grant fence (PR2a, dec#138) ========== */

export interface ArmLaunchInput {
  /**
   * Fence token + evidence nonce for this generation (§13 R2). OMIT in
   * production so armLaunch mints a cryptographically-random, generation-unique
   * value — evidenceMatchesAttempt's "stale prior-generation can never match"
   * guarantee depends on distinct tokens per generation. An explicitly-supplied
   * token is honored (tests / explicit control); the caller then owns
   * per-generation uniqueness.
   */
  token?: string;
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
    // PR2b-b (§13 R5 gap 2): enforce the DISPATCH lease. A committed reservation
    // is never abortable (repairable-only), so a stale one can't be swept away —
    // instead we refuse to arm it once its dispatch lease has passed. Without
    // this, a supervisor arriving long after the lease could arm a fresh grant
    // and spawn (phantom-spawn-after-lease). The reservation stays committed but
    // reserved_never_launched: it simply never spawns.
    // Fail-CLOSED (review PR2b-b #1): a non-parseable dispatch lease must refuse
    // arm, not skip the gate — otherwise a garbage lease reopens the very
    // phantom-spawn-after-lease this guard closes (the launch-lease check below
    // is already fail-closed; the two must be symmetric). reserve() also
    // validates the lease at the boundary, so this is defense-in-depth.
    const dispatchLeaseMs = Date.parse(record.lease_deadline);
    if (!Number.isFinite(dispatchLeaseMs) || Date.parse(nowISO()) >= dispatchLeaseMs) {
      throw new LaunchFenceError(turnId, 'dispatch_lease_expired', `armLaunch: dispatch lease ${record.lease_deadline} for ${turnId} is unparseable or has passed — reserved_never_launched, must not spawn`);
    }
    // PR2a review (BLOCKING): reject a non-parseable lease at arm time — an
    // invalid string makes Date.parse NaN and `now > NaN` false, so the grant
    // would never expire and a matching supervisor could cross it unbounded.
    if (!Number.isFinite(Date.parse(input.lease_deadline))) {
      throw new LaunchFenceError(turnId, 'lease_invalid', `armLaunch: lease_deadline "${input.lease_deadline}" is not a parseable timestamp`);
    }
    // Nonce = fence token + evidence key (§13 R2). Auto-generate a random,
    // generation-unique value unless the caller supplied one — a distinct token
    // per generation is what lets evidenceMatchesAttempt reject stale
    // prior-generation evidence (review PR2b-b #2).
    const token = input.token ?? crypto.randomUUID();
    const next: TurnReservation = {
      ...record,
      launch: { status: 'armed', token, epoch: input.epoch, lease_deadline: input.lease_deadline, armed_at: nowISO() },
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
/**
 * Result of a consume attempt. `wonTransition` is the exactly-once SPAWN
 * AUTHORITY (§13 R5): TRUE only when THIS invocation performed the
 * armed→crossed transition. `wonTransition=false` means the grant was ALREADY
 * crossed by another invocation — the attempt is launch_attempted_unknown and
 * the caller MUST NOT spawn (the double-spawn-across-restart guard).
 */
export interface ConsumeResult {
  reservation: TurnReservation;
  wonTransition: boolean;
}

function consumeLaunchGrantLocked(
  turnId: string,
  record: TurnReservation,
  token: string,
  epoch: number,
  fence: () => void,
  cwd?: string,
): ConsumeResult {
  const g = record.launch;
  if (!g) throw new LaunchFenceError(turnId, 'not_armed', `consumeLaunchGrant: turn_id ${turnId} has no launch grant`);
  // Epoch/token/lease validated against the immutable grant fields (set once
  // at arm). Epoch BEFORE token so a stale generation reports epoch_mismatch.
  if (g.epoch !== epoch) throw new LaunchFenceError(turnId, 'epoch_mismatch', `consumeLaunchGrant: epoch ${epoch} != grant epoch ${g.epoch}`);
  if (g.token !== token) throw new LaunchFenceError(turnId, 'token_mismatch', `consumeLaunchGrant: token mismatch for ${turnId}`);
  // Expiry is inclusive (now >= deadline) — the SAME rule the sweep uses. This
  // is intentionally evaluated after projection callbacks as well: a slow repair
  // cannot cross a generation whose lease expired while it was materializing.
  if (Date.parse(nowISO()) >= Date.parse(g.lease_deadline)) {
    throw new LaunchFenceError(turnId, 'lease_expired', `consumeLaunchGrant: grant for ${turnId} expired at ${g.lease_deadline}`);
  }
  if (g.status === 'revoked') {
    throw new LaunchFenceError(turnId, 'revoked', `consumeLaunchGrant: grant for ${turnId} was revoked — MUST NOT spawn`);
  }
  // Validate that this reservation-lock holder was not reaped while a projection
  // callback performed local I/O. The fence check MUST precede the irreversible
  // decision-cell create, not merely the record projection write that follows it.
  fence();
  // ATOMIC XOR — claim the decision via exclusive-create. If a revoke already
  // won (even from a newer holder after this one was reaped), we LOSE here and
  // must not spawn. No TOCTOU: the create, not a prior check, is the commit.
  const { decision: committed, won } = claimLaunchDecision(turnId, { decision: 'crossed', token, epoch, at: nowISO() }, cwd);
  if (committed.decision === 'revoked') {
    throw new LaunchFenceError(turnId, 'revoked', `consumeLaunchGrant: grant for ${turnId} was revoked — MUST NOT spawn`);
  }
  // Won → this call crossed (may spawn). Adopted (won=false) → already crossed
  // by another invocation: launch_attempted_unknown, caller MUST NOT spawn.
  const next: TurnReservation = { ...record, launch: { ...g, status: 'crossed', crossed_at: committed.at } };
  fence();
  writeReservation(next, cwd);
  return { reservation: next, wonTransition: won };
}

export function consumeLaunchGrant(turnId: string, token: string, epoch: number, cwd?: string, agentId = 'system'): ConsumeResult {
  return withReservationLock(turnId, agentId, (fence) => {
    const record = readReservation(turnId, cwd);
    if (!record) throw new ReservationStateError(turnId, 'reservation_not_found', `consumeLaunchGrant: unknown turn_id ${turnId}`);
    return consumeLaunchGrantLocked(turnId, record, token, epoch, fence, cwd);
  }, cwd);
}

/**
 * Consume a launch generation only after its deterministic local projections are durable.
 *
 * Lock order is intentionally reservation -> store -> loop. `project` must remain a short,
 * synchronous, local-I/O callback and this API must never be entered while the caller already
 * holds the store or loop lock. If projection throws, the crossed decision is not created and
 * an identical replay can repair/adopt the same Assignment, AgentRun and slot binding.
 */
export function consumeLaunchGrantWithProjection(
  turnId: string,
  token: string,
  epoch: number,
  project: (reservation: TurnReservation) => void,
  cwd?: string,
  agentId = 'system',
): ConsumeResult {
  return withReservationLock(turnId, agentId, (fence) => {
    const record = readReservation(turnId, cwd);
    if (!record) throw new ReservationStateError(turnId, 'reservation_not_found', `consumeLaunchGrantWithProjection: unknown turn_id ${turnId}`);

    // Validate the immutable generation before allowing it to materialize anything.
    const g = record.launch;
    if (!g) throw new LaunchFenceError(turnId, 'not_armed', `consumeLaunchGrantWithProjection: turn_id ${turnId} has no launch grant`);
    if (g.epoch !== epoch) throw new LaunchFenceError(turnId, 'epoch_mismatch', `consumeLaunchGrantWithProjection: epoch ${epoch} != grant epoch ${g.epoch}`);
    if (g.token !== token) throw new LaunchFenceError(turnId, 'token_mismatch', `consumeLaunchGrantWithProjection: token mismatch for ${turnId}`);
    if (g.status === 'revoked') throw new LaunchFenceError(turnId, 'revoked', `consumeLaunchGrantWithProjection: grant for ${turnId} was revoked — MUST NOT project or spawn`);
    if (g.status === 'crossed') return { reservation: record, wonTransition: false };
    if (Date.parse(nowISO()) >= Date.parse(g.lease_deadline)) {
      throw new LaunchFenceError(turnId, 'lease_expired', `consumeLaunchGrantWithProjection: grant for ${turnId} expired at ${g.lease_deadline}`);
    }

    project(record);
    return consumeLaunchGrantLocked(turnId, record, token, epoch, fence, cwd);
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
    const { decision: committed } = claimLaunchDecision(turnId, { decision: 'revoked', token: g.token, epoch, at: nowISO(), reason }, cwd);
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
  try {
    const resolved = resolveTurnGenerationChain(reservation.store_root, reservation.turn_id);
    if (resolved && (resolved.status === 'active' || resolved.status === 'settled')) {
      const generation = resolved.latest_generation;
      const launch = readV2LaunchDecision(reservation.store_root, reservation.turn_id, generation.attempt_epoch);
      return launch?.decision === 'crossed' ? generation.launch_nonce : undefined;
    }
  } catch {
    return undefined;
  }
  // Only a LIVE generation (armed or crossed) has a current nonce. A revoked
  // grant means the worker never crossed → never spawned, so its token is a
  // dead generation and must not be reported as current (review PR2b-a #1).
  const l = reservation.launch;
  return (l?.status === 'armed' || l?.status === 'crossed') ? l.token : undefined;
}

/**
 * Read-strict evidence predicate (§13 R3) — the foundation the acceptance path
 * (PR2b-c) builds on. Evidence is accepted for a turn-owned attempt ONLY when it
 * carries the matching `turn_id`, the attempt's derived `run_id`, AND the
 * current launch-generation `nonce` (the consumed token). Returns false when the
 * generation is not live (revoked / never armed → `currentNonce` undefined), so
 * a stale prior-generation or bare assignment-keyed signal can never match. The
 * `run.status === 'completed'` gate is applied separately by the caller.
 */
export function evidenceMatchesAttempt(
  reservation: TurnReservation,
  evidence: {
    assignment_id?: string;
    turn_id?: string;
    run_id?: string;
    nonce?: string;
    attempt_epoch?: number;
    contract_hash?: string;
    workspace_digest?: string;
  },
): boolean {
  try {
    const resolved = resolveTurnGenerationChain(reservation.store_root, reservation.turn_id);
    if (resolved && (resolved.status === 'active' || resolved.status === 'settled')) {
      const generation: AttemptGeneration = resolved.latest_generation;
      const launch = readV2LaunchDecision(reservation.store_root, reservation.turn_id, generation.attempt_epoch);
      if (launch?.decision !== 'crossed') return false;
      return (
        evidence.assignment_id === generation.assignment_id
        && evidence.turn_id === generation.turn_id
        && evidence.run_id === generation.run_id
        && evidence.nonce === generation.launch_nonce
        && evidence.attempt_epoch === generation.attempt_epoch
        && evidence.contract_hash === generation.contract_hash
        && evidence.workspace_digest === generation.workspace_digest
      );
    }
    if (resolved) return false;
  } catch {
    return false;
  }
  const nonce = currentNonce(reservation);
  if (!nonce) return false;
  return (
    evidence.turn_id === reservation.turn_id &&
    evidence.run_id === reservation.child_ids.run_id &&
    evidence.nonce === nonce
  );
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
