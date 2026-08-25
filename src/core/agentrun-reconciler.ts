/**
 * AgentRun reconciliation — silent-completion recovery + post-spawn health-check.
 *
 * Closes two gaps observed empirically in May 2026 dispatches:
 *
 * 1. **Silent completion** (pln#496 step stp_344f99b3). Dispatched workers
 *    sometimes finish their work and exit without ever calling
 *    `bclaw_assignment_update(status: 'completed')`. The agent_run stays in
 *    `running` forever, blocking review loops that wait on `run_completed`
 *    to converge. Concrete witnesses: codex review of pln#494 (37 min silent
 *    run_running, no completion event) and codex review of pln#480 (2h26
 *    silent). Also: claude-code worker on pln#480 implementation — committed
 *    fine but never released the claim.
 *
 * 2. **Post-spawn health check** (pln#496 step stp_e2b4429c). The dispatcher
 *    facade returns `delivered_and_started` as soon as the spawn fires, even
 *    when the process dies milliseconds later or hangs without producing any
 *    life-sign. Callers have no way to distinguish "spawned, working" from
 *    "spawned, already dead". A 60s grace window followed by an evidence
 *    check tells callers when the spawn is unverified.
 *
 * Approach: lazy reconciliation, no daemon. A single `reconcileAgentRun()`
 * function inspects evidence (process liveness, claim release, post-start
 * commits on the worktree branch) and either transitions the run to a
 * terminal state with `inferred=true` provenance or emits a synthetic
 * `delivered_but_unverified` runtime event without changing run status.
 *
 * Callers integrate this at read paths so stale runs converge on access
 * (bclaw_assignment_events, bclaw_loop intent=get) and the supervisor can
 * also trigger it explicitly via `brainclaw doctor --dispatch` (separate
 * step stp_8c072d75 — wired in later).
 *
 * @module
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { loadAgentRun, recordExecutionContractAnomaly, transitionAgentRun, type ListAgentRunsFilter, listAgentRuns } from './agentruns.js';
import { loadClaim, releaseClaim } from './claims.js';
import { loadAssignment } from './assignments.js';
import { createRuntimeEvent } from './events.js';
import { nowISO } from './ids.js';
import { readContractAck, readHeartbeat, readLogTail, signalExists, latestActivityMs, readCompletionSignals } from './runtime-signals.js';
import { validateWorkerContractAcceptance } from './execution-contract.js';
import { findReservationByRunId, evidenceMatchesAttempt, launchGrant, revokeLaunchGrant } from './loops/attempt-reservation.js';
import type { TurnReservation } from './loops/attempt-reservation.js';
import { executionContractForGeneration } from './loops/attempt-authority.js';
import { readLaunchDecision, resolveTurnGenerationChain } from './loops/attempt-generations.js';
import { reconcileFailedTurn, reconcileLaneResultForRun } from './loops/reconcile-turn.js';
import type { AgentRun, AgentRunStatus } from './schema.js';

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Minimum age before a run is eligible for reconciliation. Below this, the
 * worker has not been given a fair chance to emit its first life-sign.
 * Default 60 000 ms = 60 s — matches the pln#496 spec.
 */
export const DEFAULT_HEALTH_CHECK_GRACE_MS = 60_000;

/**
 * Age past which a run with no evidence of life and a dead process is
 * declared `failed` with `silent_termination_no_evidence`. Default 30 min.
 */
export const DEFAULT_STALE_AFTER_MS = 30 * 60_000;
export const DEFAULT_DEAD_PID_READ_SWEEP_AGE_MS = 5 * 60_000;
export const DEFAULT_DEAD_PID_READ_SWEEP_LIMIT = 50;

function normalizedWorkspace(value: string): string | undefined {
  try {
    const resolved = fs.realpathSync.native(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  } catch {
    return undefined;
  }
}

/**
 * pln#520 step 1 — a heartbeat older than this (with no completion signal) means
 * the worker reached its loop then went silent: `stalled`. Default 10 min.
 */
export const DEFAULT_HEARTBEAT_STALE_MS = 10 * 60_000;

const TERMINAL_STATUSES: ReadonlySet<AgentRunStatus> = new Set([
  'completed', 'failed', 'cancelled', 'timed_out', 'interrupted',
]);

// ── Public types ───────────────────────────────────────────────────────────

export type ReconcileAction =
  | 'no_op'
  | 'reconciled_turn'
  | 'health_check_unverified'
  | 'inferred_completed'
  | 'inferred_failed'
  | 'inferred_cancelled'
  | 'cancelled_dead_pid';

export interface ReconcileEvidence {
  /** Run's age in ms relative to `started_at` (or `created_at` if missing). */
  age_ms: number;
  /** New commits on the worktree branch since the run started. */
  has_post_start_commit: boolean;
  /** Linked claim is in `released` state. */
  claim_released: boolean;
  /** Linked assignment is in a terminal `completed` state. */
  assignment_completed: boolean;
  /** Process liveness: true=alive, false=dead, undefined=cannot determine. */
  process_alive: boolean | undefined;
  /**
   * pln#520 step 1 — sentinel evidence, the trustworthy liveness channel
   * (the wrapper pid is NOT trustworthy; see runtime-signals.ts).
   */
  /** Wrapper wrote the `completed` sentinel (agent exited 0). */
  completed_signal: boolean;
  /** Wrapper wrote the `failed` sentinel (agent exited non-zero). */
  failed_signal: boolean;
  /**
   * pln#630 PR2b-c (§13 R3) — this run is owned by a turn-attempt reservation
   * (deriveChildIds match). Turn-owned runs use READ-STRICT acceptance: only
   * turn-keyed completion evidence counts, never a bare assignment-keyed
   * presence sentinel or an assignment-keyed proxy (claim_released etc.).
   */
  turn_owned: boolean;
  /**
   * True iff a turn-keyed `completed` sentinel is present whose turn_id/run_id/
   * nonce match the owning attempt's CURRENT launch generation. The single
   * acceptance signal for a turn-owned run (closes the stale-sentinel + presence
   * -only phantom-completion holes).
   */
  turn_keyed_completed: boolean;
  /** Contracted run reported different/missing accepted hashes after crossing. */
  contract_acceptance_anomaly: boolean;
  /** Worker wrote a `heartbeat` (work_loop_reached) at least once. */
  heartbeat_exists: boolean;
  /** Age of the heartbeat in ms (undefined when no heartbeat). */
  heartbeat_age_ms?: number;
  /**
   * pln#527 — age (ms) of the most recent FILESYSTEM activity: max mtime across
   * captured stdout/stderr logs + any worktree file. The liveness signal for
   * workers that emit no heartbeat during a long single operation (codex
   * streaming to stderr; `claude -p` buffering stdout while editing files).
   * undefined when nothing observable. A SMALL value = working, even if the
   * heartbeat is stale.
   */
  fs_activity_age_ms?: number;
}

export interface ReconcileResult {
  run_id: string;
  /** Action taken — `no_op` means no transition or event was emitted. */
  action: ReconcileAction;
  /** Human-readable summary of why this action was chosen. */
  reason: string;
  evidence: ReconcileEvidence;
  /** Status before reconciliation (unchanged when action=`no_op`). */
  previous_status: AgentRunStatus;
  /** Status after reconciliation (same as previous_status when no transition). */
  current_status: AgentRunStatus;
}

export interface ReconcileOptions {
  /** Override 60 s grace window for tests. */
  healthCheckGraceMs?: number;
  /** Override 30 min stale threshold for tests. */
  staleAfterMs?: number;
  /** Override the heartbeat-stale threshold (pln#520 step 1, default 10 min). */
  heartbeatStaleMs?: number;
  /** Override the wall clock for deterministic tests. */
  nowMs?: number;
  /** Actor name recorded on synthetic transitions / events. Default 'reconciler'. */
  actor?: string;
  /** Cap for dead-pid read sweeps. */
  limit?: number;
  /** Minimum age for selecting dead-pid sweep candidates; failure still uses staleAfterMs. */
  deadPidSweepCandidateAgeMs?: number;
}

/** Shared business-result bridge for every lazy AgentRun read path. */
function reconcileOwnedLaneResultAtRead(
  run: AgentRun,
  evidence: ReconcileEvidence,
  cwd: string | undefined,
  actor: string,
): ReconcileResult | undefined {
  if (!evidence.turn_owned) return undefined;
  const lane = reconcileLaneResultForRun(run, cwd ?? process.cwd(), actor);
  if (!lane.found) return undefined;
  if (!lane.valid || !lane.result?.reconciled) {
    return {
      run_id: run.id,
      action: 'health_check_unverified',
      reason: `lane_result_withheld: ${lane.reason}`,
      evidence,
      previous_status: run.status,
      current_status: run.status,
    };
  }
  const after = loadAgentRun(run.id, cwd) ?? run;
  return {
    run_id: run.id,
    action: 'reconciled_turn',
    reason: `lane_result_reconciled: ${lane.reason}`,
    evidence,
    previous_status: run.status,
    current_status: after.status,
  };
}

// ── Process liveness ───────────────────────────────────────────────────────

/**
 * Cross-platform "is this PID alive" check. `process.kill(pid, 0)` does NOT
 * actually send a signal — it queries existence. ESRCH = dead, EPERM = alive
 * but owned by another user (still counts as alive for our purposes).
 *
 * Returns undefined when no PID is tracked on the run, so the caller can
 * distinguish "definitely dead" from "we have no way to know".
 */
export function isProcessAlive(pid: number | undefined): boolean | undefined {
  if (pid === undefined || pid === 0) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (typeof err === 'object' && err && 'code' in err) {
      const code = (err as { code?: string }).code;
      if (code === 'ESRCH') return false;
      if (code === 'EPERM') return true;
    }
    return false;
  }
}

// ── Evidence collection ────────────────────────────────────────────────────

function safeGit(args: string[], cwd: string): { ok: boolean; stdout: string } {
  try {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true });
    if (result.status !== 0) return { ok: false, stdout: '' };
    return { ok: true, stdout: (result.stdout ?? '').toString() };
  } catch {
    return { ok: false, stdout: '' };
  }
}

/**
 * True when the worktree branch has at least one commit whose committer
 * timestamp is at or after the run's start. A worker that committed its
 * work — even without releasing the claim or emitting run_completed — leaves
 * this evidence behind.
 *
 * Failure cases (returns false defensively, never throws):
 * - run.worktree_path missing or no longer on disk
 * - git not on PATH
 * - branch detached / corrupt
 */
function hasPostStartCommitEvidence(run: AgentRun): boolean {
  if (!run.worktree_path) return false;
  if (!run.started_at && !run.created_at) return false;
  const startISO = run.started_at ?? run.created_at;
  // git log on HEAD since the start timestamp, format author + commit times.
  // We intentionally check committer time (%ct) because rebases preserve
  // author time but reset committer time to the rebase moment, and we want
  // to count the actual operation that landed on the branch.
  const result = safeGit(
    ['log', `--since=${startISO}`, '-n', '1', '--format=%H'],
    run.worktree_path,
  );
  if (!result.ok) return false;
  return result.stdout.trim().length > 0;
}

/**
 * Best-effort evidence collection. Each individual signal is wrapped in
 * try/catch so partial failures (missing claim, dead worktree path) do not
 * propagate as errors — they just contribute zero evidence.
 *
 * `cwd` MUST be threaded so loadClaim / loadAssignment look in the right
 * brainclaw store. Tests that supplied cwd to reconcileAgentRun but not
 * here saw all evidence as zero because the loaders defaulted to
 * process.cwd().
 */
export function collectEvidence(run: AgentRun, cwd?: string, options?: { nowMs?: number }): ReconcileEvidence {
  const now = options?.nowMs ?? Date.now();
  const startISO = run.started_at ?? run.created_at;
  const age_ms = now - new Date(startISO).getTime();

  let has_post_start_commit = false;
  try { has_post_start_commit = hasPostStartCommitEvidence(run); } catch { /* defensive */ }

  let claim_released = false;
  try {
    const claim = loadClaim(run.claim_id, cwd);
    claim_released = claim?.status === 'released';
  } catch { /* defensive */ }

  let assignment_completed = false;
  try {
    const assignment = loadAssignment(run.assignment_id, cwd);
    assignment_completed = assignment?.status === 'completed';
  } catch { /* defensive */ }

  const process_alive = isProcessAlive(run.pid);

  // pln#520 step 1 — sentinel evidence. Signals live under the project
  // coordination dir (the dispatcher's ackRoot), which is `cwd` for the
  // reconciler. Keyed by assignment_id.
  const signalRoot = cwd ?? process.cwd();
  const signalReservation = findReservationByRunId(run.id, cwd);
  let v2SignalRunId: string | undefined;
  try {
    if (signalReservation && resolveTurnGenerationChain(signalReservation.store_root, signalReservation.turn_id)) {
      v2SignalRunId = run.id;
    }
  } catch { /* strict evidence handling below remains fail-closed */ }
  let completed_signal = false;
  let failed_signal = false;
  let heartbeat_exists = false;
  let heartbeat_age_ms: number | undefined;
  try {
    completed_signal = signalExists(signalRoot, run.assignment_id, 'completed', v2SignalRunId);
    failed_signal = signalExists(signalRoot, run.assignment_id, 'failed', v2SignalRunId);
    // sprint 1.5: also read the worktree-local heartbeat — the only location a
    // sandboxed worker can write (the project-root signal dir is outside its
    // writable roots).
    const hb = readHeartbeat(signalRoot, run.assignment_id, run.worktree_path, v2SignalRunId);
    heartbeat_exists = hb.exists;
    if (hb.exists && hb.mtimeMs !== undefined) heartbeat_age_ms = now - hb.mtimeMs;
  } catch { /* defensive */ }

  // pln#527 — filesystem-activity liveness (logs + worktree). Independent of the
  // heartbeat: a worker can be actively editing files / streaming to stderr while
  // its heartbeat is frozen (written once at step 0).
  let fs_activity_age_ms: number | undefined;
  try {
    const lastFs = latestActivityMs(signalRoot, run.assignment_id, run.worktree_path, v2SignalRunId);
    if (lastFs !== undefined) fs_activity_age_ms = now - lastFs;
  } catch { /* defensive */ }

  // pln#630 PR2b-c (§13 R3) — read-strict gate. A run owned by a turn-attempt
  // reservation is completed ONLY on turn-keyed evidence: a `completed` sentinel
  // body whose turn_id/run_id/nonce match the attempt's CURRENT launch
  // generation. A bare assignment-keyed presence sentinel — or a stale prior
  // generation's body — never counts (closes phantom-completion). Legacy runs
  // (no owning reservation) keep presence-based acceptance.
  let turn_owned = false;
  let turn_keyed_completed = false;
  let contract_acceptance_anomaly = Boolean(run.execution_contract_anomaly);
  try {
    const reservation = findReservationByRunId(run.id, cwd);
    if (reservation) {
      turn_owned = true;
      const bodies = readCompletionSignals(signalRoot, run.assignment_id, v2SignalRunId);
      const bootstrapAck = readContractAck(signalRoot, run.assignment_id, v2SignalRunId);
      const hasTerminalBody = bodies.completed !== undefined || bodies.failed !== undefined;
      const generationChain = resolveTurnGenerationChain(reservation.store_root, reservation.turn_id);
      const generation = generationChain?.latest_generation;
      const generationApplies = generation !== undefined && generation.run_id === run.id
        && (generationChain?.status === 'active' || generationChain?.status === 'settled');
      const generationLaunch = generationApplies
        ? readLaunchDecision(reservation.store_root, reservation.turn_id, generation.attempt_epoch)
        : undefined;
      const expectedContractRef = generationApplies
        ? executionContractForGeneration(reservation, generation).ref
        : reservation.execution_contract_ref;
      const bootstrapAccepted = !expectedContractRef || (
        bootstrapAck?.status === 'accepted'
        && bootstrapAck.turn_id === reservation.turn_id
        && bootstrapAck.run_id === (generationApplies ? generation.run_id : reservation.child_ids.run_id)
        && bootstrapAck.nonce === (generationApplies ? generation.launch_nonce : reservation.launch?.token)
        && (!generationApplies || bootstrapAck.cwd === normalizedWorkspace(generation.workspace_path))
        && (!generationApplies || bootstrapAck.attempt_epoch === generation.attempt_epoch)
        && (!generationApplies || bootstrapAck.workspace_digest === generation.workspace_digest)
        && validateWorkerContractAcceptance(
          expectedContractRef,
          {
            contract_hash: bootstrapAck.contract_hash,
            capability_snapshot_hash: bootstrapAck.capability_snapshot_hash,
          },
          generationApplies ? generationLaunch?.decision : reservation.launch?.status,
        ).kind === 'accepted'
      );
      if (expectedContractRef && ((bootstrapAck && !bootstrapAccepted) || (hasTerminalBody && !bootstrapAccepted))) {
        contract_acceptance_anomaly = true;
      }
      const contractAccepted = (body: typeof bodies.completed): boolean => {
        if (!expectedContractRef) return true;
        if (!bootstrapAccepted) return false;
        if (!body?.contract_hash || !body.capability_snapshot_hash) {
          contract_acceptance_anomaly = Boolean(body);
          return false;
        }
        const verdict = validateWorkerContractAcceptance(
          expectedContractRef,
          { contract_hash: body.contract_hash, capability_snapshot_hash: body.capability_snapshot_hash },
          generationApplies ? generationLaunch?.decision : reservation.launch?.status,
        );
        if (verdict.kind !== 'accepted') contract_acceptance_anomaly = true;
        return verdict.kind === 'accepted';
      };
      // Evidence must be turn-keyed AND carry the RIGHT status (a `.completed`
      // file whose body says status:'failed' is not completion evidence —
      // read-strict trusts the body, not the filename, review PR2b-c #C2).
      const matchedCompleted = bodies.completed !== undefined
        && bodies.completed.status === 'completed'
        && evidenceMatchesAttempt(reservation, { ...bodies.completed, assignment_id: run.assignment_id })
        && contractAccepted(bodies.completed);
      const matchedFailed = bodies.failed !== undefined
        && bodies.failed.status === 'failed'
        && evidenceMatchesAttempt(reservation, { ...bodies.failed, assignment_id: run.assignment_id })
        && contractAccepted(bodies.failed);
      if (matchedCompleted && matchedFailed) {
        // §13 R4 — a completed+failed contradiction WITHHOLDS both (never a
        // silent accept). Conflict-event journaling is deferred to
        // reconcileTurn (PR3); collectEvidence stays side-effect-free.
        turn_keyed_completed = false;
        failed_signal = false;
      } else {
        turn_keyed_completed = matchedCompleted;
        // Read-strict governs FAILURE too for a turn-owned run: override the
        // presence-based failed_signal so a stale/legacy bare `.failed` marker
        // cannot phantom-FAIL a healthy generation (symmetric to completed,
        // review PR2b-c #B). A genuine death with no turn-keyed evidence still
        // fails via the process-dead + stale path below.
        failed_signal = matchedFailed;
      }
    }
  } catch { /* defensive — fall back to legacy (non-turn-owned) behavior */ }

  return {
    age_ms, has_post_start_commit, claim_released, assignment_completed, process_alive,
    completed_signal, failed_signal, heartbeat_exists, heartbeat_age_ms, fs_activity_age_ms,
    turn_owned, turn_keyed_completed, contract_acceptance_anomaly,
  };
}

/**
 * pln#527 — true when the run shows filesystem activity within `windowMs`
 * (logs growing / worktree files touched). Used to VETO a `stalled` verdict: a
 * stale heartbeat with fresh fs activity means "working", not "hung".
 */
function fsActiveWithin(evidence: ReconcileEvidence, windowMs: number): boolean {
  return evidence.fs_activity_age_ms !== undefined && evidence.fs_activity_age_ms < windowMs;
}

/**
 * trp#433 — when a run is reconciled to `failed` (silent_death / stalled), release
 * its linked claim so dead runs stop leaving active claims (and their worktrees)
 * accumulating for manual cleanup. Best-effort + idempotent: only an active claim
 * is released, and any error is swallowed (GC must never break reconciliation).
 * Inference only fires after the stale window with no life evidence, so this is
 * conservative.
 *
 * pln#641 (dec#151 option b): a TURN-OWNED run's claim is business state owned
 * by its LOOP, and the pln#638 6c effects boundary forbids a transport verdict
 * from carrying business effects. So a run with a reservation routes through
 * reconcileFailedTurn — the failure is recorded ON the loop (complete_turn
 * outcome:'failed') and the release is that convergence's business decision,
 * in the same lazy pass. When the loop path DECLINES (lock contention, loop
 * missing, containment), the claim deliberately stays for the next read-path
 * pass — never a forced fallback release, that would re-open the boundary hole.
 * Non-turn-owned runs keep the trp#433 cascade unchanged.
 */
function cascadeReleaseOnFailure(run: AgentRun, actor: string, cwd?: string, terminalStatus: 'failed' | 'cancelled' = 'failed', reason?: string): void {
  if (!run.claim_id) return;
  try {
    const reservation = findReservationByRunId(run.id, cwd);
    if (reservation) {
      reconcileFailedTurn({
        reservation,
        run,
        reason: reason ?? `run reconciled to ${terminalStatus}`,
        actor,
        cwd,
      });
      return;
    }
    const claim = loadClaim(run.claim_id, cwd);
    if (claim && claim.status === 'active') {
      releaseClaim(run.claim_id, cwd);
      createRuntimeEvent({
        agent: actor,
        session_id: run.session_id,
        event_type: terminalStatus === 'cancelled' ? 'run_cancelled' : 'run_failed',
        text: `Auto-released claim ${run.claim_id} after run ${run.id} was reconciled to ${terminalStatus} (trp#433 GC cascade)`,
        tags: ['reconciler', 'gc', 'claim-release'],
        assignment_id: run.assignment_id,
        run_id: run.id,
        claim_id: run.claim_id,
        status_reason: 'gc_cascade_release_on_failure',
      }, cwd);
    }
  } catch { /* best-effort — never let GC break reconciliation */ }
}

/**
 * pln#641 review P1 — the stranded-failure retry the read path was missing.
 *
 * `cascadeReleaseOnFailure` fires exactly once, on the failed/cancelled
 * TRANSITION. When the business convergence declines in that pass (loop-lock
 * contention, transient loop read failure) or the process crashes between the
 * loop's WAL record and the release, the run is already terminal — and every
 * read path deliberately skips terminal runs, so the "next pass retries"
 * promise was unreachable: the claim stranded until the 24h stale sweep,
 * contrary to the same-lazy-pass/non-famine guarantee of dec#151.
 *
 * This is that retry, called from the read-path walk ON terminal runs
 * (entity-operations.ts loadAgentRunsWithReconciliation). Cheap by
 * construction: in-memory status/claim_id/recency guards first, ONE claim
 * read only for RECENT failed/cancelled runs that still name a claim; the
 * cascade re-checks everything and stays idempotent. The recency window keeps
 * the walk from re-reading a claim file for every historical failure forever —
 * anything older has long been the stale sweep's business anyway.
 */
export const STRANDED_RELEASE_RETRY_WINDOW_MS = 48 * 60 * 60_000;

export function reconcileStrandedFailureClaimAtRead(run: AgentRun, cwd?: string, options: ReconcileOptions = {}): boolean {
  if (run.status !== 'failed' && run.status !== 'cancelled') return false;
  if (!run.claim_id) return false;
  const now = options.nowMs ?? Date.now();
  if (run.status_reason?.startsWith('reserved_never_launched:')) {
    const reservation = findReservationByRunId(run.id, cwd);
    const dispatchDeadline = reservation ? Date.parse(reservation.lease_deadline) : Number.NaN;
    if (
      reservation?.decision === 'committed'
      && reservation.launch?.status === 'revoked'
      && Number.isFinite(dispatchDeadline)
      && now < dispatchDeadline
    ) {
      return false;
    }
  }
  const anchor = Date.parse(run.completed_at ?? run.updated_at ?? run.created_at);
  if (Number.isFinite(anchor) && now - anchor > STRANDED_RELEASE_RETRY_WINDOW_MS) return false;
  try {
    const claim = loadClaim(run.claim_id, cwd);
    if (!claim || claim.status !== 'active') return false;
  } catch { return false; }
  cascadeReleaseOnFailure(
    run,
    options.actor ?? 'reconciler',
    cwd,
    run.status,
    run.status_reason ?? `stranded ${run.status} run — read-path retry`,
  );
  return true;
}

function anyCompletionEvidence(evidence: ReconcileEvidence): boolean {
  // pln#630 PR2b-c (§13 R3): a turn-owned run is completed ONLY on turn-keyed
  // evidence — never a bare presence sentinel or an assignment-keyed proxy
  // (claim_released / assignment_completed / post_start_commit). This is the
  // read-strict split that closes the stale-sentinel + presence-only
  // phantom-completion holes. Legacy (non-turn-owned) runs are unchanged.
  if (evidence.turn_owned) return evidence.turn_keyed_completed;
  return evidence.completed_signal
    || evidence.has_post_start_commit
    || evidence.claim_released
    || evidence.assignment_completed;
}

/**
 * pln#520 step 1 — a short tail of the captured stderr (or stdout) for
 * failed_silent / stalled diagnostics, so the verdict carries the worker's
 * last words instead of just a status code.
 */
function logTailSuffix(run: AgentRun, cwd?: string): string {
  const root = cwd ?? process.cwd();
  const tail = (readLogTail(root, run.assignment_id, 'stderr', 500).trim()
    || readLogTail(root, run.assignment_id, 'stdout', 500).trim());
  if (!tail) return '';
  return ` | log tail: ${tail.replace(/\s+/g, ' ').slice(0, 300)}`;
}

function describeEvidence(evidence: ReconcileEvidence): string {
  const reasons: string[] = [];
  if (evidence.completed_signal) reasons.push('wrapper wrote completed sentinel');
  if (evidence.contract_acceptance_anomaly) reasons.push('post-crossing contract acceptance anomaly (respawn forbidden)');
  if (evidence.has_post_start_commit) reasons.push('post-start commit on worktree branch');
  if (evidence.claim_released) reasons.push('claim released');
  if (evidence.assignment_completed) reasons.push('assignment marked completed');
  if (reasons.length === 0) {
    if (evidence.process_alive === false) reasons.push('process dead, no completion signal');
    else if (evidence.process_alive === true) reasons.push('process still alive');
    else reasons.push('no PID tracked');
  }
  return reasons.join(' + ');
}

// ── Synthetic event for unverified spawns ──────────────────────────────────

/**
 * Per-run throttle for "delivered_but_unverified" events (pln#558 step 5).
 *
 * Before this throttle every reconciliation pass during the health-check
 * window produced a fresh runtime_event file. With the VS Code extension
 * polling kind='board' every 30s, both reconciliation passes firing per
 * poll, and several non-terminal runs in flight, the store accumulated
 * ~120 of these files per hour per run — all writing under the mutation
 * lock, none ever surfaced to the UI.
 *
 * Surfacing the uncertainty once per window is enough; the event content
 * is monotonic (age increases) so re-emitting adds no information.
 */
const UNVERIFIED_EVENT_THROTTLE_MS = 5 * 60_000;
const lastUnverifiedEmitAt = new Map<string, number>();

function emitUnverifiedEvent(run: AgentRun, evidence: ReconcileEvidence, actor: string, cwd?: string): void {
  const now = Date.now();
  const last = lastUnverifiedEmitAt.get(run.id);
  if (last !== undefined && now - last < UNVERIFIED_EVENT_THROTTLE_MS) {
    return;
  }
  lastUnverifiedEmitAt.set(run.id, now);
  try {
    createRuntimeEvent({
      agent: actor,
      session_id: run.session_id,
      event_type: 'run_running',
      text: `Spawn unverified after ${Math.round(evidence.age_ms / 1000)}s — no life-sign detected (process_alive=${evidence.process_alive}, post_start_commit=${evidence.has_post_start_commit}, claim_released=${evidence.claim_released})`,
      tags: ['agent-runtime', 'run', 'reconciler', 'health-check'],
      assignment_id: run.assignment_id,
      run_id: run.id,
      claim_id: run.claim_id,
      plan_id: run.plan_id,
      sequence_id: run.sequence_id,
      scope: run.scope,
      transport: run.transport,
      status: run.status,
      status_reason: 'delivered_but_unverified',
      related_paths: run.scope ? [run.scope] : [],
      metadata: {
        reconciler: true,
        evidence_age_ms: evidence.age_ms,
        protocol: 'brainclaw.agent_runtime.reconciler.v0',
      },
    }, cwd);
  } catch { /* best-effort */ }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Reconcile a single agent_run against runtime evidence.
 *
 * No-op for terminal statuses or runs younger than the grace window.
 * For older runs:
 *   - If any completion evidence exists → transition to `completed` with
 *     `status_reason='inferred=true; …'`. This unblocks loops waiting on
 *     `run_completed` even when the worker forgot to call
 *     bclaw_assignment_update.
 *   - Else if process is provably dead and run is past the stale threshold
 *     → transition to `failed` with `status_reason='silent_termination_no_evidence'`.
 *   - Else if past grace but not yet stale, no evidence either way → emit a
 *     non-mutating `delivered_but_unverified` runtime event so callers can
 *     surface the uncertainty.
 *
 * The function is pure-evidence: it never inspects in-memory state of the
 * dispatcher, so it can be called from any process / any session that has
 * read access to the brainclaw store.
 */
export function reconcileAgentRun(runId: string, cwd?: string, options: ReconcileOptions = {}): ReconcileResult {
  const run = loadAgentRun(runId, cwd);
  if (!run) {
    const evidence: ReconcileEvidence = {
      age_ms: 0, has_post_start_commit: false, claim_released: false,
      assignment_completed: false, process_alive: undefined,
      completed_signal: false, failed_signal: false, heartbeat_exists: false, turn_owned: false, turn_keyed_completed: false, contract_acceptance_anomaly: false,
    };
    return {
      run_id: runId, action: 'no_op', reason: 'run not found', evidence,
      previous_status: 'created' as AgentRunStatus, current_status: 'created' as AgentRunStatus,
    };
  }

  const previous_status = run.status;
  const evidence = collectEvidence(run, cwd, { nowMs: options.nowMs });
  const actor = options.actor ?? 'reconciler';

  // pln#692 P0 — LANE-RESULT is the worker's business outcome, not merely a
  // process-liveness hint. Reconcile it before the terminal-run short circuit
  // and before generic sentinel completion so a replay heals every projection
  // (slot, assignment, run, claim) and malformed/foreign results cannot leave
  // only the run marked completed.
  const laneResult = reconcileOwnedLaneResultAtRead(run, evidence, cwd, actor);
  if (laneResult) return laneResult;

  // Never touch terminal runs — they already converged.
  if (TERMINAL_STATUSES.has(run.status)) {
    return {
      run_id: runId, action: 'no_op', reason: `run already terminal (${run.status})`,
      evidence, previous_status, current_status: run.status,
    };
  }

  if (evidence.contract_acceptance_anomaly) {
    try {
      recordExecutionContractAnomaly(runId, {
        source: 'reconciler',
        reason: 'bootstrap or terminal evidence did not accept the immutable execution contract',
      }, cwd);
    } catch { /* ack/sentinel remains a durable fallback fence */ }
    return {
      run_id: runId,
      action: 'health_check_unverified',
      reason: 'post_crossing_contract_anomaly: accepted contract ref differs or is missing; convergence withheld and respawn=false',
      evidence,
      previous_status,
      current_status: run.status,
    };
  }

  // pln#630 PR2c-lease (§4 + R5): a turn-owned run preallocated `created`/
  // `launching` converges on its DISPATCH/LAUNCH LEASE, not the pid/heartbeat
  // heuristics below (which assume a worker already spawned and can emit
  // life-signs). Delegate before the generic evidence path so these runs never
  // orphan `created`/`launching` forever. Inert for non-turn-owned runs
  // (evidence.turn_owned=false → fall through to the unchanged generic path).
  if ((run.status === 'created' || run.status === 'launching') && evidence.turn_owned) {
    const reservation = findReservationByRunId(run.id, cwd);
    if (reservation) {
      return reconcileTurnOwnedPreRunLease(run, reservation, evidence, cwd, options);
    }
  }

  const grace = options.healthCheckGraceMs ?? DEFAULT_HEALTH_CHECK_GRACE_MS;
  const stale = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  // Below grace window: too early to draw any conclusion. Caller should
  // re-poll later.
  if (evidence.age_ms < grace) {
    return {
      run_id: runId, action: 'no_op', reason: `under grace window (${grace}ms)`,
      evidence, previous_status, current_status: run.status,
    };
  }

  // Recovery: any completion evidence outside the grace window → infer success.
  if (anyCompletionEvidence(evidence)) {
    try {
      transitionAgentRun(runId, 'completed', {
        actor,
        status_reason: `inferred=true; evidence: ${describeEvidence(evidence)}`,
      }, cwd);
      return {
        run_id: runId, action: 'inferred_completed',
        reason: `inferred=true; ${describeEvidence(evidence)}`,
        evidence, previous_status, current_status: 'completed',
      };
    } catch (err) {
      // Transition might fail if the run is no longer in a transitionable
      // state (race with explicit completion). Treat as no-op.
      return {
        run_id: runId, action: 'no_op',
        reason: `transition rejected: ${err instanceof Error ? err.message : String(err)}`,
        evidence, previous_status, current_status: run.status,
      };
    }
  }

  // pln#520 step 1 — sentinel-based failure (fast + trustworthy, pid-independent).
  const heartbeatStale = options.heartbeatStaleMs ?? DEFAULT_HEARTBEAT_STALE_MS;
  const failHere = (reason: string): ReconcileResult => {
    try {
      transitionAgentRun(runId, 'failed', { actor, status_reason: reason }, cwd);
      cascadeReleaseOnFailure(run, actor, cwd, 'failed', reason);
      return { run_id: runId, action: 'inferred_failed', reason, evidence, previous_status, current_status: 'failed' };
    } catch (err) {
      return {
        run_id: runId, action: 'no_op',
        reason: `failure transition rejected: ${err instanceof Error ? err.message : String(err)}`,
        evidence, previous_status, current_status: run.status,
      };
    }
  };

  // `failed` sentinel — the wrapper saw a non-zero agent exit.
  if (evidence.failed_signal) {
    return failHere(`failed_silent: wrapper reported non-zero exit${logTailSuffix(run, cwd)}`);
  }
  // Heartbeat present but stale → reached the loop then went silent — UNLESS the
  // filesystem shows recent activity (pln#527): a frozen heartbeat with fresh
  // log/worktree writes means the worker is mid-operation, not hung.
  if (evidence.heartbeat_exists && evidence.heartbeat_age_ms !== undefined && evidence.heartbeat_age_ms >= heartbeatStale) {
    if (fsActiveWithin(evidence, heartbeatStale)) {
      return {
        run_id: runId, action: 'no_op',
        reason: `heartbeat stale (${Math.round(evidence.heartbeat_age_ms / 1000)}s) but fs active ${Math.round((evidence.fs_activity_age_ms ?? 0) / 1000)}s ago — working, not stalled`,
        evidence, previous_status, current_status: run.status,
      };
    }
    return failHere(`stalled: heartbeat last seen ${Math.round(evidence.heartbeat_age_ms / 1000)}s ago, no fs activity${logTailSuffix(run, cwd)}`);
  }
  // Fresh heartbeat → alive; trust it over the untrustworthy wrapper pid.
  if (evidence.heartbeat_exists) {
    return {
      run_id: runId, action: 'no_op',
      reason: `heartbeat fresh (${Math.round((evidence.heartbeat_age_ms ?? 0) / 1000)}s) — worker alive, pid untrusted`,
      evidence, previous_status, current_status: run.status,
    };
  }

  // Failure inference: stale + dead process + no evidence.
  if (evidence.age_ms >= stale && evidence.process_alive === false) {
    return failHere('silent_termination_no_evidence');
  }

  // Health-check window: past grace, not yet stale, no evidence either way.
  // Emit a non-mutating event so callers see the uncertainty without
  // forcing a transition based on incomplete data.
  emitUnverifiedEvent(run, evidence, actor, cwd);
  return {
    run_id: runId, action: 'health_check_unverified',
    reason: `delivered_but_unverified (age=${Math.round(evidence.age_ms / 1000)}s, process_alive=${evidence.process_alive})`,
    evidence, previous_status, current_status: run.status,
  };
}

/**
 * pln#630 PR2c-lease (§4 + R5) — converge a TURN-OWNED run still in `created`/
 * `launching` against its dispatch/launch LEASE, not the pid/heartbeat heuristics
 * (which presuppose a spawned, life-sign-emitting worker). Reached only from
 * `reconcileAgentRun`'s turn-owned delegate branch, so it always has the owning
 * reservation + pre-collected evidence.
 *
 * Outcomes (never `completed` — no phantom success from an unspawned/unproven run):
 *   - turn-keyed completion present → NO-OP (finalization is reconcileTurn's job, PR3);
 *   - within lease → NO-OP (the worker may yet cross the launch fence / start);
 *   - past lease + launch grant CROSSED → `failed` / `launch_attempted_unknown`
 *     (the worker WAS invoked; its outcome is unknowable, so it must not complete);
 *   - past launch lease + grant not crossed, while dispatch lease is live →
 *     revoke and retain the non-terminal run for re-arm;
 *   - past dispatch lease + grant not crossed → `cancelled` /
 *     `reserved_never_launched` (the recovery window is exhausted).
 */
function reconcileTurnOwnedPreRunLease(
  run: AgentRun,
  reservation: TurnReservation,
  evidence: ReconcileEvidence,
  cwd: string | undefined,
  options: ReconcileOptions,
): ReconcileResult {
  const now = options.nowMs ?? Date.now();
  const actor = options.actor ?? 'reconciler';
  const previous_status = run.status;

  // A genuine turn-keyed completion is NOT an expiry: never fail/cancel a run
  // that produced accepted evidence. Its finalization (assignment/claim/artifacts)
  // is reconcileTurn's responsibility (PR3); here we simply decline to expire it.
  if (evidence.turn_keyed_completed) {
    return {
      run_id: run.id, action: 'no_op',
      reason: 'turn-keyed completion present — defer finalization to reconcileTurn',
      evidence, previous_status, current_status: run.status,
    };
  }

  // Effective deadline: once armed, the launch lease is the tighter authoritative
  // bound; before arm, the dispatch lease bounds how long a committed reservation
  // may wait to spawn. A non-parseable lease cannot expire a run (fail-safe: leave
  // it for explicit reconcile rather than converge on garbage).
  const leaseISO = reservation.launch?.lease_deadline ?? reservation.lease_deadline;
  const leaseMs = Date.parse(leaseISO);
  if (!Number.isFinite(leaseMs) || now < leaseMs) {
    return {
      run_id: run.id, action: 'no_op',
      reason: Number.isFinite(leaseMs)
        ? `within lease (deadline ${leaseISO})`
        : `lease deadline unparseable (${leaseISO}) — cannot expire`,
      evidence, previous_status, current_status: run.status,
    };
  }

  // Past lease, no accepted completion — the launch-grant status (authoritative,
  // decision-file reconciled) decides the terminal.
  let grant = launchGrant(reservation.turn_id, cwd);
  let crossed = grant?.status === 'crossed';
  // pln#630 dec#149 R1 (review Finding 2) — make the reserved_never_launched strand REACHABLE
  // through the WIRED lazy reconciler: revoke the still-armed grant so its authoritative status
  // becomes `revoked`. That is what lets reconcileTurn's fix-cycle strand detector see the strand
  // and re-emit, and lets the re-dispatch re-arm a fresh generation (dec#149 R1). Idempotent +
  // best-effort: a race to crossed/revoked is fine (the decision file governs) and must never
  // block the run's terminal transition below.
  if (!crossed && grant?.status === 'armed') {
    try { revokeLaunchGrant(reservation.turn_id, grant.epoch, 'reserved_never_launched', cwd, actor); }
    catch { /* raced to crossed/revoked — authoritative status governs */ }
    grant = launchGrant(reservation.turn_id, cwd);
    crossed = grant?.status === 'crossed';
  }

  if (evidence.contract_acceptance_anomaly) {
    try {
      recordExecutionContractAnomaly(run.id, {
        source: 'reconciler',
        reason: 'bootstrap or terminal evidence did not accept the immutable execution contract',
      }, cwd);
    } catch { /* ack/sentinel remains a durable fallback fence */ }
    return {
      run_id: run.id,
      action: 'health_check_unverified',
      reason: 'post_crossing_contract_anomaly: accepted contract ref differs or is missing; convergence withheld and respawn=false',
      evidence,
      previous_status,
      current_status: run.status,
    };
  }
  const targetStatus: AgentRunStatus = crossed ? 'failed' : 'cancelled';
  const action: ReconcileAction = crossed ? 'inferred_failed' : 'inferred_cancelled';
  const reason = crossed
    ? `launch_attempted_unknown: launch grant crossed but run never reached running by lease ${leaseISO} — outcome unknown, never completed`
    : `reserved_never_launched: no launch receipt by lease ${leaseISO} (grant=${grant?.status ?? 'none'})`;
  const dispatchLeaseMs = Date.parse(reservation.lease_deadline);
  const dispatchLeaseLive = Number.isFinite(dispatchLeaseMs) && now < dispatchLeaseMs;
  if (!crossed && dispatchLeaseLive) {
    return {
      run_id: run.id,
      action: 'no_op',
      reason: `${reason}; retained non-terminal for re-arm until dispatch lease ${reservation.lease_deadline}`,
      evidence,
      previous_status,
      current_status: run.status,
    };
  }
  try {
    transitionAgentRun(run.id, targetStatus, { actor, status_reason: reason }, cwd);
    cascadeReleaseOnFailure(run, actor, cwd, targetStatus, reason);
    return { run_id: run.id, action, reason, evidence, previous_status, current_status: targetStatus };
  } catch (err) {
    return {
      run_id: run.id, action: 'no_op',
      reason: `lease-expiry transition rejected: ${err instanceof Error ? err.message : String(err)}`,
      evidence, previous_status, current_status: run.status,
    };
  }
}

/**
 * Read-path reconciliation for a `running` run whose tracked PID reads dead.
 *
 * IMPORTANT (pln#520): the tracked PID is NOT trustworthy. On Windows the
 * ack-wrap spawn (shell:true) records the cmd.exe wrapper PID, not the real
 * worker (cmd.exe -> claude.cmd -> node.exe), so a dead PID does NOT prove the
 * worker died — empirically, 6 workers were cancelled here yet committed their
 * work 4-7 min later. This function therefore NEVER cancels prematurely:
 *   - work evidence (commit / claim released / assignment completed)
 *     -> inferred `completed`;
 *   - past the stale threshold with a dead pid and still no evidence
 *     -> inferred `failed` (silent_termination_no_evidence). This MUST converge
 *     HERE: the canonical read path (entity-operations.ts) and the MCP pre-read
 *     sweep route `running` runs through THIS function, never through
 *     reconcileAgentRun, so deferring would leave a crashed run `running`
 *     forever (the trp#292 pattern);
 *   - otherwise (young, dead pid, no evidence yet) -> non-mutating health-check,
 *     leaving the run `running` so a worker behind an untrusted pid keeps its
 *     fair chance.
 * Net vs pre-pln#520: a genuine silent death converges to `failed` after the
 * stale window instead of an immediate (often false) `cancelled`.
 */
export function reconcileDeadPidRunningAgentRunAtRead(runId: string, cwd?: string, options: ReconcileOptions = {}): ReconcileResult {
  const run = loadAgentRun(runId, cwd);
  if (!run) {
    const evidence: ReconcileEvidence = {
      age_ms: 0, has_post_start_commit: false, claim_released: false,
      assignment_completed: false, process_alive: undefined,
      completed_signal: false, failed_signal: false, heartbeat_exists: false, turn_owned: false, turn_keyed_completed: false, contract_acceptance_anomaly: false,
    };
    return {
      run_id: runId, action: 'no_op', reason: 'run not found', evidence,
      previous_status: 'created' as AgentRunStatus, current_status: 'created' as AgentRunStatus,
    };
  }

  const evidence = collectEvidence(run, cwd, { nowMs: options.nowMs });
  const actor = options.actor ?? 'reconciler';
  const laneResult = reconcileOwnedLaneResultAtRead(run, evidence, cwd, actor);
  if (laneResult) return laneResult;
  if (run.status !== 'running') {
    return {
      run_id: run.id, action: 'no_op', reason: `run status is ${run.status}, not running`,
      evidence, previous_status: run.status, current_status: run.status,
    };
  }

  const stale = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const heartbeatStale = options.heartbeatStaleMs ?? DEFAULT_HEARTBEAT_STALE_MS;

  const failRun = (reason: string): ReconcileResult => {
    try {
      transitionAgentRun(run.id, 'failed', { actor, status_reason: reason }, cwd);
      cascadeReleaseOnFailure(run, actor, cwd, 'failed', reason);
      return { run_id: run.id, action: 'inferred_failed', reason, evidence, previous_status: run.status, current_status: 'failed' };
    } catch (err) {
      return {
        run_id: run.id, action: 'no_op',
        reason: `failure transition rejected: ${err instanceof Error ? err.message : String(err)}`,
        evidence, previous_status: run.status, current_status: run.status,
      };
    }
  };

  // ── pln#520 step 1: SENTINELS are authoritative, independent of the
  // untrustworthy wrapper pid. Check them first. ──────────────────────────

  // 1. Completion evidence (mechanical `completed` sentinel or work evidence).
  if (anyCompletionEvidence(evidence)) {
    try {
      transitionAgentRun(run.id, 'completed', {
        actor,
        status_reason: `inferred=true; evidence: ${describeEvidence(evidence)}`,
      }, cwd);
      return {
        run_id: run.id, action: 'inferred_completed',
        reason: `inferred=true; ${describeEvidence(evidence)}`,
        evidence, previous_status: run.status, current_status: 'completed',
      };
    } catch (err) {
      return {
        run_id: run.id, action: 'no_op',
        reason: `completion transition rejected: ${err instanceof Error ? err.message : String(err)}`,
        evidence, previous_status: run.status, current_status: run.status,
      };
    }
  }

  // 2. `failed` sentinel — the wrapper saw a non-zero agent exit. This is the
  // FAST, TRUSTWORTHY failed_silent detector (vs the pid heuristic that caused
  // can_f792cacd false negatives). Carries the captured log tail.
  if (evidence.failed_signal) {
    return failRun(`failed_silent: wrapper reported non-zero exit${logTailSuffix(run, cwd)}`);
  }

  // 3. Heartbeat present but STALE → the worker reached its loop then went
  // silent (e.g. hung). pid-independent: a hung worker keeps the wrapper alive.
  if (evidence.heartbeat_exists && evidence.heartbeat_age_ms !== undefined && evidence.heartbeat_age_ms >= heartbeatStale) {
    if (fsActiveWithin(evidence, heartbeatStale)) {
      return {
        run_id: run.id, action: 'no_op',
        reason: `heartbeat stale (${Math.round(evidence.heartbeat_age_ms / 1000)}s) but fs active ${Math.round((evidence.fs_activity_age_ms ?? 0) / 1000)}s ago — working, not stalled`,
        evidence, previous_status: run.status, current_status: run.status,
      };
    }
    return failRun(`stalled: heartbeat last seen ${Math.round(evidence.heartbeat_age_ms / 1000)}s ago, no fs activity${logTailSuffix(run, cwd)}`);
  }

  // 4. Fresh heartbeat → the worker is alive and working; trust it OVER the
  // (untrustworthy) wrapper pid. This is the can_f792cacd fix: never fail a
  // live, heartbeating worker just because its wrapper pid reads dead.
  if (evidence.heartbeat_exists) {
    return {
      run_id: run.id, action: 'no_op',
      reason: `heartbeat fresh (${Math.round((evidence.heartbeat_age_ms ?? 0) / 1000)}s) — worker alive, pid untrusted`,
      evidence, previous_status: run.status, current_status: run.status,
    };
  }

  // ── No sentinel, no heartbeat: fall back to the pid-conservative path. The
  // wrapper writes completed/failed on any normal exit, so reaching here means
  // the worker has not exited and never heartbeat. Do NOT fast-fail on a dead
  // pid (it's the wrapper's, not the worker's). ──────────────────────────────
  if (evidence.process_alive !== false) {
    return {
      run_id: run.id, action: 'no_op',
      reason: evidence.process_alive === true ? 'process alive' : 'pid liveness unknown',
      evidence, previous_status: run.status, current_status: run.status,
    };
  }

  // pid dead + no sentinel + no heartbeat: only converge after the long stale
  // window (trp#292 — must converge HERE since the read path never routes
  // through reconcileAgentRun), giving an untrusted-pid worker ample time.
  if (evidence.age_ms >= stale) {
    if (fsActiveWithin(evidence, heartbeatStale)) {
      return {
        run_id: run.id, action: 'no_op',
        reason: `no heartbeat but fs active ${Math.round((evidence.fs_activity_age_ms ?? 0) / 1000)}s ago - working, not silent`,
        evidence, previous_status: run.status, current_status: run.status,
      };
    }
    return failRun('silent_termination_no_evidence');
  }

  emitUnverifiedEvent(run, evidence, actor, cwd);
  return {
    run_id: run.id, action: 'health_check_unverified',
    reason: `pid_dead_untrusted_no_evidence (age=${Math.round(evidence.age_ms / 1000)}s) — awaiting evidence or stale window`,
    evidence, previous_status: run.status, current_status: run.status,
  };
}

export function sweepDeadPidRunningAgentRunsAtRead(cwd?: string, options: ReconcileOptions = {}): ReconcileResult[] {
  const now = options.nowMs ?? Date.now();
  const minAgeMs = options.deadPidSweepCandidateAgeMs ?? DEFAULT_DEAD_PID_READ_SWEEP_AGE_MS;
  const cutoff = now - minAgeMs;
  const limit = options.limit ?? DEFAULT_DEAD_PID_READ_SWEEP_LIMIT;
  const candidates = listAgentRuns(cwd, { status: 'running' })
    .filter((run) => {
      const lastEventAt = run.last_event_at ?? run.started_at ?? run.created_at;
      const ts = new Date(lastEventAt).getTime();
      return Number.isFinite(ts) && ts <= cutoff;
    })
    .sort((left, right) => {
      const leftTs = new Date(left.last_event_at ?? left.started_at ?? left.created_at).getTime();
      const rightTs = new Date(right.last_event_at ?? right.started_at ?? right.created_at).getTime();
      return rightTs - leftTs;
    })
    .slice(0, limit);
  return candidates.map((run) => reconcileDeadPidRunningAgentRunAtRead(run.id, cwd, options));
}

/**
 * pln#630 PR2c-lease — lazy read-path sweep for TURN-OWNED runs still in
 * `created`/`launching`, converging them on their dispatch/launch lease via
 * `reconcileAgentRun`'s turn-owned delegate. Strictly turn-owned: a legacy
 * (non-reservation-owned) `created`/`launching` run is SKIPPED here, so this
 * sweep changes nothing for existing runs and is fully inert until live
 * turn-owned dispatch (PR2c-b) mints such a run. Errors are isolated per run.
 */
export function sweepTurnOwnedPreRunLeaseAtRead(cwd?: string, options: ReconcileOptions = {}): ReconcileResult[] {
  const results: ReconcileResult[] = [];
  for (const status of ['created', 'launching'] as AgentRunStatus[]) {
    for (const run of listAgentRuns(cwd, { status })) {
      // Only turn-owned runs converge on the lease here — legacy runs keep their
      // existing (non-read-path) reconciliation route untouched.
      if (!findReservationByRunId(run.id, cwd)) continue;
      try {
        results.push(reconcileAgentRun(run.id, cwd, options));
      } catch { /* best-effort — never block reads on reconciliation errors */ }
    }
  }
  return results;
}

/**
 * Reconcile every non-terminal agent_run matching `filter`. Useful for
 * batch sweeps from `bclaw_assignment_events` or `brainclaw doctor --dispatch`.
 * Errors per-run are isolated — one bad run does not abort the sweep.
 */
export function reconcileAllOpenRuns(
  cwd?: string,
  filter: Omit<ListAgentRunsFilter, 'status'> = {},
  options: ReconcileOptions = {},
): ReconcileResult[] {
  const results: ReconcileResult[] = [];
  // Run statuses we consider open / candidates for reconciliation.
  const OPEN: AgentRunStatus[] = ['created', 'launching', 'waiting_input', 'running', 'blocked'];
  for (const status of OPEN) {
    const runs = listAgentRuns(cwd, { ...filter, status });
    for (const run of runs) {
      try {
        results.push(reconcileAgentRun(run.id, cwd, options));
      } catch {
        results.push({
          run_id: run.id, action: 'no_op', reason: 'reconcile threw — skipped',
          evidence: { age_ms: 0, has_post_start_commit: false, claim_released: false, assignment_completed: false, process_alive: undefined, completed_signal: false, failed_signal: false, heartbeat_exists: false, turn_owned: false, turn_keyed_completed: false, contract_acceptance_anomaly: false },
          previous_status: run.status, current_status: run.status,
        });
      }
    }
  }
  return results;
}

// Re-export key helpers for tests.
export { TERMINAL_STATUSES };
export type { AgentRunStatus };

export const __testing = {
  describeEvidence,
  anyCompletionEvidence,
} as const;

void nowISO; // placeholder to keep import alive if a future refactor needs it
