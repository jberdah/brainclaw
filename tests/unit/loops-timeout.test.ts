import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getLoop,
  listLoopEvents,
  openLoop,
  reconcileOpenQuestions,
  requestInput,
  sweepPauseTimeouts,
  type LoopThread,
} from '../../src/core/loops/index.js';

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-loops-timeout-'));
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  return dir;
}

function openBootstrap(cwd: string, opts: { max_pause_duration?: string } = {}): LoopThread {
  const loop = openLoop(
    {
      kind: 'research',
      title: 'bootstrap timeout fixture',
      created_by: 'agt_test',
      phases: [{ name: 'investigate' }, { name: 'synthesize' }],
      slots: [{ role: 'champion', agent_id: 'agt_champion' }],
      stop_condition: { kind: 'manual' },
    },
    cwd,
  );

  // Inject a bootstrap-like protocol with max_pause_duration. openLoop has no
  // path to set this today (only iteration is carried from DEFAULT_PROTOCOLS),
  // so we patch the thread file directly. This is the same shape the bootstrap
  // preset will write once the coordinate facade lands (pln#508 step 5+).
  const threadPath = path.join(cwd, '.brainclaw', 'loops', 'threads', `${loop.id}.json`);
  const raw = JSON.parse(fs.readFileSync(threadPath, 'utf8'));
  raw.protocol = {
    ...(raw.protocol ?? {}),
    preset: 'bootstrap',
    max_operator_questions: 3,
    max_pause_duration: opts.max_pause_duration,
  };
  // Strip undefined fields so the schema stays clean.
  if (!opts.max_pause_duration) delete raw.protocol.max_pause_duration;
  fs.writeFileSync(threadPath, JSON.stringify(raw, null, 2));

  return getLoop(loop.id, cwd)!;
}

function askLoopScopedQuestion(
  loop: LoopThread,
  cwd: string,
  opts: {
    on_timeout: 'use_default' | 'cancel_loop' | 'continue_incomplete';
    timeout_at?: string;
    suggested_default?: string;
  },
): { question_id: string; thread: LoopThread } {
  const slot = loop.slots[0];
  const result = requestInput(
    {
      loop_id: loop.id,
      slot_id: slot.slot_id,
      phase: loop.current_phase,
      question_text: 'do you want X or Y?',
      evidence: ['checked memory: no prior signal'],
      suggested_default: opts.suggested_default,
      pause_scope: 'loop',
      on_timeout: opts.on_timeout,
      timeout_at: opts.timeout_at,
      actor: 'agt_champion',
    },
    cwd,
  );
  return { question_id: result.question_id, thread: result.thread };
}

describe('loops timeout — sweepPauseTimeouts use_default', () => {
  let cwd: string;
  before(() => { cwd = makeWorkspace(); });
  after(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('fires a synthetic answer and resumes the loop when timeout_at has passed', () => {
    const loop = openBootstrap(cwd);
    const past = new Date(Date.now() - 60_000).toISOString();
    const { question_id } = askLoopScopedQuestion(loop, cwd, {
      on_timeout: 'use_default',
      timeout_at: past,
      suggested_default: 'continue with X',
    });

    const result = sweepPauseTimeouts(loop.id, undefined, cwd);
    assert.equal(result.fired.length, 1);
    assert.equal(result.fired[0].question_id, question_id);
    assert.equal(result.fired[0].action_taken, 'use_default');

    const after = getLoop(loop.id, cwd)!;
    // Synthetic answer materialized from suggested_default.
    const answer = after.artifacts.find((a) => a.type === 'operator_answer');
    assert.ok(answer, 'expected operator_answer artifact');
    const body = JSON.parse(answer!.body!) as {
      by: string; resolved_via: string; synthetic?: boolean; answer_text?: string;
    };
    assert.equal(body.by, 'system');
    assert.equal(body.resolved_via, 'timeout_default');
    assert.equal(body.synthetic, true);
    assert.equal(body.answer_text, 'continue with X');

    // open_questions cleared, loop resumed.
    assert.deepEqual(after.open_questions, []);
    assert.equal(after.status, 'open');
    assert.equal(after.pause_reason, undefined);

    // pause_timeout event emitted with action_taken=use_default.
    const events = listLoopEvents(loop.id, cwd);
    const timeoutEvent = events.find((e) => e.kind === 'pause_timeout');
    assert.ok(timeoutEvent, 'expected pause_timeout event');
    if (timeoutEvent && timeoutEvent.kind === 'pause_timeout') {
      assert.equal(timeoutEvent.action_taken, 'use_default');
      assert.equal(timeoutEvent.question_id, question_id);
    }
  });
});

describe('loops timeout — sweepPauseTimeouts cancel_loop', () => {
  let cwd: string;
  before(() => { cwd = makeWorkspace(); });
  after(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('transitions the loop to cancelled with reason=operator_timeout, no answer artifact', () => {
    const loop = openBootstrap(cwd);
    const past = new Date(Date.now() - 30_000).toISOString();
    const { question_id } = askLoopScopedQuestion(loop, cwd, {
      on_timeout: 'cancel_loop',
      timeout_at: past,
    });

    const result = sweepPauseTimeouts(loop.id, undefined, cwd);
    assert.equal(result.fired.length, 1);
    assert.equal(result.fired[0].action_taken, 'cancel_loop');

    const after = getLoop(loop.id, cwd)!;
    assert.equal(after.status, 'cancelled');
    // No operator_answer materialized.
    const answer = after.artifacts.find((a) => a.type === 'operator_answer');
    assert.equal(answer, undefined);

    const events = listLoopEvents(loop.id, cwd);
    const closed = events.find((e) => e.kind === 'closed');
    assert.ok(closed, 'expected closed event');
    if (closed && closed.kind === 'closed') {
      assert.equal(closed.final_status, 'cancelled');
      assert.equal(closed.reason, 'operator_timeout');
    }
    const timeoutEvent = events.find((e) => e.kind === 'pause_timeout');
    assert.ok(timeoutEvent);
    if (timeoutEvent && timeoutEvent.kind === 'pause_timeout') {
      assert.equal(timeoutEvent.action_taken, 'cancel_loop');
      assert.equal(timeoutEvent.question_id, question_id);
    }
  });
});

describe('loops timeout — sweepPauseTimeouts continue_incomplete', () => {
  let cwd: string;
  before(() => { cwd = makeWorkspace(); });
  after(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('drops the question_id, resumes the loop, no answer artifact', () => {
    const loop = openBootstrap(cwd);
    const past = new Date(Date.now() - 5_000).toISOString();
    const { question_id } = askLoopScopedQuestion(loop, cwd, {
      on_timeout: 'continue_incomplete',
      timeout_at: past,
    });

    const result = sweepPauseTimeouts(loop.id, undefined, cwd);
    assert.equal(result.fired.length, 1);
    assert.equal(result.fired[0].action_taken, 'continue_incomplete');

    const after = getLoop(loop.id, cwd)!;
    assert.deepEqual(after.open_questions, []);
    assert.equal(after.status, 'open');
    assert.equal(after.pause_reason, undefined);
    // No answer artifact created — that's the whole point of continue_incomplete.
    const answer = after.artifacts.find((a) => a.type === 'operator_answer');
    assert.equal(answer, undefined);

    const events = listLoopEvents(loop.id, cwd);
    const timeoutEvent = events.find((e) => e.kind === 'pause_timeout');
    assert.ok(timeoutEvent);
    if (timeoutEvent && timeoutEvent.kind === 'pause_timeout') {
      assert.equal(timeoutEvent.action_taken, 'continue_incomplete');
      assert.equal(timeoutEvent.question_id, question_id);
    }
  });

  it('continue_incomplete on slot-scoped question resumes the slot to working', () => {
    const loop = openBootstrap(cwd);
    const slot = loop.slots[0];
    const past = new Date(Date.now() - 5_000).toISOString();
    const ask = requestInput(
      {
        loop_id: loop.id,
        slot_id: slot.slot_id,
        phase: loop.current_phase,
        question_text: 'tiebreaker A or B?',
        evidence: ['no signal in memory'],
        pause_scope: 'slot',
        on_timeout: 'continue_incomplete',
        timeout_at: past,
        actor: 'agt_champion',
      },
      cwd,
    );
    assert.equal(ask.thread.status, 'open'); // slot-scoped pause does not pause the loop.
    assert.equal(
      ask.thread.slots.find((s) => s.slot_id === slot.slot_id)!.status,
      'waiting_input',
    );

    const result = sweepPauseTimeouts(loop.id, undefined, cwd);
    assert.equal(result.fired.length, 1);

    const after = getLoop(loop.id, cwd)!;
    assert.deepEqual(after.open_questions, []);
    assert.equal(
      after.slots.find((s) => s.slot_id === slot.slot_id)!.status,
      'working',
      'slot should resume to working after continue_incomplete',
    );
  });
});

describe('loops timeout — non-firing edge cases', () => {
  let cwd: string;
  before(() => { cwd = makeWorkspace(); });
  after(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('does not fire when timeout_at is in the future', () => {
    const loop = openBootstrap(cwd);
    const future = new Date(Date.now() + 60_000).toISOString();
    askLoopScopedQuestion(loop, cwd, {
      on_timeout: 'use_default',
      timeout_at: future,
      suggested_default: 'X',
    });
    const result = sweepPauseTimeouts(loop.id, undefined, cwd);
    assert.equal(result.fired.length, 0);
    const after = getLoop(loop.id, cwd)!;
    assert.equal(after.status, 'paused');
    assert.equal(after.open_questions.length, 1);
  });

  it('does not fire when neither timeout_at nor max_pause_duration is set', () => {
    const loop = openBootstrap(cwd); // no max_pause_duration injected
    askLoopScopedQuestion(loop, cwd, {
      on_timeout: 'continue_incomplete',
      // timeout_at omitted
    });
    const result = sweepPauseTimeouts(loop.id, undefined, cwd);
    assert.equal(result.fired.length, 0);
    const after = getLoop(loop.id, cwd)!;
    assert.equal(after.open_questions.length, 1);
  });

  it('falls back to protocol.max_pause_duration when timeout_at is absent', () => {
    const loop = openBootstrap(cwd, { max_pause_duration: 'P1D' });
    askLoopScopedQuestion(loop, cwd, {
      on_timeout: 'continue_incomplete',
      // no timeout_at — should be computed from produced_at + P1D.
    });

    // Sweep with `now` set to 2 days after open — should fire.
    const twoDaysFromNow = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const result = sweepPauseTimeouts(loop.id, twoDaysFromNow, cwd);
    assert.equal(result.fired.length, 1);
    assert.equal(result.fired[0].action_taken, 'continue_incomplete');
  });

  it('does not fire on terminal loops', () => {
    const loop = openBootstrap(cwd);
    const past = new Date(Date.now() - 5_000).toISOString();
    askLoopScopedQuestion(loop, cwd, {
      on_timeout: 'cancel_loop',
      timeout_at: past,
    });
    // First sweep fires the cancellation.
    sweepPauseTimeouts(loop.id, undefined, cwd);
    const before = getLoop(loop.id, cwd)!;
    assert.equal(before.status, 'cancelled');

    // Second sweep on the cancelled loop is a no-op.
    const result = sweepPauseTimeouts(loop.id, undefined, cwd);
    assert.equal(result.fired.length, 0);
  });

  it('is idempotent: re-firing on an already-resolved question is a no-op', () => {
    const loop = openBootstrap(cwd);
    const past = new Date(Date.now() - 5_000).toISOString();
    askLoopScopedQuestion(loop, cwd, {
      on_timeout: 'use_default',
      timeout_at: past,
      suggested_default: 'default text',
    });
    const first = sweepPauseTimeouts(loop.id, undefined, cwd);
    assert.equal(first.fired.length, 1);
    const second = sweepPauseTimeouts(loop.id, undefined, cwd);
    assert.equal(second.fired.length, 0);
    // open_questions still empty and no new operator_answer artifact created.
    const after = getLoop(loop.id, cwd)!;
    const answers = after.artifacts.filter((a) => a.type === 'operator_answer');
    assert.equal(answers.length, 1);
  });

  it('returns a clean result for unknown loop_ids', () => {
    const result = sweepPauseTimeouts('lop_nonexistent', undefined, cwd);
    assert.equal(result.fired.length, 0);
  });
});

describe('loops timeout — multiple paused questions', () => {
  let cwd: string;
  before(() => { cwd = makeWorkspace(); });
  after(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('fires only the timed-out question, leaves the in-window one open', () => {
    // requestInput enforces one open_question at a time, so we manipulate the
    // thread directly to construct the multi-question state. This tests the
    // sweep's filter logic regardless of how a thread gets into that shape
    // (e.g. concurrent slot-scoped questions from a future preset, or
    // recovery from a partially-applied legacy thread).
    const loop = openBootstrap(cwd);
    const slot = loop.slots[0];
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    // Ask the timed-out one via the normal verb path.
    const first = requestInput(
      {
        loop_id: loop.id,
        slot_id: slot.slot_id,
        phase: loop.current_phase,
        question_text: 'A: timed out',
        evidence: ['e1'],
        suggested_default: 'use A',
        pause_scope: 'loop',
        on_timeout: 'use_default',
        timeout_at: past,
        actor: 'agt_champion',
      },
      cwd,
    );

    // Inject a second, still-in-window question via direct file edit.
    const threadPath = path.join(cwd, '.brainclaw', 'loops', 'threads', `${loop.id}.json`);
    const raw = JSON.parse(fs.readFileSync(threadPath, 'utf8'));
    const secondQuestionId = 'qst_secondab12';
    raw.artifacts.push({
      artifact_id: 'art_second99',
      phase: loop.current_phase,
      type: 'operator_question',
      body: JSON.stringify({
        question_id: secondQuestionId,
        question_text: 'B: still in window',
        evidence: ['e2'],
        pause_scope: 'loop',
        on_timeout: 'continue_incomplete',
        timeout_at: future,
      }),
      produced_by: slot.agent_id,
      produced_at: new Date().toISOString(),
      iteration: 0,
    });
    raw.open_questions.push(secondQuestionId);
    raw.version += 1;
    fs.writeFileSync(threadPath, JSON.stringify(raw, null, 2));

    const result = sweepPauseTimeouts(loop.id, undefined, cwd);
    assert.equal(result.fired.length, 1);
    assert.equal(result.fired[0].question_id, first.question_id);
    assert.equal(result.fired[0].action_taken, 'use_default');

    const after = getLoop(loop.id, cwd)!;
    // The in-window question remains. (The loop did NOT resume because there's
    // still an open question; pause_reason therefore stays awaiting_operator.)
    assert.deepEqual(after.open_questions, [secondQuestionId]);
    assert.equal(after.status, 'paused');
    assert.equal(after.pause_reason, 'awaiting_operator');
  });
});

describe('loops FSM — reconcileOpenQuestions', () => {
  it('returns the set of open question ids by replaying artifacts', () => {
    const now = new Date().toISOString();
    const thread = {
      schema_version: 1 as const,
      id: 'lop_recheck',
      version: 1,
      mutation_id: 'm',
      kind: 'review' as const,
      title: 't',
      status: 'paused' as const,
      pause_reason: 'awaiting_operator' as const,
      phases: [{ name: 'investigate' }, { name: 'synthesize' }],
      current_phase: 'investigate',
      iteration_count: 0,
      open_questions: ['qst_aaabbbccc111'],
      slots: [],
      artifacts: [
        {
          artifact_id: 'art_q1',
          phase: 'investigate',
          type: 'operator_question',
          body: JSON.stringify({
            question_id: 'qst_aaabbbccc111',
            question_text: 'q1',
            evidence: ['e'],
            pause_scope: 'loop',
            on_timeout: 'continue_incomplete',
          }),
          produced_at: now,
        },
        {
          artifact_id: 'art_q2',
          phase: 'investigate',
          type: 'operator_question',
          body: JSON.stringify({
            question_id: 'qst_aaabbbccc222',
            question_text: 'q2',
            evidence: ['e'],
            pause_scope: 'loop',
            on_timeout: 'continue_incomplete',
          }),
          produced_at: now,
        },
        {
          artifact_id: 'art_a2',
          phase: 'investigate',
          type: 'operator_answer',
          body: JSON.stringify({
            replies_to: 'qst_aaabbbccc222',
            resolved_via: 'answer',
            answer_text: 'ok',
            by: 'operator',
          }),
          produced_at: now,
        },
      ],
      created_at: now,
      updated_at: now,
      created_by: 'agt_test',
    } satisfies LoopThread;

    const computed = reconcileOpenQuestions(thread);
    assert.deepEqual(computed.sort(), ['qst_aaabbbccc111']);
  });
});

// pln#508 step 3 — assertMutable terminal-loop regression coverage AND
// pause() pause_reason coercion tests live in tests/unit/loops-verbs.test.ts.
// See the FSM invariant 1 / FSM invariant 2 suites added there.
