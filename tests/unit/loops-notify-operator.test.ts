import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import child_process from 'node:child_process';
import { EventEmitter } from 'node:events';

import {
  notifyOperatorOnInputRequested,
  type LoopEvent,
  type LoopThread,
} from '../../src/core/loops/index.js';

/**
 * pln#513 step 4 — notify-operator hook tests.
 *
 * Behavior surface we lock in:
 *   1. Returns silently when env var is not set.
 *   2. Returns silently when event.kind !== 'input_requested'.
 *   3. Returns silently when loop.protocol.preset !== 'bootstrap'.
 *   4. With all conditions met, dispatches a platform-appropriate spawn.
 *   5. Never throws — even if spawn itself fails.
 *
 * `child_process.spawn` is mocked so the suite never fires a real OS
 * notification (which would beep the test runner on Windows / pop a banner
 * on macOS).
 */

const QUESTION_ID = 'qst_abcdef';

function makeLoop(overrides: Partial<LoopThread> = {}): LoopThread {
  return {
    schema_version: 1,
    id: 'lop_testloop',
    version: 1,
    mutation_id: 'mut_1',
    kind: 'ideation',
    title: 'notify-op test',
    status: 'paused',
    phases: [{ name: 'clarify' }],
    current_phase: 'clarify',
    iteration_count: 0,
    slots: [],
    artifacts: [
      {
        artifact_id: 'art_q',
        phase: 'clarify',
        type: 'operator_question',
        body: JSON.stringify({
          question_id: QUESTION_ID,
          question_text: 'What is the primary outcome we are bootstrapping?',
          evidence: ['no prior PROJECT.md'],
          pause_scope: 'loop',
          on_timeout: 'continue_incomplete',
        }),
        produced_at: '2026-05-22T00:00:00.000Z',
      },
    ],
    open_questions: [QUESTION_ID],
    protocol: { preset: 'bootstrap' },
    created_at: '2026-05-22T00:00:00.000Z',
    updated_at: '2026-05-22T00:00:00.000Z',
    created_by: 'agt_test',
    ...overrides,
  } as LoopThread;
}

function makeInputRequestedEvent(): LoopEvent {
  return {
    event_id: 'evt_1',
    loop_id: 'lop_testloop',
    seq: 1,
    at: '2026-05-22T00:00:00.000Z',
    mutation_id: 'mut_1',
    kind: 'input_requested',
    question_id: QUESTION_ID,
    pause_scope: 'loop',
    by_slot_id: 'lsl_test',
  } as LoopEvent;
}

function fakeChild(): EventEmitter & { unref: () => void } {
  const ee = new EventEmitter() as EventEmitter & { unref: () => void };
  ee.unref = () => {};
  return ee;
}

describe('notifyOperatorOnInputRequested (pln#513 step 4)', () => {
  let spawnCalls: Array<{ command: string; args: readonly string[] }>;
  let prevEnv: string | undefined;

  beforeEach(() => {
    spawnCalls = [];
    prevEnv = process.env.BRAINCLAW_OPERATOR_NOTIFICATIONS;
    mock.method(child_process, 'spawn', ((command: string, args: readonly string[]) => {
      spawnCalls.push({ command, args });
      return fakeChild() as ReturnType<typeof child_process.spawn>;
    }) as unknown as typeof child_process.spawn);
  });

  afterEach(() => {
    mock.restoreAll();
    if (prevEnv === undefined) {
      delete process.env.BRAINCLAW_OPERATOR_NOTIFICATIONS;
    } else {
      process.env.BRAINCLAW_OPERATOR_NOTIFICATIONS = prevEnv;
    }
  });

  it('returns silently when env var is not set', () => {
    delete process.env.BRAINCLAW_OPERATOR_NOTIFICATIONS;
    notifyOperatorOnInputRequested(makeInputRequestedEvent(), makeLoop());
    assert.equal(spawnCalls.length, 0);
  });

  it('returns silently when env var is set to something other than "1"', () => {
    process.env.BRAINCLAW_OPERATOR_NOTIFICATIONS = 'true';
    notifyOperatorOnInputRequested(makeInputRequestedEvent(), makeLoop());
    assert.equal(spawnCalls.length, 0);
  });

  it('returns silently when event.kind is not input_requested', () => {
    process.env.BRAINCLAW_OPERATOR_NOTIFICATIONS = '1';
    const otherEvent: LoopEvent = {
      event_id: 'evt_2',
      loop_id: 'lop_testloop',
      seq: 2,
      at: '2026-05-22T00:00:00.000Z',
      mutation_id: 'mut_2',
      kind: 'opened',
      initial_phase: 'clarify',
      created_by: 'agt_test',
    } as LoopEvent;
    notifyOperatorOnInputRequested(otherEvent, makeLoop());
    assert.equal(spawnCalls.length, 0);
  });

  it('returns silently when loop preset is not bootstrap', () => {
    process.env.BRAINCLAW_OPERATOR_NOTIFICATIONS = '1';
    const loop = makeLoop({ protocol: { preset: 'something_else' } });
    notifyOperatorOnInputRequested(makeInputRequestedEvent(), loop);
    assert.equal(spawnCalls.length, 0);
  });

  it('returns silently when loop has no protocol at all', () => {
    process.env.BRAINCLAW_OPERATOR_NOTIFICATIONS = '1';
    const loop = makeLoop({ protocol: undefined });
    notifyOperatorOnInputRequested(makeInputRequestedEvent(), loop);
    assert.equal(spawnCalls.length, 0);
  });

  it('dispatches a platform-appropriate spawn when all conditions are met', () => {
    process.env.BRAINCLAW_OPERATOR_NOTIFICATIONS = '1';
    notifyOperatorOnInputRequested(makeInputRequestedEvent(), makeLoop());

    if (process.platform !== 'linux' && process.platform !== 'darwin' && process.platform !== 'win32') {
      assert.equal(spawnCalls.length, 0, 'unsupported platforms must no-op silently');
      return;
    }

    assert.equal(spawnCalls.length, 1, 'expected exactly one spawn invocation');
    const call = spawnCalls[0];
    const joinedArgs = call.args.join(' ');
    assert.ok(joinedArgs.includes('lop_testloop'), 'spawn payload must reference the loop id');

    if (process.platform === 'linux') {
      assert.equal(call.command, 'notify-send');
      assert.equal(call.args[0], 'brainclaw');
    } else if (process.platform === 'darwin') {
      assert.equal(call.command, 'osascript');
      assert.equal(call.args[0], '-e');
      assert.ok(call.args[1].includes('display notification'));
      assert.ok(call.args[1].includes('with title "brainclaw"'));
    } else if (process.platform === 'win32') {
      assert.equal(call.command, 'powershell.exe');
      // PowerShell command is the last arg after -NoProfile / -NonInteractive / -Command
      const psPayload = call.args[call.args.length - 1];
      assert.ok(psPayload.includes('lop_testloop'));
    }
  });

  it('never throws when spawn itself throws', () => {
    process.env.BRAINCLAW_OPERATOR_NOTIFICATIONS = '1';
    mock.restoreAll();
    mock.method(child_process, 'spawn', (() => {
      throw new Error('synthetic spawn failure');
    }) as unknown as typeof child_process.spawn);

    assert.doesNotThrow(() =>
      notifyOperatorOnInputRequested(makeInputRequestedEvent(), makeLoop()),
    );
  });

  it('never throws when the loop has no operator_question artifact body', () => {
    process.env.BRAINCLAW_OPERATOR_NOTIFICATIONS = '1';
    const loop = makeLoop({ artifacts: [] });
    assert.doesNotThrow(() => notifyOperatorOnInputRequested(makeInputRequestedEvent(), loop));
  });
});
