import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const CLI_PATH = path.resolve(import.meta.dirname, '..', '..', 'dist', 'cli.js');
const NODE = process.execPath;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-instructions-'));
}

function run(args: string[], cwd: string): { stdout: string; stderr: string; exitCode: number } {
  const fakeHome = path.join(cwd, '.fake-home');
  fs.mkdirSync(fakeHome, { recursive: true });
  const result = spawnSync(NODE, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 20000,
    env: {
      ...process.env,
      BRAINCLAW_SKIP_REPO_ANALYSIS: '1',
      BRAINCLAW_SKIP_AGENT_BOOTSTRAP: '1',
      BRAINCLAW_SKIP_SETUP_REQUIREMENT: '1',
      USERNAME: 'testuser',
      USER: 'testuser',
      BRAINCLAW_STORE_BOUNDARY: cwd,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
    },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

describe('Layered instructions', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    run(['init', '-y', '--no-analyze-repo', '--project-mode', 'multi-project', '--project-strategy', 'folder'], dir);
    const configPath = path.join(dir, '.brainclaw', 'config.yaml');
    const config = fs.readFileSync(configPath, 'utf-8').replace('known: []', 'known:\n  - auth');
    fs.writeFileSync(configPath, config, 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates global, project, and agent instructions', () => {
    run(['instruction', 'Read memory before editing'], dir);
    run(['instruction', 'Use auth gateway conventions', '--layer', 'project', '--project', 'auth'], dir);
    run(['instruction', 'OpenClaw must surface blockers', '--layer', 'agent', '--agent', 'openclaw'], dir);

    const entries = fs.readdirSync(path.join(dir, '.brainclaw', 'memory', 'instructions')).filter((name) => name.endsWith('.json'));
    assert.equal(entries.length, 3);
  });

  it('lists resolved instructions with precedence order', () => {
    run(['instruction', 'Read memory before editing'], dir);
    run(['instruction', 'Use auth gateway conventions', '--layer', 'project', '--project', 'auth'], dir);
    run(['instruction', 'OpenClaw must surface blockers', '--layer', 'agent', '--agent', 'openclaw'], dir);

    const res = run(['list-instructions', '--resolved', '--for', 'auth/routes.ts', '--agent', 'openclaw'], dir);
    assert.equal(res.exitCode, 0);
    const globalIndex = res.stdout.indexOf('Read memory before editing');
    const projectIndex = res.stdout.indexOf('Use auth gateway conventions');
    const agentIndex = res.stdout.indexOf('OpenClaw must surface blockers');
    assert.ok(globalIndex >= 0);
    assert.ok(projectIndex > globalIndex);
    assert.ok(agentIndex > projectIndex);
  });

  it('uses the configured current agent when --layer agent is used without --agent', () => {
    const res = run(['instruction', 'Current agent must capture blockers', '--layer', 'agent'], dir);
    assert.equal(res.exitCode, 0);

    const entries = fs.readdirSync(path.join(dir, '.brainclaw', 'memory', 'instructions')).filter((name) => name.endsWith('.json'));
    assert.equal(entries.length, 1);
    const entry = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'memory', 'instructions', entries[0]), 'utf-8'));
    assert.equal(entry.scope, 'testuser');
  });

  it('resolves current-agent instructions when --resolved is used without --agent', () => {
    run(['instruction', 'Read memory before editing'], dir);
    run(['instruction', 'Use auth gateway conventions', '--layer', 'project', '--project', 'auth'], dir);
    run(['instruction', 'Current agent must capture blockers', '--layer', 'agent'], dir);

    const res = run(['list-instructions', '--resolved', '--for', 'auth/routes.ts'], dir);
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes('Read memory before editing'));
    assert.ok(res.stdout.includes('Use auth gateway conventions'));
    assert.ok(res.stdout.includes('Current agent must capture blockers'));
  });

  it('project markdown and status include shared instructions', () => {
    run(['instruction', 'Read memory before editing'], dir);

    const markdown = fs.readFileSync(path.join(dir, '.brainclaw', 'project.md'), 'utf-8');
    assert.ok(markdown.includes('## Shared instructions'));
    assert.ok(markdown.includes('Read memory before editing'));

    const status = run(['status'], dir);
    assert.ok(status.stdout.includes('Instructions: 1'));
  });

  it('doctor warns when multiple active instructions share the same layer and scope', () => {
    run(['instruction', 'First project auth instruction', '--layer', 'project', '--project', 'auth'], dir);
    run(['instruction', 'Second project auth instruction', '--layer', 'project', '--project', 'auth'], dir);

    const res = run(['doctor'], dir);
    assert.ok(res.stdout.includes('Multiple active instructions share the same layer/scope') || res.stderr.includes('Multiple active instructions share the same layer/scope'));
  });
});

