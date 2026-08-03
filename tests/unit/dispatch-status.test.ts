/**
 * Unit tests for src/core/dispatch-status.ts (pln#503 phase 3.1).
 *
 * Covers the four target-id resolution paths (asgn_/clm_/lop_/run_), the
 * runtime artefact reads (ack file + stdout/stderr logs), and the diagnosis
 * verdict matrix.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { getDispatchStatus } from '../../src/core/dispatch-status.js';
import { saveAssignment } from '../../src/core/assignments.js';
import { saveAgentRun } from '../../src/core/agentruns.js';
import { saveClaim } from '../../src/core/claims.js';
import type { Assignment, AgentRun, Claim } from '../../src/core/schema.js';
import { nowISO } from '../../src/core/ids.js';

function seedClaim(workspace: TestWorkspace, id: string, overrides: Partial<Claim> = {}): Claim {
  const claim: Claim = {
    schema_version: 2,
    id,
    agent: workspace.currentAgent.agent_name,
    agent_id: workspace.currentAgent.agent_id,
    scope: 'test-scope',
    description: 'test claim',
    created_at: nowISO(),
    status: 'active',
    ...overrides,
  };
  saveClaim(claim, workspace.dir);
  return claim;
}

function seedAssignment(workspace: TestWorkspace, id: string, overrides: Partial<Assignment> = {}): Assignment {
  const assignment: Assignment = {
    schema_version: 2,
    id,
    short_label: id,
    claim_id: overrides.claim_id ?? 'clm_test',
    agent: workspace.currentAgent.agent_name,
    dispatcher_agent: workspace.currentAgent.agent_name,
    scope: 'test-scope',
    description: 'test assignment',
    status: 'offered',
    created_at: nowISO(),
    updated_at: nowISO(),
    offered_at: nowISO(),
    last_heartbeat_at: nowISO(),
    artifacts: [],
    retry_count: 0,
    max_retries: 2,
    heartbeat_ttl_ms: 30 * 60_000,
    acceptance_ttl_ms: 15 * 60_000,
    tags: [],
    ...overrides,
  };
  saveAssignment(assignment, workspace.dir);
  return assignment;
}

function seedAgentRun(workspace: TestWorkspace, id: string, overrides: Partial<AgentRun> = {}): AgentRun {
  const now = nowISO();
  const run: AgentRun = {
    schema_version: 2,
    id,
    short_label: id,
    assignment_id: overrides.assignment_id ?? 'asgn_test',
    claim_id: overrides.claim_id ?? 'clm_test',
    message_id: 'msg_test',
    attempt_index: 1,
    agent: workspace.currentAgent.agent_name,
    transport: 'cli_spawn',
    status: 'running',
    scope: 'test-scope',
    description: 'test run',
    command: 'echo test',
    pid: 1,
    created_at: now,
    updated_at: now,
    launched_at: now,
    started_at: now,
    last_event_at: now,
    artifacts: [],
    tags: ['test-run'],
    ...overrides,
  };
  saveAgentRun(run, workspace.dir);
  return run;
}

describe('getDispatchStatus — target_id resolver', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    process.env.BRAINCLAW_TEST_MODE = '1';
    workspace = createTestWorkspace({ prefix: 'bclaw-disp-status-' });
  });

  afterEach(() => {
    workspace.cleanup();
    delete process.env.BRAINCLAW_TEST_MODE;
  });

  it('resolves an asgn_ target_id to the assignment + linked claim + most recent run', () => {
    seedClaim(workspace, 'clm_r1');
    seedAssignment(workspace, 'asgn_r1', { claim_id: 'clm_r1' });
    seedAgentRun(workspace, 'run_r1', { assignment_id: 'asgn_r1', claim_id: 'clm_r1' });

    const status = getDispatchStatus({ target_id: 'asgn_r1', cwd: workspace.dir });

    assert.equal(status.resolved_from, 'assignment_id');
    assert.equal(status.entities.assignment_id, 'asgn_r1');
    assert.equal(status.entities.claim_id, 'clm_r1');
    assert.equal(status.entities.run_id, 'run_r1');
    assert.ok(status.assignment);
    assert.ok(status.claim);
    assert.ok(status.agent_run);
  });

  it('resolves a run_ target_id back to its assignment + claim', () => {
    seedClaim(workspace, 'clm_r2');
    seedAssignment(workspace, 'asgn_r2', { claim_id: 'clm_r2' });
    seedAgentRun(workspace, 'run_r2', { assignment_id: 'asgn_r2', claim_id: 'clm_r2' });

    const status = getDispatchStatus({ target_id: 'run_r2', cwd: workspace.dir });

    assert.equal(status.resolved_from, 'run_id');
    assert.equal(status.entities.assignment_id, 'asgn_r2');
    assert.equal(status.entities.run_id, 'run_r2');
  });

  it('resolves a clm_ target_id to the most-recent assignment for that claim', () => {
    seedClaim(workspace, 'clm_r3');
    const older = seedAssignment(workspace, 'asgn_r3_older', { claim_id: 'clm_r3', created_at: '2026-01-01T00:00:00.000Z' });
    const newer = seedAssignment(workspace, 'asgn_r3_newer', { claim_id: 'clm_r3', created_at: '2026-12-01T00:00:00.000Z' });

    const status = getDispatchStatus({ target_id: 'clm_r3', cwd: workspace.dir });

    assert.equal(status.resolved_from, 'claim_id');
    assert.equal(status.entities.assignment_id, newer.id, 'should pick the newer assignment');
    assert.notEqual(status.entities.assignment_id, older.id);
  });

  it('returns unresolved for a malformed target_id', () => {
    const status = getDispatchStatus({ target_id: 'garbage', cwd: workspace.dir });
    assert.equal(status.resolved_from, 'unresolved');
    assert.equal(status.diagnosis.health, 'unknown');
  });
});

describe('getDispatchStatus — diagnosis verdict', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    process.env.BRAINCLAW_TEST_MODE = '1';
    workspace = createTestWorkspace({ prefix: 'bclaw-disp-diag-' });
  });

  afterEach(() => {
    workspace.cleanup();
    delete process.env.BRAINCLAW_TEST_MODE;
  });

  it('not_dispatched when assignment exists but no agent_run', () => {
    seedClaim(workspace, 'clm_d1');
    seedAssignment(workspace, 'asgn_d1', { claim_id: 'clm_d1', status: 'offered' });
    // no seedAgentRun

    const status = getDispatchStatus({ target_id: 'asgn_d1', cwd: workspace.dir });
    assert.equal(status.diagnosis.health, 'not_dispatched');
    assert.ok(status.diagnosis.recommended_next_action.length > 0);
  });

  it('terminal when agent_run is completed', () => {
    seedClaim(workspace, 'clm_d2');
    seedAssignment(workspace, 'asgn_d2', { claim_id: 'clm_d2' });
    seedAgentRun(workspace, 'run_d2', {
      assignment_id: 'asgn_d2',
      claim_id: 'clm_d2',
      status: 'completed',
      status_reason: 'normal exit',
    });

    const status = getDispatchStatus({ target_id: 'asgn_d2', cwd: workspace.dir });
    assert.equal(status.diagnosis.health, 'terminal');
    assert.ok(status.diagnosis.summary.includes('completed'));
  });

  it('silent_death when run.status=running but pid is dead', () => {
    seedClaim(workspace, 'clm_d3');
    seedAssignment(workspace, 'asgn_d3', { claim_id: 'clm_d3' });
    seedAgentRun(workspace, 'run_d3', {
      assignment_id: 'asgn_d3',
      claim_id: 'clm_d3',
      status: 'running',
      pid: 9_999_999, // wildly improbable pid
    });

    const status = getDispatchStatus({ target_id: 'asgn_d3', cwd: workspace.dir });
    // The pid is almost certainly dead → process.kill(pid, 0) throws ESRCH
    assert.equal(status.runtime.pid_alive, false);
    assert.equal(status.diagnosis.health, 'silent_death');
  });

  it('healthy when run.status=running, pid alive (current process), recent activity', () => {
    seedClaim(workspace, 'clm_d4');
    seedAssignment(workspace, 'asgn_d4', { claim_id: 'clm_d4' });
    seedAgentRun(workspace, 'run_d4', {
      assignment_id: 'asgn_d4',
      claim_id: 'clm_d4',
      status: 'running',
      pid: process.pid, // surely alive
      last_event_at: nowISO(),
    });

    const status = getDispatchStatus({ target_id: 'asgn_d4', cwd: workspace.dir });
    assert.equal(status.runtime.pid_alive, true);
    assert.equal(status.diagnosis.health, 'healthy');
  });

  it('stalled when run.status=running, pid alive, but no activity for stall window', () => {
    seedClaim(workspace, 'clm_d5');
    seedAssignment(workspace, 'asgn_d5', { claim_id: 'clm_d5' });
    seedAgentRun(workspace, 'run_d5', {
      assignment_id: 'asgn_d5',
      claim_id: 'clm_d5',
      status: 'running',
      pid: process.pid,
      last_event_at: '2026-01-01T00:00:00.000Z', // very old
    });

    const status = getDispatchStatus({
      target_id: 'asgn_d5',
      cwd: workspace.dir,
      stall_threshold_ms: 1000,
    });
    assert.equal(status.diagnosis.health, 'stalled');
  });
});

describe('getDispatchStatus — runtime artefacts (ack + logs)', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    process.env.BRAINCLAW_TEST_MODE = '1';
    workspace = createTestWorkspace({ prefix: 'bclaw-disp-rt-' });
  });

  afterEach(() => {
    workspace.cleanup();
    delete process.env.BRAINCLAW_TEST_MODE;
  });

  it('reports ack file present and reads stdout/stderr tails', () => {
    seedClaim(workspace, 'clm_l1');
    seedAssignment(workspace, 'asgn_l1', { claim_id: 'clm_l1' });
    seedAgentRun(workspace, 'run_l1', { assignment_id: 'asgn_l1', claim_id: 'clm_l1' });

    // Create the on-disk artefacts the dispatcher would have created.
    const runtimeRoot = path.join(workspace.dir, '.brainclaw', 'coordination', 'runtime');
    fs.mkdirSync(path.join(runtimeRoot, 'ack'), { recursive: true });
    fs.mkdirSync(path.join(runtimeRoot, 'log'), { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, 'ack', 'asgn_l1.ack'), '');
    fs.writeFileSync(path.join(runtimeRoot, 'log', 'asgn_l1.stdout.log'), 'line 1\nline 2\nline 3\n');
    fs.writeFileSync(path.join(runtimeRoot, 'log', 'asgn_l1.stderr.log'), 'oops\n');

    const status = getDispatchStatus({ target_id: 'asgn_l1', cwd: workspace.dir, tail_log_lines: 10 });

    assert.equal(status.runtime.ack_file.exists, true);
    assert.equal(status.runtime.log_files.stdout?.exists, true);
    assert.deepEqual(status.runtime.log_files.stdout?.tail, ['line 1', 'line 2', 'line 3']);
    assert.equal(status.runtime.log_files.stderr?.exists, true);
    assert.deepEqual(status.runtime.log_files.stderr?.tail, ['oops']);
  });

  it('handles missing ack + log files gracefully', () => {
    seedClaim(workspace, 'clm_l2');
    seedAssignment(workspace, 'asgn_l2', { claim_id: 'clm_l2' });
    seedAgentRun(workspace, 'run_l2', { assignment_id: 'asgn_l2', claim_id: 'clm_l2' });

    const status = getDispatchStatus({ target_id: 'asgn_l2', cwd: workspace.dir });
    assert.equal(status.runtime.ack_file.exists, false);
    assert.equal(status.runtime.log_files.stdout?.exists, false);
    assert.equal(status.runtime.log_files.stdout?.size_bytes, 0);
    assert.equal(status.runtime.log_files.stderr?.exists, false);
  });

  it('respects tail_log_lines=0 (size only, no tail content)', () => {
    seedClaim(workspace, 'clm_l3');
    seedAssignment(workspace, 'asgn_l3', { claim_id: 'clm_l3' });
    seedAgentRun(workspace, 'run_l3', { assignment_id: 'asgn_l3', claim_id: 'clm_l3' });
    const runtimeRoot = path.join(workspace.dir, '.brainclaw', 'coordination', 'runtime');
    fs.mkdirSync(path.join(runtimeRoot, 'log'), { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, 'log', 'asgn_l3.stdout.log'), 'noise\n'.repeat(100));

    const status = getDispatchStatus({ target_id: 'asgn_l3', cwd: workspace.dir, tail_log_lines: 0 });
    assert.equal(status.runtime.log_files.stdout?.exists, true);
    assert.ok((status.runtime.log_files.stdout?.size_bytes ?? 0) > 0);
    assert.equal(status.runtime.log_files.stdout?.tail, undefined, 'tail should be omitted when tail_log_lines=0');
  });
});

describe('getDispatchStatus — LANE-RESULT.json as #1 verdict signal (pln#532)', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    process.env.BRAINCLAW_TEST_MODE = '1';
    workspace = createTestWorkspace({ prefix: 'bclaw-disp-lr-' });
  });

  afterEach(() => {
    workspace.cleanup();
    delete process.env.BRAINCLAW_TEST_MODE;
  });

  function seedWithWorktree(suffix: string, runOverrides: Partial<AgentRun> = {}): string {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), `bclaw-wt-${suffix}-`));
    seedClaim(workspace, `clm_${suffix}`, { worktree_path: worktree });
    seedAssignment(workspace, `asgn_${suffix}`, { claim_id: `clm_${suffix}` });
    seedAgentRun(workspace, `run_${suffix}`, {
      assignment_id: `asgn_${suffix}`,
      claim_id: `clm_${suffix}`,
      worktree_path: worktree,
      status: 'running',
      pid: process.pid,
      last_event_at: nowISO(),
      ...runOverrides,
    });
    return worktree;
  }

  it('reports terminal "worker done" when LANE-RESULT.json status=completed, even if run still running', () => {
    const worktree = seedWithWorktree('lr1');
    fs.writeFileSync(path.join(worktree, 'LANE-RESULT.json'), JSON.stringify({
      assignment_id: 'asgn_lr1',
      status: 'completed',
      summary: 'Implemented the thing and committed on the lane branch.',
    }));

    const status = getDispatchStatus({ target_id: 'asgn_lr1', cwd: workspace.dir });
    assert.equal(status.diagnosis.health, 'terminal');
    assert.match(status.diagnosis.summary, /LANE-RESULT\.json/);
    assert.match(status.diagnosis.summary, /status=completed/);
    assert.equal(status.runtime.lane_result?.status, 'completed');
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  it('reports terminal for a blocked/failed LANE-RESULT and recommends inspection', () => {
    const worktree = seedWithWorktree('lr2');
    fs.writeFileSync(path.join(worktree, 'LANE-RESULT.json'), JSON.stringify({
      assignment_id: 'asgn_lr2',
      status: 'blocked',
      summary: 'Could not resolve a merge conflict in schema.ts.',
    }));

    const status = getDispatchStatus({ target_id: 'asgn_lr2', cwd: workspace.dir });
    assert.equal(status.diagnosis.health, 'terminal');
    assert.equal(status.runtime.lane_result?.status, 'blocked');
    assert.match(status.diagnosis.recommended_next_action, /blocked/i);
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  it('ignores a malformed LANE-RESULT.json and falls back to the normal verdict', () => {
    const worktree = seedWithWorktree('lr3');
    fs.writeFileSync(path.join(worktree, 'LANE-RESULT.json'), '{ not valid json');

    const status = getDispatchStatus({ target_id: 'asgn_lr3', cwd: workspace.dir });
    assert.equal(status.runtime.lane_result, undefined);
    assert.notEqual(status.diagnosis.health, 'terminal');
    fs.rmSync(worktree, { recursive: true, force: true });
  });
});

describe('getDispatchStatus — worktree git evidence (pln#554 step 2)', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    process.env.BRAINCLAW_TEST_MODE = '1';
    workspace = createTestWorkspace({ prefix: 'bclaw-disp-git-' });
  });

  afterEach(() => {
    workspace.cleanup();
    delete process.env.BRAINCLAW_TEST_MODE;
  });

  /** A real git repo with a 'basepoint' branch marking the dispatch base. */
  function initGitWorktree(): { dir: string; git: (args: string[]) => string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-git-ev-'));
    const git = (args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8' });
    execFileSync('git', ['init', '-q', dir], { encoding: 'utf-8' });
    git(['config', 'user.email', 'test@test.local']);
    git(['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
    git(['add', 'base.txt']);
    git(['commit', '-q', '-m', 'base']);
    git(['branch', 'basepoint']);
    return { dir, git };
  }

  function seedWithGitWorktree(suffix: string, worktree: string, runOverrides: Partial<AgentRun> = {}): void {
    seedClaim(workspace, `clm_${suffix}`, { worktree_path: worktree });
    seedAssignment(workspace, `asgn_${suffix}`, { claim_id: `clm_${suffix}` });
    seedAgentRun(workspace, `run_${suffix}`, {
      assignment_id: `asgn_${suffix}`,
      claim_id: `clm_${suffix}`,
      worktree_path: worktree,
      status: 'running',
      last_event_at: nowISO(),
      ...runOverrides,
    });
  }

  it('verdict "worker delivered; harvest it" when commits ahead + clean tree, even with a dead pid (never kill-and-reroute)', () => {
    const { dir, git } = initGitWorktree();
    fs.writeFileSync(path.join(dir, 'work.txt'), 'delivered\n');
    git(['add', 'work.txt']);
    git(['commit', '-q', '-m', 'work']);
    seedWithGitWorktree('ge1', dir, { pid: 9_999_999 }); // dead pid: silent_death without git evidence

    const status = getDispatchStatus({ target_id: 'asgn_ge1', cwd: workspace.dir, base_ref: 'basepoint' });
    assert.equal(status.runtime.commits_ahead, 1);
    assert.equal(status.runtime.dirty_tracked, 0);
    assert.equal(status.diagnosis.health, 'terminal');
    assert.match(status.diagnosis.summary, /worker delivered/);
    assert.match(status.diagnosis.recommended_next_action, /harvest/i);
    assert.match(status.diagnosis.recommended_next_action, /Do NOT kill or reroute/, 'must explicitly forbid kill/reroute');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('pln#621 pack — dead pid + FRESH filesystem activity: the recommendation never says kill', () => {
    // pln#520 corpus incident: 6 workers were killed on a dead WRAPPER pid and
    // committed their work 4-7 minutes later. The commits-ahead variant above
    // pins the delivered case; THIS pins the earlier window — no commits yet,
    // but the worker is demonstrably WRITING (fresh worktree mtime). Whatever
    // the liveness verdict is, a destructive recommendation is forbidden.
    const { dir } = initGitWorktree();
    seedWithGitWorktree('ge_fsactive', dir, { pid: 9_999_999 }); // dead (wrapper) pid
    fs.writeFileSync(path.join(dir, 'in-progress.txt'), 'still writing\n'); // fresh fs activity NOW

    const status = getDispatchStatus({ target_id: 'asgn_ge_fsactive', cwd: workspace.dir, base_ref: 'basepoint' });
    assert.ok((status.runtime.last_fs_activity_ms ?? Infinity) < 60_000, 'precondition: fs activity is fresh');
    // Review of PR #170 caught the first version of this pin only rejecting the
    // LITERAL word "kill" while the silent_death branch advised "cancel +
    // reroute" — destructive advice by another name. The invariant is about
    // the ACTION, not the vocabulary.
    assert.doesNotMatch(status.diagnosis.recommended_next_action, /kill|cancel|reroute/i,
      'a dead pid proves nothing on an ack-wrapped spawn; fresh fs writes forbid ANY destructive recommendation');
    assert.notEqual(status.diagnosis.health, 'stalled', 'a writing worker is not stalled');
    assert.notEqual(status.diagnosis.health, 'silent_death', 'fresh fs activity vetoes the silent_death verdict');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('commits ahead + dirty tracked tree is NOT delivered — falls through to process evidence', () => {
    const { dir, git } = initGitWorktree();
    fs.writeFileSync(path.join(dir, 'work.txt'), 'wip\n');
    git(['add', 'work.txt']);
    git(['commit', '-q', '-m', 'work']);
    fs.writeFileSync(path.join(dir, 'base.txt'), 'modified tracked file\n'); // dirty tracked
    seedWithGitWorktree('ge2', dir, { pid: 9_999_999 });

    const status = getDispatchStatus({ target_id: 'asgn_ge2', cwd: workspace.dir, base_ref: 'basepoint' });
    assert.equal(status.runtime.commits_ahead, 1);
    assert.equal(status.runtime.dirty_tracked, 1);
    // The load-bearing half: a dirty tree is never a "delivered" terminal.
    assert.notEqual(status.diagnosis.health, 'terminal');
    assert.doesNotMatch(status.diagnosis.summary, /worker delivered/);
    // Post-pln#621: the tracked file was written moments ago, so the dead
    // (wrapper) pid now reads healthy-writing rather than silent_death — the
    // safer verdict. The process-evidence fallthrough applies only once fs
    // activity has gone quiet.
    assert.equal(status.diagnosis.health, 'healthy');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('untracked files do not count as dirty_tracked', () => {
    const { dir, git } = initGitWorktree();
    fs.writeFileSync(path.join(dir, 'work.txt'), 'delivered\n');
    git(['add', 'work.txt']);
    git(['commit', '-q', '-m', 'work']);
    fs.writeFileSync(path.join(dir, 'untracked-debris.log'), 'noise\n');
    seedWithGitWorktree('ge3', dir, { pid: process.pid });

    const status = getDispatchStatus({ target_id: 'asgn_ge3', cwd: workspace.dir, base_ref: 'basepoint' });
    assert.equal(status.runtime.dirty_tracked, 0);
    assert.equal(status.diagnosis.health, 'terminal');
    assert.match(status.diagnosis.summary, /worker delivered/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('LANE-RESULT.json still outranks git evidence', () => {
    const { dir, git } = initGitWorktree();
    fs.writeFileSync(path.join(dir, 'work.txt'), 'delivered\n');
    git(['add', 'work.txt']);
    git(['commit', '-q', '-m', 'work']);
    fs.writeFileSync(path.join(dir, 'LANE-RESULT.json'), JSON.stringify({
      assignment_id: 'asgn_ge4',
      status: 'blocked',
      summary: 'Blocked on a schema conflict.',
    }));
    seedWithGitWorktree('ge4', dir, { pid: process.pid });

    const status = getDispatchStatus({ target_id: 'asgn_ge4', cwd: workspace.dir, base_ref: 'basepoint' });
    assert.match(status.diagnosis.summary, /LANE-RESULT\.json/);
    assert.equal(status.runtime.lane_result?.status, 'blocked');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('no worktree → git evidence undefined, diagnosis unaffected', () => {
    seedClaim(workspace, 'clm_ge5');
    seedAssignment(workspace, 'asgn_ge5', { claim_id: 'clm_ge5' });
    seedAgentRun(workspace, 'run_ge5', {
      assignment_id: 'asgn_ge5', claim_id: 'clm_ge5', status: 'running', pid: process.pid, last_event_at: nowISO(),
    });

    const status = getDispatchStatus({ target_id: 'asgn_ge5', cwd: workspace.dir });
    assert.equal(status.runtime.commits_ahead, undefined);
    assert.equal(status.runtime.dirty_tracked, undefined);
    assert.equal(status.diagnosis.health, 'healthy');
  });

  it('zero commits ahead with a clean tree is NOT delivered (nothing to harvest)', () => {
    const { dir } = initGitWorktree();
    seedWithGitWorktree('ge6', dir, { pid: process.pid });

    const status = getDispatchStatus({ target_id: 'asgn_ge6', cwd: workspace.dir, base_ref: 'basepoint' });
    assert.equal(status.runtime.commits_ahead, 0);
    assert.equal(status.runtime.dirty_tracked, 0);
    assert.notEqual(status.diagnosis.summary.includes('worker delivered'), true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
