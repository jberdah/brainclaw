/**
 * pln#521 P1 — project resolution gate for review loops.
 *
 * Two questions this suite must answer:
 *  1. does the gate refuse an ambiguous review loop BEFORE anything persists?
 *  2. is it a strict no-op for an ordinary single-project store?
 * (2) matters as much as (1): a gate that fires on the common case would break
 * every local review loop.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import { ensureMemoryDir } from '../../src/core/io.js';
import { validateLoopProjectResolution } from '../../src/core/loops/project-resolution.js';
import { executeMcpToolCall } from '../../src/commands/mcp.js';
import { listAssignments } from '../../src/core/assignments.js';
import { listCandidates } from '../../src/core/candidates.js';
import { listClaims } from '../../src/core/claims.js';
import { listLoops } from '../../src/core/loops/store.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

/** Turn the workspace store into one that declares several project namespaces. */
function makeMultiProject(workspace: TestWorkspace, known: string[]): void {
  workspace.updateConfig((config) => {
    config.project_mode = 'multi-project';
    config.projects.known = known;
  });
}

/**
 * Turn the workspace store into a workspace-role parent hosting real child
 * stores. `store_type` is not part of ConfigSchema (inferRole reads the raw
 * yaml), so it is appended to the file rather than saved through saveConfig,
 * which would strip it.
 */
function makeWorkspaceWithChildren(workspace: TestWorkspace, children: string[]): string[] {
  const configPath = path.join(workspace.dir, '.brainclaw', 'config.yaml');
  fs.appendFileSync(configPath, 'store_type: workspace\n');
  const paths: string[] = [];
  for (const name of children) {
    const childDir = path.join(workspace.dir, name);
    fs.mkdirSync(childDir, { recursive: true });
    ensureMemoryDir(childDir);
    saveConfig(defaultConfig(name, { projectId: `prj_${name}` }), childDir);
    paths.push(childDir);
  }
  return paths;
}

describe('validateLoopProjectResolution — resolver', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-loop-project-', projectName: 'alpha' });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('routes an explicit project and reports source=explicit', () => {
    const result = validateLoopProjectResolution({ cwd: workspace.dir, projectArg: 'alpha' });
    assert.equal(result.ok, true);
    assert.ok(result.ok);
    assert.equal(result.source, 'explicit');
    assert.equal(result.project_cwd, path.resolve(workspace.dir));
    assert.equal(result.project_name, 'alpha');
    assert.equal(result.trace.project_arg, 'alpha');
  });

  it('honours a selector that already won upstream (session switch) without re-deciding', () => {
    const result = validateLoopProjectResolution({ cwd: workspace.dir, activeSource: 'session' });
    assert.ok(result.ok);
    assert.equal(result.source, 'session');
    assert.equal(result.project_cwd, path.resolve(workspace.dir));
    assert.equal(result.trace.active_source, 'session');
  });

  it('is a NO-OP for a single-project store on the bare cwd fallback', () => {
    const result = validateLoopProjectResolution({ cwd: workspace.dir, activeSource: 'cwd' });
    assert.ok(result.ok, 'a lone project must never need selection');
    assert.equal(result.source, 'cwd');
    assert.deepEqual(result.trace.candidates, []);
  });

  it('treats a missing activeSource as the bare fallback (safe reading)', () => {
    makeMultiProject(workspace, ['alpha', 'beta']);
    const result = validateLoopProjectResolution({ cwd: workspace.dir });
    assert.equal(result.ok, false);
  });

  it('refuses the bare fallback in a multi-project store and lists the candidates', () => {
    makeMultiProject(workspace, ['alpha', 'beta']);
    const result = validateLoopProjectResolution({ cwd: workspace.dir, activeSource: 'cwd' });
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    assert.equal(result.code, 'needs_project_selection');
    assert.deepEqual(result.candidates.map((c) => c.name).sort(), ['alpha', 'beta']);
    // The message has to be actionable: both remedies, no silent default.
    assert.match(result.message, /project='<name>'/);
    assert.match(result.message, /bclaw_switch/);
    assert.match(result.message, /Nothing was created/);
  });

  it('refuses the bare fallback in a workspace-role store hosting child projects', () => {
    const [childA] = makeWorkspaceWithChildren(workspace, ['svc-a', 'svc-b']);
    const result = validateLoopProjectResolution({ cwd: workspace.dir, activeSource: 'cwd' });
    assert.ok(!result.ok);
    assert.equal(result.code, 'needs_project_selection');
    assert.equal(result.candidates.length, 2);
    assert.ok(
      result.candidates.some((c) => c.path === path.resolve(childA)),
      'child store must be offered as a candidate with its absolute path',
    );
    assert.ok(result.candidates.every((c) => c.source === 'store_chain'));
  });

  it('lets an explicit project win over an otherwise ambiguous store', () => {
    makeMultiProject(workspace, ['alpha', 'beta']);
    const result = validateLoopProjectResolution({ cwd: workspace.dir, projectArg: 'alpha' });
    assert.ok(result.ok);
    assert.equal(result.source, 'explicit');
  });

  it('lets an active-project pointer win over an otherwise ambiguous store', () => {
    makeMultiProject(workspace, ['alpha', 'beta']);
    const result = validateLoopProjectResolution({ cwd: workspace.dir, activeSource: 'global' });
    assert.ok(result.ok);
    assert.equal(result.source, 'global');
  });

  it('does not refuse an uninitialised store — downstream reports that more precisely', () => {
    const bare = fs.mkdtempSync(path.join(workspace.dir, 'bare-'));
    const result = validateLoopProjectResolution({ cwd: bare, activeSource: 'cwd' });
    assert.ok(result.ok);
    assert.equal(result.project_name, undefined);
  });
});

describe('bclaw_coordinate(review, open_loop) — project gate', () => {
  let workspace: TestWorkspace;
  let restoreCwd: (() => void) | undefined;
  let prevNoSpawn: string | undefined;

  beforeEach(() => {
    prevNoSpawn = process.env.BRAINCLAW_NO_SPAWN;
    process.env.BRAINCLAW_NO_SPAWN = '1';
    workspace = createTestWorkspace({
      prefix: 'bclaw-loop-project-gate-',
      projectName: 'alpha',
      currentAgent: 'claude-code',
    });
    workspace.registerAgent('codex');
    restoreCwd = workspace.useCwd();
  });

  afterEach(() => {
    restoreCwd?.();
    workspace.cleanup();
    if (prevNoSpawn === undefined) delete process.env.BRAINCLAW_NO_SPAWN;
    else process.env.BRAINCLAW_NO_SPAWN = prevNoSpawn;
  });

  const review = (extra: Record<string, unknown> = {}) => executeMcpToolCall({
    name: 'bclaw_coordinate',
    args: {
      intent: 'review',
      task: 'Review the routing gate',
      scope: 'src/core/loops/project-resolution.ts',
      targetAgents: ['codex'],
      agent: 'claude-code',
      autoExecute: false,
      open_loop: true,
      ...extra,
    },
    cwd: workspace.dir,
  });

  it('ambiguous store: refuses and creates NO candidate, loop, claim or assignment', async () => {
    makeMultiProject(workspace, ['alpha', 'beta']);

    const outcome = await review();

    assert.equal(outcome.response.isError, true);
    assert.match(JSON.stringify(outcome.response), /needs_project_selection/);
    // The whole point of gating before persistence: nothing landed anywhere.
    assert.deepEqual(listCandidates(undefined, workspace.dir), [], 'no candidate');
    assert.deepEqual(listLoops({}, workspace.dir), [], 'no loop');
    assert.deepEqual(listClaims(workspace.dir), [], 'no claim');
    assert.deepEqual(listAssignments(workspace.dir), [], 'no assignment');
  });

  it('ambiguous store + explicit project: proceeds and echoes the routing decision', async () => {
    makeMultiProject(workspace, ['alpha', 'beta']);

    const outcome = await review({ project: 'alpha' });

    assert.equal(outcome.response.isError, false, JSON.stringify(outcome.response));
    const result = (outcome.response.structuredContent as { result: Record<string, unknown> }).result;
    assert.equal(result.project_cwd, path.resolve(workspace.dir));
    assert.equal(result.project_name, 'alpha');
  });

  it('single-project store: unchanged behaviour, plus the routing echo', async () => {
    const outcome = await review();

    assert.equal(outcome.response.isError, false, JSON.stringify(outcome.response));
    const structured = outcome.response.structuredContent as {
      result: Record<string, unknown>;
      side_effects: Array<{ entity: string }>;
    };
    assert.ok(structured.result.loop_id, 'the review loop still opens');
    assert.equal(structured.result.project_cwd, path.resolve(workspace.dir));
    assert.equal(structured.result.project_name, 'alpha');
    assert.ok(
      structured.side_effects.some((e) => e.entity === 'candidate'),
      'candidate still created',
    );
  });

  it('does not gate a plain review (no open_loop) even in an ambiguous store', async () => {
    makeMultiProject(workspace, ['alpha', 'beta']);

    const outcome = await review({ open_loop: false });

    assert.equal(outcome.response.isError, false, JSON.stringify(outcome.response));
    assert.equal(listCandidates(undefined, workspace.dir).length, 1, 'candidate created as before');
    assert.deepEqual(listLoops({}, workspace.dir), [], 'still no loop — open_loop was off');
  });
});
