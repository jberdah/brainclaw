import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeMcpToolCall } from '../../src/commands/mcp.js';
import { listClaims } from '../../src/core/claims.js';
import type { FacadeResponse } from '../../src/core/facade-schema.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

interface CoordinateFacadeResult extends FacadeResponse {
  result: {
    selected_targets?: string[];
    delivery_plan?: unknown[];
  } | null;
}

async function callFacade<T extends FacadeResponse>(
  workspace: TestWorkspace,
  name: 'bclaw_work' | 'bclaw_coordinate',
  args: Record<string, unknown>,
): Promise<T> {
  const outcome = await executeMcpToolCall({
    name,
    args,
    cwd: workspace.dir,
  });

  assert.equal(outcome.response.isError, false);
  return outcome.response.structuredContent as T;
}

describe('facades e2e', () => {
  let workspace: TestWorkspace;
  let previousTestMode: string | undefined;
  let restoreCwd: (() => void) | undefined;

  beforeEach(() => {
    previousTestMode = process.env.BRAINCLAW_TEST_MODE;
    process.env.BRAINCLAW_TEST_MODE = '1';
    workspace = createTestWorkspace({
      prefix: 'bclaw-facades-e2e-',
      currentAgent: 'codex',
    });
    restoreCwd = workspace.useCwd();
  });

  afterEach(() => {
    restoreCwd?.();
    workspace.cleanup();
    if (previousTestMode === undefined) {
      delete process.env.BRAINCLAW_TEST_MODE;
      return;
    }
    process.env.BRAINCLAW_TEST_MODE = previousTestMode;
  });

  it('creates or reuses a claim for solo execute work', async () => {
    const response = await callFacade<FacadeResponse>(workspace, 'bclaw_work', {
      intent: 'execute',
      scope: 'src/foo.ts',
    });

    assert.equal(response.status, 'ok');
    assert.ok(typeof response.session_id === 'string' && response.session_id.length > 0);
    assert.ok(response.claim_status === 'created' || response.claim_status === 'existing');
  });

  it('keeps consult work read-only for claims', async () => {
    const response = await callFacade<FacadeResponse>(workspace, 'bclaw_work', {
      intent: 'consult',
    });

    assert.equal(response.status, 'ok');
    assert.equal(response.claim_status, 'none');
    assert.deepEqual(
      response.side_effects.filter((effect) => effect.entity === 'claim'),
      [],
    );
    assert.equal(listClaims(workspace.dir).length, 0);
  });

  it('returns a coordination result for consult requests', async () => {
    const response = await callFacade<CoordinateFacadeResult>(workspace, 'bclaw_coordinate', {
      intent: 'consult',
      task: 'Review architecture',
    });

    assert.equal(response.status, 'ok');
    assert.ok(
      Array.isArray(response.result?.selected_targets) ||
      Array.isArray(response.result?.delivery_plan),
    );
  });
});
