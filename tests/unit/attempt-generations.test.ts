import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  AttemptGenerationError,
  CloseDecisionCellSchema,
  CorruptAttemptCellError,
  ImmutableCellPublishError,
  assertFenceMatchesGeneration,
  attemptGenerationHeadPath,
  closeDecisionCellPath,
  fenceForGeneration,
  prepareCloseDecision,
  prepareInitialGeneration,
  prepareLaunchDecision,
  prepareNextGeneration,
  publishPreparedCloseDecision,
  publishPreparedLaunchDecision,
  readAttemptGenerationHead,
  readCloseDecision,
  rebuildAttemptGenerationHead,
  resolveGenerationChain,
  type AttemptGeneration,
  type CloseDecisionCell,
} from '../../src/core/loops/attempt-generations.js';

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length > 0) {
    fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
  }
});

function workspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-attempt-v2-'));
  cleanup.push(cwd);
  return cwd;
}

function initial(turnId = 'tat_generation_test'): AttemptGeneration {
  return prepareInitialGeneration({
    turn_id: turnId,
    authority_home: {
      store_instance_id: 'store_primary',
      device_id: 'device_primary',
    },
    contract_hash: 'sha256:contract-0',
    workspace_path: generationWorkspacePath(turnId, 0),
    workspace_digest: 'sha256:workspace-0',
  });
}

function generationWorkspacePath(turnId: string, epoch: number): string {
  return path.join(os.tmpdir(), 'bclaw-generation-workspaces', turnId, `epoch-${epoch}`);
}

function runChildPublish(
  cwd: string,
  generation: AttemptGeneration,
  cell: CloseDecisionCell,
): Promise<{ won: boolean; cell: CloseDecisionCell }> {
  const moduleUrl = new URL('../../src/core/loops/attempt-generations.js', import.meta.url).href;
  const script = [
    `import { publishPreparedCloseDecision } from ${JSON.stringify(moduleUrl)};`,
    `const result = publishPreparedCloseDecision(${JSON.stringify(cwd)}, ${JSON.stringify(generation)}, ${JSON.stringify(cell)});`,
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`child publish failed (${code}): ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout) as { won: boolean; cell: CloseDecisionCell });
    });
  });
}

describe('AttemptAuthority v2 immutable generation cells', () => {
  it('arbitrates a real settle-vs-takeover process race with one close-cell winner', async () => {
    const cwd = workspace();
    const generation = initial('tat_settle_takeover');
    const next = prepareNextGeneration(generation, {
      contract_hash: 'sha256:contract-1',
      workspace_path: generationWorkspacePath(generation.turn_id, 1),
      workspace_digest: 'sha256:workspace-1',
    });
    const settled = prepareCloseDecision(generation, {
      decision: 'settled',
      actor: 'reconciler',
      cause: 'accepted terminal result',
      result_digest: 'sha256:result',
    });
    const takeover = prepareCloseDecision(generation, {
      decision: 'takeover',
      actor: 'operator',
      cause: 'explicit fenced takeover',
      next_generation: next,
    });

    const results = await Promise.all([
      runChildPublish(cwd, generation, settled),
      runChildPublish(cwd, generation, takeover),
    ]);

    assert.equal(results.filter((result) => result.won).length, 1);
    assert.deepEqual(results[0]!.cell, results[1]!.cell);
    const committed = CloseDecisionCellSchema.parse(results[0]!.cell);
    assert.ok(committed.decision === 'settled' || committed.decision === 'takeover');
  });

  it('arbitrates two concurrent takeovers and every loser adopts the same successor', async () => {
    const cwd = workspace();
    const generation = initial('tat_two_takeovers');
    const nextA = prepareNextGeneration(generation, {
      contract_hash: 'sha256:contract-a',
      workspace_path: generationWorkspacePath(generation.turn_id, 1),
      workspace_digest: 'sha256:workspace-a',
      launch_nonce: 'nonce-a',
    });
    const nextB = prepareNextGeneration(generation, {
      contract_hash: 'sha256:contract-b',
      workspace_path: path.join(os.tmpdir(), 'bclaw-generation-workspaces-b', generation.turn_id, 'epoch-1'),
      workspace_digest: 'sha256:workspace-b',
      launch_nonce: 'nonce-b',
    });
    const closeA = prepareCloseDecision(generation, {
      decision: 'takeover', actor: 'operator-a', cause: 'takeover-a', next_generation: nextA,
    });
    const closeB = prepareCloseDecision(generation, {
      decision: 'takeover', actor: 'operator-b', cause: 'takeover-b', next_generation: nextB,
    });

    const results = await Promise.all([
      runChildPublish(cwd, generation, closeA),
      runChildPublish(cwd, generation, closeB),
    ]);

    assert.equal(results.filter((result) => result.won).length, 1);
    assert.deepEqual(results[0]!.cell, results[1]!.cell);
    assert.equal(results[0]!.cell.decision, 'takeover');
    if (results[0]!.cell.decision === 'takeover') {
      assert.ok(['nonce-a', 'nonce-b'].includes(results[0]!.cell.next_generation.launch_nonce));
    }
  });

  it('keeps turn and assignment stable while run, nonce and workspace stay unique across 128 generations', () => {
    const cwd = workspace();
    const first = initial('tat_many_generations');
    let current = first;
    const assignments = new Set([current.assignment_id]);
    const turns = new Set([current.turn_id]);
    const runs = new Set([current.run_id]);
    const nonces = new Set([current.launch_nonce]);
    const workspaces = new Set([current.workspace_id]);
    const workspacePaths = new Set([current.workspace_path]);
    const contracts = new Set([current.contract_hash]);

    for (let epoch = 1; epoch <= 127; epoch++) {
      const next = prepareNextGeneration(current, {
        contract_hash: `sha256:contract-${epoch}`,
        workspace_path: generationWorkspacePath(current.turn_id, epoch),
        workspace_digest: `sha256:workspace-${epoch}`,
      });
      const close = prepareCloseDecision(current, {
        decision: epoch % 2 === 0 ? 'retry' : 'takeover',
        actor: 'engine',
        cause: `advance-${epoch}`,
        next_generation: next,
      });
      assert.equal(publishPreparedCloseDecision(cwd, current, close).won, true);
      current = next;
      assignments.add(current.assignment_id);
      turns.add(current.turn_id);
      runs.add(current.run_id);
      nonces.add(current.launch_nonce);
      workspaces.add(current.workspace_id);
      workspacePaths.add(current.workspace_path);
      contracts.add(current.contract_hash);
    }

    assert.equal(assignments.size, 1);
    assert.equal(turns.size, 1);
    assert.equal(runs.size, 128);
    assert.equal(nonces.size, 128);
    assert.equal(workspaces.size, 128);
    assert.equal(workspacePaths.size, 128);
    assert.equal(contracts.size, 128);
    const resolved = resolveGenerationChain(cwd, first);
    assert.equal(resolved.status, 'active');
    assert.equal(resolved.latest_generation.attempt_epoch, 127);
    assert.equal(resolved.latest_generation.run_id, current.run_id);
  });

  it('rejects every stale full fence tuple after a successor becomes active', () => {
    const generation = initial('tat_stale_fence');
    const stale = fenceForGeneration(generation);
    const next = prepareNextGeneration(generation, {
      contract_hash: 'sha256:contract-next',
      workspace_path: generationWorkspacePath(generation.turn_id, 1),
      workspace_digest: 'sha256:workspace-next',
    });

    assert.throws(
      () => assertFenceMatchesGeneration(next, stale),
      (error: unknown) => error instanceof AttemptGenerationError && error.code === 'fenced',
    );
    assert.doesNotThrow(() => assertFenceMatchesGeneration(next, fenceForGeneration(next)));
  });

  it('fails closed with a typed error when hard-link publication is unsupported', () => {
    const cwd = workspace();
    const generation = initial('tat_no_hardlinks');
    const cell = prepareCloseDecision(generation, {
      decision: 'cancelled', actor: 'operator', cause: 'cancelled',
    });
    const unsupportedLink = (): never => {
      throw Object.assign(new Error('hard links disabled'), { code: 'ENOTSUP' });
    };

    assert.throws(
      () => publishPreparedCloseDecision(cwd, generation, cell, { linkSync: unsupportedLink }),
      (error: unknown) => error instanceof ImmutableCellPublishError && error.code === 'hardlink_unsupported',
    );
    assert.equal(fs.existsSync(closeDecisionCellPath(cwd, generation.turn_id, 0)), false);
  });

  it('ignores a fully-fsynced temp left by a crash and later publishes the final cell', () => {
    const cwd = workspace();
    const generation = initial('tat_temp_residue');
    const cell = prepareCloseDecision(generation, {
      decision: 'cancelled', actor: 'operator', cause: 'cancelled',
    });

    assert.throws(
      () => publishPreparedCloseDecision(cwd, generation, cell, { simulateCrashAfterTempFsync: true }),
      (error: unknown) => error instanceof ImmutableCellPublishError && error.code === 'simulated_crash',
    );
    const dir = path.dirname(closeDecisionCellPath(cwd, generation.turn_id, 0));
    assert.equal(fs.readdirSync(dir).some((entry) => entry.endsWith('.tmp')), true);
    assert.equal(fs.existsSync(closeDecisionCellPath(cwd, generation.turn_id, 0)), false);

    const published = publishPreparedCloseDecision(cwd, generation, cell);
    assert.equal(published.won, true);
    assert.equal(readCloseDecision(cwd, generation.turn_id, 0)?.decision, 'cancelled');
  });

  it('rejects a corrupt incumbent cell instead of replacing it', () => {
    const cwd = workspace();
    const generation = initial('tat_corrupt_cell');
    const finalPath = closeDecisionCellPath(cwd, generation.turn_id, 0);
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.writeFileSync(finalPath, '{"torn":', 'utf8');
    const cell = prepareCloseDecision(generation, {
      decision: 'settled', actor: 'reconciler', cause: 'result accepted',
    });

    assert.throws(
      () => publishPreparedCloseDecision(cwd, generation, cell),
      (error: unknown) => error instanceof CorruptAttemptCellError,
    );
    assert.equal(fs.readFileSync(finalPath, 'utf8'), '{"torn":');
  });

  it('keeps launch decisions immutable and rebuilds a non-authoritative head from close cells', () => {
    const cwd = workspace();
    const generation = initial('tat_launch_and_head');
    const crossed = prepareLaunchDecision(generation, {
      decision: 'crossed', actor: 'supervisor', cause: 'pre-exec crossing',
    });
    const revoked = prepareLaunchDecision(generation, {
      decision: 'revoked', actor: 'sweeper', cause: 'lease expired',
    });
    assert.equal(publishPreparedLaunchDecision(cwd, generation, crossed).won, true);
    const loser = publishPreparedLaunchDecision(cwd, generation, revoked);
    assert.equal(loser.won, false);
    assert.equal(loser.cell.decision, 'crossed');

    const next = prepareNextGeneration(generation, {
      contract_hash: 'sha256:contract-1',
      workspace_path: generationWorkspacePath(generation.turn_id, 1),
      workspace_digest: 'sha256:workspace-1',
    });
    const takeover = prepareCloseDecision(generation, {
      decision: 'takeover', actor: 'operator', cause: 'worker fenced', next_generation: next,
    });
    publishPreparedCloseDecision(cwd, generation, takeover);

    const headPath = attemptGenerationHeadPath(cwd, generation.turn_id);
    fs.writeFileSync(headPath, '{"not":"a valid head"}', 'utf8');
    assert.equal(readAttemptGenerationHead(cwd, generation.turn_id), undefined);
    const rebuilt = rebuildAttemptGenerationHead(cwd, generation);
    assert.equal(rebuilt.authoritative, false);
    assert.equal(rebuilt.status, 'active');
    assert.equal(rebuilt.active_run_id, next.run_id);
    assert.deepEqual(readAttemptGenerationHead(cwd, generation.turn_id), rebuilt);
  });
});
