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
import { getLoop } from './store.js';
import { withLoopLock } from './lock.js';
import { add_artifact } from './verbs.js';
import { artifactsInIteration } from './iteration-engine.js';
import { VERIFY_DEFAULT_TIMEOUT_MS, type LoopThread, type VerifyReportBody } from './types.js';

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
 * Resolve the verify command for a loop. PR1: the loop-PROJECT cwd only (the
 * lane-worktree cwd for a sequenced impl loop is a follow-up). Returns `unconfigured`
 * when the loop opted out (no `protocol.verify`).
 */
export function resolveVerifyCommand(thread: LoopThread, cwd: string | undefined): ResolvedVerify {
  const cfg = thread.protocol?.verify;
  if (!cfg) return { kind: 'unconfigured' };
  return {
    kind: 'ok',
    config: {
      command: cfg.command,
      cwd: path.resolve(cwd ?? process.cwd()),
      timeout_ms: cfg.timeout_ms ?? VERIFY_DEFAULT_TIMEOUT_MS,
    },
  };
}

export function buildVerifyReportBody(config: VerifyCommandConfig, result: VerifyRunResult): VerifyReportBody {
  return {
    command: config.command.join(' '),
    exit_code: result.exit_code,
    passed: result.passed,
    duration_ms: result.duration_ms,
    cwd: config.cwd,
    timed_out: result.timed_out,
    stdout_tail: result.stdout_tail || undefined,
    stderr_tail: result.stderr_tail || undefined,
  };
}

export interface RunVerifyInput {
  loop_id: string;
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

/** True when a verify_report already exists in this iteration (idempotency key = loop+iteration). */
function hasVerifyReportForIteration(thread: LoopThread, iteration: number): boolean {
  return artifactsInIteration(thread, iteration).some((a) => a.type === 'verify_report');
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
    | { state: 'run'; thread: LoopThread; config: VerifyCommandConfig; iteration: number }
  >({
    cwd,
    intent: 'verify',
    agentId: input.actor,
    scope: { kind: 'loop', loopId: input.loop_id },
    work: () => {
      const thread = getLoop(input.loop_id, cwd);
      if (!thread) throw new Error(`loop ${input.loop_id} not found`);
      const resolved = resolveVerifyCommand(thread, cwd);
      if (resolved.kind === 'unconfigured') return { state: 'unconfigured', thread };
      const iteration = thread.iteration_count;
      if (hasVerifyReportForIteration(thread, iteration)) return { state: 'deduped', thread };
      return { state: 'run', thread, config: resolved.config, iteration };
    },
  });

  if (snapshot.state === 'unconfigured') return { thread: snapshot.thread, deduped: false, unconfigured: true };
  if (snapshot.state === 'deduped') return { thread: snapshot.thread, deduped: true };

  // --- OUT OF LOCK: run the command (may take minutes). ---
  const { config, iteration } = snapshot;
  const report = buildVerifyReportBody(config, runner(config));

  // --- Lock scope 2: re-check idempotency, then append via add_artifact. ---
  return withLoopLock<RunVerifyResult>({
    cwd,
    intent: 'verify',
    agentId: input.actor,
    scope: { kind: 'loop', loopId: input.loop_id },
    work: () => {
      const thread = getLoop(input.loop_id, cwd);
      if (!thread) throw new Error(`loop ${input.loop_id} not found`);
      // A concurrent verify for the SAME iteration won the append while we spawned.
      if (thread.iteration_count === iteration && hasVerifyReportForIteration(thread, iteration)) {
        return { thread, report, deduped: true };
      }
      const updated = add_artifact(
        {
          id: input.loop_id,
          actor: input.actor,
          artifact: {
            phase: thread.current_phase,
            type: 'verify_report',
            body: JSON.stringify(report),
            produced_by: 'engine',
          },
        },
        cwd,
      );
      const art = updated.artifacts[updated.artifacts.length - 1];
      return { thread: updated, report, deduped: false, report_artifact_id: art?.artifact_id };
    },
  });
}
