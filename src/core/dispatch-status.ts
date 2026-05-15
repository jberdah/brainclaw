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
import { loadAssignment, listAssignments } from './assignments.js';
import { loadAgentRun, listAgentRuns } from './agentruns.js';
import { loadClaim } from './claims.js';
import { getLoop, listLoops } from './loops/store.js';
import { isProcessAlive } from './agentrun-reconciler.js';
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
  /** Override wall clock for deterministic tests. */
  nowMs?: number;
}

const DEFAULT_TAIL = 20;
const DEFAULT_STALL_MS = 5 * 60_000;

// ── Internal helpers ──────────────────────────────────────────────────────

function readLogTail(filePath: string, lines: number): LogFileSnapshot {
  try {
    const stat = fs.statSync(filePath);
    if (lines <= 0) {
      return { path: filePath, exists: true, size_bytes: stat.size };
    }
    const content = fs.readFileSync(filePath, 'utf-8');
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

  if (runtime.pid_alive === false) {
    return {
      health: 'silent_death',
      summary: `agent_run.status="${agentRun.status}" but pid ${runtime.pid} is dead — worker exited without self-reporting; lazy reconciler will mark it failed after the stale window (default 30min)`,
      recommended_next_action: 'Read .stderr.log for the exit reason; then trigger reconciliation by calling bclaw_find(entity="agent_run") again, or cancel + reroute.',
    };
  }

  if (runtime.pid_alive === true && stallAge > options.stallMs) {
    return {
      health: 'stalled',
      summary: `agent_run alive (pid=${runtime.pid}) but no activity for ${Math.round(stallAge / 1000)}s; last_event_at=${agentRun.last_event_at ?? '(never)'}`,
      recommended_next_action: 'Tail the stdout/stderr log to see whether the worker is doing useful work; if truly hung, kill the pid and reroute.',
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
  const claim = assignment?.claim_id ? loadClaim(assignment.claim_id, cwd) : undefined;

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
  const runtimeRoot = path.join(projectRoot, '.brainclaw', 'coordination', 'runtime');
  const ackPath = assignmentId ? path.join(runtimeRoot, 'ack', `${assignmentId}.ack`) : undefined;
  const stdoutPath = assignmentId ? path.join(runtimeRoot, 'log', `${assignmentId}.stdout.log`) : undefined;
  const stderrPath = assignmentId ? path.join(runtimeRoot, 'log', `${assignmentId}.stderr.log`) : undefined;

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
  };

  const diagnosis = computeDiagnosis(assignment, agentRun, runtime, { stallMs, nowMs });

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
