import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI_PATH = path.resolve(import.meta.dirname, '..', '..', 'src', 'cli.js');
const NODE = process.execPath;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-init-onboarding-'));
}

function runInit(cwd: string): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(NODE, [CLI_PATH, 'init', '-y'], {
    cwd,
    encoding: 'utf-8',
    timeout: 90000,
    env: {
      ...process.env,
      BRAINCLAW_SKIP_REPO_ANALYSIS: '1',
      BRAINCLAW_SKIP_AGENT_BOOTSTRAP: '1',
      BRAINCLAW_SKIP_SETUP_REQUIREMENT: '1',
      BRAINCLAW_STORE_BOUNDARY: cwd,
      HOME: cwd,
      USERPROFILE: cwd,
      USERNAME: 'testuser',
      USER: 'testuser',
    },
  });

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

describe('init onboarding preflight', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prints onboarding gaps for an empty workspace', () => {
    const result = runInit(dir);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Onboarding preflight:/);
    assert.match(result.stdout, /Workspace kind: empty/);
    assert.match(result.stdout, /Open gaps:/);
    assert.match(result.stdout, /brainclaw bootstrap --interview --audience cli/);
    assert.match(result.stdout, /--audience ide_chat/);
  });

  it('prints detected native instruction files for an existing workspace', () => {
    fs.writeFileSync(path.join(dir, 'README.md'), '# Existing Workspace\n\n## Build\n\n- npm run build\n', 'utf-8');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Claude Guidance\n\n- Read the native instructions first\n', 'utf-8');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'npm run build' } }, null, 2), 'utf-8');

    const result = runInit(dir);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Onboarding preflight:/);
    assert.match(result.stdout, /Workspace kind: existing/);
    assert.match(result.stdout, /Native instruction files:/);
    assert.match(result.stdout, /CLAUDE\.md/);
    assert.match(result.stdout, /brainclaw bootstrap --apply/);
    assert.match(result.stdout, /brainclaw bootstrap --interview --audience cli/);
  });
});
