/**
 * pln#359 phase 1c — CLI `--project` global option e2e.
 *
 * Spins up two real brainclaw projects in temp dirs, links source -> target
 * via cross_project_links, then runs `brainclaw --project=target ...` from
 * the source dir and asserts the read/write hits the target store.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { defaultConfig, loadConfig, saveConfig } from '../src/core/config.js';
import { ensureMemoryDir } from '../src/core/io.js';
import { loadState, saveState } from '../src/core/state.js';
import type { State, PlanItem } from '../src/core/schema.js';
import { sanitizedProcessEnv } from './helpers/workspace.js';

const CLI_PATH = path.resolve(import.meta.dirname, '..', '..', 'dist', 'cli.js');
const NODE = process.execPath;
const BASE_STATE: State = {
  version: 1, write_version: 1,
  active_constraints: [], recent_decisions: [], known_traps: [],
  open_handoffs: [], plan_items: [],
};

function makeProject(prefix: string, projectName: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  ensureMemoryDir(dir);
  saveConfig(defaultConfig(projectName, { projectId: `prj_${projectName.replace(/[^a-z0-9]/gi, '')}` }), dir);
  saveState(BASE_STATE, dir);
  return dir;
}

function runCli(args: string[], cwd: string, envOverrides: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-cli-xp-home-'));
  const env: NodeJS.ProcessEnv = {
    ...sanitizedProcessEnv(),
    BRAINCLAW_SKIP_REPO_ANALYSIS: '1',
    BRAINCLAW_SKIP_AGENT_BOOTSTRAP: '1',
    BRAINCLAW_SKIP_SETUP_REQUIREMENT: '1',
    BRAINCLAW_STORE_BOUNDARY: cwd,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    USERNAME: 'testuser',
    USER: 'testuser',
    ...envOverrides,
  };
  const result = spawnSync(NODE, [CLI_PATH, ...args], {
    cwd, encoding: 'utf-8', timeout: 25000, env,
  });
  fs.rmSync(fakeHome, { recursive: true, force: true });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

describe('CLI --project (pln#359 phase 1c)', () => {
  let sourceDir: string;
  let targetDir: string;

  beforeEach(() => {
    sourceDir = makeProject('bclaw-cli-xp-source-', 'source-project');
    targetDir = makeProject('bclaw-cli-xp-target-', 'target-project');

    // Wire source -> target via cross_project_link
    const sourceConfig = loadConfig(sourceDir);
    sourceConfig.cross_project_links = [
      { path: targetDir, name: 'target-project', role: 'publisher' },
    ];
    saveConfig(sourceConfig, sourceDir);

    // Seed a plan in the TARGET only
    const targetState: State = { ...BASE_STATE, plan_items: [] };
    const targetPlan: PlanItem = {
      id: 'pln_target_only',
      text: 'Lives only in target',
      status: 'todo',
      type: 'feat',
      priority: 'medium',
      tags: [],
      depends_on: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      author: 'test',
    };
    targetState.plan_items.push(targetPlan);
    saveState(targetState, targetDir);
  });

  afterEach(() => {
    fs.rmSync(sourceDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
  });

  it('--project=<name> from source dir reads the target store (list-plans)', () => {
    const result = runCli(['--project=target-project', 'list-plans'], sourceDir);
    assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}. stderr=${result.stderr}`);
    assert.match(result.stdout, /pln_target_only/);
    assert.match(result.stdout, /Lives only in target/);
  });

  it('--project=<name> writes a decision into the target store', () => {
    const result = runCli(
      ['--project=target-project', 'decision', 'cross-project decision via --project'],
      sourceDir,
    );
    assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}. stderr=${result.stderr}`);

    // Source state should NOT contain the new decision; target SHOULD.
    const sourceState = loadState(sourceDir);
    const targetState = loadState(targetDir);
    const sourceHit = sourceState.recent_decisions.find((d) => d.text.includes('cross-project decision'));
    const targetHit = targetState.recent_decisions.find((d) => d.text.includes('cross-project decision'));
    assert.equal(sourceHit, undefined, 'decision should NOT appear in source state');
    assert.ok(targetHit, 'decision SHOULD appear in target state');
  });

  it('--project + --cwd are mutually exclusive', () => {
    const result = runCli(
      ['--project=target-project', '--cwd', targetDir, 'list-plans'],
      sourceDir,
    );
    assert.notEqual(result.exitCode, 0, 'Expected non-zero exit for mutex');
    assert.match(result.stderr, /mutually exclusive/);
  });

  it('--project with unknown name fails with explicit error', () => {
    const result = runCli(['--project=does-not-exist', 'list-plans'], sourceDir);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /Unknown project: 'does-not-exist'/);
  });

  it('without --project, list-plans reads the source store as before (regression check)', () => {
    const result = runCli(['list-plans'], sourceDir);
    assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}. stderr=${result.stderr}`);
    // Source has no plans seeded — should NOT show the target plan.
    assert.doesNotMatch(result.stdout, /pln_target_only/);
  });
});
