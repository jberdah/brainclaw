import readline from 'node:readline';
import { memoryExists } from '../core/io.js';
import {
  acquireBootstrapLoop,
  BootstrapCoordinationInProgressError,
  closeLoop,
  computeNextExpected,
  findExistingBootstrapLoop,
  type LoopArtifact,
  type LoopStatus,
  type LoopThread,
  type NextExpectedHint,
  type OperatorQuestionBody,
} from '../core/loops/index.js';
import { resolveCurrentAgentName } from '../core/agent-registry.js';

export interface BootstrapLoopCommandOptions {
  status?: boolean;
  cancel?: boolean;
  yes?: boolean;
  json?: boolean;
}

export type BootstrapLoopAction = 'opened' | 'joined' | 'status' | 'cancelled';

export interface BootstrapLoopResult {
  ok: boolean;
  action: BootstrapLoopAction;
  loop_id: string;
  current_phase?: string;
  status?: LoopStatus;
  open_questions?: string[];
  pause_reason?: string;
  pending_file_apply?: {
    target_path: string;
    artifact_id: string;
    diff_artifact_id: string;
  };
  next_expected?: NextExpectedHint | null;
  warnings?: string[];
  /**
   * pln#513 Phase 4 codex review fix — set to true when `action === 'joined'`,
   * matching the structural flag returned by
   * bclaw_coordinate(intent='ideate', preset='bootstrap'). Lets JSON/MCP
   * consumers branch on a single field regardless of which entry point
   * (CLI vs facade) produced the response.
   */
  joined_existing?: true;
}

function fail(message: string, exitCode: 1 | 2, opts: BootstrapLoopCommandOptions): never {
  if (opts.json) {
    console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  } else {
    console.error(`Error: ${message}`);
  }
  process.exit(exitCode);
}

function parseQuestionBody(artifact: LoopArtifact): OperatorQuestionBody | undefined {
  if (artifact.type !== 'operator_question' || !artifact.body) return undefined;
  try {
    return JSON.parse(artifact.body) as OperatorQuestionBody;
  } catch {
    return undefined;
  }
}

function formatNextExpected(hint: NextExpectedHint | null): string {
  if (!hint) return '  (loop has no further expected action)';
  const bits: string[] = [`  next: ${hint.action} (${hint.intent})`];
  if (hint.phase) bits.push(`  phase: ${hint.phase}`);
  if (hint.slot_id) bits.push(`  slot: ${hint.slot_id}${hint.role ? ` [${hint.role}]` : ''}`);
  if (hint.from_phase && hint.to_phase) bits.push(`  ${hint.from_phase} → ${hint.to_phase}`);
  if (hint.blocking_on.length) bits.push(`  blocking_on: ${hint.blocking_on.join(', ')}`);
  if (hint.reason) bits.push(`  reason: ${hint.reason}`);
  return bits.join('\n');
}

function buildResult(action: BootstrapLoopAction, loop: LoopThread): BootstrapLoopResult {
  const hint = action === 'cancelled' ? null : computeNextExpected(loop);
  const openQuestions = loop.open_questions;
  const result: BootstrapLoopResult = {
    ok: true,
    action,
    loop_id: loop.id,
    current_phase: loop.current_phase,
    status: loop.status,
    open_questions: openQuestions,
    next_expected: hint,
  };
  if (loop.pause_reason) {
    result.pause_reason = loop.pause_reason;
  }
  if (loop.pending_file_apply) {
    result.pending_file_apply = {
      target_path: loop.pending_file_apply.target_path,
      artifact_id: loop.pending_file_apply.artifact_id,
      diff_artifact_id: loop.pending_file_apply.diff_artifact_id,
    };
  }
  if (action === 'joined') {
    result.joined_existing = true;
  }
  return result;
}

function printHuman(result: BootstrapLoopResult, loop: LoopThread): void {
  const prefix =
    result.action === 'opened'
      ? '✔ Opened bootstrap loop'
      : result.action === 'joined'
        ? '↺ Joined existing bootstrap loop'
        : result.action === 'cancelled'
          ? '✔ Cancelled bootstrap loop'
          : '• Bootstrap loop status';
  console.log(`${prefix} ${loop.id}`);
  console.log(`  phase: ${loop.current_phase}`);
  console.log(`  status: ${loop.status}`);
  if (result.pause_reason) {
    console.log(`  pause_reason: ${result.pause_reason}`);
  }
  if (loop.open_questions.length > 0) {
    console.log(`  open_questions: ${loop.open_questions.length} (${loop.open_questions.join(', ')})`);
    for (const q of loop.artifacts) {
      const body = parseQuestionBody(q);
      if (body && loop.open_questions.includes(body.question_id)) {
        console.log(`    - ${body.question_id}: ${body.question_text}`);
      }
    }
  }
  if (result.pending_file_apply) {
    console.log(`  pending_file_apply: ${result.pending_file_apply.target_path}`);
  }
  if (loop.slots.length > 0) {
    const slotDesc = loop.slots
      .map((s) => `${s.role}${s.agent ? `=${s.agent}` : ''} [${s.status}]`)
      .join(', ');
    console.log(`  slots: ${slotDesc}`);
  }
  if (result.action !== 'cancelled') {
    console.log(formatNextExpected(result.next_expected ?? null));
  }
}

async function confirmCancel(loopId: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(
        `Cancel bootstrap loop ${loopId}? This sets status='cancelled'. [y/N] `,
        (a) => resolve(a),
      );
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * `brainclaw bootstrap-loop` — open, join, query, or cancel the bootstrap
 * loop on the current project. The open/join path delegates to
 * `acquireBootstrapLoop` (src/core/loops/bootstrap-acquire.ts) which
 * implements the same coordination-lock singleton acquire used by the MCP
 * bclaw_coordinate facade. Two concurrent CLI invocations will now converge
 * on the same loop rather than opening duplicates (pln#518 step 1).
 */
export async function runBootstrapLoopCommand(
  options: BootstrapLoopCommandOptions = {},
  cwd?: string,
): Promise<void> {
  if (!memoryExists(cwd)) {
    fail('.brainclaw/ not found. Run `brainclaw init` first.', 1, options);
  }

  const modes: string[] = [];
  if (options.status) modes.push('--status');
  if (options.cancel) modes.push('--cancel');
  if (modes.length > 1) {
    fail(`--status and --cancel are mutually exclusive (got: ${modes.join(', ')})`, 1, options);
  }

  if (options.status) {
    const existing = findExistingBootstrapLoop(cwd);
    if (!existing) {
      fail(
        'no active bootstrap loop on this project. Run `brainclaw bootstrap-loop` to open one.',
        1,
        options,
      );
    }
    const result = buildResult('status', existing);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    printHuman(result, existing);
    return;
  }

  if (options.cancel) {
    const existing = findExistingBootstrapLoop(cwd);
    if (!existing) {
      fail(
        'no active bootstrap loop to cancel on this project.',
        1,
        options,
      );
    }
    if (!options.yes) {
      const confirmed = await confirmCancel(existing.id);
      if (!confirmed) {
        fail('cancellation aborted by operator.', 1, options);
      }
    }
    const actor = resolveCurrentAgentName(cwd);
    let closed: LoopThread;
    try {
      closed = closeLoop(
        {
          id: existing.id,
          final_status: 'cancelled',
          reason: 'operator_cancelled',
          actor,
        },
        cwd,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fail(`closeLoop verb rejected the call: ${msg}`, 2, options);
    }
    const result = buildResult('cancelled', closed);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    printHuman(result, closed);
    return;
  }

  // No-args: delegate to the singleton acquire path (pln#518 step 1).
  // acquireBootstrapLoop handles find-existing + coordination-lock + openLoop,
  // preventing two concurrent CLI invocations from both calling openLoop.
  const actor = resolveCurrentAgentName(cwd);
  let loop: LoopThread;
  let action: 'opened' | 'joined';
  try {
    const acquired = acquireBootstrapLoop({ actor }, cwd);
    loop = acquired.loop;
    action = acquired.action;
  } catch (err) {
    if (err instanceof BootstrapCoordinationInProgressError) {
      fail(err.message, 2, options);
    }
    const msg = err instanceof Error ? err.message : String(err);
    fail(`bootstrap-loop acquire failed: ${msg}`, 2, options);
  }
  const result = buildResult(action, loop);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printHuman(result, loop);
}
