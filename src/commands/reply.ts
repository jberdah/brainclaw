import { memoryExists } from '../core/io.js';
import { listLoops, provideInput } from '../core/loops/index.js';
import type { ProvideInputResult } from '../core/loops/index.js';
import { resolveCurrentAgentName } from '../core/agent-registry.js';
import type {
  LoopArtifact,
  LoopSlot,
  LoopThread,
  OperatorAnswerBody,
  OperatorQuestionBody,
} from '../core/loops/types.js';

export interface ReplyCommandOptions {
  answer?: string;
  choose?: string;
  skip?: boolean;
  json?: boolean;
}

export interface ReplyCommandResult {
  ok: boolean;
  loop_id: string;
  question_id: string;
  resolved_via: 'answer' | 'choose' | 'skip';
  artifact_id?: string;
  next_expected: NextExpectedHint | null;
  duplicate?: boolean;
}

export interface NextExpectedHint {
  action: 'turn' | 'complete_turn' | 'provide_input' | 'advance' | 'close';
  intent: string;
  reason?: string;
  phase?: string;
  slot_id?: string;
  role?: string;
  from_phase?: string;
  to_phase?: string;
  blocking_on: string[];
}

function fail(message: string, exitCode: 1 | 2, opts: ReplyCommandOptions): never {
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

function parseAnswerBody(artifact: LoopArtifact): OperatorAnswerBody | undefined {
  if (artifact.type !== 'operator_answer' || !artifact.body) return undefined;
  try {
    return JSON.parse(artifact.body) as OperatorAnswerBody;
  } catch {
    return undefined;
  }
}

function findLoopForQuestion(
  loops: LoopThread[],
  questionId: string,
): { loop: LoopThread; question: OperatorQuestionBody; isOpen: boolean; existingAnswer?: OperatorAnswerBody } | undefined {
  for (const loop of loops) {
    for (const artifact of loop.artifacts) {
      const body = parseQuestionBody(artifact);
      if (body && body.question_id === questionId) {
        const isOpen = loop.open_questions.includes(questionId);
        let existingAnswer: OperatorAnswerBody | undefined;
        if (!isOpen) {
          for (const a of loop.artifacts) {
            const ab = parseAnswerBody(a);
            if (ab && ab.replies_to === questionId) {
              existingAnswer = ab;
              break;
            }
          }
        }
        return { loop, question: body, isOpen, existingAnswer };
      }
    }
  }
  return undefined;
}

function computeNextExpected(loop: LoopThread): NextExpectedHint | null {
  if (loop.status === 'completed' || loop.status === 'cancelled' || loop.status === 'blocked') {
    return null;
  }
  if (loop.open_questions.length > 0) {
    return {
      action: 'provide_input',
      intent: 'bclaw_loop.provide_input',
      reason: loop.status === 'paused' ? loop.pause_reason : 'awaiting_operator',
      blocking_on: [...loop.open_questions],
    };
  }
  if (loop.status === 'paused') {
    return null;
  }

  const currentPhaseSlots: LoopSlot[] = loop.slots.filter(
    (s) => (s.phase ?? loop.current_phase) === loop.current_phase,
  );
  const openSlots = currentPhaseSlots.filter((s) => s.status === 'open');
  if (openSlots.length > 0) {
    const first = openSlots[0];
    return {
      action: 'turn',
      intent: 'bclaw_loop.turn',
      phase: loop.current_phase,
      slot_id: first.slot_id,
      role: first.role,
      blocking_on: openSlots.map((s) => s.slot_id),
    };
  }
  const assignedOrWorking = currentPhaseSlots.filter(
    (s) => s.status === 'assigned' || s.status === 'working',
  );
  if (assignedOrWorking.length > 0) {
    return {
      action: 'complete_turn',
      intent: 'bclaw_loop.complete_turn',
      phase: loop.current_phase,
      slot_id: assignedOrWorking[0].slot_id,
      role: assignedOrWorking[0].role,
      blocking_on: assignedOrWorking.map((s) => s.slot_id),
    };
  }

  const phaseNames = loop.phases.map((p) => p.name);
  const currentIndex = phaseNames.indexOf(loop.current_phase);
  if (currentIndex >= 0 && currentIndex + 1 < phaseNames.length) {
    return {
      action: 'advance',
      intent: 'bclaw_loop.advance',
      from_phase: loop.current_phase,
      to_phase: phaseNames[currentIndex + 1],
      blocking_on: [],
    };
  }

  return {
    action: 'close',
    intent: 'bclaw_loop.close',
    reason: 'terminal_phase_reached',
    blocking_on: [],
  };
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

/**
 * `brainclaw reply <qst_id>` — wraps the provideInput verb. Locates the loop
 * containing the question, validates the requested resolution against the
 * question's options/suggested_default, and prints the resulting next_expected
 * hint on success.
 *
 * Exit codes:
 *   0 — success.
 *   1 — validation error (unknown qst, already resolved, mutually-exclusive
 *       flags, missing flags, invalid option id, --skip without default).
 *   2 — verb threw a domain error (e.g. terminal loop status).
 */
export function runReplyCommand(
  questionId: string,
  options: ReplyCommandOptions = {},
  cwd?: string,
): ReplyCommandResult {
  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  // Validate mutually-exclusive resolution flags.
  const modes: Array<'answer' | 'choose' | 'skip'> = [];
  if (options.answer !== undefined) modes.push('answer');
  if (options.choose !== undefined) modes.push('choose');
  if (options.skip) modes.push('skip');
  if (modes.length === 0) {
    fail(
      'reply requires exactly one of --answer <text>, --choose <option_id>, or --skip',
      1,
      options,
    );
  }
  if (modes.length > 1) {
    fail(
      `--answer, --choose, and --skip are mutually exclusive (got: ${modes.join(', ')})`,
      1,
      options,
    );
  }
  const mode = modes[0];

  // Validate qst id format up-front so we can give a nicer error than
  // "unknown question" for typos like `brainclaw reply foo`.
  if (!/^qst_[0-9a-z]+$/.test(questionId)) {
    fail(
      `invalid question_id "${questionId}" — expected format qst_<hex>`,
      1,
      options,
    );
  }

  const loops = listLoops({}, cwd);
  const located = findLoopForQuestion(loops, questionId);
  if (!located) {
    fail(
      `question not found: ${questionId} (run \`brainclaw questions\` to list pending questions)`,
      1,
      options,
    );
  }

  const { loop, question, isOpen, existingAnswer } = located;

  if (!isOpen) {
    if (mode === 'answer' || mode === 'choose') {
      const detail = existingAnswer
        ? ` (resolved via ${existingAnswer.resolved_via}${
            existingAnswer.by === 'system' ? ', synthetic' : ''
          })`
        : '';
      fail(
        `question already resolved: ${questionId}${detail}`,
        1,
        options,
      );
    }
    // --skip on an already-resolved question is treated as idempotent replay:
    // provideInput's idempotent path returns the existing answer artifact.
  }

  if (mode === 'choose') {
    const optionId = options.choose!;
    const opts = question.options ?? [];
    const found = opts.find((o) => o.id === optionId);
    if (!found) {
      const known = opts.map((o) => o.id).join(', ') || '<none>';
      fail(
        `--choose ${optionId}: question ${questionId} has no such option (known: ${known})`,
        1,
        options,
      );
    }
  }

  if (mode === 'skip' && question.suggested_default === undefined) {
    fail(
      `--skip on ${questionId}: source question has no suggested_default to materialize`,
      1,
      options,
    );
  }

  const actor = resolveCurrentAgentName(cwd);
  const resolvedVia: 'answer' | 'choose' | 'skip' =
    mode === 'answer' ? 'answer' : mode === 'choose' ? 'choose' : 'skip';

  let result: ProvideInputResult;
  try {
    result = provideInput(
      {
        loop_id: loop.id,
        replies_to: questionId,
        resolved_via: resolvedVia,
        answer_text: mode === 'answer' ? options.answer : undefined,
        chosen_option_id: mode === 'choose' ? options.choose : undefined,
        actor,
      },
      cwd,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(`provide_input verb rejected the call: ${message}`, 2, options);
  }

  const hint = computeNextExpected(result.thread);
  const out: ReplyCommandResult = {
    ok: true,
    loop_id: loop.id,
    question_id: questionId,
    resolved_via: resolvedVia,
    artifact_id: result.artifact_id,
    next_expected: hint,
    duplicate: result.duplicate || undefined,
  };

  if (options.json) {
    console.log(JSON.stringify(out, null, 2));
    return out;
  }

  const prefix = result.duplicate ? '↺ Replay-acked' : '✔ Answered';
  console.log(`${prefix} ${questionId} via ${resolvedVia} on loop ${loop.id}`);
  console.log(formatNextExpected(hint));
  return out;
}
