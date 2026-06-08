/**
 * Runtime spawn signals (pln#520 steps 1 + 4) — the file-based, zero-MCP
 * liveness channel between a dispatched worker and brainclaw.
 *
 * Why files, not the tracked pid: on Windows the ack-wrap spawn runs under
 * `shell:true`, so `child.pid` is the cmd.exe wrapper (which dies early),
 * NOT the real worker (cmd.exe → claude.cmd → node.exe). Reading that pid as
 * dead produced false-negative `pid_dead_at_read` cancellations while the
 * worker was alive and committing (can_f792cacd: 6 workers cancelled, then
 * committed 4-7 min later). The fix is to stop trusting the wrapper pid and
 * trust sentinels the worker / wrapper actually write:
 *
 *   - `ack`        — pre-exec; the spawn shell touched it BEFORE the agent ran
 *                    (pln#476). Proves delivery, NOT that work started.
 *   - `heartbeat`  — the worker writes `work_loop_reached{run_id,nonce}` as its
 *                    FIRST action (step 0 of the generated brief) and refreshes
 *                    it periodically. Distinct from `ack`: this is what flips
 *                    execution_status to `started`.
 *   - `completed` / `failed` — emitted MECHANICALLY by the spawn wrapper
 *                    (`agentcmd && completed || failed`) so a dead wrapper pid
 *                    is never misread as a silent failure.
 *
 * All paths are absolute under the project coordination dir so a worker in a
 * worktree (or a sandboxed agent without MCP) can write them with a plain
 * shell redirect.
 *
 * @module
 */
import fs from 'node:fs';
import path from 'node:path';

export type RuntimeSignal = 'ack' | 'heartbeat' | 'completed' | 'failed';

function runtimeDir(root: string): string {
  return path.join(root, '.brainclaw', 'coordination', 'runtime');
}

/**
 * Absolute path for a runtime signal sentinel. `ack` keeps its historical
 * `runtime/ack/<id>.ack` location (pln#476); the liveness signals live under
 * `runtime/signal/<id>.<signal>`.
 */
export function getRuntimeSignalPath(root: string, assignmentId: string, signal: RuntimeSignal): string {
  if (signal === 'ack') {
    return path.join(runtimeDir(root), 'ack', `${assignmentId}.ack`);
  }
  return path.join(runtimeDir(root), 'signal', `${assignmentId}.${signal}`);
}

/** Absolute path for a captured stream log (`runtime/log/<id>.{stdout,stderr}.log`). */
export function getRuntimeLogPath(root: string, assignmentId: string, stream: 'stdout' | 'stderr'): string {
  return path.join(runtimeDir(root), 'log', `${assignmentId}.${stream}.log`);
}

/** Ensure the ack / signal / log directories exist (best-effort, recursive). */
export function ensureRuntimeDirs(root: string): void {
  const base = runtimeDir(root);
  for (const sub of ['ack', 'signal', 'log']) {
    fs.mkdirSync(path.join(base, sub), { recursive: true });
  }
}

export function signalExists(root: string, assignmentId: string, signal: RuntimeSignal): boolean {
  try {
    return fs.existsSync(getRuntimeSignalPath(root, assignmentId, signal));
  } catch {
    return false;
  }
}

export interface HeartbeatInfo {
  exists: boolean;
  /** mtime of the heartbeat file in ms since epoch, when present. */
  mtimeMs?: number;
  /** Parsed `run_id` from the heartbeat body, when the worker wrote JSON. */
  runId?: string;
  /** Parsed `nonce` from the heartbeat body, when present. */
  nonce?: string;
}

/**
 * Read the heartbeat sentinel. The body is expected to be
 * `work_loop_reached{run_id,nonce}` JSON, but a bare `touch` (empty file) still
 * counts as a heartbeat — the mtime alone is a valid life-sign.
 */
export function readHeartbeat(root: string, assignmentId: string): HeartbeatInfo {
  const p = getRuntimeSignalPath(root, assignmentId, 'heartbeat');
  try {
    const stat = fs.statSync(p);
    const info: HeartbeatInfo = { exists: true, mtimeMs: stat.mtimeMs };
    try {
      const raw = fs.readFileSync(p, 'utf-8').trim();
      if (raw) {
        const parsed = JSON.parse(raw) as { run_id?: string; nonce?: string };
        if (typeof parsed.run_id === 'string') info.runId = parsed.run_id;
        if (typeof parsed.nonce === 'string') info.nonce = parsed.nonce;
      }
    } catch { /* empty / non-JSON body — mtime still counts */ }
    return info;
  } catch {
    return { exists: false };
  }
}

/** Read the tail of a captured stream log (for failed_silent diagnostics). */
export function readLogTail(root: string, assignmentId: string, stream: 'stdout' | 'stderr', maxBytes = 2000): string {
  try {
    const p = getRuntimeLogPath(root, assignmentId, stream);
    const content = fs.readFileSync(p, 'utf-8');
    return content.length > maxBytes ? content.slice(content.length - maxBytes) : content;
  } catch {
    return '';
  }
}

/**
 * pln#527 — directories never worth walking for filesystem-activity (junction
 * targets / VCS / coordination store). Skipping them keeps the worktree mtime
 * scan cheap AND avoids following node_modules/dist junctions into the main repo.
 */
const FS_ACTIVITY_SKIP_DIRS = new Set(['.git', '.brainclaw', 'node_modules', 'dist', '.venv', 'venv', 'vendor']);

/**
 * pln#527 — most-recent file mtime (ms) under a worktree, via a bounded walk that
 * NEVER follows symlinks/junctions (lstat) and skips dependency/VCS dirs. This is
 * the liveness signal for workers that edit files but emit no heartbeat/stdout
 * (e.g. `claude -p` buffers stdout; a long single edit pass refreshes no
 * sentinel). Returns undefined when the path is absent/unreadable.
 */
export function latestWorktreeFileMtimeMs(worktreePath: string, maxDepth = 4): number | undefined {
  let latest: number | undefined;
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue; // never follow junctions (node_modules/dist)
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (FS_ACTIVITY_SKIP_DIRS.has(entry.name)) continue;
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        try {
          const m = fs.statSync(full).mtimeMs;
          if (latest === undefined || m > latest) latest = m;
        } catch { /* ignore */ }
      }
    }
  };
  walk(worktreePath, 0);
  return latest;
}

/**
 * pln#527 — the most recent filesystem activity (ms since epoch) attributable to
 * a dispatched run: the max mtime across its captured stdout/stderr logs AND any
 * file in its worktree. Lets the reconciler / dispatch_status distinguish
 * "no heartbeat BUT fs active" (working — e.g. codex streaming to stderr, or
 * claude -p editing files) from "no heartbeat AND fs inert" (genuinely stalled),
 * fixing the false-`stalled` verdict (debrief LeaseUp P1#1). Returns undefined
 * when nothing is observable.
 */
export function latestActivityMs(root: string, assignmentId: string, worktreePath?: string): number | undefined {
  let latest: number | undefined;
  const bump = (ms: number | undefined): void => {
    if (ms !== undefined && (latest === undefined || ms > latest)) latest = ms;
  };
  for (const stream of ['stdout', 'stderr'] as const) {
    try { bump(fs.statSync(getRuntimeLogPath(root, assignmentId, stream)).mtimeMs); } catch { /* no log */ }
  }
  if (worktreePath) bump(latestWorktreeFileMtimeMs(worktreePath));
  return latest;
}
