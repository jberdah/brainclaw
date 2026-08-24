import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { add_artifact } from '../../src/core/loops/verbs.js';
import { openLoop } from '../../src/core/loops/store.js';
import { ensureContinuation } from '../../src/core/loops/continuation.js';
import type { NextAction } from '../../src/core/facade-schema.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

describe('durable continuation authority', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-continuation-', currentAgent: 'codex' });
  });

  afterEach(() => workspace.cleanup());

  function proposal() {
    const source = openLoop({
      kind: 'ideation', title: 'Concurrent continuation', phases: [{ name: 'synthesis' }],
      created_by: workspace.currentAgent.agent_id,
    }, workspace.dir);
    const added = add_artifact({
      id: source.id,
      artifact: {
        phase: 'synthesis', type: 'plan_draft', body: 'Implement once.',
        addresses_critique: ['art_critique1'],
        implementation_verify: { command: [process.execPath, '-e', 'process.exit(0)'] },
      },
      actor: workspace.currentAgent.agent_id,
    }, workspace.dir);
    const thread = added;
    const artifact = thread.artifacts.at(-1)!;
    const action: NextAction = {
      tool: 'bclaw_loop',
      args: {
        intent: 'open', kind: 'implementation', title: 'Implement once', goal: 'Implement once',
        linked: {
          source_loop_id: thread.id,
          source_artifact_id: artifact.artifact_id,
          source_artifact_digest: artifact.evidence?.artifact_digest,
        },
        verify: artifact.implementation_verify,
        slots: [{ role: 'implementer' }],
        allow_orphan: true,
      },
    };
    return { thread, artifact, action };
  }

  it('elects one live applier and makes a concurrent caller observe without duplicating', async () => {
    const { thread, artifact, action } = proposal();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => { started = resolve; });
    let executions = 0;
    const input = {
      source_loop: thread,
      source_artifact: artifact,
      action,
      action_index: 0,
      autonomy_mode: 'autonomous' as const,
      risk: 'normal' as const,
      actor: 'codex',
      actor_id: workspace.currentAgent.agent_id,
      execute: async () => {
        executions += 1;
        started();
        await gate;
        return { kind: 'loop' as const, id: 'lop_deadbeef' };
      },
    };

    const winner = ensureContinuation(input, workspace.dir);
    await hasStarted;
    const observer = await ensureContinuation(input, workspace.dir);
    assert.equal(observer.executing_elsewhere, true);
    assert.equal(observer.record.state, 'applying');
    assert.equal(executions, 1);

    release();
    const applied = await winner;
    assert.equal(applied.record.state, 'applied');
    assert.equal(applied.record.downstream?.id, 'lop_deadbeef');

    const replay = await ensureContinuation(input, workspace.dir);
    assert.equal(replay.reused, true);
    assert.equal(replay.record.downstream?.id, 'lop_deadbeef');
    assert.equal(executions, 1);
  });
});
