import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  AttemptGenerationError,
  CloseDecisionCellSchema,
  closeDecisionCellPath,
  fenceForGeneration,
  generationDigest,
  prepareCloseDecision,
  prepareInitialGeneration,
  prepareNextGeneration,
  publishPreparedCloseDecision,
  type AttemptGeneration,
  type CloseDecisionCell,
} from '../../src/core/loops/attempt-generations.js';

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length > 0) {
    fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(directory);
  return directory;
}

function initialGeneration(turnId: string, workspacePath: string): AttemptGeneration {
  return prepareInitialGeneration({
    turn_id: turnId,
    authority_home: {
      store_instance_id: 'store_primary',
      device_id: 'device_primary',
    },
    contract_hash: 'sha256:contract-0',
    workspace_path: workspacePath,
    workspace_digest: 'sha256:workspace-0',
  });
}

function rawTakeoverCell(
  current: AttemptGeneration,
  next: AttemptGeneration,
): CloseDecisionCell {
  return CloseDecisionCellSchema.parse({
    schema_version: 2,
    cell_kind: 'close_decision',
    fence: fenceForGeneration(current),
    generation_digest: generationDigest(current),
    decision: 'takeover',
    actor: 'direct-low-level-caller',
    cause: 'attempt alias bypass',
    decided_at: '2026-08-23T00:00:00.000Z',
    next_generation: next,
  });
}

describe('AttemptAuthority successor workspace canonicalization', () => {
  it('rejects two junction/symlink aliases of the same workspace through direct publication', () => {
    const cwd = temporaryDirectory('bclaw-attempt-canonical-');
    const realWorkspace = path.join(cwd, 'real-workspace');
    const firstAlias = path.join(cwd, 'workspace-alias-a');
    const secondAlias = path.join(cwd, 'workspace-alias-b');
    fs.mkdirSync(realWorkspace);
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(realWorkspace, firstAlias, linkType);
    fs.symlinkSync(realWorkspace, secondAlias, linkType);

    const current = initialGeneration('tat_workspace_aliases', firstAlias);
    const next = prepareNextGeneration(current, {
      contract_hash: 'sha256:contract-1',
      workspace_path: secondAlias,
      workspace_digest: 'sha256:workspace-1',
    });
    const cell = rawTakeoverCell(current, next);

    assert.throws(
      () => publishPreparedCloseDecision(cwd, current, cell),
      (error: unknown) => error instanceof AttemptGenerationError
        && error.code === 'invalid_transition'
        && error.message.endsWith('workspace_path'),
    );
    assert.equal(fs.existsSync(closeDecisionCellPath(cwd, current.turn_id, 0)), false);
  });

  it('uses immutable publication order regardless of clock skew and PID-like actor values', () => {
    const cases = [
      {
        turnId: 'tat_order_old_high_pid_first',
        first: { actor: 'worker-pid-99999', decided_at: '1970-01-01T00:00:00.000Z' },
        second: { actor: 'worker-pid-1', decided_at: '2099-12-31T23:59:59.999Z' },
      },
      {
        turnId: 'tat_order_new_low_pid_first',
        first: { actor: 'worker-pid-1', decided_at: '2099-12-31T23:59:59.999Z' },
        second: { actor: 'worker-pid-99999', decided_at: '1970-01-01T00:00:00.000Z' },
      },
    ] as const;

    for (const testCase of cases) {
      const cwd = temporaryDirectory('bclaw-attempt-order-');
      const workspacePath = path.join(cwd, 'workspace');
      fs.mkdirSync(workspacePath);
      const generation = initialGeneration(testCase.turnId, workspacePath);
      const first = prepareCloseDecision(generation, {
        decision: 'cancelled',
        cause: 'published first',
        ...testCase.first,
      });
      const second = prepareCloseDecision(generation, {
        decision: 'settled',
        cause: 'published second',
        ...testCase.second,
      });

      const winner = publishPreparedCloseDecision(cwd, generation, first);
      const loser = publishPreparedCloseDecision(cwd, generation, second);

      assert.equal(winner.won, true);
      assert.equal(loser.won, false);
      assert.equal(loser.cell.decision, first.decision);
      assert.equal(loser.cell.cause, first.cause);
      assert.equal(loser.cell.generation_digest, first.generation_digest);
      assert.equal(loser.cell.actor, testCase.first.actor);
      assert.equal(loser.cell.decided_at, testCase.first.decided_at);
    }
  });
});
