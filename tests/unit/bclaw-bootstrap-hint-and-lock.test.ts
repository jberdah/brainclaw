import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { executeMcpToolCall } from '../../src/commands/mcp.js';
import type { FacadeResponse } from '../../src/core/facade-schema.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { listClaims } from '../../src/core/claims.js';

/**
 * pln#513 step 5 — coverage for the bootstrap entry-point primitives:
 *   - step 1 (#50): bclaw_work surfaces `bootstrap_recommended` + `next_action`
 *     when PROJECT.md is absent or 0 bytes.
 *   - step 2 (#60): bclaw_coordinate(intent='ideate', preset='bootstrap')
 *     joins an existing bootstrap loop instead of opening a duplicate, and
 *     acquires + releases a coordination lock around the open path.
 */

async function callTool(
  workspace: TestWorkspace,
  name: string,
  args: Record<string, unknown>,
): Promise<FacadeResponse> {
  const outcome = await executeMcpToolCall({ name, args, cwd: workspace.dir });
  return outcome.response.structuredContent as FacadeResponse;
}

describe('bclaw_work — bootstrap_recommended hint (pln#513 step 1, seq #50)', () => {
  let workspace: TestWorkspace;
  let previousTestMode: string | undefined;
  let restoreCwd: (() => void) | undefined;

  beforeEach(() => {
    previousTestMode = process.env.BRAINCLAW_TEST_MODE;
    process.env.BRAINCLAW_TEST_MODE = '1';
    workspace = createTestWorkspace({ prefix: 'bclaw-bootstrap-hint-', currentAgent: 'claude-code' });
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

  it('returns bootstrap_recommended=true with next_action when PROJECT.md is absent', async () => {
    const projectMd = path.join(workspace.dir, 'PROJECT.md');
    assert.equal(fs.existsSync(projectMd), false, 'precondition: PROJECT.md must not exist');

    const r = await callTool(workspace, 'bclaw_work', { intent: 'consult' });
    assert.equal(r.status, 'ok');
    assert.equal(r.bootstrap_recommended, true);
    assert.equal(
      r.next_action,
      "bclaw_coordinate(intent='ideate', preset='bootstrap')",
    );
  });

  it('returns bootstrap_recommended=true when PROJECT.md exists but is 0 bytes', async () => {
    fs.writeFileSync(path.join(workspace.dir, 'PROJECT.md'), '', 'utf8');

    const r = await callTool(workspace, 'bclaw_work', { intent: 'consult' });
    assert.equal(r.bootstrap_recommended, true);
    assert.equal(r.next_action, "bclaw_coordinate(intent='ideate', preset='bootstrap')");
  });

  it('returns bootstrap_recommended=false (no next_action) when PROJECT.md exists with content', async () => {
    fs.writeFileSync(path.join(workspace.dir, 'PROJECT.md'), '# project\n\nSome content.\n', 'utf8');

    const r = await callTool(workspace, 'bclaw_work', { intent: 'consult' });
    assert.equal(r.bootstrap_recommended, false);
    assert.equal(r.next_action, undefined);
  });
});

describe('bclaw_coordinate — bootstrap join-or-lock (pln#513 step 2, seq #60)', () => {
  let workspace: TestWorkspace;
  let previousTestMode: string | undefined;
  let restoreCwd: (() => void) | undefined;

  beforeEach(() => {
    previousTestMode = process.env.BRAINCLAW_TEST_MODE;
    process.env.BRAINCLAW_TEST_MODE = '1';
    workspace = createTestWorkspace({ prefix: 'bclaw-bootstrap-join-', currentAgent: 'claude-code' });
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

  it('first ideate(preset=bootstrap) opens a new loop and releases its coordination lock', async () => {
    const r = await callTool(workspace, 'bclaw_coordinate', {
      intent: 'ideate',
      preset: 'bootstrap',
      task: 'bootstrap a new project',
      agent: 'claude-code',
    });
    assert.equal(r.status, 'ok');
    const result = r.result as { loop_id: string; joined_existing?: boolean; preset?: string };
    assert.match(result.loop_id, /^lop_/);
    assert.equal(result.joined_existing, undefined, 'first call must NOT report joined_existing');
    assert.equal(result.preset, 'bootstrap');

    // Coordination lock acquired + released — must NOT be active anymore.
    const lockScope = `bootstrap-coordination-lock:${workspace.dir}`;
    const activeLocks = listClaims(workspace.dir).filter(
      (c) => c.scope === lockScope && c.status === 'active',
    );
    assert.deepEqual(activeLocks, [], 'coordination lock must be released after open');
  });

  it('second ideate(preset=bootstrap) joins the existing loop instead of opening a duplicate', async () => {
    const first = await callTool(workspace, 'bclaw_coordinate', {
      intent: 'ideate',
      preset: 'bootstrap',
      task: 'first call',
      agent: 'claude-code',
    });
    const firstResult = first.result as { loop_id: string };

    const second = await callTool(workspace, 'bclaw_coordinate', {
      intent: 'ideate',
      preset: 'bootstrap',
      task: 'second call',
      agent: 'claude-code',
    });
    assert.equal(second.status, 'ok');
    const secondResult = second.result as { loop_id: string; joined_existing: boolean; current_phase?: string };
    assert.equal(secondResult.loop_id, firstResult.loop_id, 'second call must return the SAME loop_id');
    assert.equal(secondResult.joined_existing, true);
    assert.ok(secondResult.current_phase, 'joined response must include current_phase');

    const joinedWarning = second.warnings.find((w) => w.includes('joined existing'));
    assert.ok(joinedWarning, `expected a "joined existing" warning, got: ${second.warnings.join(' | ')}`);
  });

  it('non-bootstrap ideate does NOT trigger the join-or-lock path', async () => {
    // First plain ideate call (no preset) — opens a loop.
    const r1 = await callTool(workspace, 'bclaw_coordinate', {
      intent: 'ideate',
      task: 'plain ideation A',
      agent: 'claude-code',
    });
    const r1result = r1.result as { loop_id: string; joined_existing?: boolean };
    assert.equal(r1result.joined_existing, undefined);

    // Second plain ideate call — should open a SECOND distinct loop, not join.
    const r2 = await callTool(workspace, 'bclaw_coordinate', {
      intent: 'ideate',
      task: 'plain ideation B',
      agent: 'claude-code',
    });
    const r2result = r2.result as { loop_id: string; joined_existing?: boolean };
    assert.notEqual(r2result.loop_id, r1result.loop_id);
    assert.equal(r2result.joined_existing, undefined);
  });
});
