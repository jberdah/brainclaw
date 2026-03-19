import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanGitRepos } from '../../src/commands/setup.js';

const CLI_PATH = path.resolve(import.meta.dirname, '..', '..', 'src', 'cli.js');
const NODE = process.execPath;
let testHomeDir = '';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-setup-'));
}

function initGitRepo(dir: string): void {
  const result = spawnSync('git', ['init'], { cwd: dir, encoding: 'utf-8' });
  assert.equal(result.status, 0, result.stderr ?? result.stdout);
}

function run(
  args: string[],
  cwd: string,
  envOverrides: Record<string, string> = {},
): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(NODE, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 20000,
    env: {
      ...process.env,
      BRAINCLAW_SKIP_REPO_ANALYSIS: '1',
      BRAINCLAW_SKIP_AGENT_BOOTSTRAP: '1',
      USERNAME: 'testuser',
      USER: 'testuser',
      HOME: testHomeDir,
      USERPROFILE: testHomeDir,
      ...envOverrides,
    },
  });

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

describe('setup/init guardrails', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    testHomeDir = path.join(dir, '.home');
    fs.mkdirSync(testHomeDir, { recursive: true });
    initGitRepo(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('scanGitRepos includes the root repo and ignores internal .brainclaw repos', () => {
    const nestedMemoryRepo = path.join(dir, '.brainclaw');
    const childRepo = path.join(dir, 'child-repo');

    fs.mkdirSync(nestedMemoryRepo, { recursive: true });
    fs.mkdirSync(childRepo, { recursive: true });
    initGitRepo(nestedMemoryRepo);
    initGitRepo(childRepo);

    const repos = scanGitRepos([dir]);

    assert.deepEqual(
      repos.map((repo) => repo.path).sort(),
      [dir, childRepo].sort(),
    );
  });

  it('setup skips an already initialized root repo without creating .brainclaw/.brainclaw', () => {
    const firstSetup = run(['setup', '--yes', '--roots', dir, '--agents', 'codex'], dir, {
      BRAINCLAW_SKIP_SETUP_REQUIREMENT: '0',
    });
    assert.equal(firstSetup.exitCode, 0, firstSetup.stderr);

    const setupResult = run(['setup', '--yes', '--roots', dir, '--agents', 'codex'], dir, {
      BRAINCLAW_SKIP_SETUP_REQUIREMENT: '0',
    });
    assert.equal(setupResult.exitCode, 0, setupResult.stderr);
    assert.ok(!fs.existsSync(path.join(dir, '.brainclaw', '.brainclaw', 'project.identity.json')));
    assert.match(setupResult.stdout, /already initialised|skip/i);
  });

  it('init requires setup before first project initialization', () => {
    const initResult = run(['init', '-y'], dir, {
      BRAINCLAW_SKIP_SETUP_REQUIREMENT: '0',
    });

    assert.notEqual(initResult.exitCode, 0);
    assert.match(initResult.stderr, /brainclaw setup/i);
  });

  it('init refuses to run from inside an existing .brainclaw store', () => {
    const setupResult = run(['setup', '--yes', '--roots', dir, '--agents', 'codex'], dir, {
      BRAINCLAW_SKIP_SETUP_REQUIREMENT: '0',
    });
    assert.equal(setupResult.exitCode, 0, setupResult.stderr);

    const nestedInit = run(['init', '-y'], path.join(dir, '.brainclaw'), {
      BRAINCLAW_SKIP_SETUP_REQUIREMENT: '0',
    });
    assert.notEqual(nestedInit.exitCode, 0);
    assert.match(nestedInit.stderr, /inside an existing project memory store/i);
  });

  it('setup adds generated workspace integration files to .gitignore', () => {
    const setupResult = run(['setup', '--yes', '--roots', dir, '--agents', 'claude-code,roo,continue,cline,opencode'], dir, {
      BRAINCLAW_SKIP_SETUP_REQUIREMENT: '0',
    });
    assert.equal(setupResult.exitCode, 0, setupResult.stderr);

    const gitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
    assert.match(gitignore, /\.claude\/commands\/brainclaw\.md/);
    assert.match(gitignore, /\.claude\/settings\.local\.json/);
    assert.match(gitignore, /\.mcp\.json/);
    assert.match(gitignore, /\.roo\/mcp\.json/);
    assert.match(gitignore, /\.continue\/config\.json/);
    assert.match(gitignore, /\.vscode\/cline_mcp_settings\.json/);
    assert.match(gitignore, /opencode\.json/);
    assert.doesNotMatch(gitignore, /package\.json/);
  });
});
