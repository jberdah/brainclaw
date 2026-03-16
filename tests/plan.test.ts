import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const CLI_PATH = path.resolve(import.meta.dirname, '..', 'src', 'cli.js');
const NODE = process.execPath;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-plan-'));
}

function extractId(stdout: string): string {
  const match = stdout.match(/\[([a-z]+_[a-f0-9]+)\]/);
  if (!match) throw new Error(`No ID found in output: ${stdout}`);
  return match[1];
}

function run(args: string[], cwd: string): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(NODE, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 10000,
    env: {
      ...process.env,
      BRAINCLAW_SKIP_REPO_ANALYSIS: '1',
      USERNAME: 'testuser',
      USER: 'testuser',
      HOME: cwd,
      USERPROFILE: cwd,
    },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

describe('Shared plan', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    run(['init', '-y', '--no-analyze-repo'], dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates a plan item', () => {
    const res = run([
      'plan',
      'Ship shared plan MVP',
      '--priority', 'high',
      '--assignee', 'copilot',
      '--project', 'agent-platform',
      '--tag', 'roadmap',
    ], dir);
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes('Plan item added'));

    const planFiles = fs.readdirSync(path.join(dir, '.brainclaw', 'plans')).filter(f => f.endsWith('.json'));
    const plan = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'plans', planFiles[0]), 'utf-8'));
    assert.equal(plan.priority, 'high');
    assert.equal(plan.assignee, 'copilot');
    assert.equal(plan.project, 'agent-platform');
    assert.deepEqual(plan.tags, ['roadmap']);
  });

  it('lists active plan items by default', () => {
    run(['plan', 'First shared task'], dir);
    const secondPlanRes = run(['plan', 'Second shared task'], dir);
    run(['update-plan', extractId(secondPlanRes.stdout), '--status', 'done'], dir);

    const res = run(['list-plans'], dir);
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes('First shared task'));
    assert.ok(!res.stdout.includes('Second shared task'));
  });

  it('updates plan status and assignee', () => {
    const planCreation = run(['plan', 'Coordinate repo analysis'], dir);
    const planId = extractId(planCreation.stdout);
    const res = run(['update-plan', planId, '--status', 'in_progress', '--assignee', 'alice'], dir);
    assert.equal(res.exitCode, 0);

    const [planFile] = fs.readdirSync(path.join(dir, '.brainclaw', 'plans')).filter(f => f.endsWith('.json'));
    const plan = JSON.parse(fs.readFileSync(path.join(dir, '.brainclaw', 'plans', planFile), 'utf-8'));
    assert.equal(plan.status, 'in_progress');
    assert.equal(plan.assignee, 'alice');
  });

  it('includes active plans in project.md and status output', () => {
    run(['plan', 'Document plan integration', '--priority', 'high'], dir);

    const status = run(['status'], dir);
    assert.ok(status.stdout.includes('Plans       : 1'));

    const markdown = fs.readFileSync(path.join(dir, '.brainclaw', 'project.md'), 'utf-8');
    assert.ok(markdown.includes('## Shared plan'));
    assert.ok(markdown.includes('Document plan integration'));
  });

  it('includes active plans in context output', () => {
    run(['plan', 'Coordinate auth rollout', '--tag', 'auth', '--project', 'auth'], dir);

    const res = run(['context', '--for', 'auth'], dir);
    assert.equal(res.exitCode, 0);
    assert.ok(res.stdout.includes('<plan>'));
    assert.ok(res.stdout.includes('Coordinate auth rollout'));
  });

  it('doctor warns on in-progress plans without assignee', () => {
    const unownedPlanRes = run(['plan', 'Unowned execution item'], dir);
    run(['update-plan', extractId(unownedPlanRes.stdout), '--status', 'in_progress'], dir);

    const res = run(['doctor'], dir);
    assert.ok(res.stdout.includes('in-progress plan item(s) have no assignee') || res.stderr.includes('in-progress plan item(s) have no assignee'));
  });

  it('rejects reserved subcommand words as plan text', () => {
    // 'update' should error with exit 1
    const updateRes = run(['plan', 'update'], dir);
    assert.equal(updateRes.exitCode, 1, `expected exit 1 for 'plan update'`);
    assert.ok(updateRes.stderr.includes('looks like a subcommand'), `expected subcommand error for 'plan update'`);
  });

  it('plan list and plan ls alias behaves like list-plans', () => {
    run(['plan', 'Task via alias test'], dir);

    for (const alias of ['list', 'ls']) {
      const res = run(['plan', alias], dir);
      assert.equal(res.exitCode, 0, `expected exit 0 for 'plan ${alias}'`);
      assert.ok(!res.stdout.includes('Plan item added'), `'plan ${alias}' should not create a plan`);
      assert.ok(res.stdout.includes('Task via alias test'), `'plan ${alias}' should list plans`);
    }
  });
});
