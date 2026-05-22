/**
 * Tests for the `bclaw_init_project` MCP verb (pln#515 step 2).
 *
 * Covers the cross-workspace bootstrap path: a session whose cwd is workspace A
 * initialises brainclaw at folder B in one MCP call and registers B as a
 * cross_project_link in A's config.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { executeMcpToolCall } from '../../src/commands/mcp.js';
import { loadConfig } from '../../src/core/config.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

interface InitProjectResult {
  status: string;
  project_name: string;
  path: string;
  link_id: string;
  was_already_initialized: boolean;
}

interface ErrorResult {
  error: { kind: string; message: string };
}

describe('bclaw_init_project MCP verb', () => {
  let workspaceA: TestWorkspace;
  let targetB: string;
  let previousTestMode: string | undefined;
  let previousSkipRepoAnalysis: string | undefined;
  let previousSkipAgentBootstrap: string | undefined;

  beforeEach(() => {
    previousTestMode = process.env.BRAINCLAW_TEST_MODE;
    previousSkipRepoAnalysis = process.env.BRAINCLAW_SKIP_REPO_ANALYSIS;
    previousSkipAgentBootstrap = process.env.BRAINCLAW_SKIP_AGENT_BOOTSTRAP;
    process.env.BRAINCLAW_TEST_MODE = '1';
    process.env.BRAINCLAW_SKIP_REPO_ANALYSIS = '1';
    process.env.BRAINCLAW_SKIP_AGENT_BOOTSTRAP = '1';
    workspaceA = createTestWorkspace({
      prefix: 'bclaw-init-project-A-',
      projectName: 'workspace-a',
    });
    targetB = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-init-project-B-'));
  });

  afterEach(() => {
    fs.rmSync(targetB, { recursive: true, force: true });
    workspaceA.cleanup();
    if (previousTestMode === undefined) delete process.env.BRAINCLAW_TEST_MODE;
    else process.env.BRAINCLAW_TEST_MODE = previousTestMode;
    if (previousSkipRepoAnalysis === undefined) delete process.env.BRAINCLAW_SKIP_REPO_ANALYSIS;
    else process.env.BRAINCLAW_SKIP_REPO_ANALYSIS = previousSkipRepoAnalysis;
    if (previousSkipAgentBootstrap === undefined) delete process.env.BRAINCLAW_SKIP_AGENT_BOOTSTRAP;
    else process.env.BRAINCLAW_SKIP_AGENT_BOOTSTRAP = previousSkipAgentBootstrap;
  });

  it('initialises brainclaw at target path and registers it as a cross_project_link in caller cwd', async () => {
    const outcome = await executeMcpToolCall({
      name: 'bclaw_init_project',
      args: { path: targetB },
      cwd: workspaceA.dir,
    });

    assert.equal(outcome.response.isError, false, 'expected success response');
    const result = outcome.response.structuredContent as unknown as InitProjectResult;
    assert.equal(result.status, 'ok');
    assert.equal(result.was_already_initialized, false);
    assert.equal(path.resolve(result.path), path.resolve(targetB));
    assert.ok(
      fs.existsSync(path.join(targetB, '.brainclaw', 'config.yaml')),
      'target .brainclaw/config.yaml should exist after init',
    );

    const callerConfig = loadConfig(workspaceA.dir);
    const links = callerConfig.cross_project_links ?? [];
    const match = links.find(
      (l) => path.resolve(workspaceA.dir, l.path) === path.resolve(targetB),
    );
    assert.ok(
      match,
      `cross_project_link to target B should be registered in workspace A's config; got: ${JSON.stringify(links)}`,
    );
  });

  it('bclaw_find(entity=claim, project=<B>) resolves to B\'s store and returns 0 claims for empty B', async () => {
    const initOutcome = await executeMcpToolCall({
      name: 'bclaw_init_project',
      args: { path: targetB },
      cwd: workspaceA.dir,
    });
    assert.equal(initOutcome.response.isError, false);
    const initResult = initOutcome.response.structuredContent as unknown as InitProjectResult;

    const findOutcome = await executeMcpToolCall({
      name: 'bclaw_find',
      args: { entity: 'claim', filter: {}, project: initResult.link_id },
      cwd: workspaceA.dir,
    });

    assert.equal(findOutcome.response.isError, false, `find failed: ${JSON.stringify(findOutcome.response.structuredContent)}`);
    const findResult = findOutcome.response.structuredContent as unknown as { items: unknown[]; total: number };
    assert.equal(findResult.total, 0, 'expected zero claims in freshly-initialised target');
    assert.ok(Array.isArray(findResult.items), 'items array should be present');
  });

  it('re-running bclaw_init_project on an already-initialised path returns was_already_initialized=true and does not recreate', async () => {
    const firstOutcome = await executeMcpToolCall({
      name: 'bclaw_init_project',
      args: { path: targetB },
      cwd: workspaceA.dir,
    });
    assert.equal(firstOutcome.response.isError, false);
    const configPath = path.join(targetB, '.brainclaw', 'config.yaml');
    const firstMtime = fs.statSync(configPath).mtimeMs;

    // Sleep briefly so any (unwanted) rewrite would change mtime measurably.
    await new Promise((r) => setTimeout(r, 20));

    const secondOutcome = await executeMcpToolCall({
      name: 'bclaw_init_project',
      args: { path: targetB },
      cwd: workspaceA.dir,
    });

    assert.equal(secondOutcome.response.isError, false);
    const secondResult = secondOutcome.response.structuredContent as unknown as InitProjectResult;
    assert.equal(secondResult.was_already_initialized, true, 'second call should detect existing init');
    assert.equal(secondResult.status, 'ok');

    const secondMtime = fs.statSync(configPath).mtimeMs;
    assert.equal(secondMtime, firstMtime, 'config.yaml should not have been rewritten by the no-op second call');
  });

  it('returns a structured error envelope when path is missing', async () => {
    const outcome = await executeMcpToolCall({
      name: 'bclaw_init_project',
      args: {},
      cwd: workspaceA.dir,
    });

    assert.equal(outcome.response.isError, true);
    const err = outcome.response.structuredContent as unknown as ErrorResult;
    assert.equal(err.error.kind, 'validation_error');
  });
});
