/**
 * pln#508 step 5 — engine-level tests for the request_input / provide_input
 * intents and the ref-based artifact body guard (Phase 0 spec §10).
 *
 * Coverage map against the §10 "minimal test surface" (18 items):
 *   1  request_input happy path (slot scope)            — here
 *   2  request_input happy path (loop scope)            — here
 *   3  request_input refused on already-paused loop     — here
 *   4  request_input refused on terminal-status loop    — loops-verbs.test.ts
 *   5  request_input refused at max_operator_questions  — here
 *   6  request_input evidence-empty payload rejected    — here
 *   7  request_input options.length ∉ [2,4] rejected    — here
 *   8  provide_input happy path resumes slot/loop       — here
 *   9  provide_input unknown replies_to rejected        — here
 *   10 provide_input idempotent on resolved question    — here
 *   11 provide_input empties open_questions → resume     — here
 *   12 provide_input with multiple open → stays paused  — here
 *   13 timeout use_default synthetic artifact           — loops-timeout.test.ts
 *   14 timeout cancel_loop ends loop                    — loops-timeout.test.ts
 *   15 timeout continue_incomplete drops question       — loops-timeout.test.ts
 *   16 ref-based artifact rejects inline body content   — here
 *   17 CLI `brainclaw questions --json`                 — cli/questions-reply.test.ts
 *   18 CLI `brainclaw reply --choose/--answer/--skip`   — cli/questions-reply.test.ts
 *
 * Direct verb calls against a tmpdir cwd keep the suite fast and isolated.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  LoopArtifactSchema,
  add_artifact,
  getLoop,
  openLoop,
  pause,
  provideInput,
  requestInput,
  type LoopThread,
} from '../../src/core/loops/index.js';

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-loops-reqprov-'));
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  return dir;
}

/**
 * A single-slot loop with a manual stop_condition so request_input /
 * provide_input never trip an auto-close. `max_operator_questions` is patched
 * directly onto the thread file when requested — openLoop has no path to set
 * it today (same approach as loops-timeout.test.ts::openBootstrap).
 */
function openChampionLoop(
  cwd: string,
  opts: { max_operator_questions?: number } = {},
): LoopThread {
  const loop = openLoop(
    {
      kind: 'research',
      title: 'request/provide fixture',
      created_by: 'agt_test',
      phases: [{ name: 'investigate' }, { name: 'synthesize' }],
      slots: [{ role: 'champion', agent_id: 'agt_champion' }],
      stop_condition: { kind: 'manual' },
    },
    cwd,
  );

  if (opts.max_operator_questions !== undefined) {
    const threadPath = path.join(cwd, '.brainclaw', 'loops', 'threads', `${loop.id}.json`);
    const raw = JSON.parse(fs.readFileSync(threadPath, 'utf8'));
    raw.protocol = {
      ...(raw.protocol ?? {}),
      max_operator_questions: opts.max_operator_questions,
    };
    fs.writeFileSync(threadPath, JSON.stringify(raw, null, 2));
    return getLoop(loop.id, cwd)!;
  }

  return loop;
}

function askSlotScoped(
  loop: LoopThread,
  cwd: string,
  extras: { question_text?: string; suggested_default?: string } = {},
) {
  return requestInput(
    {
      loop_id: loop.id,
      slot_id: loop.slots[0].slot_id,
      phase: loop.current_phase,
      question_text: extras.question_text ?? 'pick a direction',
      evidence: ['checked memory: no prior signal'],
      suggested_default: extras.suggested_default,
      pause_scope: 'slot',
      on_timeout: 'continue_incomplete',
      actor: 'agt_champion',
    },
    cwd,
  );
}

function askLoopScoped(
  loop: LoopThread,
  cwd: string,
  extras: { question_text?: string; suggested_default?: string } = {},
) {
  return requestInput(
    {
      loop_id: loop.id,
      slot_id: loop.slots[0].slot_id,
      phase: loop.current_phase,
      question_text: extras.question_text ?? 'pick a direction',
      evidence: ['checked memory: no prior signal'],
      suggested_default: extras.suggested_default,
      pause_scope: 'loop',
      on_timeout: 'continue_incomplete',
      actor: 'agt_champion',
    },
    cwd,
  );
}

describe('request_input (Phase 0 spec §10 — tests 1-3, 5-7)', () => {
  let cwd: string;
  before(() => { cwd = makeWorkspace(); });
  after(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('1) happy path (slot scope): slot → waiting_input, loop stays open', () => {
    const loop = openChampionLoop(cwd);
    const { thread, question_id } = askSlotScoped(loop, cwd);

    assert.equal(thread.status, 'open', 'loop stays open under slot-scoped pause');
    assert.equal(thread.pause_reason, undefined);
    assert.deepEqual(thread.open_questions, [question_id]);
    assert.equal(thread.slots[0].status, 'waiting_input');

    const persisted = getLoop(loop.id, cwd)!;
    assert.deepEqual(persisted.open_questions, [question_id]);
    assert.equal(persisted.slots[0].status, 'waiting_input');
  });

  it('2) happy path (loop scope): loop → paused with pause_reason', () => {
    const loop = openChampionLoop(cwd);
    const { thread, question_id } = askLoopScoped(loop, cwd);

    assert.equal(thread.status, 'paused');
    assert.equal(thread.pause_reason, 'awaiting_operator');
    assert.deepEqual(thread.open_questions, [question_id]);
    // Slot is untouched under loop-scoped pause.
    assert.notEqual(thread.slots[0].status, 'waiting_input');
  });

  it('3) refused on an already-paused loop', () => {
    const loop = openChampionLoop(cwd);
    pause({ id: loop.id, pause_reason: 'awaiting_operator', actor: 'agt_test' }, cwd);

    assert.throws(
      () => askLoopScoped(getLoop(loop.id, cwd)!, cwd),
      /paused|cannot accept new questions/i,
    );
  });

  it('5) refused once max_operator_questions is reached', () => {
    const loop = openChampionLoop(cwd, { max_operator_questions: 1 });
    // First question (slot scope) then resolve it so open_questions is empty
    // and the loop is open again — isolating the max cap from the
    // one-open-question guard.
    const first = askSlotScoped(loop, cwd);
    provideInput(
      {
        loop_id: loop.id,
        replies_to: first.question_id,
        resolved_via: 'answer',
        answer_text: 'go with A',
        actor: 'agt_test',
      },
      cwd,
    );

    const reopened = getLoop(loop.id, cwd)!;
    assert.equal(reopened.status, 'open');
    assert.deepEqual(reopened.open_questions, []);

    assert.throws(
      () => askSlotScoped(reopened, cwd),
      /max_operator_questions/,
    );
  });

  it('6) evidence-empty payload rejected', () => {
    const loop = openChampionLoop(cwd);
    assert.throws(
      () =>
        requestInput(
          {
            loop_id: loop.id,
            slot_id: loop.slots[0].slot_id,
            phase: loop.current_phase,
            question_text: 'no evidence shown',
            evidence: [],
            pause_scope: 'loop',
            on_timeout: 'continue_incomplete',
            actor: 'agt_champion',
          },
          cwd,
        ),
      /evidence/i,
    );
  });

  it('7) options.length outside [2,4] rejected', () => {
    const loop = openChampionLoop(cwd);
    assert.throws(
      () =>
        requestInput(
          {
            loop_id: loop.id,
            slot_id: loop.slots[0].slot_id,
            phase: loop.current_phase,
            question_text: 'only one option offered',
            evidence: ['e'],
            options: [{ id: 'only', label: 'Only choice' }],
            pause_scope: 'loop',
            on_timeout: 'continue_incomplete',
            actor: 'agt_champion',
          },
          cwd,
        ),
      /body failed schema validation|options/i,
    );
  });
});

describe('provide_input (Phase 0 spec §10 — tests 8-12)', () => {
  let cwd: string;
  before(() => { cwd = makeWorkspace(); });
  after(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  it('8) happy path: resolves a slot-scoped question and resumes the slot', () => {
    const loop = openChampionLoop(cwd);
    const { question_id } = askSlotScoped(loop, cwd);

    const result = provideInput(
      {
        loop_id: loop.id,
        replies_to: question_id,
        resolved_via: 'answer',
        answer_text: 'go with X',
        actor: 'agt_test',
      },
      cwd,
    );

    assert.equal(result.duplicate, false);
    assert.ok(result.artifact_id);
    const after = result.thread;
    assert.deepEqual(after.open_questions, []);
    assert.equal(after.slots[0].status, 'working', 'slot resumes to working');
    const answer = after.artifacts.find((a) => a.type === 'operator_answer');
    assert.ok(answer, 'operator_answer artifact appended');
  });

  it('9) unknown replies_to rejected', () => {
    const loop = openChampionLoop(cwd);
    assert.throws(
      () =>
        provideInput(
          {
            loop_id: loop.id,
            replies_to: 'qst_does_not_exist',
            resolved_via: 'answer',
            answer_text: 'x',
            actor: 'agt_test',
          },
          cwd,
        ),
      /unknown_question/,
    );
  });

  it('10) idempotent on an already-resolved question (replay returns same artifact)', () => {
    const loop = openChampionLoop(cwd);
    const { question_id } = askSlotScoped(loop, cwd);
    const first = provideInput(
      {
        loop_id: loop.id,
        replies_to: question_id,
        resolved_via: 'answer',
        answer_text: 'first',
        actor: 'agt_test',
      },
      cwd,
    );

    const replay = provideInput(
      {
        loop_id: loop.id,
        replies_to: question_id,
        resolved_via: 'answer',
        answer_text: 'second attempt — ignored',
        actor: 'agt_test',
      },
      cwd,
    );

    assert.equal(replay.duplicate, true);
    assert.equal(replay.artifact_id, first.artifact_id, 'no new artifact created');
    const after = getLoop(loop.id, cwd)!;
    const answers = after.artifacts.filter((a) => a.type === 'operator_answer');
    assert.equal(answers.length, 1, 'exactly one answer artifact on the loop');
  });

  it('11) emptying open_questions resumes the loop from paused', () => {
    const loop = openChampionLoop(cwd);
    const { question_id, thread } = askLoopScoped(loop, cwd);
    assert.equal(thread.status, 'paused');

    const result = provideInput(
      {
        loop_id: loop.id,
        replies_to: question_id,
        resolved_via: 'answer',
        answer_text: 'resume please',
        actor: 'agt_test',
      },
      cwd,
    );

    assert.deepEqual(result.thread.open_questions, []);
    assert.equal(result.thread.status, 'open');
    assert.equal(result.thread.pause_reason, undefined);
  });

  it('12) with multiple open questions, the loop stays paused after one answer', () => {
    // requestInput enforces one open question at a time, so we inject the
    // second loop-scoped question directly — the same technique used by
    // loops-timeout.test.ts to exercise the multi-question branch.
    const loop = openChampionLoop(cwd);
    const first = askLoopScoped(loop, cwd, { question_text: 'A' });

    const threadPath = path.join(cwd, '.brainclaw', 'loops', 'threads', `${loop.id}.json`);
    const raw = JSON.parse(fs.readFileSync(threadPath, 'utf8'));
    const secondQuestionId = 'qst_secondab12';
    raw.artifacts.push({
      artifact_id: 'art_second99',
      phase: loop.current_phase,
      type: 'operator_question',
      body: JSON.stringify({
        question_id: secondQuestionId,
        question_text: 'B: still open',
        evidence: ['e2'],
        pause_scope: 'loop',
        on_timeout: 'continue_incomplete',
      }),
      produced_by: loop.slots[0].agent_id,
      produced_at: new Date().toISOString(),
      iteration: 0,
    });
    raw.open_questions.push(secondQuestionId);
    raw.version += 1;
    fs.writeFileSync(threadPath, JSON.stringify(raw, null, 2));

    // Answer only the first question.
    const result = provideInput(
      {
        loop_id: loop.id,
        replies_to: first.question_id,
        resolved_via: 'answer',
        answer_text: 'A resolved',
        actor: 'agt_test',
      },
      cwd,
    );

    assert.deepEqual(result.thread.open_questions, [secondQuestionId]);
    assert.equal(result.thread.status, 'paused', 'loop stays paused while B is open');
    assert.equal(result.thread.pause_reason, 'awaiting_operator');
  });
});

describe('ref-based artifacts (Phase 0 spec §10 — test 16)', () => {
  let cwd: string;
  before(() => { cwd = makeWorkspace(); });
  after(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  const now = () => new Date().toISOString();

  it('16) rejects a project_md_draft whose body is inline content, not ref metadata', () => {
    // Raw markdown in body (instead of {ref, byte_count, sha256}) must fail the
    // KNOWN_ARTIFACT_BODY_SCHEMAS guard at parse time.
    assert.throws(
      () =>
        LoopArtifactSchema.parse({
          artifact_id: 'art_badref',
          phase: 'converge',
          type: 'project_md_draft',
          body: '# Brainclaw\n\nThis is raw markdown that should live behind a ref.',
          produced_at: now(),
        }),
      /body failed schema validation|JSON-encoded/i,
    );
  });

  it('16b) accepts a project_md_draft with valid ref metadata', () => {
    const sha = 'a'.repeat(64);
    const parsed = LoopArtifactSchema.parse({
      artifact_id: 'art_goodref',
      phase: 'converge',
      type: 'project_md_draft',
      body: JSON.stringify({ ref: 'project_md_draft.md', byte_count: 1234, sha256: sha }),
      produced_at: now(),
    });
    assert.equal(parsed.type, 'project_md_draft');
  });

  it('16c) the engine attach path (add_artifact) also rejects inline ref-type body', () => {
    const loop = openChampionLoop(cwd);
    assert.throws(
      () =>
        add_artifact(
          {
            id: loop.id,
            actor: 'agt_test',
            artifact: {
              phase: loop.current_phase,
              type: 'signals_report',
              body: 'plain text signals, not a ref',
              produced_by: 'agt_champion',
            },
          },
          cwd,
        ),
      /body failed schema validation|JSON-encoded/i,
    );
  });
});
