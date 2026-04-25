import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeMcpToolCall } from '../../src/commands/mcp.js';
import type { FacadeResponse } from '../../src/core/facade-schema.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

interface CompactResult {
  context_schema: string;
  profile: string;
  memory_version: string;
  memory_density: string;
  plan_summary: Array<{ id: string; short_label: string; status: string; plan_id?: string }>;
  stale_warnings: Array<{ id: string; entity: string; text: string; age_days: number }>;
  workflow_hints: string[];
  claim_conflicts: unknown[];
  open_work: unknown;
  _compact: true;
  _full_context_hint: string;
}

async function callWork(
  workspace: TestWorkspace,
  args: Record<string, unknown>,
): Promise<FacadeResponse> {
  const outcome = await executeMcpToolCall({
    name: 'bclaw_work',
    args,
    cwd: workspace.dir,
  });

  assert.equal(outcome.response.isError, false);
  return outcome.response.structuredContent as FacadeResponse;
}

describe('bclaw_work compact mode', () => {
  let workspace: TestWorkspace;
  let previousTestMode: string | undefined;
  let restoreCwd: (() => void) | undefined;

  beforeEach(() => {
    previousTestMode = process.env.BRAINCLAW_TEST_MODE;
    process.env.BRAINCLAW_TEST_MODE = '1';
    workspace = createTestWorkspace({
      prefix: 'bclaw-work-compact-',
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

  it('defaults to compact mode (compact not specified)', async () => {
    const response = await callWork(workspace, {
      intent: 'consult',
    });

    assert.equal(response.status, 'ok');
    const result = response.result as CompactResult | null;
    if (result !== null) {
      assert.equal(result._compact, true, 'result should be in compact mode');
      assert.ok(result._full_context_hint, 'should include hint for full payload');
      // Compact result should NOT have `selected` (the full context items array)
      assert.equal('selected' in result, false, 'compact result must not contain selected[]');
    }
  });

  it('compact mode payload is small', async () => {
    const response = await callWork(workspace, {
      intent: 'consult',
      compact: true,
    });

    assert.equal(response.status, 'ok');
    const serialized = JSON.stringify(response);
    // Compact payload should be well under 5000 chars even with metadata
    assert.ok(
      serialized.length < 5000,
      `Compact payload should be < 5000 chars, got ${serialized.length}`,
    );
  });

  it('compact:false returns full context result', async () => {
    const response = await callWork(workspace, {
      intent: 'consult',
      compact: false,
    });

    assert.equal(response.status, 'ok');
    const result = response.result as Record<string, unknown> | null;
    if (result !== null) {
      // Full result should have `selected` array (from ContextResult)
      assert.ok('selected' in result, 'full result should contain selected[]');
      // Should NOT have compact marker
      assert.equal('_compact' in result, false, 'full result should not be marked compact');
    }
  });

  it('side effects are identical in compact and non-compact execute', async () => {
    const compactResponse = await callWork(workspace, {
      intent: 'execute',
      scope: 'src/test-compact.ts',
      compact: true,
    });

    // Register a second agent to avoid claim reuse
    workspace.registerAgent('claude-code');

    const fullResponse = await callWork(workspace, {
      intent: 'execute',
      scope: 'src/test-full.ts',
      compact: false,
      agent: 'claude-code',
    });

    // Both should produce claims
    assert.equal(compactResponse.status, 'ok');
    assert.equal(fullResponse.status, 'ok');
    assert.ok(
      compactResponse.claim_status === 'created' || compactResponse.claim_status === 'existing',
      'compact execute should create/reuse claim',
    );
    assert.ok(
      fullResponse.claim_status === 'created' || fullResponse.claim_status === 'existing',
      'full execute should create/reuse claim',
    );
    // Both should have session_id
    assert.ok(typeof compactResponse.session_id === 'string' && compactResponse.session_id.length > 0);
    assert.ok(typeof fullResponse.session_id === 'string' && fullResponse.session_id.length > 0);
    // Side effects structure should match (both have claim side effect)
    assert.equal(compactResponse.side_effects.length, 1);
    assert.equal(fullResponse.side_effects.length, 1);
    assert.equal(compactResponse.side_effects[0].entity, 'claim');
    assert.equal(fullResponse.side_effects[0].entity, 'claim');
  });

  it('compact result caps plan_summary to 5 items', async () => {
    const response = await callWork(workspace, {
      intent: 'consult',
      compact: true,
    });

    assert.equal(response.status, 'ok');
    const result = response.result as CompactResult | null;
    if (result !== null) {
      assert.ok(Array.isArray(result.plan_summary), 'plan_summary should be an array');
      assert.ok(result.plan_summary.length <= 5, 'plan_summary should be capped at 5');
    }
  });

  it('compact result caps stale_warnings to 3 items', async () => {
    const response = await callWork(workspace, {
      intent: 'consult',
      compact: true,
    });

    assert.equal(response.status, 'ok');
    const result = response.result as CompactResult | null;
    if (result !== null) {
      assert.ok(Array.isArray(result.stale_warnings), 'stale_warnings should be an array');
      assert.ok(result.stale_warnings.length <= 3, 'stale_warnings should be capped at 3');
    }
  });
});
