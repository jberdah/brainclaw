import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { harvestLaneResults } from '../../src/commands/harvest.js';
import { loadAgentRun } from '../../src/core/agentruns.js';
import { saveClaim } from '../../src/core/claims.js';
import { resolveHarnessBinding } from '../../src/core/harness-adapters/index.js';
import { nowISO } from '../../src/core/ids.js';
import { getLoop, openLoop } from '../../src/core/loops/store.js';
import { prepareTurnExecution } from '../../src/core/loops/turn-execution.js';
import { getRuntimeLogPath, getRuntimeSignalPath, writeCompletionSignal } from '../../src/core/runtime-signals.js';

function prepareNativeReview(
  cwd: string,
  worktree: string,
  suffix: string,
  terminalClaim: Record<string, unknown>,
) {
  const slotId = `lsl_review${suffix}`;
  const claimId = `clm_review${suffix}`;
  const loop = openLoop({
    kind: 'review', title: `native review ${suffix}`, created_by: 'coord',
    phases: [{ name: 'findings' }, { name: 'verdict' }],
    stop_condition: { kind: 'reviewer_green' },
    slots: [{ slot_id: slotId, role: 'reviewer', agent: 'codex' }],
  }, cwd);
  saveClaim({
    schema_version: 2, id: claimId, agent: 'codex', scope: `native-review-${suffix}`,
    description: 'native review', created_at: nowISO(), status: 'active', worktree_path: worktree,
  }, cwd);
  const binding = resolveHarnessBinding('codex', 'gpt-5.6-sol', true, { resolveExecutable: (binary) => binary });
  const prepared = prepareTurnExecution({
    kind: 'review', loop_id: loop.id, slot_id: slotId, phase: 'findings', agent: 'codex',
    claim_id: claimId, dispatcher_agent: 'coord', scope: `native-review-${suffix}`,
    description: 'native review', task: 'review the change', cwd, worktree_path: worktree,
    model: 'gpt-5.6-sol', harness_binding: binding,
  });
  assert.equal(prepared.kind, 'won');
  if (prepared.kind !== 'won' || !prepared.execution_contract_ref) throw new Error('contracted review did not win');
  const ackPath = getRuntimeSignalPath(cwd, prepared.assignment_id, 'ack');
  fs.mkdirSync(path.dirname(ackPath), { recursive: true });
  fs.writeFileSync(ackPath, JSON.stringify({
    status: 'accepted', turn_id: prepared.turn_id, run_id: prepared.run_id, nonce: prepared.nonce,
    contract_hash: prepared.execution_contract_ref.hash,
    capability_snapshot_hash: prepared.execution_contract_ref.snapshot_hash,
  }));
  const stdoutLog = getRuntimeLogPath(cwd, prepared.assignment_id, 'stdout');
  fs.mkdirSync(path.dirname(stdoutLog), { recursive: true });
  fs.writeFileSync(stdoutLog, [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(terminalClaim) } }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n'));
  fs.writeFileSync(getRuntimeLogPath(cwd, prepared.assignment_id, 'stderr'), '');
  writeCompletionSignal(cwd, prepared.assignment_id, {
    turn_id: prepared.turn_id, run_id: prepared.run_id, nonce: prepared.nonce,
    status: 'completed', at: nowISO(), contract_hash: prepared.execution_contract_ref.hash,
    capability_snapshot_hash: prepared.execution_contract_ref.snapshot_hash,
  });
  return { loop, prepared };
}

describe('native harness production harvest (pln#681)', () => {
  let cwd: string;
  let worktree: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-native-harvest-'));
    fs.mkdirSync(path.join(cwd, '.brainclaw'), { recursive: true });
    worktree = path.join(cwd, 'critic-worktree');
    fs.mkdirSync(worktree, { recursive: true });
  });
  afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

  it('normalizes terminal Codex JSONL, records the observation, then lets the server seal evidence', () => {
    const loop = openLoop({
      kind: 'ideation', title: 'native critic', created_by: 'coord',
      phases: [{ name: 'critique' }, { name: 'revision' }, { name: 'synthesis' }],
      stop_condition: { kind: 'max_iterations', n: 2 },
      slots: [{ slot_id: 'lsl_nativecritic', role: 'critic', agent: 'codex' }],
    }, cwd);
    saveClaim({
      schema_version: 2, id: 'clm_native_critic', agent: 'codex', scope: 'native-critic',
      description: 'native critic', created_at: nowISO(), status: 'active', worktree_path: worktree,
    }, cwd);
    const binding = resolveHarnessBinding('codex', 'gpt-5.6-sol', true, { resolveExecutable: (binary) => binary });
    const prepared = prepareTurnExecution({
      kind: 'ideation', loop_id: loop.id, slot_id: 'lsl_nativecritic', phase: 'critique',
      agent: 'codex', claim_id: 'clm_native_critic', dispatcher_agent: 'coord',
      scope: 'native-critic', description: 'native critic', task: 'challenge proposal',
      cwd, worktree_path: worktree, model: 'gpt-5.6-sol', harness_binding: binding,
    });
    assert.equal(prepared.kind, 'won');
    if (prepared.kind !== 'won' || !prepared.execution_contract_ref) throw new Error('contracted turn did not win');

    const ackPath = getRuntimeSignalPath(cwd, prepared.assignment_id, 'ack');
    fs.mkdirSync(path.dirname(ackPath), { recursive: true });
    fs.writeFileSync(ackPath, JSON.stringify({
      status: 'accepted', turn_id: prepared.turn_id, run_id: prepared.run_id, nonce: prepared.nonce,
      contract_hash: prepared.execution_contract_ref.hash,
      capability_snapshot_hash: prepared.execution_contract_ref.snapshot_hash,
    }));
    const stdoutLog = getRuntimeLogPath(cwd, prepared.assignment_id, 'stdout');
    fs.mkdirSync(path.dirname(stdoutLog), { recursive: true });
    fs.writeFileSync(stdoutLog, [
      JSON.stringify({
        type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({
          schema_version: 1, status: 'completed', summary: 'portability conflict',
          body: 'The proposal conflicts with the retained portability constraint.', artifact_type: 'critique',
        }) },
      }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n'));
    fs.writeFileSync(getRuntimeLogPath(cwd, prepared.assignment_id, 'stderr'), '');
    writeCompletionSignal(cwd, prepared.assignment_id, {
      turn_id: prepared.turn_id, run_id: prepared.run_id, nonce: prepared.nonce,
      status: 'completed', at: nowISO(), contract_hash: prepared.execution_contract_ref.hash,
      capability_snapshot_hash: prepared.execution_contract_ref.snapshot_hash,
    });

    const harvested = harvestLaneResults({
      assignmentId: prepared.assignment_id, worktreePaths: [worktree], cwd,
    });
    assert.equal(harvested.errors.length, 0, JSON.stringify(harvested.errors));
    assert.equal(harvested.harvested.length, 1);
    assert.equal(harvested.harvested[0]?.artifact_type, 'critique');
    assert.equal('evidence' in harvested.harvested[0]!, false, 'adapter output cannot mint evidence');
    assert.equal('gate' in harvested.harvested[0]!, false, 'adapter output cannot decide a gate');
    const recordedRun = loadAgentRun(prepared.run_id, cwd)!;
    assert.equal(recordedRun.runtime_capability_observation?.adapter_id, 'codex-cli');
    assert.equal(recordedRun.execution_contract_anomaly, undefined);
    const updatedLoop = getLoop(loop.id, cwd)!;
    const critique = updatedLoop.artifacts.find((artifact) => artifact.type === 'critique');
    assert.ok(critique, 'the shared reconciler accepted the normalized critique');
    assert.ok(critique?.evidence, 'evidence is sealed only after server reconciliation');
  });

  it('converges native review only from an explicit structured approve verdict', () => {
    const fixture = prepareNativeReview(cwd, worktree, 'approve', {
      schema_version: 1, status: 'completed', summary: 'No blocking findings.',
      body: 'The change satisfies the acceptance criteria.', artifact_type: 'verdict', review_verdict: 'approve',
    });
    const harvested = harvestLaneResults({
      assignmentId: fixture.prepared.assignment_id, worktreePaths: [worktree], cwd,
    });
    assert.equal(harvested.errors.length, 0, JSON.stringify(harvested.errors));
    assert.equal(harvested.harvested[0]?.review_verdict, 'approve');
    assert.equal(getLoop(fixture.loop.id, cwd)?.status, 'completed');
    assert.ok(getLoop(fixture.loop.id, cwd)?.artifacts.some((artifact) => artifact.type === 'verdict' && artifact.evidence));
  });

  it('keeps missing and unknown native review verdicts fail-closed', () => {
    for (const [suffix, terminalClaim] of [
      ['missing', { schema_version: 1, status: 'completed', summary: 'Narrative only.' }],
      ['unknown', { schema_version: 1, status: 'completed', summary: 'Ambiguous.', review_verdict: 'maybe' }],
    ] as const) {
      const laneWorktree = path.join(cwd, `review-${suffix}`);
      fs.mkdirSync(laneWorktree, { recursive: true });
      const fixture = prepareNativeReview(cwd, laneWorktree, suffix, terminalClaim);
      const harvested = harvestLaneResults({
        assignmentId: fixture.prepared.assignment_id, worktreePaths: [laneWorktree], cwd,
      });
      assert.equal(harvested.errors.length, 0, JSON.stringify(harvested.errors));
      assert.equal(harvested.harvested[0]?.status, 'failed');
      assert.equal(harvested.harvested[0]?.review_verdict, undefined);
      assert.notEqual(getLoop(fixture.loop.id, cwd)?.status, 'completed');
      assert.equal(getLoop(fixture.loop.id, cwd)?.artifacts.some((artifact) => artifact.type === 'verdict'), false);
    }
  });
});
