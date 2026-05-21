import { memoryExists } from '../core/io.js';
import { listLoops, listLoopEvents } from '../core/loops/index.js';
import type {
  LoopArtifact,
  LoopThread,
  OperatorAnswerBody,
  OperatorQuestionBody,
  OperatorQuestionOption,
  OnTimeoutPolicy,
  PauseScope,
} from '../core/loops/types.js';
import { resolveCurrentAgentName } from '../core/agent-registry.js';

export type QuestionStatus = 'awaiting' | 'answered' | 'timed_out';

export interface QuestionsCommandOptions {
  loop?: string;
  status?: QuestionStatus;
  mine?: boolean;
  json?: boolean;
}

export interface QuestionAnswer {
  resolved_via: 'answer' | 'choose' | 'skip' | 'timeout_default';
  answer_text?: string;
  chosen_option_id?: string;
  by: 'operator' | 'system';
  synthetic: boolean;
  produced_at: string;
}

export interface QuestionRow {
  question_id: string;
  loop_id: string;
  loop_title: string;
  phase: string;
  status: QuestionStatus;
  question_text: string;
  evidence: string[];
  suggested_default?: string;
  options?: OperatorQuestionOption[];
  pause_scope: PauseScope;
  on_timeout: OnTimeoutPolicy;
  timeout_at?: string;
  produced_at: string;
  age_seconds: number;
  answer?: QuestionAnswer;
}

export interface QuestionsCommandResult {
  questions: QuestionRow[];
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

function relativeAge(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function findAnswerFor(loop: LoopThread, questionId: string): { artifact: LoopArtifact; body: OperatorAnswerBody } | undefined {
  for (const artifact of loop.artifacts) {
    const body = parseAnswerBody(artifact);
    if (body && body.replies_to === questionId) {
      return { artifact, body };
    }
  }
  return undefined;
}

function loopWasTimedOut(loop: LoopThread, questionId: string, cwd?: string): boolean {
  if (loop.status === 'cancelled') {
    // Check events for pause_timeout that targeted this question with cancel_loop
    try {
      const events = listLoopEvents(loop.id, cwd);
      for (const ev of events) {
        if (ev.kind === 'pause_timeout' && ev.question_id === questionId && ev.action_taken === 'cancel_loop') {
          return true;
        }
      }
    } catch {
      // ignore
    }
  }
  return false;
}

function determineStatus(
  loop: LoopThread,
  questionBody: OperatorQuestionBody,
  cwd: string | undefined,
): { status: QuestionStatus; answer?: QuestionAnswer } {
  if (loop.open_questions.includes(questionBody.question_id)) {
    return { status: 'awaiting' };
  }
  const answer = findAnswerFor(loop, questionBody.question_id);
  if (answer) {
    const isTimedOut = answer.body.by === 'system' || answer.body.resolved_via === 'timeout_default';
    const answerInfo: QuestionAnswer = {
      resolved_via: answer.body.resolved_via,
      answer_text: answer.body.answer_text,
      chosen_option_id: answer.body.chosen_option_id,
      by: answer.body.by,
      synthetic: answer.body.synthetic === true,
      produced_at: answer.artifact.produced_at,
    };
    return { status: isTimedOut ? 'timed_out' : 'answered', answer: answerInfo };
  }
  if (loopWasTimedOut(loop, questionBody.question_id, cwd)) {
    return { status: 'timed_out' };
  }
  // No answer artifact and not in open_questions — treat as answered for safety.
  return { status: 'answered' };
}

function collectQuestions(
  loops: LoopThread[],
  cwd: string | undefined,
  now: number,
): QuestionRow[] {
  const rows: QuestionRow[] = [];
  for (const loop of loops) {
    for (const artifact of loop.artifacts) {
      const body = parseQuestionBody(artifact);
      if (!body) continue;
      const { status, answer } = determineStatus(loop, body, cwd);
      const producedAtMs = Date.parse(artifact.produced_at);
      const ageSeconds = Number.isFinite(producedAtMs)
        ? Math.max(0, (now - producedAtMs) / 1000)
        : 0;
      rows.push({
        question_id: body.question_id,
        loop_id: loop.id,
        loop_title: loop.title,
        phase: artifact.phase,
        status,
        question_text: body.question_text,
        evidence: body.evidence,
        suggested_default: body.suggested_default,
        options: body.options,
        pause_scope: body.pause_scope,
        on_timeout: body.on_timeout,
        timeout_at: body.timeout_at,
        produced_at: artifact.produced_at,
        age_seconds: ageSeconds,
        answer,
      });
    }
  }
  return rows;
}

function formatTable(rows: QuestionRow[]): string {
  if (rows.length === 0) return 'No questions match the current filters.';
  const header = ['QUESTION_ID', 'LOOP_ID', 'STATUS', 'QUESTION', 'AGE'];
  const data = rows.map((r) => [
    r.question_id,
    r.loop_id,
    r.status,
    truncate(r.question_text, 50),
    relativeAge(r.age_seconds),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...data.map((row) => row[i].length)),
  );
  const pad = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  const lines = [pad(header), pad(widths.map((w) => '-'.repeat(w)))];
  for (const row of data) lines.push(pad(row));
  return lines.join('\n');
}

/**
 * `brainclaw questions` — list operator_question artifacts across loops in
 * the current project. Filters by --loop, --status, --mine; emits a human
 * table or --json.
 *
 * v1 caveat: question targeting (which agent should answer) isn't tracked
 * on the artifact body yet. The --mine filter therefore returns ALL awaiting
 * questions for human callers; agent callers see none (since no question is
 * provably theirs). Documented in the brief.
 */
export function runQuestionsCommand(
  options: QuestionsCommandOptions = {},
  cwd?: string,
): QuestionsCommandResult {
  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const status: QuestionStatus = options.status ?? 'awaiting';
  const allLoops = listLoops({}, cwd);
  const loops = options.loop
    ? allLoops.filter((l) => l.id === options.loop)
    : allLoops;

  const now = Date.now();
  let rows = collectQuestions(loops, cwd, now);
  rows = rows.filter((r) => r.status === status);

  if (options.mine) {
    const caller = resolveCurrentAgentName(cwd);
    const isHuman = !/^(claude|codex|copilot|gemini|opencode|cline|continue|antigravity|sonnet|opus|haiku)/i.test(caller);
    if (!isHuman) {
      // Agent callers can't prove ownership of any question — return empty
      // until question targeting is tracked (v1 heuristic).
      rows = [];
    }
    // For humans, --mine is a no-op in v1 because question targeting isn't tracked.
  }

  rows.sort((a, b) => b.produced_at.localeCompare(a.produced_at));

  const result: QuestionsCommandResult = { questions: rows };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  console.log(formatTable(rows));
  return result;
}
