import { execFileSync } from 'node:child_process';
import { getDispatchStatus, type DispatchStatus } from '../core/dispatch-status.js';

/**
 * `brainclaw dispatch watch <asgn_|clm_|run_>` — blocking coordinator-side
 * monitor for a dispatched worker (pln#554 step 1).
 *
 * Encodes the heuristics hand-validated on 2026-06-10 (five ad-hoc bash
 * monitors during sprints 1/1.5/2):
 *   - lane-result / completed / failed sentinels   → worker reported done
 *   - committed-clean (commits ahead + clean tree) → the claude -p
 *     "delivered-but-end-stalled" pattern: everything is on the branch, only
 *     the exit/LANE-RESULT formality is missing (can_d622e024)
 *   - worker-process-gone (wrapper alive, real agent child dead, work
 *     uncommitted) → abrupt worker death whose orphaned grandchildren hold the
 *     redirected pipes open, so the wrapper never emits a sentinel
 *     (can_9458576e). Detected in ~1 poll instead of a full timeout.
 *
 * Exit codes are distinct per terminal state so the command can drive scripts:
 *   0 done (lane-result / completed / committed-clean)
 *   2 watch timeout reached, worker still running
 *   3 worker reported failed
 *   4 worker process gone with uncommitted work (recover via worktree triage)
 *   5 target could not be resolved
 */

export type WatchState =
  | 'running'
  | 'lane-result'
  | 'completed'
  | 'failed'
  | 'committed-clean'
  | 'worker-process-gone';

export interface WatchTickInput {
  /** Health verdict straight from getDispatchStatus. */
  health: DispatchStatus['diagnosis']['health'];
  runStatus: string | undefined;
  laneResultStatus: string | undefined;
  /** Wrapper pid liveness (the tracked pid — NOT the real worker on win32). */
  pidAlive: boolean | undefined;
  /** A real agent child process (claude/codex/copilot/node) lives under the wrapper. */
  agentChildAlive: boolean | undefined;
  /** Commits on the worktree branch ahead of the base ref. */
  commitsAhead: number;
  /** Modified tracked files in the worktree (untracked excluded). */
  dirtyTracked: number;
  /**
   * Age (ms) of the most recent filesystem activity in the worktree/logs
   * (from getDispatchStatus). Fresh activity vetoes process-gone verdicts —
   * the pln#527 rule applied to the watch itself: a stale tracked pid (e.g.
   * after a manual respawn) must not kill a worker that is visibly writing.
   */
  fsActivityMs: number | undefined;
}

/** Filesystem activity younger than this vetoes a process-gone verdict. */
export const FS_FRESH_MS = 5 * 60_000;

/**
 * Pure decision core — one watch poll in, one state out.
 * Evidence priority (strongest first): worker-written results, then git
 * evidence, then process evidence, then administrative status. This is the
 * inverse of trusting `assignment.status`, which expired live workers three
 * times on 2026-06-10 (can_948acfd6).
 */
export function evaluateWatchTick(input: WatchTickInput): WatchState {
  if (input.laneResultStatus === 'failed') return 'failed';
  if (input.laneResultStatus !== undefined) return 'lane-result';

  if (input.runStatus === 'completed') return 'completed';
  if (input.runStatus === 'failed' || input.runStatus === 'timed_out') return 'failed';

  // Git evidence beats process evidence: a worker that committed everything
  // and stalled on exit is DONE for the coordinator's purposes.
  if (input.commitsAhead > 0 && input.dirtyTracked === 0) return 'committed-clean';

  // Fresh filesystem activity vetoes every process-gone verdict below: the
  // tracked pid may be stale (manual respawn, wrapper recycling) while the
  // real worker is visibly writing.
  const fsFresh = input.fsActivityMs !== undefined && input.fsActivityMs < FS_FRESH_MS;

  // Wrapper alive but the real agent child is gone: abrupt death — the wrapper
  // waits forever on inherited pipe handles and never emits a sentinel.
  // agentChildAlive === undefined means "could not observe" — never conclude
  // death from a failed observation.
  if (input.agentChildAlive === false && !fsFresh) return 'worker-process-gone';

  // Wrapper itself dead with nothing delivered: same recovery path.
  if (input.pidAlive === false && input.agentChildAlive !== true && !fsFresh) {
    return 'worker-process-gone';
  }

  return 'running';
}

const AGENT_CHILD_NAMES = ['claude', 'codex', 'copilot', 'node'];

/**
 * Does a real agent process live under the wrapper pid?
 * Returns undefined when the observation itself fails (never treated as death).
 */
export function probeAgentChildAlive(wrapperPid: number | undefined): boolean | undefined {
  if (!wrapperPid) return undefined;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', [
        '-NoProfile', '-Command',
        // Single quotes survive Windows argv re-parsing; double quotes do not.
        `(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${Math.floor(wrapperPid)}').Name`,
      ], { encoding: 'utf-8', timeout: 15000 });
      const names = out.split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter(Boolean);
      return names.some((n) => AGENT_CHILD_NAMES.some((a) => n.startsWith(a)));
    }
    const out = execFileSync('ps', ['-o', 'comm=', '--ppid', String(wrapperPid)], {
      encoding: 'utf-8', timeout: 15000,
    });
    const names = out.split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean);
    return names.some((n) => AGENT_CHILD_NAMES.some((a) => n.includes(a)));
  } catch {
    return undefined;
  }
}

export interface DispatchWatchOptions {
  intervalSeconds?: number;
  timeoutMinutes?: number;
  base?: string;
  json?: boolean;
  cwd?: string;
}

const EXIT_CODES: Record<WatchState, number> = {
  'running': 2, // only used when the timeout fires
  'lane-result': 0,
  'completed': 0,
  'committed-clean': 0,
  'failed': 3,
  'worker-process-gone': 4,
};

const NEXT_ACTION: Record<WatchState, string> = {
  'running': 'Watch timeout — worker still running; re-run watch or inspect with dispatch-status.',
  'lane-result': 'Run `brainclaw harvest <assignment_id> --integrate` to ingest and converge the lane.',
  'completed': 'Run `brainclaw harvest <assignment_id> --integrate` (or merge the lane branch).',
  'committed-clean': 'Work is on the branch; harvest/merge it. The worker stalled only on exit formalities.',
  'failed': 'Read the captured stderr log, then fix and re-dispatch.',
  'worker-process-gone': 'Triage the worktree (commits? dirty files?). Recover uncommitted work by evaluate+commit-on-behalf before any re-dispatch.',
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runDispatchWatch(targetId: string, options: DispatchWatchOptions = {}): Promise<void> {
  const intervalMs = Math.max(5, options.intervalSeconds ?? 60) * 1000;
  const timeoutMs = Math.max(1, options.timeoutMinutes ?? 90) * 60_000;
  const baseRef = options.base ?? 'master';
  const startedAt = Date.now();
  let poll = 0;
  let lastState: WatchState = 'running';
  let lastStatus: DispatchStatus | undefined;

  for (;;) {
    poll += 1;
    let status: DispatchStatus;
    try {
      status = getDispatchStatus({ target_id: targetId, cwd: options.cwd, tail_log_lines: 0, base_ref: baseRef });
    } catch (err) {
      console.error(`Error: could not resolve '${targetId}': ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 5;
      return;
    }
    lastStatus = status;

    // Git evidence is computed by getDispatchStatus (shared helper, pln#554 step 2).
    const commitsAhead = status.runtime.commits_ahead ?? 0;
    const dirtyTracked = status.runtime.dirty_tracked ?? 0;
    const state = evaluateWatchTick({
      health: status.diagnosis.health,
      runStatus: status.agent_run?.status,
      laneResultStatus: status.runtime.lane_result?.status,
      pidAlive: status.runtime.pid_alive,
      agentChildAlive: probeAgentChildAlive(status.runtime.pid),
      commitsAhead,
      dirtyTracked,
      fsActivityMs: status.runtime.last_fs_activity_ms,
    });
    lastState = state;

    const line = options.json
      ? JSON.stringify({ poll, state, commits_ahead: commitsAhead, dirty_tracked: dirtyTracked, health: status.diagnosis.health })
      : `[poll ${poll}] ${state} (commits=${commitsAhead} dirty=${dirtyTracked} health=${status.diagnosis.health})`;
    console.log(line);

    if (state !== 'running') break;
    if (Date.now() - startedAt + intervalMs > timeoutMs) break;
    await sleep(intervalMs);
  }

  const assignmentId = lastStatus?.entities.assignment_id ?? targetId;
  if (!options.json) {
    console.log(lastState === 'running' ? 'TIMEOUT' : 'TERMINAL');
    console.log(`→ ${NEXT_ACTION[lastState].replace('<assignment_id>', assignmentId)}`);
  }
  process.exitCode = EXIT_CODES[lastState];
}
