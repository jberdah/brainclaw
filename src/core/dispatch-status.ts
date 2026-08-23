/**
 * Consolidated dispatch status (pln#503 phase 3.1).
 *
 * Resolves a single dispatch reference (`asgn_…`, `clm_…`, `lop_…`, `run_…`)
 * into the full set of linked entities — assignment, claim, loop, agent_run —
 * plus on-disk artefacts (brief-ack sentinel, stdout/stderr logs) and a
 * pid-liveness check, then computes a health verdict + a recommended next
 * action for the caller.
 *
 * The motivating use case: an agent who just called `bclaw_coordinate` and
 * got `execution_status: "delivered_and_started"` should be able to verify
 * the dispatch is alive without running five separate `bclaw_find` calls.
 * The `verify_with` hint added in phase 3.3 already points callers at this
 * tool by name.
 *
 * See docs/concepts/dispatch-lifecycle.md for the full entity-relationship
 * and FSM model.
 *
 * @module
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadAssignment, listAssignments } from './assignments.js';
import { logger } from './logger.js';
import { loadAgentRun, listAgentRuns } from './agentruns.js';
import { loadClaim } from './claims.js';
import { getLoop, listLoops } from './loops/store.js';
import { isProcessAlive } from './agentrun-reconciler.js';
import { findRuntimeNoteById } from './runtime.js';
import { latestActivityMs, decodeOemAwareBuffer, getRuntimeLogPath, getRuntimeSignalPath } from './runtime-signals.js';
import { currentAttemptRunIdForAssignment } from './loops/attempt-reservation.js';
import { LaneResultSchema } from './schema.js';
import type { Assignment, AgentRun, Claim } from './schema.js';
import type { LoopThread } from './loops/types.js';

export type ResolvedFrom =
  | 'assignment_id'
  | 'claim_id'
  | 'loop_id'
  | 'run_id'
  | 'unresolved';

export type DispatchHealth =
  | 'healthy'           // run.status=running, pid alive, recent activity
  | 'stalled'           // run.status=running, pid alive, no progress for a while
  | 'silent_death'      // run.status=running, pid dead, lazy reconciler hasn't caught up
  | 'terminal'          // run.status ∈ {completed, failed, cancelled, interrupted, timed_out}
  | 'not_dispatched'    // assignment exists but no agent_run yet (offered, not started)
  | 'unknown';          // could not resolve target_id to anything useful

export interface LogFileSnapshot {
  /** Absolute path on disk. */
  path: string;
  /** File exists. */
  exists: boolean;
  /** Size in bytes (0 when missing). */
  size_bytes: number;
  /** Last N lines (default 20). Omitted when the file does not exist. */
  tail?: string[];
}

export interface DispatchRuntimeSnapshot {
  pid: number | undefined;
  /** true=alive, false=dead, undefined=cannot determine (no pid tracked). */
  pid_alive: boolean | undefined;
  ack_file: { exists: boolean; path: string | undefined };
  log_files: {
    stdout: LogFileSnapshot | undefined;
    stderr: LogFileSnapshot | undefined;
  };
  /**
   * pln#527 — age (ms) of the most recent filesystem activity (max mtime across
   * logs + worktree files). A small value means the worker is doing real work
   * even when its heartbeat / last_event_at is stale. undefined when unobservable.
   */
  last_fs_activity_ms?: number;
  /**
   * pln#532 — the worker's LANE-RESULT.json (if present at the worktree root).
   * This is the #1 verdict signal: a worker that wrote it has FINISHED, even when
   * it could not self-update the agent_run (sandboxed). undefined when absent.
   *
   * trp_e824d2af: only a lane result whose OWN assignment_id matches the target
   * assignment lands here. A reused worktree keeps the PRIOR turn's file at the
   * root, and reading it unmatched declared a freshly-spawned round 2 "worker
   * reported done" with round 1's verdict.
   */
  lane_result?: { status: string; summary: string };
  /**
   * trp_e824d2af — a LANE-RESULT.json found at the worktree root that belongs
   * to a DIFFERENT assignment (a prior turn in a reused worktree). Surfaced for
   * observability, NEVER treated as a terminal signal for this dispatch.
   */
  lane_result_stale?: { assignment_id: string; status: string; summary: string };
  /**
   * pln#554 + trp#926 — commits on the lane branch ahead of the base ref, but
   * refined via patch-id: a squash-merged commit whose patch is already on
   * base counts as 0, not 1 — the fix for the observed `worker delivered`
   * false-positive after squash-merge (rtn_c5542b05). Base ref is the
   * worktree's recorded creation SHA when the sidecar carries one. Legacy
   * sidecars without that SHA report unknown instead of falling back to moving
   * `master`.
   */
  commits_ahead?: number;
  /**
   * trp#926 — the ancestry-only count preserved for callers that need the raw
   * `<base>..HEAD` number (telemetry, diff drivers). `commits_ahead` is the
   * squash-aware refinement — use it for verdicts.
   */
  commits_ahead_raw?: number;
  /**
   * trp#926 — the base ref actually used for the ahead computation. Reflects
   * the sidecar's recorded creation SHA when present. Emitted so a diagnosis
   * reader can see WHY commits_ahead is what it is (comparison to creation ref
   * vs. current master). Omitted for legacy sidecars whose creation ref is
   * unknown.
   */
  commits_ahead_base?: string;
  /**
   * pln#554 — modified TRACKED files in the worktree (`git status --short`
   * minus untracked). commits_ahead>0 with dirty_tracked==0 means the worker
   * delivered everything to the branch. undefined when unobservable.
   */
  dirty_tracked?: number;
}

export interface DispatchDiagnosis {
  health: DispatchHealth;
  summary: string;
  /**
   * Concrete next step for the caller — what to read, what to ack, who to
   * notify. Should be actionable in one sentence.
   */
  recommended_next_action: string;
}

export interface DispatchStatus {
  target_id: string;
  resolved_from: ResolvedFrom;
  entities: {
    assignment_id: string | undefined;
    claim_id: string | undefined;
    loop_id: string | undefined;
    run_id: string | undefined;
  };
  assignment: Assignment | undefined;
  claim: Claim | undefined;
  loop: LoopThread | undefined;
  agent_run: AgentRun | undefined;
  runtime: DispatchRuntimeSnapshot;
  diagnosis: DispatchDiagnosis;
}

export interface DispatchStatusOptions {
  target_id: string;
  cwd?: string;
  /** How many trailing lines of each log file to include. Default 20, 0 = none. */
  tail_log_lines?: number;
  /** Age in ms past which an idle running run is considered stalled. Default 5min. */
  stall_threshold_ms?: number;
  /** Base ref for the worktree git-evidence comparison. Default 'master'. */
  base_ref?: string;
  /** Override wall clock for deterministic tests. */
  nowMs?: number;
}

const DEFAULT_TAIL = 20;
const DEFAULT_STALL_MS = 5 * 60_000;
const DEFAULT_BASE_REF = 'master';

/**
 * trp#926 — read the worktree's recorded creation ref (SHA) from its brainclaw
 * sidecar so gitEvidence can measure "commits the worker added" against the
 * anchor the worktree was BORN at, not the caller's moving default (which is
 * usually `master`). Comparing to master after master advanced was the
 * observed false-positive on rtn_c5542b05: lane HEAD's commits still appeared
 * "ahead of master" long after they were squash-merged, so dispatch_status
 * reported "worker delivered" for a fully integrated lane.
 *
 * Returns the SHA when the sidecar records `base_ref_sha`. A legacy sidecar
 * without that field means "unknown": falling back to the caller's moving
 * `master` would recreate the false `worker delivered` signal this fixes.
 */
function readWorktreeBaseRef(worktreePath: string): { ref?: string; legacySidecar: boolean } {
  const sidecar = path.join(worktreePath, '.brainclaw-worktree.json');
  try {
    const meta = JSON.parse(fs.readFileSync(sidecar, 'utf-8')) as { base_ref_sha?: unknown };
    if (typeof meta.base_ref_sha === 'string' && meta.base_ref_sha.length > 0) {
      return { ref: meta.base_ref_sha, legacySidecar: false };
    }
    return { legacySidecar: true };
  } catch {
    return { legacySidecar: fs.existsSync(sidecar) };
  }
}

function aggregateChangesMatchIntegrationBase(
  worktreePath: string,
  creationBase: string,
  integrationBase: string,
): boolean {
  try {
    const changed = execFileSync('git', ['-C', worktreePath, 'diff', '--name-only', '-z', creationBase, 'HEAD'], {
      encoding: 'utf-8', timeout: 15000,
    });
    const paths = changed.split('\0').filter(Boolean);
    if (paths.length === 0) return true;
    for (let i = 0; i < paths.length; i += 100) {
      const chunk = paths.slice(i, i + 100);
      execFileSync('git', ['-C', worktreePath, 'diff', '--quiet', 'HEAD', integrationBase, '--', ...chunk], {
        encoding: 'utf-8', timeout: 15000,
      });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * pln#554 + trp#926 — worktree git evidence, the signal that beats process /
 * administrative status: a worker that committed everything to its lane branch
 * has DELIVERED, whatever its pid/heartbeat/assignment.status say. Shared by
 * dispatch-status and `brainclaw dispatch watch`. Returns undefined when there
 * is no worktree or git could not be queried (never conclude "no commits" from
 * a failed read).
 *
 * The comparison anchor is:
 *   1. the worktree sidecar's recorded creation SHA (`base_ref_sha`) — the
 *      truthful anchor a worker was born at;
 *   2. otherwise `commits_ahead_base` (caller-supplied, default `master`) ONLY
 *      when there is no brainclaw sidecar at all (plain/non-brainclaw git
 *      evidence callers).
 * A legacy sidecar without `base_ref_sha` returns undefined. That is deliberate:
 * unknown is safer than silently comparing to a moving `master`.
 * Anchoring on the creation ref is what avoids the "worker delivered"
 * false-positive after a squash-merge advanced master.
 *
 * Additionally, `commitsAhead` is refined via `git cherry <base> HEAD`
 * (patch-id): a commit whose patch is already on `base` is treated as
 * integrated even if its SHA is not an ancestor of `base` (squash-merge case).
 * `commitsAheadRaw` preserves the historical ancestry-only count for callers /
 * telemetry that need it.
 */
export function gitEvidence(
  worktreePath: string | undefined,
  baseRef: string,
): { commitsAhead: number; commitsAheadRaw: number; dirtyTracked: number; baseRef: string } | undefined {
  if (!worktreePath) return undefined;
  // Two DIFFERENT anchors:
  //   - creationBase: sidecar `base_ref_sha`, else caller `baseRef` for
  //     non-brainclaw paths only. A legacy sidecar without the SHA is unknown.
  //     stable anchor for "how much did the worker add?" (raw ahead count).
  //   - integrationBase: caller `baseRef` (default `master`) — the moving
  //     integration target the patch-id refinement compares against ("still
  //     un-integrated?"). Using the creation SHA here would falsely count a
  //     squash-merged commit as un-integrated (its patch is on master, but
  //     master isn't the creation ref).
  const recordedBase = readWorktreeBaseRef(worktreePath);
  if (recordedBase.legacySidecar && !recordedBase.ref) {
    logger.debug('dispatch status: git evidence unavailable: legacy worktree sidecar lacks base_ref_sha');
    return undefined;
  }
  const creationBase = recordedBase.ref ?? baseRef;
  const integrationBase = baseRef;
  try {
    const aheadRaw = execFileSync('git', ['-C', worktreePath, 'rev-list', '--count', `${creationBase}..HEAD`], {
      encoding: 'utf-8', timeout: 15000,
    }).trim();
    const status = execFileSync('git', ['-C', worktreePath, 'status', '--short'], {
      encoding: 'utf-8', timeout: 15000,
    });
    const dirty = status.split('\n').filter((l) => l.trim() && !l.startsWith('??')).length;
    const rawCount = Number.parseInt(aheadRaw, 10) || 0;
    // Patch-id refinement against the INTEGRATION base: `git cherry` marks
    // each commit in `base..HEAD` as `-` (patch on base — squash-merged /
    // cherry-picked) or `+` (still un-integrated). Refined count = `+` lines.
    // Best-effort — a failed cherry falls back to the raw ancestry count.
    let refined = rawCount;
    if (rawCount > 0) {
      try {
        const cherry = execFileSync('git', ['-C', worktreePath, 'cherry', integrationBase, 'HEAD'], {
          encoding: 'utf-8', timeout: 15000,
        });
        const plusLines = cherry.split(/\r?\n/).filter((l) => l.startsWith('+ '));
        refined = plusLines.length;
        if (refined > 0 && aggregateChangesMatchIntegrationBase(worktreePath, creationBase, integrationBase)) {
          refined = 0;
        }
      } catch { /* keep raw count */ }
    }
    return {
      commitsAhead: refined,
      commitsAheadRaw: rawCount,
      dirtyTracked: dirty,
      baseRef: creationBase,
    };
  } catch (err) {
    logger.debug('dispatch status: git evidence unavailable:', err);
    return undefined;
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────

function readLogTail(filePath: string, lines: number): LogFileSnapshot {
  try {
    const stat = fs.statSync(filePath);
    if (lines <= 0) {
      return { path: filePath, exists: true, size_bytes: stat.size };
    }
    // can_c39f0961: Windows-native tools write OEM cp850 — decode-aware read
    // instead of blind utf-8 so the tail is human-readable.
    const content = decodeOemAwareBuffer(fs.readFileSync(filePath));
    const all = content.split(/\r?\n/);
    // Strip trailing empty line from final \n
    if (all.length > 0 && all[all.length - 1] === '') all.pop();
    return {
      path: filePath,
      exists: true,
      size_bytes: stat.size,
      tail: all.slice(-lines),
    };
  } catch {
    return { path: filePath, exists: false, size_bytes: 0 };
  }
}

function findLoopByAssignmentId(assignmentId: string, cwd?: string): LoopThread | undefined {
  for (const loop of listLoops({}, cwd)) {
    if (loop.slots.some((s) => s.assignment_id === assignmentId)) return loop;
  }
  return undefined;
}

function resolveTarget(targetId: string, cwd?: string): {
  resolved_from: ResolvedFrom;
  assignment_id?: string;
  agent_run?: AgentRun;
} {
  if (targetId.startsWith('asgn_')) {
    return { resolved_from: 'assignment_id', assignment_id: targetId };
  }
  if (targetId.startsWith('run_')) {
    const run = loadAgentRun(targetId, cwd);
    if (run) return { resolved_from: 'run_id', assignment_id: run.assignment_id, agent_run: run };
    return { resolved_from: 'unresolved' };
  }
  if (targetId.startsWith('clm_')) {
    const assignments = listAssignments(cwd, { claim_id: targetId });
    if (assignments.length > 0) {
      // Pick the most recent assignment for this claim (latest created_at).
      const recent = [...assignments].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      return { resolved_from: 'claim_id', assignment_id: recent.id };
    }
    return { resolved_from: 'claim_id' };
  }
  if (targetId.startsWith('lop_')) {
    const loop = getLoop(targetId, cwd);
    if (loop) {
      // Prefer the slot in the current_phase with an assignment_id; fall back
      // to any slot's assignment_id.
      const phaseSlot = loop.slots.find((s) => s.phase === loop.current_phase && s.assignment_id);
      const anySlot = loop.slots.find((s) => s.assignment_id);
      const slot = phaseSlot ?? anySlot;
      if (slot?.assignment_id) {
        return { resolved_from: 'loop_id', assignment_id: slot.assignment_id };
      }
      return { resolved_from: 'loop_id' };
    }
    return { resolved_from: 'unresolved' };
  }
  return { resolved_from: 'unresolved' };
}

const TERMINAL_RUN_STATUSES: ReadonlySet<AgentRun['status']> = new Set([
  'completed', 'failed', 'cancelled', 'timed_out', 'interrupted',
]);

interface StderrSignature { summary: string; recommended_next_action: string; }

/**
 * pln#527 (#5) — recognize known fatal boot signatures in a worker's stderr tail
 * so dispatch_status returns a targeted diagnosis + remediation instead of a
 * generic silent_death. These are agent/CLI/config faults (NOT brainclaw bugs)
 * that a coordinator can fix and re-dispatch. Patterns sourced from field traps
 * (trp#292 codex service_tier / model mismatch).
 */
export function recognizeStderrSignature(tail: string[] | undefined): StderrSignature | undefined {
  if (!tail || tail.length === 0) return undefined;
  const text = tail.join('\n');
  if (/service_tier/i.test(text) && /flex|unsupported/i.test(text)) {
    return {
      summary: 'codex rejected an unsupported `service_tier` (e.g. flex) — a config/model mismatch at boot, not a brainclaw fault',
      recommended_next_action: 'Fix ~/.codex/config.toml `service_tier` (remove it or set a supported value) or upgrade codex, then re-dispatch. See trap trp#292.',
    };
  }
  if (/unknown variant/i.test(text)) {
    return {
      summary: 'codex CLI rejected an unknown config variant — the installed codex does not support a value in ~/.codex/config.toml (e.g. model/approval)',
      recommended_next_action: 'Reconcile ~/.codex/config.toml with the installed codex (`codex --version`) or upgrade codex, then re-dispatch.',
    };
  }
  if (/\b400\b/.test(text) && /(unsupported|requires a newer|model)/i.test(text)) {
    return {
      summary: 'the model API returned 400 (unsupported model / needs a newer CLI) — the worker died at boot, before doing work',
      recommended_next_action: 'Check the configured model vs the installed CLI version; upgrade the agent CLI or pick a supported model, then re-dispatch.',
    };
  }
  return undefined;
}

function computeDiagnosis(
  assignment: Assignment | undefined,
  agentRun: AgentRun | undefined,
  runtime: DispatchRuntimeSnapshot,
  options: { stallMs: number; nowMs: number },
): DispatchDiagnosis {
  if (!assignment && !agentRun) {
    return {
      health: 'unknown',
      summary: 'target_id did not resolve to any assignment or agent_run',
      recommended_next_action: 'Verify the target_id is correct (asgn_/clm_/lop_/run_). Use bclaw_find(entity="assignment") to list available assignments.',
    };
  }

  // pln#532 — RESULT is the #1 verdict signal. If the worker wrote LANE-RESULT.json
  // it has FINISHED — regardless of pid / heartbeat / agent_run.status (a sandboxed
  // worker frequently cannot self-update the run). This sits above every other
  // signal, including the agent_run terminal/running checks below.
  if (runtime.lane_result) {
    const lr = runtime.lane_result;
    const ok = lr.status === 'completed';
    const stale = agentRun && agentRun.status !== 'completed'
      ? ` (agent_run still ${agentRun.status}; the worker could not self-update — harvest reconciles it)`
      : '';
    return {
      health: 'terminal',
      summary: `worker reported done via LANE-RESULT.json: status=${lr.status} — ${lr.summary.slice(0, 140)}${stale}`,
      recommended_next_action: ok
        ? 'Worker finished. `brainclaw harvest <assignment_id>` to ingest the result, then commit/integrate its worktree diff and converge the lane.'
        : `Worker reported "${lr.status}". Read the LANE-RESULT summary + stderr; address the blocker or reroute.`,
    };
  }

  // pln#554 — git evidence is the #2 signal, ABOVE process sentinels and
  // administrative status: commits ahead of base with a clean tracked tree
  // means the worker delivered everything to the branch, even if its pid is
  // dead, its heartbeat stale, or the run was relabeled interrupted by a TTL
  // sweep (can_948acfd6). The verdict is "harvest it" — never "kill and reroute".
  if ((runtime.commits_ahead ?? 0) > 0 && runtime.dirty_tracked === 0) {
    return {
      health: 'terminal',
      summary: `worker delivered: ${runtime.commits_ahead} commit(s) ahead of base with a clean tracked tree — everything is on the lane branch${agentRun && !TERMINAL_RUN_STATUSES.has(agentRun.status) ? ` (agent_run still ${agentRun.status}; exit formalities missing — harvest reconciles it)` : ''}`,
      recommended_next_action: 'Worker delivered; harvest it: `brainclaw harvest <assignment_id>` to ingest and merge the lane branch. Do NOT kill or reroute.',
    };
  }

  if (!agentRun) {
    return {
      health: 'not_dispatched',
      summary: `assignment exists (status=${assignment?.status}) but no agent_run record — the spawn never produced a process, or the assignment is still waiting to be picked up`,
      recommended_next_action: assignment?.status === 'offered'
        ? 'Wait for the target agent to accept, or reroute via bclaw_coordinate(intent="reroute", scope=…).'
        : 'Re-dispatch with bclaw_coordinate or check for an earlier spawn error.',
    };
  }

  if (TERMINAL_RUN_STATUSES.has(agentRun.status)) {
    const isSuccess = agentRun.status === 'completed';
    return {
      health: 'terminal',
      summary: `agent_run already terminal (status=${agentRun.status})${agentRun.status_reason ? `: ${agentRun.status_reason}` : ''}`,
      recommended_next_action: isSuccess
        ? 'Harvest artifacts and move on; if the assignment is still open, transition it to completed.'
        : 'Read stderr log (path in runtime.log_files.stderr) for the failure detail; reroute or retry if appropriate.',
    };
  }

  // status is running / launching / waiting_input / blocked → check liveness
  const lastEventMs = new Date(agentRun.last_event_at ?? agentRun.started_at ?? agentRun.created_at).getTime();
  const stallAge = options.nowMs - lastEventMs;

  // pln#527 — a stale last_event_at is NOT "stalled" when the filesystem is still
  // active (logs streaming / worktree files edited). Workers emit no heartbeat
  // during a long single operation (codex→stderr, claude -p buffering stdout),
  // so fs activity is the truer liveness signal and vetoes the false-stalled.
  const fsAge = runtime.last_fs_activity_ms;
  const fsActive = fsAge !== undefined && fsAge < options.stallMs;

  if (runtime.pid_alive === false) {
    // pln#621 pack (review of PR #170) — the fs-activity veto applies HERE too,
    // not only to the stalled branch below. On an ack-wrapped spawn the tracked
    // pid is the WRAPPER, dead by design while the worker keeps writing — the
    // exact pln#520 shape (6 workers "dead", committing minutes later). This
    // branch used to skip the veto and advise "cancel + reroute" on a worker
    // that was demonstrably mid-write: a destructive recommendation on
    // ambiguous evidence, which is the one thing the regression pack forbids.
    if (fsActive) {
      return {
        health: 'healthy',
        summary: `pid ${runtime.pid} is dead but the filesystem is ACTIVE (${Math.round((fsAge ?? 0) / 1000)}s ago) — on an ack-wrapped spawn the tracked pid is the wrapper, which exits by design while the worker keeps writing (pln#520)`,
        recommended_next_action: 'No destructive action — the worker is writing. Re-check until a terminal signal appears (LANE-RESULT, completion sentinel, or a commit on the lane branch).',
      };
    }
    // pln#527 (#5) — surface a TARGETED diagnosis when the captured stderr matches
    // a known fatal boot signature (codex model/service_tier mismatch, API 400)
    // instead of a generic "silent_death".
    const sig = recognizeStderrSignature(runtime.log_files.stderr?.tail);
    return {
      health: 'silent_death',
      summary: sig
        ? `agent_run.status="${agentRun.status}", pid ${runtime.pid} dead — ${sig.summary}`
        : `agent_run.status="${agentRun.status}" but pid ${runtime.pid} is dead — worker exited without self-reporting; lazy reconciler will mark it failed after the stale window (default 30min)`,
      recommended_next_action: sig?.recommended_next_action
        ?? 'Read .stderr.log for the exit reason; then trigger reconciliation by calling bclaw_find(entity="agent_run") again, or cancel + reroute.',
    };
  }

  if (runtime.pid_alive === true && stallAge > options.stallMs && fsActive) {
    return {
      health: 'healthy',
      summary: `agent_run alive (pid=${runtime.pid}); last_event_at stale (${Math.round(stallAge / 1000)}s) but filesystem active ${Math.round((fsAge ?? 0) / 1000)}s ago — working through a long op without a heartbeat`,
      recommended_next_action: 'No action — the worker is actively writing to logs/worktree. Re-check periodically until terminal.',
    };
  }

  if (runtime.pid_alive === true && stallAge > options.stallMs) {
    return {
      health: 'stalled',
      summary: `agent_run alive (pid=${runtime.pid}) but no activity for ${Math.round(stallAge / 1000)}s AND no filesystem writes${fsAge !== undefined ? ` (last fs ${Math.round(fsAge / 1000)}s ago)` : ' (no logs/worktree mtime)'}; last_event_at=${agentRun.last_event_at ?? '(never)'}`,
      recommended_next_action: 'Worker appears genuinely hung (no log/file writes). Tail stderr to confirm, then kill the pid and reroute.',
    };
  }

  if (runtime.pid_alive === true) {
    return {
      health: 'healthy',
      summary: `agent_run.status="${agentRun.status}", pid ${runtime.pid} alive, last activity ${Math.round(stallAge / 1000)}s ago`,
      recommended_next_action: 'No action — the dispatch is alive and recent. Re-check periodically until terminal.',
    };
  }

  // pid_alive undefined → cannot determine (no pid tracked, or signal failed)
  return {
    health: 'unknown',
    summary: `agent_run.status="${agentRun.status}" but pid liveness could not be determined (pid=${agentRun.pid ?? '(none)'})`,
    recommended_next_action: 'Read the stdout/stderr log for life signs; or wait for the lazy reconciler to converge based on commit / claim / assignment evidence.',
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

export function getDispatchStatus(options: DispatchStatusOptions): DispatchStatus {
  const cwd = options.cwd;
  const tailLines = options.tail_log_lines ?? DEFAULT_TAIL;
  const stallMs = options.stall_threshold_ms ?? DEFAULT_STALL_MS;
  const nowMs = options.nowMs ?? Date.now();

  const resolved = resolveTarget(options.target_id, cwd);
  const assignmentId = resolved.assignment_id;

  const assignment = assignmentId ? loadAssignment(assignmentId, cwd) : undefined;
  // loadClaim THROWS on a missing id — a GC'd/never-created claim must not
  // crash the whole diagnostic (sprint 1.5).
  let claim: Claim | undefined;
  if (assignment?.claim_id) {
    try { claim = loadClaim(assignment.claim_id, cwd); } catch { /* claim gone — diagnose without it */ }
  }

  // Prefer the pre-resolved agent_run (when target_id was a run_…); otherwise
  // look up by assignment_id and pick the most recent attempt.
  let agentRun = resolved.agent_run;
  if (!agentRun && assignmentId) {
    const runs = listAgentRuns(cwd, { assignment_id: assignmentId });
    agentRun = [...runs].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  }

  let loop: LoopThread | undefined;
  if (resolved.resolved_from === 'loop_id') {
    loop = getLoop(options.target_id, cwd);
  } else if (assignmentId) {
    loop = findLoopByAssignmentId(assignmentId, cwd);
  }

  // Runtime artefacts (ack file + log files) — all under the project's
  // coordination root. Use the cwd or the runtime cwd as the anchor; the
  // dispatcher writes them under cwd/.brainclaw/coordination/runtime/...
  const projectRoot = cwd ?? process.cwd();
  const currentAttemptRunId = assignmentId
    ? currentAttemptRunIdForAssignment(assignmentId, cwd)
    : undefined;
  const runtimeRunId = currentAttemptRunId ? (agentRun?.id ?? currentAttemptRunId) : undefined;
  const ackPath = assignmentId
    ? getRuntimeSignalPath(projectRoot, assignmentId, 'ack', runtimeRunId)
    : undefined;
  const stdoutPath = assignmentId
    ? getRuntimeLogPath(projectRoot, assignmentId, 'stdout', runtimeRunId)
    : undefined;
  const stderrPath = assignmentId
    ? getRuntimeLogPath(projectRoot, assignmentId, 'stderr', runtimeRunId)
    : undefined;

  // pln#527 — filesystem-activity age: max mtime across the captured logs + the
  // run's worktree files (skipping junctions). The truer liveness signal when
  // the heartbeat / last_event_at is stale during a long single operation.
  // can_948acfd6: also fall back to assignment.worktree_path — without it a
  // LANE-RESULT.json sitting in the assignment's worktree was invisible when
  // neither the run nor the claim carried the path, and the verdict degraded
  // to 'read stderr for failure detail' despite a completed lane result.
  const worktreeForFs = agentRun?.worktree_path ?? claim?.worktree_path ?? assignment?.worktree_path;
  let lastFsActivityMs: number | undefined;
  if (assignmentId) {
    const lastFs = latestActivityMs(projectRoot, assignmentId, worktreeForFs, runtimeRunId);
    if (lastFs !== undefined) lastFsActivityMs = nowMs - lastFs;
  }

  // pln#532 — the #1 verdict signal: a LANE-RESULT.json at the worktree root means
  // the worker FINISHED (even if it couldn't self-update the run). Read + validate it.
  // trp_e824d2af — validate OWNERSHIP too: assignment_id is required on the schema,
  // and a reused worktree keeps the prior turn's file at the root. Unmatched, that
  // file declared a freshly-spawned round 2 terminal with round 1's verdict (observed
  // live 2026-08-02, lop_626271ee10ad09d8). A mismatch is surfaced as stale, never
  // as this dispatch's result.
  let laneResult: { status: string; summary: string } | undefined;
  let laneResultStale: { assignment_id: string; status: string; summary: string } | undefined;
  if (worktreeForFs) {
    try {
      const parsed = LaneResultSchema.parse(JSON.parse(fs.readFileSync(path.join(worktreeForFs, 'LANE-RESULT.json'), 'utf-8')));
      if (parsed.assignment_id === assignmentId) {
        laneResult = { status: parsed.status, summary: parsed.summary };
      } else {
        laneResultStale = { assignment_id: parsed.assignment_id, status: parsed.status, summary: parsed.summary };
      }
    } catch { /* no / invalid LANE-RESULT.json */ }
  }

  // pln#554 — worktree git evidence (commits ahead of base + dirty tracked files).
  const evidence = gitEvidence(worktreeForFs, options.base_ref ?? DEFAULT_BASE_REF);

  const runtime: DispatchRuntimeSnapshot = {
    pid: agentRun?.pid,
    pid_alive: isProcessAlive(agentRun?.pid),
    ack_file: {
      exists: ackPath ? fs.existsSync(ackPath) : false,
      path: ackPath,
    },
    log_files: {
      stdout: stdoutPath ? readLogTail(stdoutPath, tailLines) : undefined,
      stderr: stderrPath ? readLogTail(stderrPath, tailLines) : undefined,
    },
    last_fs_activity_ms: lastFsActivityMs,
    lane_result: laneResult,
    ...(laneResultStale ? { lane_result_stale: laneResultStale } : {}),
    commits_ahead: evidence?.commitsAhead,
    commits_ahead_raw: evidence?.commitsAheadRaw,
    commits_ahead_base: evidence?.baseRef,
    dirty_tracked: evidence?.dirtyTracked,
  };

  let diagnosis = computeDiagnosis(assignment, agentRun, runtime, { stallMs, nowMs });

  // can_b8d53d18 — a `run_` target that resolves to nothing may be a LEGACY
  // runtime_note id (pre-rtn_ prefix collision). Say so precisely instead of
  // the generic "verify the target_id" message.
  if (resolved.resolved_from === 'unresolved' && options.target_id.startsWith('run_')) {
    try {
      if (findRuntimeNoteById(options.target_id, {}, cwd)) {
        diagnosis = {
          health: 'unknown',
          summary: `${options.target_id} is a runtime_note (legacy run_ id prefix), not an agent_run — nothing to dispatch-diagnose`,
          recommended_next_action: 'Read it with bclaw_get(entity="runtime_note"). Run `brainclaw repair` to migrate legacy run_ note ids to rtn_.',
        };
      }
    } catch { /* diagnosis stays generic */ }
  }

  return {
    target_id: options.target_id,
    resolved_from: resolved.resolved_from,
    entities: {
      assignment_id: assignmentId,
      claim_id: assignment?.claim_id,
      loop_id: loop?.id,
      run_id: agentRun?.id,
    },
    assignment,
    claim,
    loop,
    agent_run: agentRun,
    runtime,
    diagnosis,
  };
}
