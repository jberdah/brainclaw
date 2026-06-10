import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { executeMcpToolCall } from '../../src/commands/mcp.js';
import type { FacadeResponse } from '../../src/core/facade-schema.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { generateClaimId, listClaims, saveClaim } from '../../src/core/claims.js';
import {
  acquireBootstrapLoop,
  BootstrapCoordinationInProgressError,
  findExistingBootstrapLoop,
  normalizeLockKey,
  sweepOrphanBootstrapLocks,
} from '../../src/core/loops/bootstrap-acquire.js';

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

interface McpErrorEnvelope {
  isError: boolean;
  error?: { kind: string; message: string; details?: unknown };
}

async function callToolExpectError(
  workspace: TestWorkspace,
  name: string,
  args: Record<string, unknown>,
): Promise<McpErrorEnvelope> {
  const outcome = await executeMcpToolCall({ name, args, cwd: workspace.dir });
  return {
    isError: outcome.response.isError === true,
    error: (outcome.response.structuredContent as { error?: McpErrorEnvelope['error'] })?.error,
  };
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

  it('returns bootstrap_recommended=true with the ideate route on a greenfield repo', async () => {
    const projectMd = path.join(workspace.dir, 'PROJECT.md');
    assert.equal(fs.existsSync(projectMd), false, 'precondition: PROJECT.md must not exist');

    const r = await callTool(workspace, 'bclaw_work', { intent: 'consult' });
    assert.equal(r.status, 'ok');
    assert.equal(r.bootstrap_recommended, true);
    // Greenfield (no repo content beyond .brainclaw) → bootstrap loop.
    assert.equal(
      r.next_action,
      "bclaw_coordinate(intent='ideate', preset='bootstrap')",
    );
  });

  it('returns the extract route when the repo has content but PROJECT.md is missing or empty', async () => {
    fs.writeFileSync(path.join(workspace.dir, 'PROJECT.md'), '', 'utf8');
    fs.writeFileSync(path.join(workspace.dir, 'README.md'), '# readme\n', 'utf8');

    const r = await callTool(workspace, 'bclaw_work', { intent: 'consult' });
    assert.equal(r.bootstrap_recommended, true);
    // Repo with content → bclaw_bootstrap extraction (shared empty-memory rule).
    assert.equal(r.next_action, 'bclaw_bootstrap()');
    const bootstrapAction = r.next_actions?.find((a) => a.tool === 'bclaw_bootstrap');
    assert.ok(bootstrapAction, 'next_actions must carry the bclaw_bootstrap affordance');
  });

  it('returns bootstrap_recommended=false (no next_action) when PROJECT.md exists with content', async () => {
    fs.writeFileSync(path.join(workspace.dir, 'PROJECT.md'), '# project\n\nSome content.\n', 'utf8');

    const r = await callTool(workspace, 'bclaw_work', { intent: 'consult' });
    assert.equal(r.bootstrap_recommended, false);
    assert.equal(r.bootstrap_verdict, 'none');
    assert.equal(r.next_action, undefined);
  });

  // pln#557 step 3 — composite verdict cases.
  it('returns verdict=refresh on a rich store without PROJECT.md (no from-scratch bootstrap)', async () => {
    const line = JSON.stringify({ ts: new Date().toISOString(), agent: 'alice', action: 'update', item_type: 'claim' }) + '\n';
    fs.writeFileSync(path.join(workspace.dir, '.brainclaw', 'events.jsonl'), line.repeat(Math.ceil((80 * 1024) / line.length)), 'utf8');

    const r = await callTool(workspace, 'bclaw_work', { intent: 'consult' });
    assert.equal(r.bootstrap_recommended, true);
    assert.equal(r.bootstrap_verdict, 'refresh');
    assert.equal(r.next_action, 'bclaw_bootstrap(refresh: true)');
    const refreshAction = r.next_actions?.find((a) => a.tool === 'bclaw_bootstrap');
    assert.ok(refreshAction, 'next_actions must carry the refresh affordance');
    assert.equal((refreshAction?.args as { refresh?: boolean })?.refresh, true);
  });

  it('returns verdict=refresh on a fossil PROJECT.md (eternal false negative killed)', async () => {
    const projectMd = path.join(workspace.dir, 'PROJECT.md');
    fs.writeFileSync(projectMd, '# project\n\nOld content.\n', 'utf8');
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000);
    fs.utimesSync(projectMd, sixtyDaysAgo, sixtyDaysAgo);
    fs.writeFileSync(path.join(workspace.dir, '.brainclaw', 'events.jsonl'), '{"ts":"now","agent":"alice","action":"update","item_type":"claim"}\n', 'utf8');

    const r = await callTool(workspace, 'bclaw_work', { intent: 'consult' });
    assert.equal(r.bootstrap_recommended, true);
    assert.equal(r.bootstrap_verdict, 'refresh');
    assert.equal(r.next_action, 'bclaw_bootstrap(refresh: true)');
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
    const lockScope = `bootstrap-coordination-lock:${normalizeLockKey(workspace.dir)}`;
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

  it('returns bootstrap_coordination_in_progress when an active lock exists with no backing loop (pln#513 phase 4 codex review)', async () => {
    // Seed an orphan coordination lock — simulates a parallel coordinator
    // mid-acquire (saveClaim ran but openLoop hasn't completed yet) AND no
    // bootstrap loop on disk for the re-find to land on.
    const lockScope = `bootstrap-coordination-lock:${normalizeLockKey(workspace.dir)}`;
    saveClaim({
      id: generateClaimId(),
      agent: 'claude-code',
      agent_id: undefined,
      user: undefined,
      project_id: undefined,
      host_id: undefined,
      session_id: undefined,
      scope: lockScope,
      description: 'simulated parallel coordinator',
      created_at: new Date().toISOString(),
      status: 'active',
      plan_id: undefined,
      model: undefined,
    }, workspace.dir);

    const r = await callToolExpectError(workspace, 'bclaw_coordinate', {
      intent: 'ideate',
      preset: 'bootstrap',
      task: 'should be rejected because a lock is held',
      agent: 'claude-code',
    });

    assert.equal(r.isError, true);
    assert.equal(r.error?.kind, 'bootstrap_coordination_in_progress');
    assert.ok(
      r.error?.message.includes('another coordinator is currently opening'),
      `expected coordinator-in-progress message, got: ${r.error?.message}`,
    );
  });

  it('TTL sweep releases orphan locks older than the cutoff with no backing loop (pln#518 step 4, seq #120)', async () => {
    // Seed an OLD orphan lock (created 10 minutes ago) with no backing loop.
    const lockScope = `bootstrap-coordination-lock:${normalizeLockKey(workspace.dir)}`;
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const orphanId = generateClaimId();
    saveClaim({
      id: orphanId,
      agent: 'claude-code',
      agent_id: undefined,
      user: undefined,
      project_id: undefined,
      host_id: undefined,
      session_id: undefined,
      scope: lockScope,
      description: 'crashed parallel coordinator',
      created_at: tenMinutesAgo,
      status: 'active',
      plan_id: undefined,
      model: undefined,
    }, workspace.dir);

    // Direct sweep call.
    const sweepResult = sweepOrphanBootstrapLocks(workspace.dir);
    assert.equal(sweepResult.released, 1, 'sweep must release exactly the one orphan');

    // The orphan is now released — next bootstrap call must succeed.
    const r = await callTool(workspace, 'bclaw_coordinate', {
      intent: 'ideate',
      preset: 'bootstrap',
      task: 'should succeed after orphan sweep',
      agent: 'claude-code',
    });
    assert.equal(r.status, 'ok');
    const result = r.result as { loop_id: string; joined_existing?: boolean };
    assert.match(result.loop_id, /^lop_/);
    assert.equal(result.joined_existing, undefined);
  });

  it('TTL sweep does NOT release fresh locks (< TTL)', async () => {
    const lockScope = `bootstrap-coordination-lock:${normalizeLockKey(workspace.dir)}`;
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
    saveClaim({
      id: generateClaimId(),
      agent: 'claude-code',
      agent_id: undefined,
      user: undefined,
      project_id: undefined,
      host_id: undefined,
      session_id: undefined,
      scope: lockScope,
      description: 'fresh in-flight coordinator',
      created_at: oneMinuteAgo,
      status: 'active',
      plan_id: undefined,
      model: undefined,
    }, workspace.dir);

    const sweepResult = sweepOrphanBootstrapLocks(workspace.dir);
    assert.equal(sweepResult.released, 0, 'fresh lock must be preserved (still in-flight)');
  });

  it('TTL sweep does NOT release locks when a backing loop exists', async () => {
    // Open a real bootstrap loop first.
    const opened = await callTool(workspace, 'bclaw_coordinate', {
      intent: 'ideate',
      preset: 'bootstrap',
      task: 'bootstrap with backing loop',
      agent: 'claude-code',
    });
    assert.equal(opened.status, 'ok');

    // Seed an orphan-shaped lock (old created_at) AFTER the loop exists.
    const lockScope = `bootstrap-coordination-lock:${normalizeLockKey(workspace.dir)}`;
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    saveClaim({
      id: generateClaimId(),
      agent: 'claude-code',
      agent_id: undefined,
      user: undefined,
      project_id: undefined,
      host_id: undefined,
      session_id: undefined,
      scope: lockScope,
      description: 'stale lock with backing loop',
      created_at: tenMinutesAgo,
      status: 'active',
      plan_id: undefined,
      model: undefined,
    }, workspace.dir);

    // The backing loop short-circuits sweep — no release happens because the
    // lock might be legitimate (a parallel coordinator about to detect the
    // backing loop on its own re-check).
    const sweepResult = sweepOrphanBootstrapLocks(workspace.dir);
    assert.equal(sweepResult.released, 0, 'sweep must be a no-op when backing loop exists');
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

describe('normalizeLockKey — lock scope path normalization (pln#518 step 2)', () => {
  let workspace: TestWorkspace;
  let previousTestMode: string | undefined;
  let restoreCwd: (() => void) | undefined;

  beforeEach(() => {
    previousTestMode = process.env.BRAINCLAW_TEST_MODE;
    process.env.BRAINCLAW_TEST_MODE = '1';
    workspace = createTestWorkspace({ prefix: 'bclaw-bootstrap-normalize-', currentAgent: 'claude-code' });
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

  it('second acquire with a dotted-segment path joins the existing loop', () => {
    const cwdA = workspace.dir;
    // Construct a path with an injected dot segment (avoid path.join which normalizes eagerly).
    const cwdB = `${path.dirname(cwdA)}${path.sep}.${path.sep}${path.basename(cwdA)}`;

    const first = acquireBootstrapLoop({ actor: 'test-agent' }, cwdA);
    assert.equal(first.action, 'opened');

    const second = acquireBootstrapLoop({ actor: 'test-agent' }, cwdB);
    assert.equal(second.action, 'joined', 'second call with dotted path must join the existing loop');
    assert.equal(second.loop.id, first.loop.id, 'must return the SAME loop id');
  });

  it('seeded lock with canonical scope is detected when caller uses a dotted path', () => {
    const cwdA = workspace.dir;
    const cwdB = `${path.dirname(cwdA)}${path.sep}.${path.sep}${path.basename(cwdA)}`;

    // Simulate a concurrent caller holding the coordination lock via the
    // canonical (normalized) path scope.
    const scope = `bootstrap-coordination-lock:${normalizeLockKey(cwdA)}`;

    saveClaim({
      id: generateClaimId(),
      agent: 'concurrent-agent',
      agent_id: undefined,
      user: undefined,
      project_id: undefined,
      host_id: undefined,
      session_id: undefined,
      scope,
      description: 'seeded lock for normalization test',
      created_at: new Date().toISOString(),
      status: 'active',
      plan_id: undefined,
      model: undefined,
    }, cwdA);

    // A caller arriving with cwdB (dotted path) must detect the seeded lock.
    assert.throws(
      () => acquireBootstrapLoop({ actor: 'late-agent' }, cwdB),
      (err: unknown) => err instanceof BootstrapCoordinationInProgressError,
      'caller with dotted path must detect the lock held by canonical-path caller',
    );
  });

  if (process.platform === 'win32') {
    it('uppercase path joins the existing loop (Windows case-insensitive filesystem)', () => {
      const cwdA = workspace.dir;
      const cwdB = cwdA.toUpperCase();

      const first = acquireBootstrapLoop({ actor: 'test-agent' }, cwdA);
      assert.equal(first.action, 'opened');

      const second = acquireBootstrapLoop({ actor: 'test-agent' }, cwdB);
      assert.equal(second.action, 'joined', 'uppercase path must join the existing loop on Windows');
      assert.equal(second.loop.id, first.loop.id);
    });
  }
});
