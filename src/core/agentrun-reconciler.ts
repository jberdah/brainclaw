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
import path from 'node:path';
import { loadAgentRun, transitionAgentRun, type ListAgentRunsFilter, listAgentRuns } from './agentruns.js';
import { loadClaim } from './claims.js';
import { loadAssignment } from './assignments.js';
import { createRuntimeEvent } from './events.js';
import { nowISO } from './ids.js';
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

const TERMINAL_STATUSES: ReadonlySet<AgentRunStatus> = new Set([
  'completed', 'failed', 'cancelled', 'timed_out', 'interrupted',
]);

// ── Public types ───────────────────────────────────────────────────────────

export type ReconcileAction =
  | 'no_op'
  | 'health_check_unverified'
  | 'inferred_completed'
  | 'inferred_failed'
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
  /** Override the wall clock for deterministic tests. */
  nowMs?: number;
  /** Actor name recorded on synthetic transitions / events. Default 'reconciler'. */
  actor?: string;
  /** Cap for dead-pid read sweeps. */
  limit?: number;
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

  return { age_ms, has_post_start_commit, claim_released, assignment_completed, process_alive };
}

function anyCompletionEvidence(evidence: ReconcileEvidence): boolean {
  return evidence.has_post_start_commit
    || evidence.claim_released
    || evidence.assignment_completed;
}

function describeEvidence(evidence: ReconcileEvidence): string {
  const reasons: string[] = [];
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

function emitUnverifiedEvent(run: AgentRun, evidence: ReconcileEvidence, actor: string, cwd?: string): void {
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
    };
    return {
      run_id: runId, action: 'no_op', reason: 'run not found', evidence,
      previous_status: 'created' as AgentRunStatus, current_status: 'created' as AgentRunStatus,
    };
  }

  const previous_status = run.status;
  const evidence = collectEvidence(run, cwd, { nowMs: options.nowMs });

  // Never touch terminal runs — they already converged.
  if (TERMINAL_STATUSES.has(run.status)) {
    return {
      run_id: runId, action: 'no_op', reason: `run already terminal (${run.status})`,
      evidence, previous_status, current_status: run.status,
    };
  }

  const grace = options.healthCheckGraceMs ?? DEFAULT_HEALTH_CHECK_GRACE_MS;
  const stale = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const actor = options.actor ?? 'reconciler';

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

  // Failure inference: stale + dead process + no evidence.
  if (evidence.age_ms >= stale && evidence.process_alive === false) {
    try {
      transitionAgentRun(runId, 'failed', {
        actor,
        status_reason: 'silent_termination_no_evidence',
      }, cwd);
      return {
        run_id: runId, action: 'inferred_failed',
        reason: 'silent_termination_no_evidence',
        evidence, previous_status, current_status: 'failed',
      };
    } catch (err) {
      return {
        run_id: runId, action: 'no_op',
        reason: `failure transition rejected: ${err instanceof Error ? err.message : String(err)}`,
        evidence, previous_status, current_status: run.status,
      };
    }
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

export function reconcileDeadPidRunningAgentRunAtRead(runId: string, cwd?: string, options: ReconcileOptions = {}): ReconcileResult {
  const run = loadAgentRun(runId, cwd);
  if (!run) {
    const evidence: ReconcileEvidence = {
      age_ms: 0, has_post_start_commit: false, claim_released: false,
      assignment_completed: false, process_alive: undefined,
    };
    return {
      run_id: runId, action: 'no_op', reason: 'run not found', evidence,
      previous_status: 'created' as AgentRunStatus, current_status: 'created' as AgentRunStatus,
    };
  }

  const evidence = collectEvidence(run, cwd, { nowMs: options.nowMs });
  if (run.status !== 'running') {
    return {
      run_id: run.id, action: 'no_op', reason: `run status is ${run.status}, not running`,
      evidence, previous_status: run.status, current_status: run.status,
    };
  }
  if (evidence.process_alive !== false) {
    return {
      run_id: run.id, action: 'no_op',
      reason: evidence.process_alive === true ? 'process alive' : 'pid liveness unknown',
      evidence, previous_status: run.status, current_status: run.status,
    };
  }

  try {
    transitionAgentRun(run.id, 'cancelled', {
      actor: options.actor ?? 'reconciler',
      status_reason: 'pid_dead_at_read',
    }, cwd);
    return {
      run_id: run.id, action: 'cancelled_dead_pid', reason: 'pid_dead_at_read',
      evidence, previous_status: run.status, current_status: 'cancelled',
    };
  } catch (err) {
    return {
      run_id: run.id, action: 'no_op',
      reason: `cancel transition rejected: ${err instanceof Error ? err.message : String(err)}`,
      evidence, previous_status: run.status, current_status: run.status,
    };
  }
}

export function sweepDeadPidRunningAgentRunsAtRead(cwd?: string, options: ReconcileOptions = {}): ReconcileResult[] {
  const now = options.nowMs ?? Date.now();
  const minAgeMs = options.staleAfterMs ?? DEFAULT_DEAD_PID_READ_SWEEP_AGE_MS;
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
          evidence: { age_ms: 0, has_post_start_commit: false, claim_released: false, assignment_completed: false, process_alive: undefined },
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
