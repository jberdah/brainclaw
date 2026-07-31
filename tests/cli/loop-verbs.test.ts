/**
 * Tests for `brainclaw loop <verb>` CLI wrappers (pln#517 step 2).
 *
 * Direct invocation keeps the tests fast while still covering stdout,
 * validation exits, and the facade path used by the command wrappers.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import {
  closeLoop,
  getLoop,
  openLoop,
  type LoopSlot,
  type LoopThread,
} from '../../src/core/loops/index.js';
import { runLoopCommand } from '../../src/commands/loop.js';

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

function openReview(cwd: string, title = 'cli loop verbs'): LoopThread {
  return openLoop(
    {
      kind: 'review',
      title,
      created_by: 'agt_test',
      slots: [
        { role: 'author', agent: 'claude-code', agent_id: 'agt_author' },
        { role: 'reviewer', agent: 'codex', agent_id: 'agt_reviewer' },
      ],
    },
    cwd,
  );
}

function reviewerSlot(loop: LoopThread): LoopSlot {
  const slot = loop.slots.find((s) => s.role === 'reviewer');
  assert.ok(slot, 'fixture should include reviewer slot');
  return slot;
}

describe('runLoopCommand', () => {
  let workspace: TestWorkspace;
  let restoreConsole: () => void;
  let restoreExit: () => void;
  let captured: Captured;

  beforeEach(async () => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-cli-loop-verbs-',
      currentAgent: 'agt_test',
    });
    const c = captureConsole();
    captured = c.captured;
    restoreConsole = c.restore;
    restoreExit = stubExit();
  });

  afterEach(async () => {
    restoreConsole();
    restoreExit();
    workspace.cleanup();
  });

  it('turn resolves a slot by id, assigns it, and prints next_expected', async () => {
    const loop = openReview(workspace.dir);
    const slot = reviewerSlot(loop);

    const result = await runLoopCommand(
      'turn',
      { loop_id: loop.id },
      { slot: slot.slot_id, input: 'review this diff', assignmentId: 'asg_cli_1' },
      workspace.dir,
    );

    const onDisk = getLoop(loop.id, workspace.dir)!;
    const updatedSlot = onDisk.slots.find((s) => s.slot_id === slot.slot_id)!;
    assert.equal(result.ok, true);
    assert.equal(updatedSlot.status, 'assigned');
    assert.equal(updatedSlot.assignment_id, 'asg_cli_1');
    const joined = captured.stdout.join('\n');
    assert.ok(joined.includes('OK loop turn'), `expected success line, got:\n${joined}`);
    assert.ok(joined.includes('next:'), `expected next_expected, got:\n${joined}`);
  });

  it('complete-turn with --outcome done --artifact lands the artifact and bumps the slot', async () => {
    const loop = openReview(workspace.dir);
    const slot = reviewerSlot(loop);
    await runLoopCommand('turn', { loop_id: loop.id }, { slot: slot.slot_id, input: 'review' }, workspace.dir);
    captured.stdout.length = 0;

    await runLoopCommand(
      'complete-turn',
      { loop_id: loop.id },
      {
        slot: slot.slot_id,
        outcome: 'done',
        artifact: '{"phase":"findings","type":"finding","body":"LGTM"}',
      },
      workspace.dir,
    );

    const onDisk = getLoop(loop.id, workspace.dir)!;
    assert.equal(onDisk.slots.find((s) => s.slot_id === slot.slot_id)!.status, 'done');
    assert.equal(onDisk.artifacts.length, 1);
    assert.equal(onDisk.artifacts[0].type, 'finding');
    assert.equal(onDisk.artifacts[0].body, 'LGTM');
  });

  it('complete-turn with --outcome failed --failure-reason works without artifact', async () => {
    const loop = openReview(workspace.dir);
    const slot = reviewerSlot(loop);
    await runLoopCommand('turn', { loop_id: loop.id }, { slot: slot.slot_id, input: 'review' }, workspace.dir);

    await runLoopCommand(
      'complete-turn',
      { loop_id: loop.id },
      { slot: slot.slot_id, outcome: 'failed', failureReason: 'tool error' },
      workspace.dir,
    );

    const onDisk = getLoop(loop.id, workspace.dir)!;
    assert.equal(onDisk.slots.find((s) => s.slot_id === slot.slot_id)!.status, 'failed');
    assert.equal(onDisk.artifacts.length, 0);
  });

  it('advance moves the loop one phase forward when the gate passes', async () => {
    const loop = openReview(workspace.dir);
    const result = await runLoopCommand('advance', { loop_id: loop.id }, {}, workspace.dir);
    assert.equal(result.current_phase, 'findings');
    assert.equal(getLoop(loop.id, workspace.dir)!.current_phase, 'findings');
  });

  it('advance --to-phase honors the explicit target', async () => {
    const loop = openReview(workspace.dir);
    const result = await runLoopCommand(
      'advance',
      { loop_id: loop.id },
      { toPhase: 'verdict' },
      workspace.dir,
    );
    assert.equal(result.current_phase, 'verdict');
  });

  it('advance --force bypasses gate check', async () => {
    const loop = openLoop(
      {
        kind: 'ideation',
        title: 'gated loop',
        created_by: 'agt_test',
        slots: [{ role: 'critic', agent: 'codex', agent_id: 'agt_critic' }],
      },
      workspace.dir,
    );
    await runLoopCommand('advance', { loop_id: loop.id }, {}, workspace.dir);
    captured.stdout.length = 0;

    const result = await runLoopCommand(
      'advance',
      { loop_id: loop.id },
      { force: true },
      workspace.dir,
    );

    assert.equal(result.current_phase, 'revision');
  });

  it('add-artifact attaches a fresh artifact and the loop reflects it', async () => {
    const loop = openReview(workspace.dir);
    await runLoopCommand(
      'add-artifact',
      { loop_id: loop.id },
      {
        phase: 'change_summary',
        type: 'note',
        body: '{"summary":"small doc"}',
        producedBy: 'codex',
      },
      workspace.dir,
    );

    const onDisk = getLoop(loop.id, workspace.dir)!;
    assert.equal(onDisk.artifacts.length, 1);
    assert.equal(onDisk.artifacts[0].type, 'note');
    assert.equal(onDisk.artifacts[0].body, '{"summary":"small doc"}');
    assert.equal(onDisk.artifacts[0].produced_by, 'codex');
  });

  it('--json emits parseable JSON with expected fields', async () => {
    const loop = openReview(workspace.dir);
    await runLoopCommand('advance', { loop_id: loop.id }, { json: true }, workspace.dir);

    const parsed = JSON.parse(captured.stdout.join('\n'));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.action, 'advance');
    assert.equal(parsed.loop_id, loop.id);
    assert.equal(parsed.current_phase, 'findings');
    assert.ok(parsed.next_expected);
  });

  it('exits 1 on malformed loop_id', async () => {
    await assert.rejects(
      () => runLoopCommand('advance', { loop_id: 'not-a-loop' }, {}, workspace.dir),
      (err: unknown) => err instanceof ProcessExitError && err.code === 1,
    );
    assert.ok(captured.stderr.join('\n').includes('invalid loop_id'));
  });

  it('exits 2 on a verb error', async () => {
    const loop = openReview(workspace.dir);
    closeLoop({ id: loop.id, final_status: 'cancelled', actor: 'agt_test' }, workspace.dir);

    await assert.rejects(
      () => runLoopCommand('advance', { loop_id: loop.id }, {}, workspace.dir),
      (err: unknown) => err instanceof ProcessExitError && err.code === 2,
    );
    assert.ok(captured.stderr.join('\n').includes('rejected the call'));
  });
});
