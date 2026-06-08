import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeMcpToolCall } from '../../src/commands/mcp.js';
import { listClaims } from '../../src/core/claims.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

// trp#431 — bclaw_claim used to ALWAYS create a worktree. Advisory mode lets an
// agent take an advisory-only lock (no worktree) for in-place work that already
// lives uncommitted in the main tree.

describe('bclaw_claim advisory mode (trp#431)', () => {
  let workspace: TestWorkspace;
  beforeEach(() => { workspace = createTestWorkspace({ prefix: 'bclaw-advisory-', currentAgent: 'claude-code' }); });
  afterEach(() => { workspace.cleanup(); });

  it('advisory:true creates a claim WITHOUT a worktree', async () => {
    const out = await executeMcpToolCall({
      name: 'bclaw_claim',
      args: { scope: 'src/advisory-a.ts', description: 'in-place work', agent: 'claude-code', advisory: true },
      cwd: workspace.dir,
    });
    assert.equal(out.response.isError ?? false, false, JSON.stringify(out.response));
    const claims = listClaims(workspace.dir).filter((c) => c.scope === 'src/advisory-a.ts');
    assert.equal(claims.length, 1, 'claim was created');
    assert.equal(claims[0].worktree_path, undefined, 'advisory claim must have no worktree_path');
  });

  it('worktree:false is an alias for advisory (no worktree)', async () => {
    const out = await executeMcpToolCall({
      name: 'bclaw_claim',
      args: { scope: 'src/advisory-b.ts', description: 'in-place work', agent: 'claude-code', worktree: false },
      cwd: workspace.dir,
    });
    assert.equal(out.response.isError ?? false, false, JSON.stringify(out.response));
    const claims = listClaims(workspace.dir).filter((c) => c.scope === 'src/advisory-b.ts');
    assert.equal(claims.length, 1);
    assert.equal(claims[0].worktree_path, undefined);
  });
});
