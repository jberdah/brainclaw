import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ExecutionContractSchema,
  canonicalExecutionContract,
  executionContractHash,
  executionContractRef,
  assertExecutionContractIntegrity,
  capabilitySnapshotHash,
  resolveCapabilitySnapshot,
  validateWorkerContractAcceptance,
  type ExecutionContract,
} from '../../src/core/execution-contract.js';

function contract(scope = 'src/core'): ExecutionContract {
  return ExecutionContractSchema.parse({
    schema_version: 1,
    minimum_reader_version: 1,
    identity: {
      loop_id: 'lop_1', turn_id: 'ltr_1', logical_attempt_epoch: 0,
      assignment_id: 'asg_1', run_id: 'run_1', kind: 'research',
      phase: 'investigate', iteration: 0,
    },
    artifact_contract: {
      completion_mode: 'file',
      expected_artifacts: [{
        logical_name: 'finding', worker_path: 'LANE-RESULT.json',
        loop_artifact_type: 'finding', completion_policy: 'required',
      }],
    },
    capability_requirement: {
      roles: ['execute'], required_surfaces: ['cli_spawn'],
      execution_surfaces: ['cli'], required_tools: [],
    },
    workspace_policy: {
      scope, cwd: 'C:\\repo', isolation: 'shared_checkout', write_access: 'workspace',
    },
    timeout_policy: { dispatch_lease_ms: 60_000, grant_lease_ms: 30_000 },
    evidence_policy: {
      require_turn_id: true, require_run_id: true, require_nonce: true, artifact_hash: 'optional',
    },
    protocol: { name: 'attempt-authority', minimum_version: 1 },
  });
}

describe('ExecutionContract v1', () => {
  it('serializes canonically, normalizes Unicode, and hashes every immutable policy field', () => {
    const decomposed = contract('re\u0301sultat');
    const composed = contract('résultat');
    assert.equal(canonicalExecutionContract(decomposed), canonicalExecutionContract(composed));
    assert.equal(executionContractHash(decomposed), executionContractHash(composed));
    assert.notEqual(executionContractHash(contract('src/a')), executionContractHash(contract('src/b')));
    const snapshot = resolveCapabilitySnapshot('codex', composed.capability_requirement);
    assert.deepEqual(executionContractRef(composed, snapshot), {
      version: 1,
      hash: executionContractHash(composed),
      snapshot_hash: capabilitySnapshotHash(snapshot),
      turn_id: 'ltr_1',
    });
  });

  it('fails closed when the reader or protocol cannot interpret the contract', () => {
    assert.equal(ExecutionContractSchema.safeParse({ ...contract(), minimum_reader_version: 2 }).success, false);
    assert.equal(ExecutionContractSchema.safeParse({
      ...contract(), protocol: { name: 'attempt-authority', minimum_version: 2 },
    }).success, false);
  });

  it('separates requirements from the deterministic observed snapshot', () => {
    const accepted = resolveCapabilitySnapshot('codex', {
      roles: ['execute'], required_surfaces: ['cli_spawn'], execution_surfaces: ['cli'],
      model: 'gpt-contract-test', required_tools: [],
    });
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.requested.required_surfaces.includes('cli_spawn'), true);
    assert.equal(accepted.resolved.surfaces.includes('cli_spawn'), true);
    assert.equal(accepted.resolved.model, 'gpt-contract-test');

    const unattested = resolveCapabilitySnapshot('codex', {
      roles: ['execute'], required_surfaces: [], execution_surfaces: [], required_tools: ['bclaw_work'],
    });
    assert.equal(unattested.accepted, false);
    assert.deepEqual(unattested.reasons.map((reason) => reason.code), ['tool_catalog_unattested']);

    const unknown = resolveCapabilitySnapshot('not-a-profile', {
      roles: ['execute'], required_surfaces: [], execution_surfaces: [], required_tools: [],
    });
    assert.equal(unknown.accepted, false);
    assert.deepEqual(unknown.reasons.map((reason) => reason.code), ['agent_profile_missing']);
  });

  it('treats CLI spawnability independently from the native execution surface', () => {
    const spawnableExtension = resolveCapabilitySnapshot('cline', {
      roles: ['review'], required_surfaces: ['cli_spawn'], execution_surfaces: [], required_tools: [],
    });
    assert.equal(spawnableExtension.accepted, true);
    assert.equal(spawnableExtension.resolved.surfaces.includes('cli_spawn'), true);
    assert.equal(spawnableExtension.resolved.execution_surface, 'extension');

    const cliOnly = resolveCapabilitySnapshot('cline', {
      roles: ['review'], required_surfaces: ['cli_spawn'], execution_surfaces: ['cli'], required_tools: [],
    });
    assert.equal(cliOnly.accepted, false);
    assert.deepEqual(cliOnly.reasons.map((reason) => reason.code), ['execution_surface_mismatch']);
  });

  it('refuses a hash or snapshot that does not belong to the contract', () => {
    const value = contract();
    const snapshot = resolveCapabilitySnapshot('codex', value.capability_requirement);
    const ref = executionContractRef(value, snapshot);
    assert.doesNotThrow(() => assertExecutionContractIntegrity(value, ref, snapshot));
    assert.throws(() => assertExecutionContractIntegrity(value, { ...ref, hash: '0'.repeat(64) }, snapshot), /hash mismatch/);
    assert.throws(() => assertExecutionContractIntegrity(value, ref, {
      ...snapshot,
      requested: { ...snapshot.requested, required_surfaces: [] },
    }), /snapshot hash mismatch|requirement differs/);
  });

  it('distinguishes a safe pre-cross abort from a post-cross anomaly without respawn', () => {
    const expected = { version: 1, hash: 'a', snapshot_hash: 's', turn_id: 'turn' } as const;
    assert.deepEqual(validateWorkerContractAcceptance(expected, { contract_hash: 'a', capability_snapshot_hash: 's' }, 'armed'), { kind: 'accepted' });
    assert.deepEqual(validateWorkerContractAcceptance(expected, { contract_hash: 'b', capability_snapshot_hash: 's' }, 'armed'), {
      kind: 'abort_and_reselect',
      expected: { contract_hash: 'a', capability_snapshot_hash: 's' },
      accepted: { contract_hash: 'b', capability_snapshot_hash: 's' },
    });
    assert.deepEqual(validateWorkerContractAcceptance(expected, { contract_hash: 'a', capability_snapshot_hash: 'x' }, 'crossed'), {
      kind: 'post_crossing_anomaly',
      expected: { contract_hash: 'a', capability_snapshot_hash: 's' },
      accepted: { contract_hash: 'a', capability_snapshot_hash: 'x' },
      respawn: false,
    });
  });
});
