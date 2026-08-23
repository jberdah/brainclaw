/**
 * pln#632 — engine-run verify-command runner (pln#609 Increment 2).
 *
 * Makes the loop `command_green` gate DETERMINISTIC: brainclaw itself runs the
 * configured verify command (tests/build/lint) and records a `verify_report`, instead
 * of trusting an agent-narrated one. The iteration engine already READS a passing
 * verify_report (iteration-engine.ts hasPassingVerifyReportInIteration); this module is
 * the execution seam it referenced.
 *
 * SECURITY (the whole point of the runner):
 *  - PROVENANCE: the command comes only from `thread.protocol.verify` (set by the loop
 *    OPENER at open), never from the worker under test — that is the determinism
 *    guarantee (a tested agent cannot fabricate green by supplying `['true']`).
 *  - argv ARRAY, `shell:false` — no `;`/`&&`/`$()` injection surface. A pipeline is an
 *    explicit `['bash','-lc','npm test && npm run lint']` the operator owns.
 *  - ENV SANITIZATION: every `BRAINCLAW_*` (+ `BCLAW_PROMPT_FILE`) is stripped from the
 *    child env so the spawned suite can't hit the REAL brainclaw store
 *    (trap_agent_shell_env_contaminates_tests).
 *  - BOUNDED: a timeout (→ passed:false, timed_out:true) + a maxBuffer cap.
 *
 * The long spawn runs OUT of the loop lock (two lock scopes with the spawn between),
 * so a multi-minute test run never holds the lock past its deadline. Opt-out: no
 * `protocol.verify` → a typed `unconfigured` result; the agent-narrated path is unchanged.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { loadAssignment } from '../assignments.js';
import { getLoop } from './store.js';
import { withLoopLock } from './lock.js';
import { addArtifactWithEvidence } from './verbs.js';
import { artifactsInIteration } from './iteration-engine.js';
import { evidenceDigest } from './evidence.js';
import { eligibleArtifactsForPurpose } from './gate-policy.js';
import { captureWorkspaceDigest } from './workspace-digest.js';
import {
  VERIFY_DEFAULT_TIMEOUT_MS,
  LOOP_ARTIFACT_BODY_MAX_BYTES,
  type LoopThread,
  type VerifyReportBody,
} from './types.js';

export interface VerifyCommandConfig {
  command: string[];
  cwd: string;
  timeout_ms: number;
}

export interface VerifyRunResult {
  exit_code: number | null;
  passed: boolean;
  timed_out: boolean;
  duration_ms: number;
  stdout_tail: string;
  stderr_tail: string;
}

/** Injectable for tests; production uses {@link defaultVerifyRunner}. */
export type VerifyRunner = (config: VerifyCommandConfig) => VerifyRunResult;

/** VerifyReportBodySchema caps stdout_tail/stderr_tail at 1024. */
const TAIL_MAX = 1024;
function tail(s: string): string {
  return s.length <= TAIL_MAX ? s : s.slice(s.length - TAIL_MAX);
}

/**
 * The one security-critical function: spawnSync the verify command with `shell:false`,
 * a SANITIZED env (all BRAINCLAW_* + BCLAW_PROMPT_FILE removed), a bounded timeout and
 * maxBuffer. Timeout → passed:false, timed_out:true, exit_code:null. A spawn error
 * (ENOENT — misconfigured command) → passed:false with the message in stderr_tail
 * (stays RED, so the loop hits max_iterations → blocked, never a false green).
 */
export const defaultVerifyRunner: VerifyRunner = (config) => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('BRAINCLAW_') || k === 'BCLAW_PROMPT_FILE') delete env[k];
  }
  const started = Date.now();
  const r = spawnSync(config.command[0]!, config.command.slice(1), {
    cwd: config.cwd,
    env,
    shell: false,
    encoding: 'utf-8',
    timeout: config.timeout_ms,
    maxBuffer: 8 * 1024 * 1024,
  });
  const duration_ms = Date.now() - started;
  const err = r.error as NodeJS.ErrnoException | undefined;
  const stdout_tail = tail(r.stdout ?? '');

  if (err?.code === 'ETIMEDOUT') {
    return { exit_code: null, passed: false, timed_out: true, duration_ms, stdout_tail, stderr_tail: tail(r.stderr ?? '') };
  }
  if (err) {
    // Could not RUN the command (ENOENT, EACCES, …) — red, with the reason.
    return { exit_code: null, passed: false, timed_out: false, duration_ms, stdout_tail, stderr_tail: tail(String(err.message ?? err)) };
  }
  return {
    exit_code: r.status,
    passed: r.status === 0,
    timed_out: false,
    duration_ms,
    stdout_tail,
    stderr_tail: tail(r.stderr ?? ''),
  };
};

export type ResolvedVerify = { kind: 'ok'; config: VerifyCommandConfig } | { kind: 'unconfigured' };

/**
 * Resolve the verify command for a loop. Bound implementation lanes run only
 * in their assignment worktree; legacy/unbound loops retain the project cwd.
 * Returns `unconfigured` when the loop opted out (no `protocol.verify`).
 */
export function resolveVerifyCommand(thread: LoopThread, cwd: string | undefined, slotId?: string): ResolvedVerify {
  const cfg = thread.protocol?.verify;
  if (!cfg) return { kind: 'unconfigured' };
  let verifyCwd = path.resolve(cwd ?? process.cwd());
  if (thread.kind === 'implementation') {
    const selected = slotId ? thread.slots.find((slot) => slot.slot_id === slotId) : undefined;
    if (slotId && !selected) throw new Error(`verify: slot ${slotId} not found on loop ${thread.id}`);
    const candidates = (selected ? [selected] : thread.slots)
      .filter((slot) => slot.assignment_id)
      .map((slot) => ({ slot, assignment: loadAssignment(slot.assignment_id!, cwd) }))
      .filter((entry) => entry.assignment?.worktree_path);
    if (!selected && candidates.length > 1) {
      throw new Error(`verify: implementation loop ${thread.id} has multiple bound worktrees; pass slot_id to verify one lane deterministically`);
    }
    if (!selected && thread.slots.some((slot) => slot.lane) && candidates.length === 0) {
      throw new Error(`verify: implementation loop ${thread.id} has bound lanes but no assignment worktree; dispatch and settle the execute turn first`);
    }
    const candidate = candidates[0];
    if (selected?.assignment_id && !candidate?.assignment?.worktree_path) {
      throw new Error(`verify: slot ${selected.slot_id} assignment ${selected.assignment_id} has no worktree_path`);
    }
    if (candidate?.assignment?.worktree_path) verifyCwd = path.resolve(candidate.assignment.worktree_path);
  }
  return {
    kind: 'ok',
    config: {
      command: cfg.command,
      cwd: verifyCwd,
      timeout_ms: cfg.timeout_ms ?? VERIFY_DEFAULT_TIMEOUT_MS,
    },
  };
}

/**
 * pln#632 (review F2) — ensure the SERIALIZED body fits add_artifact's 4 KiB byte limit.
 * Each tail is ≤1024 CHARS (schema-valid), but multibyte / ANSI output can make the
 * JSON body exceed LOOP_ARTIFACT_BODY_MAX_BYTES *bytes* (a control char JSON-escapes to
 * 6 bytes), which would make add_artifact throw and drop a green suite's report. Shrink
 * the tails (halving) until the serialized body fits; last resort drops the tails.
 */
function fitBody(report: VerifyReportBody): VerifyReportBody {
  const size = (r: VerifyReportBody): number => Buffer.byteLength(JSON.stringify(r), 'utf8');
  if (size(report) <= LOOP_ARTIFACT_BODY_MAX_BYTES) return report;
  for (let keep = 512; keep >= 1; keep = Math.floor(keep / 2)) {
    const r: VerifyReportBody = {
      ...report,
      stdout_tail: report.stdout_tail ? report.stdout_tail.slice(-keep) : undefined,
      stderr_tail: report.stderr_tail ? report.stderr_tail.slice(-keep) : undefined,
    };
    if (size(r) <= LOOP_ARTIFACT_BODY_MAX_BYTES) return r;
  }
  return { ...report, stdout_tail: undefined, stderr_tail: undefined };
}

interface VerifyEvidenceBindings {
  command_digest: string;
  workspace_digest: string;
  workspace_stable: boolean;
  lane?: string;
}

export function buildVerifyReportBody(
  config: VerifyCommandConfig,
  result: VerifyRunResult,
  bindings?: VerifyEvidenceBindings,
): VerifyReportBody {
  return fitBody({
    command: config.command.join(' '),
    command_argv: config.command,
    exit_code: result.exit_code,
    passed: result.passed,
    duration_ms: result.duration_ms,
    cwd: config.cwd,
    timed_out: result.timed_out,
    stdout_tail: result.stdout_tail || undefined,
    stderr_tail: result.stderr_tail || undefined,
    ...bindings,
  });
}

export interface RunVerifyInput {
  loop_id: string;
  slot_id?: string;
  actor: string;
  /** Test seam; defaults to {@link defaultVerifyRunner}. */
  runner?: VerifyRunner;
}

export interface RunVerifyResult {
  thread: LoopThread;
  report?: VerifyReportBody;
  /** A verify_report already existed for this iteration — nothing appended. */
  deduped: boolean;
  /** The loop has no `protocol.verify` — agent-narrated path unchanged. */
  unconfigured?: boolean;
  report_artifact_id?: string;
}

/** True when an authoritative, still-fresh engine report exists for this iteration. */
function hasVerifyReportForIteration(thread: LoopThread, iteration: number, lane?: string): boolean {
  const reports = artifactsInIteration(thread, iteration).filter((artifact) => {
    if (artifact.type !== 'verify_report') return false;
    if (!lane) return true;
    try { return (JSON.parse(artifact.body ?? '{}') as { lane?: string }).lane === lane; }
    catch { return false; }
  });
  return eligibleArtifactsForPurpose(thread, reports, 'command_green').eligible.length > 0;
}

/**
 * Run the configured verify command and record a deterministic `verify_report` for the
 * loop's CURRENT iteration/phase. Two lock scopes with the spawn BETWEEN them: scope 1
 * reads the command + iteration + idempotency pre-check; the command runs OUT of the
 * lock; scope 2 re-checks idempotency (a concurrent verify may have appended while we
 * spawned) and appends via the existing `add_artifact` verb (which auto-stamps the
 * iteration). Does NOT advance — the report is a fact; exiting the cycle stays a
 * separate `advance` call by the driver.
 */
export function runVerify(input: RunVerifyInput, cwd?: string): RunVerifyResult {
  const runner = input.runner ?? defaultVerifyRunner;

  // --- Lock scope 1: read config + iteration; idempotency pre-check; snapshot. ---
  const snapshot = withLoopLock<
    | { state: 'unconfigured'; thread: LoopThread }
    | { state: 'deduped'; thread: LoopThread }
    | { state: 'run'; thread: LoopThread; config: VerifyCommandConfig; iteration: number; phase: string; lane?: string }
  >({
    cwd,
    intent: 'verify',
    agentId: input.actor,
    scope: { kind: 'loop', loopId: input.loop_id },
    work: () => {
      const thread = getLoop(input.loop_id, cwd);
      if (!thread) throw new Error(`loop ${input.loop_id} not found`);
      const inferredSlots = thread.kind === 'implementation' && !input.slot_id
        ? thread.slots.filter((slot) => slot.assignment_id && loadAssignment(slot.assignment_id, cwd)?.worktree_path)
        : [];
      const selectedSlot = input.slot_id
        ? thread.slots.find((slot) => slot.slot_id === input.slot_id)
        : inferredSlots.length === 1 ? inferredSlots[0] : undefined;
      const lane = selectedSlot?.lane;
      const resolved = resolveVerifyCommand(thread, cwd, selectedSlot?.slot_id ?? input.slot_id);
      if (resolved.kind === 'unconfigured') return { state: 'unconfigured', thread };
      const iteration = thread.iteration_count;
      if (hasVerifyReportForIteration(thread, iteration, lane)) return { state: 'deduped', thread };
      // Snapshot the iteration + phase we are about to verify. The command tests THIS
      // iteration's working tree; the report must be attributed to it even if a
      // concurrent advance bumps the loop's iteration while we spawn (review F1).
      return { state: 'run', thread, config: resolved.config, iteration, phase: thread.current_phase, lane };
    },
  });

  if (snapshot.state === 'unconfigured') return { thread: snapshot.thread, deduped: false, unconfigured: true };
  if (snapshot.state === 'deduped') return { thread: snapshot.thread, deduped: true };

  // --- OUT OF LOCK: run the command (may take minutes). ---
  const { config, iteration, phase, lane } = snapshot;
  const command_digest = evidenceDigest({ command: config.command });
  const workspaceBefore = captureWorkspaceDigest(config.cwd);
  const runResult = runner(config);
  const workspaceAfter = captureWorkspaceDigest(config.cwd);
  const workspace_stable = workspaceBefore === workspaceAfter;
  const reportAfterRun = buildVerifyReportBody(
    config,
    { ...runResult, passed: runResult.passed && workspace_stable },
    { command_digest, workspace_digest: workspaceAfter, workspace_stable, lane },
  );

  // --- Lock scope 2: re-check idempotency (by SNAPSHOT iteration), then append. ---
  return withLoopLock<RunVerifyResult>({
    cwd,
    intent: 'verify',
    agentId: input.actor,
    scope: { kind: 'loop', loopId: input.loop_id },
    work: () => {
      const thread = getLoop(input.loop_id, cwd);
      if (!thread) throw new Error(`loop ${input.loop_id} not found`);
      // Dedup on the SNAPSHOT iteration — a report for the iteration we verified already
      // landed (a concurrent verify won). Checking the snapshot (not the current)
      // iteration is what makes this correct after a concurrent advance (review F1).
      if (hasVerifyReportForIteration(thread, iteration, lane)) {
        return { thread, report: reportAfterRun, deduped: true };
      }
      // Close the final out-of-lock race: the bytes verified above must still be the
      // bytes present at the evidence commit boundary. A later gate independently
      // repeats this freshness check so a post-commit mutation also fails closed.
      const workspaceAtCommit = captureWorkspaceDigest(config.cwd);
      const commitStable = workspace_stable && workspaceAtCommit === workspaceAfter;
      const report = buildVerifyReportBody(
        config,
        { ...runResult, passed: runResult.passed && commitStable },
        { command_digest, workspace_digest: workspaceAtCommit, workspace_stable: commitStable, lane },
      );
      const updated = addArtifactWithEvidence(
        {
          id: input.loop_id,
          actor: input.actor,
          evidence_context: {
            channel: 'verify_command',
            producer_kind: 'engine',
            producer_id: 'brainclaw:verify-command',
            command_digest,
            workspace_digest: workspaceAtCommit,
          },
          artifact: {
            // Stamp the SNAPSHOT phase + iteration so the report is attributed to the
            // iteration whose code it actually tested — never a later iteration a
            // concurrent advance moved the loop to (which would be a FALSE green).
            phase,
            iteration,
            type: 'verify_report',
            body: JSON.stringify(report),
          },
        },
        cwd,
      );
      const art = updated.artifacts[updated.artifacts.length - 1];
      return { thread: updated, report, deduped: false, report_artifact_id: art?.artifact_id };
    },
  });
}
