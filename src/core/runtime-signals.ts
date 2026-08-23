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
export function getRuntimeSignalPath(root: string, assignmentId: string, signal: RuntimeSignal, runId?: string): string {
  const key = runId ? `${assignmentId}.${runId}` : assignmentId;
  if (signal === 'ack') {
    return path.join(runtimeDir(root), 'ack', `${key}.ack`);
  }
  return path.join(runtimeDir(root), 'signal', `${key}.${signal}`);
}

/** Absolute path for a captured stream log (`runtime/log/<id>.{stdout,stderr}.log`). */
export function getRuntimeLogPath(root: string, assignmentId: string, stream: 'stdout' | 'stderr', runId?: string): string {
  const key = runId ? `${assignmentId}.${runId}` : assignmentId;
  return path.join(runtimeDir(root), 'log', `${key}.${stream}.log`);
}

/**
 * Worktree-local heartbeat path (sprint 1.5). The project-root signal path is
 * NOT writable from inside many worker sandboxes (Claude Code restricts writes
 * to its working directories; codex workspace-write roots exclude the project) —
 * observed live: the generated brief demanded a heartbeat the worker could not
 * write. The worktree root is the one location every dispatched worker can
 * write, so briefs point step-0 here, and every heartbeat reader checks BOTH
 * locations.
 */
export function getWorktreeHeartbeatPath(worktreePath: string, assignmentId: string, runId?: string): string {
  return path.join(worktreePath, `.brainclaw-heartbeat-${assignmentId}${runId ? `-${runId}` : ''}`);
}

/** Ensure the ack / signal / log directories exist (best-effort, recursive). */
export function ensureRuntimeDirs(root: string): void {
  const base = runtimeDir(root);
  for (const sub of ['ack', 'signal', 'log']) {
    fs.mkdirSync(path.join(base, sub), { recursive: true });
  }
}

export function signalExists(root: string, assignmentId: string, signal: RuntimeSignal, runId?: string): boolean {
  try {
    return fs.existsSync(getRuntimeSignalPath(root, assignmentId, signal, runId));
  } catch {
    return false;
  }
}

export interface ContractAckBody {
  status: 'accepted' | 'rejected';
  turn_id: string;
  run_id: string;
  nonce: string;
  contract_hash: string;
  capability_snapshot_hash: string;
  attempt_epoch?: number;
  workspace_digest?: string;
  cwd?: string;
}

/** Read the bootstrap's effective-environment attestation. Empty legacy acks return undefined. */
export function readContractAck(root: string, assignmentId: string, runId?: string): ContractAckBody | undefined {
  try {
    const raw = fs.readFileSync(getRuntimeSignalPath(root, assignmentId, 'ack', runId), 'utf8').trim();
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<ContractAckBody>;
    if (
      (parsed.status === 'accepted' || parsed.status === 'rejected')
      && typeof parsed.turn_id === 'string'
      && typeof parsed.run_id === 'string'
      && typeof parsed.nonce === 'string'
      && typeof parsed.contract_hash === 'string'
      && typeof parsed.capability_snapshot_hash === 'string'
    ) {
      return {
        status: parsed.status,
        turn_id: parsed.turn_id,
        run_id: parsed.run_id,
        nonce: parsed.nonce,
        contract_hash: parsed.contract_hash,
        capability_snapshot_hash: parsed.capability_snapshot_hash,
        ...(typeof parsed.attempt_epoch === 'number' ? { attempt_epoch: parsed.attempt_epoch } : {}),
        ...(typeof parsed.workspace_digest === 'string' ? { workspace_digest: parsed.workspace_digest } : {}),
        ...(typeof parsed.cwd === 'string' ? { cwd: parsed.cwd } : {}),
      };
    }
  } catch { /* absent, legacy or malformed */ }
  return undefined;
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

function readHeartbeatFile(p: string): HeartbeatInfo {
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

/**
 * Read the heartbeat sentinel. The body is expected to be
 * `work_loop_reached{run_id,nonce}` JSON, but a bare `touch` (empty file) still
 * counts as a heartbeat — the mtime alone is a valid life-sign.
 *
 * Checks the project-root signal path AND (when `worktreePath` is given) the
 * worktree-local heartbeat — sandboxed workers can only write the latter. When
 * both exist, the freshest mtime wins.
 */
export function readHeartbeat(root: string, assignmentId: string, worktreePath?: string, runId?: string): HeartbeatInfo {
  const projectInfo = readHeartbeatFile(getRuntimeSignalPath(root, assignmentId, 'heartbeat', runId));
  const worktreeInfo = worktreePath
    ? readHeartbeatFile(getWorktreeHeartbeatPath(worktreePath, assignmentId, runId))
    : { exists: false } as HeartbeatInfo;
  if (!projectInfo.exists) return worktreeInfo;
  if (!worktreeInfo.exists) return projectInfo;
  return (worktreeInfo.mtimeMs ?? 0) > (projectInfo.mtimeMs ?? 0) ? worktreeInfo : projectInfo;
}

/**
 * pln#630 PR2b-a (§13 R2/R3) — typed completion-sentinel body. A worker on the
 * turn-attempt path emits this JSON in its `completed`/`failed` sentinel so
 * reconcile can prove the exact attempt+generation that finished. `nonce` ==
 * the consumed launch-grant token (the epoch-unique generation id).
 */
export interface CompletionSignalBody {
  turn_id: string;
  run_id: string;
  nonce: string;
  contract_hash?: string;
  capability_snapshot_hash?: string;
  attempt_epoch?: number;
  workspace_digest?: string;
  status: 'completed' | 'failed';
  /** ISO timestamp; '' when a legacy body omitted it. */
  at: string;
}

/**
 * Write a turn-keyed completion/failed sentinel body. Used when brainclaw itself
 * (wrapper/reconcile) writes the sentinel; the shell `&& completed` fallback
 * still produces a legacy presence-only marker, which stays a valid life-sign
 * via signalExists but is NOT accepted as turn-owned evidence (PR2b-c).
 */
export function writeCompletionSignal(root: string, assignmentId: string, body: CompletionSignalBody, runId?: string): void {
  const p = getRuntimeSignalPath(root, assignmentId, body.status, runId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(body), 'utf-8');
}

/** Parse ONE turn-keyed sentinel body, or undefined if absent / legacy
 *  presence-only / non-JSON / missing correlation keys. Never throws. */
function readOneCompletionSignal(root: string, assignmentId: string, status: 'completed' | 'failed', runId?: string): CompletionSignalBody | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(getRuntimeSignalPath(root, assignmentId, status, runId), 'utf-8').trim();
  } catch {
    return undefined; // sentinel absent
  }
  if (!raw) return undefined; // legacy presence-only (empty) marker
  try {
    const parsed = JSON.parse(raw) as Partial<CompletionSignalBody>;
    if (
      typeof parsed.turn_id === 'string' &&
      typeof parsed.run_id === 'string' &&
      typeof parsed.nonce === 'string' &&
      (parsed.status === 'completed' || parsed.status === 'failed')
    ) {
      return {
        turn_id: parsed.turn_id,
        run_id: parsed.run_id,
        nonce: parsed.nonce,
        ...(typeof parsed.contract_hash === 'string' ? { contract_hash: parsed.contract_hash } : {}),
        ...(typeof parsed.capability_snapshot_hash === 'string'
          ? { capability_snapshot_hash: parsed.capability_snapshot_hash }
          : {}),
        ...(typeof parsed.attempt_epoch === 'number' ? { attempt_epoch: parsed.attempt_epoch } : {}),
        ...(typeof parsed.workspace_digest === 'string' ? { workspace_digest: parsed.workspace_digest } : {}),
        status: parsed.status,
        at: typeof parsed.at === 'string' ? parsed.at : '',
      };
    }
  } catch { /* non-JSON legacy body */ }
  return undefined;
}

/**
 * Read BOTH turn-keyed completion sentinels for an attempt. This is the
 * authoritative reader for the read-strict acceptance path: it surfaces a
 * `completed`+`failed` contradiction so the caller can raise a conflict event
 * and WITHHOLD an irreversible auto-stop (spec §13 R4), rather than silently
 * collapsing to one. Legacy presence-only markers read as absent here.
 */
export function readCompletionSignals(root: string, assignmentId: string, runId?: string): { completed?: CompletionSignalBody; failed?: CompletionSignalBody } {
  const out: { completed?: CompletionSignalBody; failed?: CompletionSignalBody } = {};
  const completed = readOneCompletionSignal(root, assignmentId, 'completed', runId);
  const failed = readOneCompletionSignal(root, assignmentId, 'failed', runId);
  if (completed) out.completed = completed;
  if (failed) out.failed = failed;
  return out;
}

/**
 * Convenience single-body reader (`completed` preferred over `failed`). Returns
 * undefined for absent / legacy presence-only / non-JSON / missing-keys.
 * CALLERS THAT ACT IRREVERSIBLY must use {@link readCompletionSignals} instead
 * so a completed+failed contradiction is not hidden (spec §13 R4).
 */
export function readCompletionSignal(root: string, assignmentId: string, runId?: string): CompletionSignalBody | undefined {
  const both = readCompletionSignals(root, assignmentId, runId);
  return both.completed ?? both.failed;
}

/**
 * can_c39f0961 — CP850 high-byte table (0x80–0xFF). Windows-native console
 * tools write redirected stdout/stderr in the OEM codepage (cp850 on western
 * locales), which read as UTF-8 produces U+FFFD mojibake in captured logs.
 * WHATWG TextDecoder does not cover ibm850, so a 128-entry table keeps the
 * fallback decode dependency-free.
 */
const CP850_HIGH =
  'ÇüéâäàåçêëèïîìÄÅ' +
  'ÉæÆôöòûùÿÖÜø£Ø×ƒ' +
  'áíóúñÑªº¿®¬½¼¡«»' +
  '░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐' +
  '└┴┬├─┼ãÃ╚╔╩╦╠═╬¤' +
  'ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀' +
  'ÓßÔÒõÕµþÞÚÛÙýÝ¯´' +
  '­±‗¾¶§÷¸°¨·¹³²■ ';

/**
 * Decode a captured-log buffer: UTF-8 first, falling back to cp850 when the
 * UTF-8 decode shows replacement characters (the OEM-output signature).
 */
export function decodeOemAwareBuffer(buf: Buffer): string {
  const utf8 = buf.toString('utf-8');
  if (!utf8.includes('�')) return utf8;
  let out = '';
  for (const byte of buf) {
    out += byte < 0x80 ? String.fromCharCode(byte) : CP850_HIGH[byte - 0x80];
  }
  return out;
}

/** Read the tail of a captured stream log (for failed_silent diagnostics). */
export function readLogTail(root: string, assignmentId: string, stream: 'stdout' | 'stderr', maxBytes = 2000, runId?: string): string {
  try {
    const p = getRuntimeLogPath(root, assignmentId, stream, runId);
    const buf = fs.readFileSync(p);
    let slice = buf.length > maxBytes ? buf.subarray(buf.length - maxBytes) : buf;
    // A byte-offset tail can start mid-UTF-8-sequence; dropping leading
    // continuation bytes avoids a false U+FFFD that would trigger the cp850
    // fallback on genuine UTF-8 content.
    while (slice.length > 0 && slice[0] >= 0x80 && slice[0] <= 0xbf) {
      slice = slice.subarray(1);
    }
    return decodeOemAwareBuffer(slice);
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
 * fixing the false-`stalled` verdict (field debrief P1#1). Returns undefined
 * when nothing is observable.
 */
export function latestActivityMs(root: string, assignmentId: string, worktreePath?: string, runId?: string): number | undefined {
  let latest: number | undefined;
  const bump = (ms: number | undefined): void => {
    if (ms !== undefined && (latest === undefined || ms > latest)) latest = ms;
  };
  for (const stream of ['stdout', 'stderr'] as const) {
    try { bump(fs.statSync(getRuntimeLogPath(root, assignmentId, stream, runId)).mtimeMs); } catch { /* no log */ }
  }
  if (worktreePath) bump(latestWorktreeFileMtimeMs(worktreePath));
  return latest;
}
