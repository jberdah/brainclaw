import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const CLI_PATH = path.resolve(import.meta.dirname, '..', '..', 'dist', 'cli.js');
const NODE = process.execPath;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-sec-'));
}

function run(args: string[], cwd: string): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(NODE, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 10000,
    env: {
      ...process.env,
      BRAINCLAW_SKIP_SETUP_REQUIREMENT: '1',
      USERNAME: 'testuser',
      USER: 'testuser',
      BRAINCLAW_STORE_BOUNDARY: cwd,
    },
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.status ?? 1 };
}

function initGitRepo(dir: string): void {
  spawnSync('git', ['init'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
}

describe('Security: strict mode on automated imports', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    run(['init', '-y'], dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reflect --batch blocks on sensitive content (strict enforced)', () => {
    const batchPath = path.join(dir, 'bad-events.json');
    const events = [{
      id: 'evt_sec_001',
      agent: 'openclaw',
      event_type: 'observation',
      created_at: '2026-03-14T10:00:00Z',
      text: 'API_KEY=sk-deadbeefdeadbeef is used for external calls',
      tags: [],
    }];
    fs.writeFileSync(batchPath, JSON.stringify(events), 'utf-8');

    const res = run(['reflect', '--batch', batchPath], dir);
    assert.notEqual(res.exitCode, 0, 'should exit non-zero on sensitive content in batch');
    assert.ok(
      res.stderr.includes('Blocked') || res.stdout.includes('Blocked'),
      'should emit Blocked message'
    );

    const inboxDir = path.join(dir, '.brainclaw', 'coordination', 'inbox');
    const candidates = fs.existsSync(inboxDir)
      ? fs.readdirSync(inboxDir).filter(f => f.endsWith('.json'))
      : [];
    assert.equal(candidates.length, 0, 'no candidate should be created when blocked');
  });

  it('reflect --batch succeeds for clean events', () => {
    const batchPath = path.join(dir, 'clean-events.json');
    const events = [{
      id: 'evt_sec_002',
      agent: 'openclaw',
      event_type: 'observation',
      created_at: '2026-03-14T10:00:00Z',
      text: 'Auth gateway is now handling all OAuth flows',
      tags: ['auth'],
    }];
    fs.writeFileSync(batchPath, JSON.stringify(events), 'utf-8');

    const res = run(['reflect', '--batch', batchPath], dir);
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes('Created 1 candidate'));
  });

  it('reflect single mode only warns on sensitive content (not blocked by default)', () => {
    const res = run(
      ['reflect', 'API_KEY=sk-deadbeef is used for external calls', '--type', 'decision'],
      dir
    );
    // single mode is warn by default — exits 0 with a warning
    assert.equal(res.exitCode, 0, 'single mode should not block by default (warn mode)');
    assert.ok(
      res.stderr.includes('⚠') || res.stdout.includes('⚠') ||
      res.stderr.includes('sensitive') || res.stdout.includes('sensitive'),
      'should emit a warning'
    );
  });

  it('adapter-openclaw-import dry-run notes strict mode enforcement', () => {
    const batchPath = path.join(dir, 'dry-sec.json');
    const events = [{
      id: 'evt_sec_003',
      agent: 'openclaw',
      event_type: 'observation',
      created_at: '2026-03-14T10:00:00Z',
      text: 'Clean observation from agent',
      tags: [],
    }];
    fs.writeFileSync(batchPath, JSON.stringify(events), 'utf-8');

    const res = run(['adapter-openclaw-import', batchPath, '--dry-run'], dir);
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes('strict mode'), 'dry-run should mention strict mode enforcement');
  });

  it('adapter-openclaw-import blocks on sensitive content in actual import', () => {
    const batchPath = path.join(dir, 'sensitive-events.json');
    const events = [{
      id: 'evt_sec_004',
      agent: 'openclaw',
      event_type: 'observation',
      created_at: '2026-03-14T10:00:00Z',
      text: 'password=hunter2 is stored in config',
      tags: [],
    }];
    fs.writeFileSync(batchPath, JSON.stringify(events), 'utf-8');

    const res = run(['adapter-openclaw-import', batchPath], dir);
    assert.notEqual(res.exitCode, 0);
    assert.ok(
      res.stderr.includes('Blocked') || res.stdout.includes('Blocked'),
      'should block and emit Blocked message'
    );
  });
});

describe('Security: install-hooks', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    run(['init', '-y'], dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fails without a git repo', () => {
    const res = run(['install-hooks'], dir);
    assert.notEqual(res.exitCode, 0);
    assert.ok(
      res.stderr.includes('.git') || res.stderr.includes('Git'),
      'should report missing git repo'
    );
  });

  it('installs pre-commit hook in a git repo', () => {
    initGitRepo(dir);
    const res = run(['install-hooks'], dir);
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes('pre-commit hook installed'));

    const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit');
    assert.ok(fs.existsSync(hookPath), 'hook file should exist');

    const content = fs.readFileSync(hookPath, 'utf-8');
    assert.ok(content.includes('brainclaw'), 'hook should reference brainclaw');
    assert.ok(content.includes('doctor --json'), 'hook should call doctor --json');
  });

  it('refuses to overwrite without --force', () => {
    initGitRepo(dir);
    run(['install-hooks'], dir);
    const res = run(['install-hooks'], dir);
    assert.notEqual(res.exitCode, 0);
    assert.ok(
      res.stderr.includes('already exists') || res.stderr.includes('--force'),
      'should report existing hook and suggest --force'
    );
  });

  it('overwrites existing hook with --force', () => {
    initGitRepo(dir);
    run(['install-hooks'], dir);
    const res = run(['install-hooks', '--force'], dir);
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes('installed'));
  });
});


