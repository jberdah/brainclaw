import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createAgentRun, loadAgentRun, transitionAgentRun } from '../../src/core/agentruns.js';
import { createAssignment, transitionAssignment } from '../../src/core/assignments.js';
import { saveClaim } from '../../src/core/claims.js';
import {
  reconcileAgentRun,
  reconcileAllOpenRuns,
  reconcileDeadPidRunningAgentRunAtRead,
  sweepDeadPidRunningAgentRunsAtRead,
  isProcessAlive,
  collectEvidence,
  DEFAULT_HEALTH_CHECK_GRACE_MS,
} from '../../src/core/agentrun-reconciler.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

let ws: TestWorkspace;

beforeEach(() => {
  ws = createTestWorkspace({ currentAgent: 'reconciler-test' });
});

afterEach(() => {
  ws.cleanup();
});

// ── Helpers ───────────────────────────────────────────────────────────────

function makeAssignment(overrides?: Partial<Parameters<typeof createAssignment>[0]>) {
  return createAssignment({
    id: 'asgn_test',
    short_label: 'asgn#1',
    agent: 'codex',
    dispatcher_agent: 'reconciler-test',
    plan_id: 'pln_test',
    claim_id: 'clm_test',
    scope: 'src/test',
    description: 'Reconciler fixture',
    ...overrides,
  }, ws.dir);
}

function makeClaim(overrides?: { status?: 'active' | 'released' | 'stale'; id?: string }) {
  saveClaim({
    schema_version: 2,
    id: overrides?.id ?? 'clm_test',
    agent: 'codex',
    scope: 'src/test',
    description: 'Reconciler claim',
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    status: overrides?.status ?? 'active',
  }, ws.dir);
}

function makeRun(overrides?: Partial<Parameters<typeof createAgentRun>[0]>) {
  return createAgentRun({
    assignment_id: 'asgn_test',
    claim_id: 'clm_test',
    agent: 'codex',
    transport: 'cli_spawn',
    scope: 'src/test',
    description: 'Reconciler run',
    status: 'running',
    ...overrides,
  }, ws.dir);
}

/**
 * Initialise a temporary git worktree so the post-start-commit evidence
 * path has something to look at. Fast (~50 ms): `git init`, one bootstrap
 * commit, return the path.
 */
function bootstrapGitWorktree(): string {
  const repoDir = fs.mkdtempSync(path.join(ws.dir, 'reconciler-wt-'));
  const run = (...args: string[]) => spawnSync('git', args, { cwd: repoDir, encoding: 'utf-8' });
  run('init', '-q');
  run('config', 'user.email', 'reconciler-test@brainclaw.local');
  run('config', 'user.name', 'Reconciler Test');
  run('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'bootstrap');
  run('add', '.');
  run('commit', '-q', '-m', 'bootstrap');
  return repoDir;
}

function commitInWorktree(repoDir: string, file: string, content: string): void {
  fs.writeFileSync(path.join(repoDir, file), content);
  spawnSync('git', ['add', file], { cwd: repoDir });
  spawnSync('git', ['commit', '-q', '-m', `add ${file}`], { cwd: repoDir });
}

// ── isProcessAlive ────────────────────────────────────────────────────────

describe('reconciler/isProcessAlive', () => {
  it('returns undefined when no PID provided', () => {
    assert.equal(isProcessAlive(undefined), undefined);
    assert.equal(isProcessAlive(0), undefined);
  });

  it('returns true for the current process', () => {
    assert.equal(isProcessAlive(process.pid), true);
  });

  it('returns false for an obviously dead PID', () => {
    // 999_999 is virtually guaranteed to not be a live PID on modern systems.
    assert.equal(isProcessAlive(999_999), false);
  });
});

// ── collectEvidence ───────────────────────────────────────────────────────

describe('reconciler/collectEvidence', () => {
  it('all-zero evidence when assignment + claim missing', () => {
    const run = makeRun({ assignment_id: 'asgn_missing', claim_id: 'clm_missing' });
    const evidence = collectEvidence(run, ws.dir);
    assert.equal(evidence.has_post_start_commit, false);
    assert.equal(evidence.claim_released, false);
    assert.equal(evidence.assignment_completed, false);
  });

  it('claim_released=true when linked claim is released', () => {
    makeClaim({ status: 'released' });
    const run = makeRun();
    const evidence = collectEvidence(run, ws.dir);
    assert.equal(evidence.claim_released, true);
  });

  it('detects post-start commit on the worktree branch', () => {
    const repoDir = bootstrapGitWorktree();
    const run = makeRun({ worktree_path: repoDir });
    // Force run.started_at slightly in the past so the next commit is "after start".
    transitionAgentRun(run.id, 'running', { actor: 'test' }, ws.dir);
    // Sleep 1 s to ensure git commit timestamp > started_at (git uses 1 s
    // granularity on commit time).
    const sleepUntil = Date.now() + 1100;
    while (Date.now() < sleepUntil) { /* spin */ }
    commitInWorktree(repoDir, 'NEW.md', 'work');
    const evidence = collectEvidence(loadAgentRun(run.id, ws.dir)!, ws.dir);
    assert.equal(evidence.has_post_start_commit, true);
  });

  it('process_alive=true for current process PID', () => {
    const run = makeRun({ pid: process.pid });
    const evidence = collectEvidence(loadAgentRun(run.id, ws.dir)!, ws.dir);
    assert.equal(evidence.process_alive, true);
  });
});

// ── reconcileAgentRun ─────────────────────────────────────────────────────

describe('reconciler/reconcileAgentRun', () => {
  it('no_op when run is already terminal', () => {
    const run = makeRun({ status: 'completed' });
    const result = reconcileAgentRun(run.id, ws.dir);
    assert.equal(result.action, 'no_op');
    assert.match(result.reason, /already terminal/);
    assert.equal(result.current_status, 'completed');
  });

  it('no_op when run is under the grace window', () => {
    const run = makeRun();
    // run was created milliseconds ago; default grace is 60 s.
    const result = reconcileAgentRun(run.id, ws.dir);
    assert.equal(result.action, 'no_op');
    assert.match(result.reason, /under grace window/);
  });

  it('inferred_completed when claim was released past grace window', () => {
    makeClaim({ status: 'released' });
    const run = makeRun();
    // Past grace — 90 s window.
    const result = reconcileAgentRun(run.id, ws.dir, {
      nowMs: new Date(run.created_at).getTime() + 90_000,
    });
    assert.equal(result.action, 'inferred_completed');
    assert.match(result.reason, /claim released/);
    assert.equal(result.current_status, 'completed');
    // Verify the transition was persisted.
    const reloaded = loadAgentRun(run.id, ws.dir)!;
    assert.equal(reloaded.status, 'completed');
    assert.match(reloaded.status_reason ?? '', /inferred=true/);
  });

  it('inferred_completed when assignment is marked completed', () => {
    const assignment = makeAssignment();
    // Walk the assignment FSM through its valid path.
    transitionAssignment(assignment.id, 'offered', { actor: 'test', syncAgentRun: false }, ws.dir);
    transitionAssignment(assignment.id, 'accepted', { actor: 'test', syncAgentRun: false }, ws.dir);
    transitionAssignment(assignment.id, 'started', { actor: 'test', syncAgentRun: false }, ws.dir);
    transitionAssignment(assignment.id, 'completed', { actor: 'test', syncAgentRun: false }, ws.dir);
    const run = makeRun({ assignment_id: assignment.id });
    const result = reconcileAgentRun(run.id, ws.dir, {
      nowMs: new Date(run.created_at).getTime() + 90_000,
    });
    assert.equal(result.action, 'inferred_completed');
    assert.match(result.reason, /assignment marked completed/);
  });

  it('inferred_completed when worktree branch has a post-start commit', () => {
    const repoDir = bootstrapGitWorktree();
    const run = makeRun({ worktree_path: repoDir });
    // Wait 1s + commit to land a commit after started_at granularity.
    const sleepUntil = Date.now() + 1100;
    while (Date.now() < sleepUntil) { /* spin */ }
    commitInWorktree(repoDir, 'NEW.md', 'work');
    const result = reconcileAgentRun(run.id, ws.dir, {
      nowMs: new Date(run.created_at).getTime() + 90_000,
    });
    assert.equal(result.action, 'inferred_completed');
    assert.match(result.reason, /post-start commit/);
  });

  it('health_check_unverified past grace, no evidence, process unknown', () => {
    const run = makeRun(); // no PID, no completion evidence
    const result = reconcileAgentRun(run.id, ws.dir, {
      nowMs: new Date(run.created_at).getTime() + 90_000, // past grace, before stale
    });
    assert.equal(result.action, 'health_check_unverified');
    // Run status MUST remain unchanged — health-check is non-mutating.
    const reloaded = loadAgentRun(run.id, ws.dir)!;
    assert.equal(reloaded.status, 'running');
  });

  it('inferred_failed past stale + dead process + no evidence', () => {
    const run = makeRun({ pid: 999_999 }); // virtually-guaranteed-dead PID
    const result = reconcileAgentRun(run.id, ws.dir, {
      nowMs: new Date(run.created_at).getTime() + 35 * 60_000, // past 30-min stale
    });
    assert.equal(result.action, 'inferred_failed');
    assert.equal(result.current_status, 'failed');
    const reloaded = loadAgentRun(run.id, ws.dir)!;
    assert.equal(reloaded.status, 'failed');
    assert.match(reloaded.status_reason ?? '', /silent_termination_no_evidence/);
  });

  it('does NOT mark failed when process still alive and stale, no evidence', () => {
    const run = makeRun({ pid: process.pid }); // current process is alive
    const result = reconcileAgentRun(run.id, ws.dir, {
      nowMs: new Date(run.created_at).getTime() + 35 * 60_000,
    });
    // Without completion evidence and a live process, we can't conclude
    // either way. Stay in health_check_unverified.
    assert.equal(result.action, 'health_check_unverified');
  });

  it('respects custom healthCheckGraceMs', () => {
    makeClaim({ status: 'released' });
    const run = makeRun();
    // 10 s grace, 5 s elapsed → still under grace.
    const earlyResult = reconcileAgentRun(run.id, ws.dir, {
      healthCheckGraceMs: 10_000,
      nowMs: new Date(run.created_at).getTime() + 5_000,
    });
    assert.equal(earlyResult.action, 'no_op');
    // 10 s grace, 15 s elapsed → past grace, claim_released → inferred.
    const lateResult = reconcileAgentRun(run.id, ws.dir, {
      healthCheckGraceMs: 10_000,
      nowMs: new Date(run.created_at).getTime() + 15_000,
    });
    assert.equal(lateResult.action, 'inferred_completed');
  });

  it('returns no_op for unknown run ids without throwing', () => {
    const result = reconcileAgentRun('run_does_not_exist', ws.dir);
    assert.equal(result.action, 'no_op');
    assert.match(result.reason, /not found/);
  });
});

// ── reconcileAllOpenRuns ──────────────────────────────────────────────────

describe('reconciler/reconcileAllOpenRuns', () => {
  it('reconciles every non-terminal run, isolates errors per-run', () => {
    makeClaim({ status: 'released' });
    const run1 = makeRun();
    const run2 = makeRun({ assignment_id: 'asgn_other', claim_id: 'clm_other' });
    const run3 = makeRun({ assignment_id: 'asgn_done', claim_id: 'clm_done', status: 'completed' });

    const results = reconcileAllOpenRuns(ws.dir, {}, {
      nowMs: new Date(run1.created_at).getTime() + 90_000,
    });

    const byId = new Map(results.map((r) => [r.run_id, r]));
    // run1 has the released claim → inferred_completed.
    assert.equal(byId.get(run1.id)?.action, 'inferred_completed');
    // run2 has no evidence and no PID → health_check_unverified.
    assert.equal(byId.get(run2.id)?.action, 'health_check_unverified');
    // run3 was already completed and is filtered out by status before reconcile.
    // It should NOT appear in results.
    assert.equal(byId.has(run3.id), false);
  });
});

// Anchor: keep the constants exported so callers can document their tuning.
describe('reconciler/exports', () => {
  it('exposes default thresholds', () => {
    assert.equal(typeof DEFAULT_HEALTH_CHECK_GRACE_MS, 'number');
    assert.ok(DEFAULT_HEALTH_CHECK_GRACE_MS > 0);
  });
});

// ── reconcileDeadPidRunningAgentRunAtRead (pln#520) ─────────────────────────

describe('reconciler/reconcileDeadPidRunningAgentRunAtRead', () => {
  it('NEVER cancels a dead pid with no evidence — leaves run running (pln#520 regression)', () => {
    // 2026-05-26 scenario: the tracked pid reads dead (untrusted shell-wrapper
    // pid) while the worker is still doing real work. Cancelling here threw
    // away 6 valid worker outputs that committed minutes later.
    const run = makeRun({ pid: 999_999 });
    const result = reconcileDeadPidRunningAgentRunAtRead(run.id, ws.dir);
    assert.equal(result.action, 'health_check_unverified');
    assert.notEqual(result.action, 'cancelled_dead_pid');
    const reloaded = loadAgentRun(run.id, ws.dir)!;
    assert.equal(reloaded.status, 'running');
  });

  it('infers completion when a dead pid coincides with a post-start commit', () => {
    const repoDir = bootstrapGitWorktree();
    const run = makeRun({ pid: 999_999, worktree_path: repoDir });
    const sleepUntil = Date.now() + 1100; // git commit-time granularity is 1 s
    while (Date.now() < sleepUntil) { /* spin */ }
    commitInWorktree(repoDir, 'NEW.md', 'work');
    const result = reconcileDeadPidRunningAgentRunAtRead(run.id, ws.dir);
    assert.equal(result.action, 'inferred_completed');
    assert.equal(loadAgentRun(run.id, ws.dir)!.status, 'completed');
  });

  it('infers completion when a dead pid coincides with a released claim', () => {
    makeClaim({ status: 'released' });
    const run = makeRun({ pid: 999_999 });
    const result = reconcileDeadPidRunningAgentRunAtRead(run.id, ws.dir);
    assert.equal(result.action, 'inferred_completed');
  });

  it('no_op when the process is alive', () => {
    const run = makeRun({ pid: process.pid });
    const result = reconcileDeadPidRunningAgentRunAtRead(run.id, ws.dir);
    assert.equal(result.action, 'no_op');
  });

  it('no_op when the run is not running', () => {
    const run = makeRun({ pid: 999_999, status: 'completed' });
    const result = reconcileDeadPidRunningAgentRunAtRead(run.id, ws.dir);
    assert.equal(result.action, 'no_op');
  });

  it('sweep never cancels — defers dead-pid runs lacking evidence', () => {
    const run = makeRun({ pid: 999_999 });
    const results = sweepDeadPidRunningAgentRunsAtRead(ws.dir, {
      nowMs: new Date(run.created_at).getTime() + 10 * 60_000,
    });
    const r = results.find((x) => x.run_id === run.id);
    assert.ok(r, 'run should be swept');
    assert.notEqual(r!.action, 'cancelled_dead_pid');
    assert.equal(loadAgentRun(run.id, ws.dir)!.status, 'running');
  });
});
