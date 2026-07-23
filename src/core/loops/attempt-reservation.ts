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
  // review-only slice: file result ingress only (no mcp/either yet).
  completion_mode: z.literal('file'),
  store_root: z.string().min(1),
  cwd: z.string().min(1),
  lease_deadline: z.string().min(1),
  decision: z.enum(['prepared', 'committed', 'aborted']),
  created_at: z.string().min(1),
  decided_at: z.string().optional(),
  abort_reason: z.string().optional(),
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
function withReservationLock<R>(turnId: string, agentId: string, fn: () => R, cwd?: string): R {
  ensureDirs(cwd);
  const lock = acquireLock({
    lockPath: reservationLockPath(turnId, cwd),
    agentId,
    intent: 'reservation',
    maxMutationDurationMs: 30_000,
  });
  try {
    return fn();
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
    () => {
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
        completion_mode: 'file',
        store_root: input.store_root,
        cwd: input.cwd,
        lease_deadline: input.lease_deadline,
        decision: 'prepared',
        created_at: nowISO(),
      };
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
    () => {
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
    () => {
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
