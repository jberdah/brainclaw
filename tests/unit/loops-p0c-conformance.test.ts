import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadClaim, saveClaim } from '../../src/core/claims.js';
import { ensureAssignmentProjection, loadAssignment } from '../../src/core/assignments.js';
import { ensureAgentRunProjection, loadAgentRun } from '../../src/core/agentruns.js';
import { reconcileAgentRun } from '../../src/core/agentrun-reconciler.js';
import { executionContractHash } from '../../src/core/execution-contract.js';
import { nowISO } from '../../src/core/ids.js';
import { deriveTurnId, getReservation, listReservations } from '../../src/core/loops/attempt-reservation.js';
import { matchEvidence, prepareAttempt } from '../../src/core/loops/attempt-authority.js';
import { LOOP_KIND_POLICIES, assertLoopKindPoliciesComplete, phasePolicy } from '../../src/core/loops/kind-policies.js';
import { reducerForKind } from '../../src/core/loops/result-reducers.js';
import { getLoop, openLoop } from '../../src/core/loops/store.js';
import { prepareTurnExecution } from '../../src/core/loops/turn-execution.js';
import { reconcileTurn } from '../../src/core/loops/reconcile-turn.js';
import { DEFAULT_PROTOCOLS, LOOP_KINDS, type LoopKind } from '../../src/core/loops/types.js';
import type { LaneResult } from '../../src/core/schema.js';
import { getLaneResultPath, harvestLaneResults } from '../../src/commands/harvest.js';
import { prepareTurnOwnedReviewDispatch, turnOwnedLoopEnabled, turnOwnedLoopMode } from '../../src/core/review-loop-turn-dispatch.js';
import { getRuntimeSignalPath, writeCompletionSignal } from '../../src/core/runtime-signals.js';

function workspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-p0c-'));
  fs.mkdirSync(path.join(cwd, '.brainclaw'), { recursive: true });
  return cwd;
}

const workerPhase: Record<LoopKind, string> = {
  review: 'findings',
  ideation: 'critique',
  implementation: 'execute',
  research: 'investigate',
  debug: 'reproduce',
};

function setupAttempt(cwd: string, kind: LoopKind, selectedPhase = workerPhase[kind]) {
  const phase = selectedPhase;
  const suffix = `${kind}${phase}`.replace(/_/g, '');
  const slotId = `lsl_${suffix}`;
  const claimId = `clm_${suffix}`;
  const loop = openLoop({
    kind,
    title: `${kind} conformance`,
    created_by: 'coord',
    phases: kind === 'ideation'
      ? [{ name: 'critique' }, { name: 'revision' }, { name: 'synthesis' }]
      : [{ name: phase }],
    stop_condition: { kind: 'max_iterations', n: 9 },
    slots: [{ slot_id: slotId, role: 'worker', agent: 'codex' }],
  }, cwd);
  saveClaim({
    schema_version: 2,
    id: claimId,
    agent: 'codex',
    scope: `loop:${loop.id}:${slotId}`,
    description: `${kind} conformance attempt`,
    created_at: nowISO(),
    status: 'active',
  }, cwd);
  const result = prepareTurnExecution({
    kind,
    loop_id: loop.id,
    slot_id: slotId,
    phase,
    agent: 'codex',
    claim_id: claimId,
    dispatcher_agent: 'coord',
    scope: `loop:${loop.id}:${slotId}`,
    description: `${kind} conformance attempt`,
    task: `execute ${kind}.${phase}`,
    cwd,
  });
  assert.equal(result.kind, 'won');
  if (result.kind !== 'won') throw new Error('attempt did not win');
  return { loop, phase, slotId, claimId, result, reservation: getReservation(result.turn_id, cwd)! };
}

describe('P0C — common AttemptAuthority lifecycle across five LoopKinds', () => {
  let cwd: string;
  beforeEach(() => { cwd = workspace(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  for (const kind of LOOP_KINDS) {
    it(`${kind}: projections precede one crossing and replay cannot spawn twice`, () => {
      const first = setupAttempt(cwd, kind);
      assert.equal(first.reservation.decision, 'committed');
      assert.equal(first.reservation.launch?.status, 'crossed');
      assert.equal(first.reservation.child_ids.assignment_id, first.result.assignment_id);
      assert.equal(first.reservation.child_ids.run_id, first.result.run_id);
      assert.equal(first.reservation.phase, first.phase);
      assert.deepEqual(first.reservation.expected_artifacts, phasePolicy(kind, first.phase)?.expected_artifacts);
      assert.ok(first.reservation.execution_contract, 'reservation owns the complete contract');
      assert.ok(first.reservation.execution_contract_ref, 'reservation owns the contract hash/reference');
      assert.ok(first.reservation.capability_snapshot?.accepted, 'capability is resolved before crossing');
      assert.equal(
        first.reservation.execution_contract_ref.hash,
        executionContractHash(first.reservation.execution_contract),
      );
      const assignment = loadAssignment(first.result.assignment_id, cwd)!;
      const run = loadAgentRun(first.result.run_id, cwd)!;
      assert.deepEqual(assignment.execution_contract_ref, first.reservation.execution_contract_ref);
      assert.deepEqual(run.execution_contract_ref, first.reservation.execution_contract_ref);
      assert.deepEqual(assignment.capability_snapshot, first.reservation.capability_snapshot);
      assert.deepEqual(run.capability_snapshot, first.reservation.capability_snapshot);
      assert.equal(matchEvidence(first.reservation, {
        turn_id: first.result.turn_id,
        run_id: first.result.run_id,
        nonce: first.result.nonce,
      }), true);
      assert.equal(matchEvidence(first.reservation, {
        turn_id: first.result.turn_id,
        run_id: first.result.run_id,
        nonce: 'stale-generation',
      }), false);

      const replay = prepareTurnExecution({
        kind,
        loop_id: first.loop.id,
        slot_id: first.slotId,
        phase: first.phase,
        agent: 'codex',
        claim_id: first.claimId,
        dispatcher_agent: 'coord',
        scope: `loop:${first.loop.id}:${first.slotId}`,
        description: `${kind} conformance attempt`,
        task: `execute ${kind}.${first.phase}`,
        cwd,
      });
      assert.equal(replay.kind, 'denied');
      assert.equal(listReservations({}, cwd).length, 1, 'no second authority record is invented');
    });
  }

  it('engine/manual phases never reserve or cross a worker attempt', () => {
    assertLoopKindPoliciesComplete();
    assert.deepEqual(Object.keys(LOOP_KIND_POLICIES).sort(), [...LOOP_KINDS].sort());
    const loop = openLoop({
      kind: 'implementation', title: 'engine phase', created_by: 'coord',
      phases: [{ name: 'bind' }], stop_condition: { kind: 'max_iterations', n: 2 },
      slots: [{ slot_id: 'lsl_impl', role: 'worker', agent: 'codex' }],
    }, cwd);
    saveClaim({ schema_version: 2, id: 'clm_impl', agent: 'codex', scope: 'impl', description: 'impl', created_at: nowISO(), status: 'active' }, cwd);
    const result = prepareTurnExecution({
      kind: 'implementation', loop_id: loop.id, slot_id: 'lsl_impl', phase: 'bind', agent: 'codex',
      claim_id: 'clm_impl', dispatcher_agent: 'coord', scope: 'impl', description: 'impl', task: 'bind', cwd,
    });
    assert.equal(result.kind, 'denied');
    if (result.kind === 'denied') {
      assert.equal(result.code, 'precondition');
      assert.equal(result.claim_disposition, 'release');
      assert.equal(result.authority_claimed, false);
    }
    assert.equal(listReservations({}, cwd).length, 0);
  });

  it('rejects unavailable capabilities and a stale worker hash before reserving authority', () => {
    const loop = openLoop({
      kind: 'research', title: 'contract preflight', created_by: 'coord',
      phases: [{ name: 'investigate' }], stop_condition: { kind: 'max_iterations', n: 2 },
      slots: [{ slot_id: 'lsl_preflight', role: 'worker', agent: 'codex' }],
    }, cwd);
    saveClaim({ schema_version: 2, id: 'clm_preflight', agent: 'codex', scope: 'preflight', description: 'preflight', created_at: nowISO(), status: 'active' }, cwd);
    const unavailable = prepareTurnExecution({
      kind: 'research', loop_id: loop.id, slot_id: 'lsl_preflight', phase: 'investigate', agent: 'codex',
      claim_id: 'clm_preflight', dispatcher_agent: 'coord', scope: 'preflight', description: 'preflight', task: 'preflight', cwd,
      capability_requirement: { roles: ['execute'], required_surfaces: [], execution_surfaces: [], required_tools: ['unattested_tool'] },
    });
    assert.equal(unavailable.kind, 'denied');
    assert.equal(listReservations({}, cwd).length, 0);

    const staleHash = prepareTurnExecution({
      kind: 'research', loop_id: loop.id, slot_id: 'lsl_preflight', phase: 'investigate', agent: 'codex',
      claim_id: 'clm_preflight', dispatcher_agent: 'coord', scope: 'preflight', description: 'preflight', task: 'preflight', cwd,
      accepted_execution_contract: {
        contract_hash: '0'.repeat(64),
        capability_snapshot_hash: '0'.repeat(64),
      },
    });
    assert.equal(staleHash.kind, 'denied');
    assert.equal(listReservations({}, cwd).length, 0);
  });

  it('adopts a pre-P1 reservation without inventing an unpersisted contract reference', () => {
    const loop = openLoop({
      kind: 'research', title: 'legacy adoption', created_by: 'coord',
      phases: [{ name: 'investigate' }], stop_condition: { kind: 'max_iterations', n: 2 },
      slots: [{ slot_id: 'lsl_legacy', role: 'worker', agent: 'codex' }],
    }, cwd);
    const claimId = 'clm_legacy';
    saveClaim({ schema_version: 2, id: claimId, agent: 'codex', scope: 'legacy', description: 'legacy', created_at: nowISO(), status: 'active' }, cwd);
    const turnId = deriveTurnId(loop.id, 'lsl_legacy', 0);
    const policy = phasePolicy('research', 'investigate')!;
    prepareAttempt({
      turn_id: turnId,
      loop_id: loop.id,
      slot_id: 'lsl_legacy',
      target_slot_generation: 0,
      loop_version_at_reserve: loop.version,
      agent: 'codex',
      claim_id: claimId,
      phase: 'investigate',
      iteration: 0,
      completion_mode: policy.completion_mode,
      expected_artifacts: policy.expected_artifacts,
      store_root: cwd,
      cwd,
      lease_deadline: new Date(Date.now() + 60_000).toISOString(),
      grant_lease_deadline: new Date(Date.now() + 30_000).toISOString(),
    }, cwd);

    const adopted = prepareTurnExecution({
      kind: 'research', loop_id: loop.id, slot_id: 'lsl_legacy', phase: 'investigate', agent: 'codex',
      claim_id: claimId, dispatcher_agent: 'coord', scope: 'legacy', description: 'legacy', task: 'legacy', cwd,
    });
    assert.equal(adopted.kind, 'won');
    if (adopted.kind !== 'won') throw new Error('legacy reservation was not adopted');
    assert.equal(adopted.contract_status, 'legacy_uncontracted');
    assert.equal(adopted.execution_contract_ref, undefined);
    assert.equal(getReservation(turnId, cwd)?.execution_contract_ref, undefined);
    assert.equal(loadAssignment(adopted.assignment_id, cwd)?.execution_contract_ref, undefined);
    assert.equal(loadAgentRun(adopted.run_id, cwd)?.execution_contract_ref, undefined);
  });

  it('preserves P1 projection fields when a rollback caller replays the legacy shape', () => {
    const prepared = setupAttempt(cwd, 'research');
    const assignment = loadAssignment(prepared.result.assignment_id, cwd)!;
    const run = loadAgentRun(prepared.result.run_id, cwd)!;

    assert.doesNotThrow(() => ensureAssignmentProjection({
      id: assignment.id,
      short_label: assignment.short_label,
      claim_id: assignment.claim_id,
      agent: assignment.agent,
      agent_id: assignment.agent_id,
      dispatcher_agent: assignment.dispatcher_agent,
      dispatcher_session_id: assignment.dispatcher_session_id,
      scope: assignment.scope,
      description: assignment.description,
      worktree_path: assignment.worktree_path,
      tags: assignment.tags,
    }, cwd));
    assert.doesNotThrow(() => ensureAgentRunProjection({
      id: run.id,
      short_label: run.short_label,
      assignment_id: run.assignment_id,
      claim_id: run.claim_id,
      attempt_index: run.attempt_index,
      agent: run.agent,
      agent_id: run.agent_id,
      transport: run.transport,
      status: run.status,
      scope: run.scope,
      description: run.description,
      worktree_path: run.worktree_path,
      tags: run.tags,
    }, cwd));
    assert.deepEqual(loadAssignment(assignment.id, cwd)?.execution_contract_ref, assignment.execution_contract_ref);
    assert.deepEqual(loadAgentRun(run.id, cwd)?.capability_snapshot, run.capability_snapshot);
  });

  it('withholds both loop and run convergence on post-crossing contract evidence mismatch', () => {
    const prepared = setupAttempt(cwd, 'review');
    const ackPath = getRuntimeSignalPath(cwd, prepared.result.assignment_id, 'ack');
    fs.mkdirSync(path.dirname(ackPath), { recursive: true });
    fs.writeFileSync(ackPath, JSON.stringify({
      status: 'accepted',
      turn_id: prepared.result.turn_id,
      run_id: prepared.result.run_id,
      nonce: prepared.result.nonce,
      contract_hash: prepared.result.execution_contract_ref!.hash,
      capability_snapshot_hash: prepared.result.execution_contract_ref!.snapshot_hash,
    }));
    const wrongLane: LaneResult = {
      assignment_id: prepared.result.assignment_id,
      turn_id: prepared.result.turn_id,
      run_id: prepared.result.run_id,
      nonce: prepared.result.nonce,
      status: 'completed',
      summary: 'wrong contract',
      review_verdict: 'approve',
      execution_contract_hash: '0'.repeat(64),
      capability_snapshot_hash: prepared.result.execution_contract_ref!.snapshot_hash,
    };
    const reconciled = reconcileTurn({ turn_id: prepared.result.turn_id, lane: wrongLane, cwd });
    assert.equal(reconciled.reconciled, false);
    assert.equal(reconciled.contract_anomaly, true);
    assert.equal(reconciled.respawn, false);
    assert.equal(getLoop(prepared.loop.id, cwd)?.status, 'open');
    assert.equal(loadAgentRun(prepared.result.run_id, cwd)?.execution_contract_anomaly?.source, 'lane_result');

    const laterCorrectEvidence = reconcileTurn({
      turn_id: prepared.result.turn_id,
      lane: {
        ...wrongLane,
        execution_contract_hash: prepared.result.execution_contract_ref!.hash,
      },
      cwd,
    });
    assert.equal(laterCorrectEvidence.reconciled, false, 'a later matching lane cannot erase the monotone anomaly fence');
    assert.equal(laterCorrectEvidence.contract_anomaly, true);
    assert.equal(laterCorrectEvidence.respawn, false);

    writeCompletionSignal(cwd, prepared.result.assignment_id, {
      turn_id: prepared.result.turn_id,
      run_id: prepared.result.run_id,
      nonce: prepared.result.nonce,
      status: 'completed',
      at: nowISO(),
      contract_hash: '0'.repeat(64),
      capability_snapshot_hash: prepared.result.execution_contract_ref!.snapshot_hash,
    });
    const runResult = reconcileAgentRun(prepared.result.run_id, cwd);
    assert.equal(runResult.action, 'health_check_unverified');
    assert.equal(runResult.evidence.contract_acceptance_anomaly, true);
    assert.equal(loadAgentRun(prepared.result.run_id, cwd)?.status, 'created');
  });

  it('production review dispatch persists the common review phase policy', () => {
    const loop = openLoop({
      kind: 'review', title: 'review production path', created_by: 'coord',
      phases: [{ name: 'findings' }], stop_condition: { kind: 'max_iterations', n: 2 },
      slots: [{ slot_id: 'lsl_reviewer', role: 'reviewer', agent: 'codex' }],
    }, cwd);
    saveClaim({ schema_version: 2, id: 'clm_reviewer', agent: 'codex', scope: 'review-scope', description: 'review', created_at: nowISO(), status: 'active' }, cwd);
    const prepared = prepareTurnOwnedReviewDispatch({
      loopId: loop.id, slotId: 'lsl_reviewer', agent: 'codex', phase: 'findings', task: 'review',
      description: 'review', scope: 'review-scope', claimId: 'clm_reviewer', dispatcherAgent: 'coord',
      isReviewer: true, cwd,
    });
    assert.equal(prepared.kind, 'won');
    const reservation = listReservations({}, cwd)[0];
    assert.equal(reservation.completion_mode, 'either');
    assert.deepEqual(reservation.expected_artifacts, phasePolicy('review', 'findings')?.expected_artifacts);
    assert.ok(reservation.execution_contract, 'production review uses the common ExecutionContract path');
    assert.equal(loadAssignment(prepared.kind === 'won' ? prepared.assignmentId : '', cwd)?.execution_contract_ref?.hash, reservation.execution_contract_ref?.hash);
    assert.equal(loadAgentRun(prepared.kind === 'won' ? prepared.runId : '', cwd)?.execution_contract_ref?.hash, reservation.execution_contract_ref?.hash);
  });

  it('classifies pre-identity, repairable, crossed, and foreign-authority denials', () => {
    const first = setupAttempt(cwd, 'research');
    const replay = prepareTurnExecution({
      kind: 'research', loop_id: first.loop.id, slot_id: first.slotId, phase: first.phase,
      agent: 'codex', claim_id: first.claimId, dispatcher_agent: 'coord', scope: `loop:${first.loop.id}:${first.slotId}`,
      description: 'replay', task: 'replay', cwd,
    });
    assert.equal(replay.kind, 'denied');
    if (replay.kind === 'denied') {
      assert.equal(replay.code, 'already_crossed');
      assert.equal(replay.claim_disposition, 'retain');
      assert.equal(replay.authority_claimed, true);
    }

    const failureCwd = workspace();
    try {
      const loop = openLoop({ kind: 'implementation', title: 'projection failure', created_by: 'coord', phases: [{ name: 'execute' }], stop_condition: { kind: 'max_iterations', n: 2 }, slots: [{ slot_id: 'lsl_failure', role: 'worker', agent: 'codex' }] }, failureCwd);
      saveClaim({ schema_version: 2, id: 'clm_failure', agent: 'codex', scope: 'failure', description: 'failure', created_at: nowISO(), status: 'active' }, failureCwd);
      const failed = prepareTurnExecution({ kind: 'implementation', loop_id: loop.id, slot_id: 'lsl_failure', phase: 'execute', agent: 'codex', claim_id: 'clm_failure', dispatcher_agent: 'coord', scope: 'failure', description: 'failure', task: 'failure', cwd: failureCwd, on_projection: (stage) => { if (stage === 'assignment') throw new Error('projection fault'); } });
      assert.equal(failed.kind, 'denied');
      if (failed.kind === 'denied') {
        assert.equal(failed.code, 'repairable');
        assert.equal(failed.claim_disposition, 'retain');
      }
    } finally {
      fs.rmSync(failureCwd, { recursive: true, force: true });
    }

    const conflictCwd = workspace();
    try {
      const loop = openLoop({ kind: 'research', title: 'authority conflict', created_by: 'coord', phases: [{ name: 'investigate' }], stop_condition: { kind: 'max_iterations', n: 2 }, slots: [{ slot_id: 'lsl_conflict', role: 'worker', agent: 'codex' }] }, conflictCwd);
      for (const id of ['clm_owner', 'clm_foreign']) {
        saveClaim({ schema_version: 2, id, agent: 'codex', scope: id === 'clm_owner' ? 'owner' : 'foreign', description: id, created_at: nowISO(), status: 'active' }, conflictCwd);
      }
      const turnId = deriveTurnId(loop.id, 'lsl_conflict', loop.iteration_count);
      const policy = phasePolicy('research', 'investigate')!;
      prepareAttempt({ turn_id: turnId, loop_id: loop.id, slot_id: 'lsl_conflict', target_slot_generation: 0, loop_version_at_reserve: loop.version, agent: 'codex', claim_id: 'clm_owner', phase: 'investigate', iteration: 0, completion_mode: policy.completion_mode, expected_artifacts: policy.expected_artifacts, store_root: conflictCwd, cwd: conflictCwd, lease_deadline: new Date(Date.now() + 60_000).toISOString(), grant_lease_deadline: new Date(Date.now() + 30_000).toISOString() }, conflictCwd);
      const conflict = prepareTurnExecution({ kind: 'research', loop_id: loop.id, slot_id: 'lsl_conflict', phase: 'investigate', agent: 'codex', claim_id: 'clm_foreign', dispatcher_agent: 'coord', scope: 'foreign', description: 'foreign', task: 'foreign', cwd: conflictCwd });
      assert.equal(conflict.kind, 'denied');
      if (conflict.kind === 'denied') {
        assert.equal(conflict.code, 'authority_conflict');
        assert.equal(conflict.claim_disposition, 'release');
        assert.equal(conflict.authority_claimed, false);
      }
    } finally {
      fs.rmSync(conflictCwd, { recursive: true, force: true });
    }
  });

  it('turn-owned ideation harvest uses the common reconciler, not the legacy closer', () => {
    const prepared = setupAttempt(cwd, 'ideation');
    const worktree = path.join(cwd, 'critic-worktree');
    fs.mkdirSync(worktree, { recursive: true });
    const ackPath = getRuntimeSignalPath(cwd, prepared.result.assignment_id, 'ack');
    fs.mkdirSync(path.dirname(ackPath), { recursive: true });
    fs.writeFileSync(ackPath, JSON.stringify({
      status: 'accepted',
      turn_id: prepared.result.turn_id,
      run_id: prepared.result.run_id,
      nonce: prepared.result.nonce,
      contract_hash: prepared.result.execution_contract_ref!.hash,
      capability_snapshot_hash: prepared.result.execution_contract_ref!.snapshot_hash,
    }));
    fs.writeFileSync(getLaneResultPath(worktree), JSON.stringify({
      assignment_id: prepared.result.assignment_id,
      turn_id: prepared.result.turn_id,
      run_id: prepared.result.run_id,
      nonce: prepared.result.nonce,
      status: 'completed',
      summary: 'challenged the proposal',
      body: 'The proposal conflicts with the retained portability constraint.',
      artifact_type: 'critique',
      execution_contract_hash: prepared.result.execution_contract_ref?.hash,
      capability_snapshot_hash: prepared.result.execution_contract_ref?.snapshot_hash,
    }));

    const harvested = harvestLaneResults({
      assignmentId: prepared.result.assignment_id,
      worktreePaths: [worktree],
      cwd,
    });
    assert.equal(harvested.errors.length, 0, JSON.stringify(harvested.errors));
    assert.equal(harvested.warnings.length, 0, JSON.stringify(harvested.warnings));
    const loop = getLoop(prepared.loop.id, cwd)!;
    assert.ok(loop.artifacts.some((artifact) => artifact.type === 'critique'));
    assert.equal(loop.slots.find((slot) => slot.slot_id === prepared.slotId)?.status, 'done');
  });

  it('report-only harvest retains a mutating implementation attempt for integration', () => {
    const prepared = setupAttempt(cwd, 'implementation', 'execute');
    const worktree = path.join(cwd, 'implementation-worktree');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(getLaneResultPath(worktree), JSON.stringify({
      assignment_id: prepared.result.assignment_id,
      turn_id: prepared.result.turn_id,
      run_id: prepared.result.run_id,
      nonce: prepared.result.nonce,
      status: 'completed',
      summary: 'implemented change',
      artifact_type: 'execute_report',
      body: 'implemented and locally tested',
      files_changed: ['src/example.ts'],
    }));
    const harvested = harvestLaneResults({ assignmentId: prepared.result.assignment_id, worktreePaths: [worktree], cwd });
    assert.ok(harvested.warnings.some((warning) => /requires harvest --integrate/.test(warning.message)));
    assert.equal(loadClaim(prepared.claimId, cwd).status, 'active');
    assert.equal(getLoop(prepared.loop.id, cwd)?.artifacts.some((artifact) => artifact.type === 'execute_report'), false);
  });
});

describe('P0C — exhaustive phase-aware reducers', () => {
  let cwd: string;
  beforeEach(() => { cwd = workspace(); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  const cases: Array<{
    kind: LoopKind;
    phase: string;
    expected: string;
    lane: Partial<LaneResult>;
    critiques?: Array<{ body: string }>;
  }> = [
    { kind: 'review', phase: 'findings', expected: 'verdict', lane: { review_verdict: 'approve', review_summary: 'green' } },
    { kind: 'review', phase: 'author_response', expected: 'author_response', lane: { artifact_type: 'author_response', body: 'fixed and tested' } },
    { kind: 'review', phase: 'followup_review', expected: 'verdict', lane: { review_verdict: 'approve', review_summary: 'green' } },
    { kind: 'ideation', phase: 'critique', expected: 'critique', lane: { artifact_type: 'critique', body: 'counterexample' }, critiques: [{ body: 'counterexample' }] },
    { kind: 'implementation', phase: 'execute', expected: 'execute_report', lane: { artifact_type: 'execute_report', body: 'implementation complete' } },
    { kind: 'research', phase: 'investigate', expected: 'finding', lane: { artifact_type: 'finding', body: 'source-backed finding' } },
    { kind: 'research', phase: 'synthesize', expected: 'synthesis', lane: { artifact_type: 'synthesis', body: 'answer synthesis' } },
    { kind: 'debug', phase: 'reproduce', expected: 'repro', lane: { artifact_type: 'repro', body: 'npm test -- bug' } },
    { kind: 'debug', phase: 'hypothesize', expected: 'hypothesis', lane: { artifact_type: 'hypothesis', body: 'likely race' } },
    { kind: 'debug', phase: 'isolate', expected: 'isolation_report', lane: { artifact_type: 'isolation_report', body: 'isolated to lock handoff' } },
    { kind: 'debug', phase: 'fix', expected: 'verify_report', lane: { artifact_type: 'verify_report', body: JSON.stringify({ command: 'npm test', exit_code: 0, passed: true }) } },
  ];

  for (const c of cases) {
    it(`${c.kind}.${c.phase} produces ${c.expected} without a generic fallback`, () => {
      const attempt = setupAttempt(cwd, c.kind, c.phase).reservation;
      const lane: LaneResult = {
        assignment_id: attempt.child_ids.assignment_id,
        status: 'completed',
        summary: `${c.kind} result`,
        ...c.lane,
      };
      const reduced = reducerForKind(c.kind)({ lane, phase: c.phase, critiques: c.critiques }, attempt);
      assert.equal(reduced.slot_outcome, 'done');
      assert.equal(reduced.artifacts[0]?.type, c.expected);
      assert.notEqual(reduced.artifacts[0]?.type, 'lane_result');
    });
  }

  it('gate-driving artifacts are never inferred from a narrative summary', () => {
    const attempt = setupAttempt(cwd, 'debug').reservation;
    const reduced = reducerForKind('debug')({
      phase: 'reproduce',
      lane: { assignment_id: attempt.child_ids.assignment_id, status: 'completed', summary: 'I reproduced it' },
    }, attempt);
    assert.equal(reduced.slot_outcome, 'failed');
    assert.equal(reduced.artifacts.length, 0);
    assert.match(reduced.failure_reason ?? '', /artifact_type 'repro'/);
  });

  it('a narrative-only ideation lane cannot manufacture a critique artifact', () => {
    const attempt = setupAttempt(cwd, 'ideation', 'critique');
    const worktree = path.join(cwd, 'untyped-critic');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(getLaneResultPath(worktree), JSON.stringify({
      assignment_id: attempt.result.assignment_id,
      turn_id: attempt.result.turn_id,
      run_id: attempt.result.run_id,
      nonce: attempt.result.nonce,
      status: 'completed',
      summary: 'looks risky but this is only a narrative summary',
    }));
    const harvested = harvestLaneResults({ assignmentId: attempt.result.assignment_id, worktreePaths: [worktree], cwd });
    assert.equal(getLoop(attempt.loop.id, cwd)?.artifacts.some((artifact) => artifact.type === 'critique'), false);
    assert.ok(harvested.warnings.some((warning) => warning.code === 'loop_turn_not_converged'));
  });
});

describe('P0C — protocol/policy conformance by phase', () => {
  it('matches every DEFAULT_PROTOCOLS phase and declares complete worker metadata', () => {
    assertLoopKindPoliciesComplete();
    for (const kind of LOOP_KINDS) {
      assert.deepEqual(
        Object.keys(LOOP_KIND_POLICIES[kind].phases).sort(),
        DEFAULT_PROTOCOLS[kind].phases.map((phase) => phase.name).sort(),
      );
      for (const [phase, policy] of Object.entries(LOOP_KIND_POLICIES[kind].phases)) {
        if (policy.execution === 'worker') {
          assert.ok(policy.completion_mode, `${kind}.${phase} completion_mode`);
          assert.ok(policy.expected_artifacts?.length, `${kind}.${phase} expected_artifacts`);
          assert.ok(policy.finalization, `${kind}.${phase} finalization`);
        } else {
          assert.equal(policy.completion_mode, undefined);
          assert.equal(policy.expected_artifacts, undefined);
          assert.equal(policy.finalization, undefined);
        }
      }
    }
  });
});

describe('P0C — additive rollout switch', () => {
  const priorLoops = process.env.BRAINCLAW_TURN_OWNED_LOOPS;
  const priorReview = process.env.BRAINCLAW_TURN_OWNED_REVIEW;
  afterEach(() => {
    if (priorLoops === undefined) delete process.env.BRAINCLAW_TURN_OWNED_LOOPS;
    else process.env.BRAINCLAW_TURN_OWNED_LOOPS = priorLoops;
    if (priorReview === undefined) delete process.env.BRAINCLAW_TURN_OWNED_REVIEW;
    else process.env.BRAINCLAW_TURN_OWNED_REVIEW = priorReview;
  });

  it('defaults to all and supports off/review/all explicitly', () => {
    delete process.env.BRAINCLAW_TURN_OWNED_LOOPS;
    delete process.env.BRAINCLAW_TURN_OWNED_REVIEW;
    assert.equal(turnOwnedLoopMode(), 'all');
    for (const kind of LOOP_KINDS) assert.equal(turnOwnedLoopEnabled(kind), true);

    process.env.BRAINCLAW_TURN_OWNED_LOOPS = 'review';
    assert.equal(turnOwnedLoopEnabled('review'), true);
    assert.equal(turnOwnedLoopEnabled('ideation'), false);

    process.env.BRAINCLAW_TURN_OWNED_LOOPS = 'off';
    for (const kind of LOOP_KINDS) assert.equal(turnOwnedLoopEnabled(kind), false);
  });

  it('keeps BRAINCLAW_TURN_OWNED_REVIEW as a review-only compatibility alias', () => {
    delete process.env.BRAINCLAW_TURN_OWNED_LOOPS;
    process.env.BRAINCLAW_TURN_OWNED_REVIEW = '1';
    assert.equal(turnOwnedLoopMode(), 'review');
    assert.equal(turnOwnedLoopEnabled('review'), true);
    assert.equal(turnOwnedLoopEnabled('debug'), false);
    process.env.BRAINCLAW_TURN_OWNED_REVIEW = '0';
    assert.equal(turnOwnedLoopMode(), 'off');
  });

  it('gives the new switch precedence for valid and invalid legacy combinations', () => {
    for (const [loops, review, expected] of [
      ['all', '0', 'all'],
      ['review', '0', 'review'],
      ['off', '1', 'off'],
      ['invalid', '0', 'off'],
      ['invalid', '1', 'review'],
    ] as const) {
      process.env.BRAINCLAW_TURN_OWNED_LOOPS = loops;
      process.env.BRAINCLAW_TURN_OWNED_REVIEW = review;
      assert.equal(turnOwnedLoopMode(), expected, `${loops} × ${review}`);
    }
  });
});
