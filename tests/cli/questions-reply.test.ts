/**
 * Tests for `brainclaw questions` and `brainclaw reply` (pln#508 step 4).
 *
 * These are unit-style tests: we invoke `runQuestionsCommand` /
 * `runReplyCommand` directly with a tmpdir cwd and a fixture built via
 * `openLoop` + `requestInput`. No MCP facade, no child-process — direct verb
 * calls keep the suite fast and let us assert exit codes / stdout cleanly.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  openLoop,
  requestInput,
  provideInput,
  type LoopSlot,
} from '../../src/core/loops/index.js';

import { runQuestionsCommand } from '../../src/commands/questions.js';
import { runReplyCommand } from '../../src/commands/reply.js';

interface Captured {
  stdout: string[];
  stderr: string[];
}

function captureConsole(): { captured: Captured; restore: () => void } {
  const captured: Captured = { stdout: [], stderr: [] };
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => {
    captured.stdout.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    captured.stderr.push(args.map(String).join(' '));
  };
  return {
    captured,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

class ProcessExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

function stubExit(): () => void {
  const origExit = process.exit;
  process.exit = ((code?: number) => {
    throw new ProcessExitError(code ?? 0);
  }) as typeof process.exit;
  return () => {
    process.exit = origExit;
  };
}

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-cli-qreply-'));
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  return dir;
}

function openLoopWithChampion(cwd: string, title = 'fixture loop') {
  const loop = openLoop(
    {
      kind: 'review',
      title,
      created_by: 'agt_test',
      slots: [{ role: 'champion', status: 'working' }],
    },
    cwd,
  );
  const champion = loop.slots[0] as LoopSlot;
  return { loop, championSlotId: champion.slot_id };
}

function askQuestion(
  cwd: string,
  loopId: string,
  slotId: string,
  extras: {
    question_text?: string;
    suggested_default?: string;
    options?: Array<{ id: string; label: string; tradeoff?: string }>;
    on_timeout?: 'use_default' | 'cancel_loop' | 'continue_incomplete';
  } = {},
): string {
  const result = requestInput(
    {
      loop_id: loopId,
      slot_id: slotId,
      phase: 'change_summary',
      question_text: extras.question_text ?? 'pick one',
      evidence: ['searched memory; no precedent found'],
      suggested_default: extras.suggested_default,
      options: extras.options,
      pause_scope: 'slot',
      on_timeout: extras.on_timeout ?? 'continue_incomplete',
      actor: 'agt_test',
    },
    cwd,
  );
  return result.question_id;
}

describe('runQuestionsCommand', () => {
  let cwd: string;
  let restoreConsole: () => void;
  let restoreExit: () => void;
  let captured: Captured;

  beforeEach(() => {
    cwd = makeWorkspace();
    const c = captureConsole();
    captured = c.captured;
    restoreConsole = c.restore;
    restoreExit = stubExit();
  });

  afterEach(() => {
    restoreConsole();
    restoreExit();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('--json returns empty list when no loops have open questions', () => {
    const result = runQuestionsCommand({ json: true }, cwd);
    assert.deepEqual(result, { questions: [] });
    const parsed = JSON.parse(captured.stdout.join('\n'));
    assert.deepEqual(parsed.questions, []);
  });

  it('--json returns the expected shape for one open question', () => {
    const { loop, championSlotId } = openLoopWithChampion(cwd);
    const qid = askQuestion(cwd, loop.id, championSlotId, {
      question_text: 'apply diff to PROJECT.md?',
      options: [
        { id: 'apply', label: 'Apply' },
        { id: 'skip', label: 'Skip' },
      ],
      suggested_default: 'apply',
    });

    const result = runQuestionsCommand({ json: true }, cwd);
    assert.equal(result.questions.length, 1);
    const q = result.questions[0];
    assert.equal(q.question_id, qid);
    assert.equal(q.loop_id, loop.id);
    assert.equal(q.loop_title, 'fixture loop');
    assert.equal(q.phase, 'change_summary');
    assert.equal(q.status, 'awaiting');
    assert.equal(q.question_text, 'apply diff to PROJECT.md?');
    assert.deepEqual(q.evidence, ['searched memory; no precedent found']);
    assert.equal(q.suggested_default, 'apply');
    assert.equal(q.options?.length, 2);
    assert.equal(q.pause_scope, 'slot');
    assert.equal(q.on_timeout, 'continue_incomplete');
    assert.ok(typeof q.age_seconds === 'number' && q.age_seconds >= 0);
    assert.ok(q.produced_at.endsWith('Z') || q.produced_at.includes('+'));
    assert.equal(q.answer, undefined);
  });

  it('--json returns N questions across multiple loops', () => {
    const a = openLoopWithChampion(cwd, 'loop A');
    askQuestion(cwd, a.loop.id, a.championSlotId, { question_text: 'Q1', suggested_default: 'yes' });

    const b = openLoopWithChampion(cwd, 'loop B');
    askQuestion(cwd, b.loop.id, b.championSlotId, { question_text: 'Q2', suggested_default: 'no' });

    const result = runQuestionsCommand({ json: true }, cwd);
    assert.equal(result.questions.length, 2);
    const titles = new Set(result.questions.map((q) => q.loop_title));
    assert.deepEqual(titles, new Set(['loop A', 'loop B']));
  });

  it('--status answered surfaces historic operator_answer artifacts', () => {
    const { loop, championSlotId } = openLoopWithChampion(cwd);
    const qid = askQuestion(cwd, loop.id, championSlotId, {
      suggested_default: 'yes',
    });
    provideInput(
      {
        loop_id: loop.id,
        replies_to: qid,
        resolved_via: 'answer',
        answer_text: 'yes please',
        actor: 'agt_test',
      },
      cwd,
    );

    const awaiting = runQuestionsCommand({ status: 'awaiting', json: true }, cwd);
    assert.equal(awaiting.questions.length, 0);

    const answered = runQuestionsCommand({ status: 'answered', json: true }, cwd);
    assert.equal(answered.questions.length, 1);
    assert.equal(answered.questions[0].question_id, qid);
    assert.equal(answered.questions[0].status, 'answered');
    assert.equal(answered.questions[0].answer?.resolved_via, 'answer');
    assert.equal(answered.questions[0].answer?.answer_text, 'yes please');
    assert.equal(answered.questions[0].answer?.by, 'operator');
    assert.equal(answered.questions[0].answer?.synthetic, false);
  });

  it('--status timed_out surfaces synthetic answers', () => {
    const { loop, championSlotId } = openLoopWithChampion(cwd, 'timeout-loop');
    const qid = askQuestion(cwd, loop.id, championSlotId, { suggested_default: 'fallback' });
    provideInput(
      {
        loop_id: loop.id,
        replies_to: qid,
        resolved_via: 'timeout_default',
        by: 'system',
        actor: 'engine',
      },
      cwd,
    );
    const result = runQuestionsCommand({ status: 'timed_out', json: true }, cwd);
    assert.equal(result.questions.length, 1);
    assert.equal(result.questions[0].status, 'timed_out');
    assert.equal(result.questions[0].answer?.by, 'system');
    assert.equal(result.questions[0].answer?.synthetic, true);
  });

  it('--loop <id> filters to a single loop', () => {
    const a = openLoopWithChampion(cwd, 'loop A');
    askQuestion(cwd, a.loop.id, a.championSlotId, { question_text: 'A?' });
    const b = openLoopWithChampion(cwd, 'loop B');
    askQuestion(cwd, b.loop.id, b.championSlotId, { question_text: 'B?' });

    const result = runQuestionsCommand({ loop: a.loop.id, json: true }, cwd);
    assert.equal(result.questions.length, 1);
    assert.equal(result.questions[0].loop_id, a.loop.id);
  });

  it('non-JSON output renders a table with truncated long question text', () => {
    const { loop, championSlotId } = openLoopWithChampion(cwd);
    askQuestion(cwd, loop.id, championSlotId, {
      question_text: 'a'.repeat(120),
    });
    runQuestionsCommand({}, cwd);
    const joined = captured.stdout.join('\n');
    assert.ok(joined.includes('QUESTION_ID'), 'table header missing');
    // Truncation appends an ellipsis at column 50.
    assert.ok(/a{49}…/.test(joined), `expected truncated cell, got:\n${joined}`);
  });
});

describe('runReplyCommand', () => {
  let cwd: string;
  let restoreConsole: () => void;
  let restoreExit: () => void;
  let captured: Captured;

  beforeEach(() => {
    cwd = makeWorkspace();
    const c = captureConsole();
    captured = c.captured;
    restoreConsole = c.restore;
    restoreExit = stubExit();
  });

  afterEach(() => {
    restoreConsole();
    restoreExit();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('--answer resolves an awaiting question and prints success', () => {
    const { loop, championSlotId } = openLoopWithChampion(cwd);
    const qid = askQuestion(cwd, loop.id, championSlotId);

    const result = runReplyCommand(qid, { answer: 'ship it' }, cwd);
    assert.equal(result.ok, true);
    assert.equal(result.resolved_via, 'answer');
    assert.equal(result.loop_id, loop.id);
    assert.ok(result.artifact_id);
    const joined = captured.stdout.join('\n');
    assert.ok(/Answered qst_/.test(joined), `expected success line, got:\n${joined}`);
  });

  it('--choose resolves via a structured option', () => {
    const { loop, championSlotId } = openLoopWithChampion(cwd);
    const qid = askQuestion(cwd, loop.id, championSlotId, {
      options: [
        { id: 'apply', label: 'Apply' },
        { id: 'skip', label: 'Skip' },
      ],
      suggested_default: 'apply',
    });
    const result = runReplyCommand(qid, { choose: 'apply' }, cwd);
    assert.equal(result.ok, true);
    assert.equal(result.resolved_via, 'choose');
  });

  it('--skip materializes the suggested_default', () => {
    const { loop, championSlotId } = openLoopWithChampion(cwd);
    const qid = askQuestion(cwd, loop.id, championSlotId, {
      suggested_default: 'pragmatic-default',
    });
    const result = runReplyCommand(qid, { skip: true }, cwd);
    assert.equal(result.ok, true);
    assert.equal(result.resolved_via, 'skip');
  });

  it('exits 1 with clear error for unknown question', () => {
    assert.throws(
      () => runReplyCommand('qst_deadbeef0000', { answer: 'x' }, cwd),
      (err: unknown) => err instanceof ProcessExitError && err.code === 1,
    );
    assert.ok(
      captured.stderr.join('\n').includes('question not found'),
      `expected "question not found" stderr, got: ${captured.stderr.join('\n')}`,
    );
  });

  it('exits 1 with clear error when no resolution flag is passed', () => {
    const { loop, championSlotId } = openLoopWithChampion(cwd);
    const qid = askQuestion(cwd, loop.id, championSlotId);
    assert.throws(
      () => runReplyCommand(qid, {}, cwd),
      (err: unknown) => err instanceof ProcessExitError && err.code === 1,
    );
    assert.ok(captured.stderr.join('\n').includes('exactly one of'));
  });

  it('exits 1 with clear error when multiple resolution flags are passed', () => {
    const { loop, championSlotId } = openLoopWithChampion(cwd);
    const qid = askQuestion(cwd, loop.id, championSlotId, {
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      suggested_default: 'a',
    });
    assert.throws(
      () =>
        runReplyCommand(
          qid,
          { answer: 'x', choose: 'a' },
          cwd,
        ),
      (err: unknown) => err instanceof ProcessExitError && err.code === 1,
    );
    assert.ok(captured.stderr.join('\n').includes('mutually exclusive'));
  });

  it('exits 1 with clear error for an already-resolved question (re-answer attempt)', () => {
    const { loop, championSlotId } = openLoopWithChampion(cwd);
    const qid = askQuestion(cwd, loop.id, championSlotId, { suggested_default: 'd' });
    runReplyCommand(qid, { answer: 'first' }, cwd);
    captured.stderr.length = 0;
    captured.stdout.length = 0;
    assert.throws(
      () => runReplyCommand(qid, { answer: 'second' }, cwd),
      (err: unknown) => err instanceof ProcessExitError && err.code === 1,
    );
    assert.ok(
      captured.stderr.join('\n').includes('already resolved'),
      `expected "already resolved" stderr, got: ${captured.stderr.join('\n')}`,
    );
  });

  it('exits 1 with options-mismatch error for an invalid --choose value', () => {
    const { loop, championSlotId } = openLoopWithChampion(cwd);
    const qid = askQuestion(cwd, loop.id, championSlotId, {
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      suggested_default: 'a',
    });
    assert.throws(
      () => runReplyCommand(qid, { choose: 'zzz' }, cwd),
      (err: unknown) => err instanceof ProcessExitError && err.code === 1,
    );
    const joined = captured.stderr.join('\n');
    assert.ok(joined.includes('has no such option'), `got: ${joined}`);
    assert.ok(joined.includes('known: a, b'), `got: ${joined}`);
  });

  it('exits 1 when --skip is used on a question with no suggested_default', () => {
    const { loop, championSlotId } = openLoopWithChampion(cwd);
    const qid = askQuestion(cwd, loop.id, championSlotId, {
      // no suggested_default
    });
    assert.throws(
      () => runReplyCommand(qid, { skip: true }, cwd),
      (err: unknown) => err instanceof ProcessExitError && err.code === 1,
    );
    assert.ok(captured.stderr.join('\n').includes('no suggested_default'));
  });

  it('exits 1 with mode-mismatch error when --answer is used on a question with structured options (pln#512 phase 3 codex fix #2)', () => {
    const { loop, championSlotId } = openLoopWithChampion(cwd);
    const qid = askQuestion(cwd, loop.id, championSlotId, {
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
      suggested_default: 'reject',
    });
    // Crucially: "approve" looks like a free-text answer but it would resolve
    // as chosen_option_id='' which post-hooks treat as the reject branch.
    assert.throws(
      () => runReplyCommand(qid, { answer: 'approve' }, cwd),
      (err: unknown) => err instanceof ProcessExitError && err.code === 1,
    );
    const joined = captured.stderr.join('\n');
    assert.ok(
      joined.includes('has structured options'),
      `expected mode-mismatch error, got: ${joined}`,
    );
    // When the answer text matches an option id verbatim, the error points
    // the operator at the right --choose form.
    assert.ok(
      joined.includes('--choose approve'),
      `expected --choose approve hint, got: ${joined}`,
    );
  });

  it('exits 1 with mode-mismatch error when --answer is used on options without a matching id', () => {
    const { loop, championSlotId } = openLoopWithChampion(cwd);
    const qid = askQuestion(cwd, loop.id, championSlotId, {
      options: [
        { id: 'apply', label: 'Apply' },
        { id: 'skip', label: 'Skip' },
      ],
      suggested_default: 'apply',
    });
    assert.throws(
      () => runReplyCommand(qid, { answer: 'something else' }, cwd),
      (err: unknown) => err instanceof ProcessExitError && err.code === 1,
    );
    const joined = captured.stderr.join('\n');
    assert.ok(joined.includes('has structured options'));
    assert.ok(joined.includes('known: apply, skip'), `got: ${joined}`);
  });

  it('exits 1 with format error for a malformed qst_id', () => {
    assert.throws(
      () => runReplyCommand('not-a-qst-id', { answer: 'x' }, cwd),
      (err: unknown) => err instanceof ProcessExitError && err.code === 1,
    );
    assert.ok(captured.stderr.join('\n').includes('invalid question_id'));
  });

  it('--json on success returns a structured payload', () => {
    const { loop, championSlotId } = openLoopWithChampion(cwd);
    const qid = askQuestion(cwd, loop.id, championSlotId);
    const result = runReplyCommand(qid, { answer: 'ok', json: true }, cwd);
    assert.equal(result.ok, true);
    const parsed = JSON.parse(captured.stdout.join('\n'));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.question_id, qid);
    assert.equal(parsed.resolved_via, 'answer');
    assert.ok(parsed.artifact_id);
  });
});
