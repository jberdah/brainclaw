import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AwaitingFileApplyApprovalError,
  BOOTSTRAP_PRESET,
  closeLoop,
  getLoop,
  listLoopEvents,
  openLoop,
  provideInput,
  sweepPauseTimeouts,
  writeThreadFile,
  type LoopArtifact,
  type LoopEvent,
  type LoopThread,
} from '../../src/core/loops/index.js';
import { handleBclawLoop } from '../../src/commands/loops-handlers.js';
import { writeFileAtomic } from '../../src/core/io.js';

/**
 * pln#512 step 2 — closeLoop pre-hook + file_overwrite_approval flow tests.
 *
 * Each test stands up a bootstrap-preset loop with a project_md_final
 * artifact already in place, then exercises closeLoop / provideInput to
 * verify:
 *   1. absent PROJECT.md → direct write + completed
 *   2. present non-empty PROJECT.md → pause + approval question
 *   3. operator approves → file written + completed
 *   4. operator rejects → file untouched + completed
 *   5. timeout default=reject fires → completed via synthetic answer
 *   6. atomicity smoke — no .tmp leftovers
 */

const FINAL_BODY = '# PROJECT\n\nGenerated from the bootstrap loop.\n';

interface Fixture {
  cwd: string;
  loop: LoopThread;
  finalArtifactId: string;
  refPath: string;
}

/**
 * Build a freshly-opened bootstrap loop with a `project_md_final` artifact
 * already attached. The artifact's ref file is written to the
 * loops/threads/<id>/artifacts/ directory under .brainclaw, matching the
 * layout `writeProjectMdSafe` expects.
 */
function setupBootstrapLoop(opts: { finalContent?: string } = {}): Fixture {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-bootstrap-close-flow-'));
  fs.mkdirSync(path.join(cwd, '.brainclaw'), { recursive: true });

  // Open via the canonical openLoop entry so protocol/preset/slots/phase
  // chain go through the real schema validation path.
  const loop = openLoop(
    {
      kind: 'ideation',
      title: 'bootstrap close flow test',
      phases: BOOTSTRAP_PRESET.phases,
      stop_condition: BOOTSTRAP_PRESET.stop_condition,
      protocol: BOOTSTRAP_PRESET.protocol,
      slots: [{ role: 'champion', agent: 'claude-code', agent_id: 'agt_champion' }],
      created_by: 'agt_test',
    },
    cwd,
  );

  // Splice a project_md_final artifact onto the loop. We bypass
  // add_artifact because that verb auto-populates `iteration` and we want
  // to keep the test fixture surgical — the close hook only cares about
  // the artifact body + ref file on disk.
  const finalArtifactId = `art_${crypto.randomBytes(6).toString('hex')}`;
  const ref = `${finalArtifactId}.md`;
  const artifactsDir = path.join(cwd, '.brainclaw', 'loops', 'threads', loop.id, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });
  const refPath = path.join(artifactsDir, ref);
  const finalContent = opts.finalContent ?? FINAL_BODY;
  fs.writeFileSync(refPath, finalContent, 'utf8');

  const sha = crypto.createHash('sha256').update(finalContent, 'utf8').digest('hex');
  const finalArtifact: LoopArtifact = {
    artifact_id: finalArtifactId,
    phase: 'converge',
    type: 'project_md_final',
    body: JSON.stringify({
      ref,
      byte_count: Buffer.byteLength(finalContent, 'utf8'),
      sha256: sha,
    }),
    produced_at: '2026-05-22T00:00:00.000Z',
  };

  // Re-save the loop with the artifact attached and current_phase=converge
  // so the close path matches a realistic bootstrap end-state.
  const updated: LoopThread = {
    ...loop,
    current_phase: 'converge',
    artifacts: [finalArtifact],
  };
  writeThreadFile(updated, cwd);

  return { cwd, loop: updated, finalArtifactId, refPath };
}

function findEvent<K extends LoopEvent['kind']>(
  events: LoopEvent[],
  kind: K,
): Extract<LoopEvent, { kind: K }> | undefined {
  return events.find((e): e is Extract<LoopEvent, { kind: K }> => e.kind === kind);
}

describe('closeLoop bootstrap pre-hook — direct write paths (pln#512 step 2)', () => {
  let fixtures: Fixture[] = [];

  beforeEach(() => { fixtures = []; });
  afterEach(() => {
    for (const f of fixtures) {
      try { fs.rmSync(f.cwd, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  function make(opts?: { finalContent?: string }): Fixture {
    const f = setupBootstrapLoop(opts);
    fixtures.push(f);
    return f;
  }

  it('absent PROJECT.md → file written, loop completed, file_apply_resolved(approved=true)', () => {
    const f = make();
    const target = path.join(f.cwd, 'PROJECT.md');
    assert.equal(fs.existsSync(target), false, 'precondition: PROJECT.md must not exist');

    const closed = closeLoop({ id: f.loop.id, final_status: 'completed', actor: 'agt_test' }, f.cwd);

    assert.equal(closed.status, 'completed');
    assert.ok(closed.closed_at, 'closed_at must be set');
    assert.equal(closed.pause_reason, undefined);
    assert.equal(closed.pending_file_apply, undefined);

    assert.equal(fs.existsSync(target), true, 'PROJECT.md must be created');
    assert.equal(fs.readFileSync(target, 'utf8'), FINAL_BODY);

    const events = listLoopEvents(f.loop.id, f.cwd);
    const resolved = findEvent(events, 'file_apply_resolved');
    assert.ok(resolved, 'file_apply_resolved event must be emitted');
    assert.equal(resolved.approved, true);
    assert.equal(resolved.artifact_id, f.finalArtifactId);

    const closedEvent = findEvent(events, 'closed');
    assert.ok(closedEvent);
    assert.equal(closedEvent.final_status, 'completed');
  });

  it('PROJECT.md exists but is 0 bytes → file written, completed', () => {
    const f = make();
    const target = path.join(f.cwd, 'PROJECT.md');
    fs.writeFileSync(target, '', 'utf8');

    const closed = closeLoop({ id: f.loop.id, final_status: 'completed', actor: 'agt_test' }, f.cwd);
    assert.equal(closed.status, 'completed');
    assert.equal(fs.readFileSync(target, 'utf8'), FINAL_BODY);

    const events = listLoopEvents(f.loop.id, f.cwd);
    assert.ok(findEvent(events, 'file_apply_resolved'));
  });

  it('no project_md_final artifact → close proceeds without write', () => {
    const f = make();
    // Strip the artifact off the persisted thread so the hook hits
    // no_final_artifact.
    const stripped: LoopThread = { ...f.loop, artifacts: [] };
    writeThreadFile(stripped, f.cwd);

    const closed = closeLoop({ id: f.loop.id, final_status: 'completed', actor: 'agt_test' }, f.cwd);
    assert.equal(closed.status, 'completed');

    const target = path.join(f.cwd, 'PROJECT.md');
    assert.equal(fs.existsSync(target), false, 'no file should be written when project_md_final is missing');

    // file_apply_resolved is only emitted when the hook actually wrote.
    const events = listLoopEvents(f.loop.id, f.cwd);
    assert.equal(findEvent(events, 'file_apply_resolved'), undefined);
    assert.ok(findEvent(events, 'closed'));
  });

  it('cancel close skips the bootstrap hook (no file write, no file_apply events)', () => {
    const f = make();
    const target = path.join(f.cwd, 'PROJECT.md');

    const closed = closeLoop({ id: f.loop.id, final_status: 'cancelled', actor: 'agt_test' }, f.cwd);
    assert.equal(closed.status, 'cancelled');
    assert.equal(fs.existsSync(target), false);

    const events = listLoopEvents(f.loop.id, f.cwd);
    assert.equal(findEvent(events, 'file_apply_resolved'), undefined);
    assert.equal(findEvent(events, 'file_apply_requested'), undefined);
  });
});

describe('closeLoop bootstrap pre-hook — pause-on-overwrite path (pln#512 step 2)', () => {
  let fixtures: Fixture[] = [];
  beforeEach(() => { fixtures = []; });
  afterEach(() => {
    for (const f of fixtures) {
      try { fs.rmSync(f.cwd, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
  function make(opts?: { finalContent?: string }): Fixture {
    const f = setupBootstrapLoop(opts);
    fixtures.push(f);
    return f;
  }

  it('PROJECT.md present + non-empty → loop paused, pending_file_apply set, file_apply_requested + input_requested emitted, NEW operator_question on artifacts', () => {
    const f = make({ finalContent: '# proposed\n\nNew body.\n' });
    const target = path.join(f.cwd, 'PROJECT.md');
    const existingBody = '# existing\n\nDo not overwrite.\n';
    fs.writeFileSync(target, existingBody, 'utf8');

    assert.throws(
      () => closeLoop({ id: f.loop.id, final_status: 'completed', actor: 'agt_test' }, f.cwd),
      (err: unknown) => {
        assert.ok(err instanceof AwaitingFileApplyApprovalError);
        assert.equal(err.code, 'awaiting_file_apply_approval');
        assert.equal(err.loop_id, f.loop.id);
        assert.match(err.question_id, /^qst_[0-9a-f]+$/);
        assert.equal(err.target_path, target);
        return true;
      },
    );

    // Loop on disk: paused, pause_reason=awaiting_file_apply, pending_file_apply set.
    const reread = getLoop(f.loop.id, f.cwd);
    assert.ok(reread, 'loop must persist after pause');
    assert.equal(reread.status, 'paused');
    assert.equal(reread.pause_reason, 'awaiting_file_apply');
    assert.ok(reread.pending_file_apply);
    assert.equal(reread.pending_file_apply.artifact_id, f.finalArtifactId);
    assert.equal(reread.pending_file_apply.target_path, target);
    assert.match(reread.pending_file_apply.diff_artifact_id, /^art_[0-9a-f]+$/);

    // PROJECT.md untouched.
    assert.equal(fs.readFileSync(target, 'utf8'), existingBody);

    // Diff + operator_question artifacts spliced onto the loop.
    const fileDiff = reread.artifacts.find((a) => a.type === 'file_diff');
    const question = reread.artifacts.find((a) => a.type === 'operator_question');
    assert.ok(fileDiff, 'file_diff artifact must be appended');
    assert.equal(fileDiff.artifact_id, reread.pending_file_apply.diff_artifact_id);
    assert.ok(question, 'operator_question artifact must be appended');
    const questionBody = JSON.parse(question.body!) as {
      question_id: string;
      question_text: string;
      options: Array<{ id: string; label: string }>;
      suggested_default: string;
      pause_scope: string;
      on_timeout: string;
      by_slot_id: string;
    };
    assert.equal(questionBody.question_text, 'Apply the proposed PROJECT.md diff?');
    assert.equal(questionBody.pause_scope, 'loop');
    assert.equal(questionBody.on_timeout, 'use_default');
    assert.equal(questionBody.suggested_default, 'reject');
    assert.deepEqual(
      questionBody.options.map((o) => o.id).sort(),
      ['approve', 'reject'],
    );
    assert.equal(questionBody.by_slot_id, f.loop.slots[0].slot_id);

    // open_questions tracks the new question id.
    assert.deepEqual(reread.open_questions, [questionBody.question_id]);

    // Events: file_apply_requested + input_requested. NO closed event.
    const events = listLoopEvents(f.loop.id, f.cwd);
    const requested = findEvent(events, 'file_apply_requested');
    assert.ok(requested);
    assert.equal(requested.artifact_id, f.finalArtifactId);
    assert.equal(requested.target_path, target);

    const inputReq = findEvent(events, 'input_requested');
    assert.ok(inputReq);
    assert.equal(inputReq.question_id, questionBody.question_id);
    assert.equal(inputReq.pause_scope, 'loop');

    assert.equal(findEvent(events, 'closed'), undefined, 'must NOT close while pending approval');
  });
});

describe('provideInput post-hook — file_overwrite_approval resolution (pln#512 step 2)', () => {
  let fixtures: Fixture[] = [];
  beforeEach(() => { fixtures = []; });
  afterEach(() => {
    for (const f of fixtures) {
      try { fs.rmSync(f.cwd, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
  function make(opts?: { finalContent?: string }): Fixture {
    const f = setupBootstrapLoop(opts);
    fixtures.push(f);
    return f;
  }

  function setupPausedOnApproval(finalContent = '# proposed final\n\nNew.\n'): {
    fixture: Fixture;
    questionId: string;
    target: string;
    existingBody: string;
  } {
    const fixture = make({ finalContent });
    const target = path.join(fixture.cwd, 'PROJECT.md');
    const existingBody = '# existing\n\nOld.\n';
    fs.writeFileSync(target, existingBody, 'utf8');

    assert.throws(
      () => closeLoop({ id: fixture.loop.id, final_status: 'completed', actor: 'agt_test' }, fixture.cwd),
      AwaitingFileApplyApprovalError,
    );
    const paused = getLoop(fixture.loop.id, fixture.cwd)!;
    return { fixture, questionId: paused.open_questions[0], target, existingBody };
  }

  it("operator approves → file written with project_md_final body, loop transitions to completed, file_apply_resolved(approved=true)", () => {
    const { fixture, questionId, target } = setupPausedOnApproval();

    const result = provideInput(
      {
        loop_id: fixture.loop.id,
        replies_to: questionId,
        resolved_via: 'choose',
        chosen_option_id: 'approve',
        actor: 'agt_test',
      },
      fixture.cwd,
    );

    assert.equal(result.duplicate, false);
    assert.equal(result.thread.status, 'completed');
    assert.equal(result.thread.pause_reason, undefined);
    assert.equal(result.thread.pending_file_apply, undefined);
    assert.ok(result.thread.closed_at);

    // File now carries the proposed final body.
    assert.equal(fs.readFileSync(target, 'utf8'), '# proposed final\n\nNew.\n');

    const events = listLoopEvents(fixture.loop.id, fixture.cwd);
    const resolved = findEvent(events, 'file_apply_resolved');
    assert.ok(resolved);
    assert.equal(resolved.approved, true);
    assert.equal(resolved.artifact_id, fixture.finalArtifactId);

    const closedEvent = findEvent(events, 'closed');
    assert.ok(closedEvent);
    assert.equal(closedEvent.final_status, 'completed');
    assert.equal(closedEvent.reason, 'file_overwrite_approved');

    // open_questions drained.
    assert.deepEqual(result.thread.open_questions, []);
  });

  it("operator rejects → file untouched, loop transitions to completed, file_apply_resolved(approved=false)", () => {
    const { fixture, questionId, target, existingBody } = setupPausedOnApproval();

    const result = provideInput(
      {
        loop_id: fixture.loop.id,
        replies_to: questionId,
        resolved_via: 'choose',
        chosen_option_id: 'reject',
        actor: 'agt_test',
      },
      fixture.cwd,
    );

    assert.equal(result.thread.status, 'completed');
    assert.equal(result.thread.pause_reason, undefined);
    assert.equal(result.thread.pending_file_apply, undefined);

    // File still carries the original body — operator vetoed the overwrite.
    assert.equal(fs.readFileSync(target, 'utf8'), existingBody);

    const events = listLoopEvents(fixture.loop.id, fixture.cwd);
    const resolved = findEvent(events, 'file_apply_resolved');
    assert.ok(resolved);
    assert.equal(resolved.approved, false);

    const closedEvent = findEvent(events, 'closed');
    assert.ok(closedEvent);
    assert.equal(closedEvent.reason, 'file_overwrite_rejected');
  });

  it("timeout → synthetic answer materializes suggested_default='reject', loop completes, file untouched", () => {
    const { fixture, questionId, target, existingBody } = setupPausedOnApproval();

    // Force the question's deadline into the past so sweepPauseTimeouts
    // fires immediately. Bootstrap protocol's max_pause_duration is P7D
    // and the artifact's produced_at is the close-time `nowISO()`, so the
    // implicit deadline is ~7d from now. Drop max_pause_duration to a tiny
    // value via a thread rewrite, then sweep with a now in the future.
    const paused = getLoop(fixture.loop.id, fixture.cwd)!;
    writeThreadFile(
      {
        ...paused,
        protocol: { ...paused.protocol!, max_pause_duration: 'PT1S' },
      },
      fixture.cwd,
    );

    const sweep = sweepPauseTimeouts(
      fixture.loop.id,
      new Date(Date.now() + 60_000),
      fixture.cwd,
    );
    assert.equal(sweep.fired.length, 1);
    assert.equal(sweep.fired[0].question_id, questionId);
    assert.equal(sweep.fired[0].action_taken, 'use_default');

    const reread = getLoop(fixture.loop.id, fixture.cwd)!;
    assert.equal(reread.status, 'completed');
    assert.equal(reread.pause_reason, undefined);
    assert.equal(reread.pending_file_apply, undefined);

    // Default=reject, so the file must remain untouched.
    assert.equal(fs.readFileSync(target, 'utf8'), existingBody);

    const events = listLoopEvents(fixture.loop.id, fixture.cwd);
    const resolved = findEvent(events, 'file_apply_resolved');
    assert.ok(resolved);
    assert.equal(resolved.approved, false);

    const provided = findEvent(events, 'input_provided');
    assert.ok(provided);
    assert.equal(provided.synthetic, true);
    assert.equal(provided.resolved_via, 'timeout_default');
  });
});

describe('closeLoop bootstrap pre-hook — atomicity (pln#512 step 2)', () => {
  let fixtures: Fixture[] = [];
  beforeEach(() => { fixtures = []; });
  afterEach(() => {
    for (const f of fixtures) {
      try { fs.rmSync(f.cwd, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
  function make(opts?: { finalContent?: string }): Fixture {
    const f = setupBootstrapLoop(opts);
    fixtures.push(f);
    return f;
  }

  it('no .tmp leftovers in cwd after direct write (absent target)', () => {
    const f = make({ finalContent: 'line A\nline B\n' });
    closeLoop({ id: f.loop.id, final_status: 'completed', actor: 'agt_test' }, f.cwd);

    const target = path.join(f.cwd, 'PROJECT.md');
    assert.equal(fs.readFileSync(target, 'utf8'), 'line A\nline B\n');

    const leftover = fs.readdirSync(f.cwd).filter((e) => e.endsWith('.tmp'));
    assert.deepEqual(leftover, [], 'no .tmp file should remain after atomic rename');
  });

  it('no .tmp leftovers after approve-path write (present non-empty target)', () => {
    const f = make({ finalContent: 'fresh A\nfresh B\n' });
    const target = path.join(f.cwd, 'PROJECT.md');
    writeFileAtomic(target, 'old content\n');

    assert.throws(
      () => closeLoop({ id: f.loop.id, final_status: 'completed', actor: 'agt_test' }, f.cwd),
      AwaitingFileApplyApprovalError,
    );
    const paused = getLoop(f.loop.id, f.cwd)!;
    provideInput(
      {
        loop_id: f.loop.id,
        replies_to: paused.open_questions[0],
        resolved_via: 'choose',
        chosen_option_id: 'approve',
        actor: 'agt_test',
      },
      f.cwd,
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'fresh A\nfresh B\n');

    const leftover = fs.readdirSync(f.cwd).filter((e) => e.endsWith('.tmp'));
    assert.deepEqual(leftover, [], 'no .tmp file should remain after approve-path atomic rename');
  });
});

describe('bclaw_loop facade — awaiting_file_apply_approval is surfaced structurally (pln#512 phase 3 codex fix #1)', () => {
  let fixtures: Fixture[] = [];
  beforeEach(() => { fixtures = []; });
  afterEach(() => {
    for (const f of fixtures) {
      try { fs.rmSync(f.cwd, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('close intent on a paused-overwrite loop returns code=awaiting_file_apply_approval with structured details', () => {
    const fixture = setupBootstrapLoop({ finalContent: '# new\n' });
    fixtures.push(fixture);
    const target = path.join(fixture.cwd, 'PROJECT.md');
    fs.writeFileSync(target, '# original\n', 'utf8');

    const r = handleBclawLoop({
      args: { intent: 'close', loop_id: fixture.loop.id, status: 'completed', agentId: 'agt_test' },
      cwd: fixture.cwd,
    });

    assert.equal(r.response.status, 'error');
    assert.equal(r.response.intent, 'bclaw_loop.close');
    assert.ok(
      r.response.error?.startsWith('awaiting_file_apply_approval:'),
      `error code should be awaiting_file_apply_approval, got: ${r.response.error}`,
    );

    const details = r.response.result as {
      loop_id: string;
      question_id: string;
      target_path: string;
      diff_artifact_id: string;
    };
    assert.equal(details.loop_id, fixture.loop.id);
    assert.match(details.question_id, /^qst_[0-9a-f]+$/);
    assert.equal(details.target_path, target);
    assert.match(details.diff_artifact_id, /^art_[0-9a-f]+$/);
  });
});
