import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { add_artifact } from '../../src/core/loops/verbs.js';
import { openLoop } from '../../src/core/loops/store.js';
import { ensureContinuation, evaluateContinuation } from '../../src/core/loops/continuation.js';
import type { NextAction } from '../../src/core/facade-schema.js';
import { saveAgentIdentity } from '../../src/core/agent-registry.js';
import { selectImplementationReviewer } from '../../src/core/reviewer-policy.js';
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

  it('selects a stable independent reviewer and accepts an attested review action', () => {
    saveAgentIdentity({ ...workspace.currentAgent, trust_level: 'trusted' }, workspace.dir);
    const reviewer = workspace.registerAgent('claude-code');
    saveAgentIdentity({ ...reviewer, trust_level: 'trusted' }, workspace.dir);
    const source = openLoop({
      kind: 'implementation', title: 'Implementation ready for review',
      phases: [{ name: 'handoff_ready' }],
      slots: [{ role: 'implementer', agent: workspace.currentAgent.agent_name, agent_id: workspace.currentAgent.agent_id }],
      created_by: workspace.currentAgent.agent_id,
    }, workspace.dir);
    const thread = add_artifact({
      id: source.id,
      artifact: {
        phase: 'handoff_ready', type: 'handoff', body: 'Verified implementation.',
        ref: { kind: 'commit', id: 'abc1234' },
      },
      actor: workspace.currentAgent.agent_id,
    }, workspace.dir);
    const artifact = thread.artifacts.at(-1)!;
    const selected = selectImplementationReviewer(thread, workspace.dir);
    assert.equal(selected.agent, 'claude-code');
    assert.equal(selected.agent_id, reviewer.agent_id);
    assert.deepEqual(selected.excluded_implementers, [{
      agent: workspace.currentAgent.agent_name,
      agent_id: workspace.currentAgent.agent_id,
    }]);

    const action: NextAction = {
      tool: 'bclaw_coordinate',
      args: {
        intent: 'review', open_loop: true, review_mode: 'asymmetric',
        task: 'Review abc1234', targetAgents: [selected.agent], ref: 'abc1234',
        linked: {
          source_loop_id: thread.id,
          source_artifact_id: artifact.artifact_id,
          source_artifact_digest: artifact.evidence?.artifact_digest,
        },
      },
    };
    const proposal = evaluateContinuation({
      source_loop: thread, source_artifact: artifact, action, action_index: 0,
      autonomy_mode: 'autonomous', risk: 'normal',
    });
    assert.equal(proposal.decision, 'auto');
    assert.match(proposal.continuation_key, /^[a-f0-9]{64}$/);
    assert.deepEqual(proposal.reason.slice(0, 2), [
      'attested implementation handoff', 'concrete independent review action',
    ]);
  });

  it('fails closed when every review-capable identity implemented the change', () => {
    saveAgentIdentity({ ...workspace.currentAgent, trust_level: 'trusted' }, workspace.dir);
    const other = workspace.registerAgent('claude-code');
    saveAgentIdentity({ ...other, trust_level: 'trusted' }, workspace.dir);
    const source = openLoop({
      kind: 'implementation', title: 'No independent reviewer',
      slots: [
        { role: 'implementer', agent: workspace.currentAgent.agent_name, agent_id: workspace.currentAgent.agent_id },
        { role: 'implementer', agent: other.agent_name },
      ],
      created_by: workspace.currentAgent.agent_id,
    }, workspace.dir);
    assert.throws(
      () => selectImplementationReviewer(source, workspace.dir),
      /continuation_reviewer_unavailable: no independent spawnable reviewer/,
    );
  });
});
