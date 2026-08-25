import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createAgentRun, loadAgentRun, transitionAgentRun } from '../../src/core/agentruns.js';
import { createAssignment, loadAssignment, transitionAssignment } from '../../src/core/assignments.js';
import { saveClaim, loadClaim } from '../../src/core/claims.js';
import { openLoop, getLoop } from '../../src/core/loops/store.js';
import {
  reserve, commitReservation, armLaunch, consumeLaunchGrant, deriveChildIds, deriveTurnId,
} from '../../src/core/loops/attempt-reservation.js';
import { complete_turn } from '../../src/core/loops/verbs.js';
import { withLoopLock } from '../../src/core/loops/lock.js';
import { listEntities } from '../../src/core/entity-operations.js';
import { listRuntimeEvents } from '../../src/core/events.js';
import {
  reconcileAgentRun,
  reconcileAllOpenRuns,
  reconcileDeadPidRunningAgentRunAtRead,
  reconcileStrandedFailureClaimAtRead,
  sweepDeadPidRunningAgentRunsAtRead,
  isProcessAlive,
  collectEvidence,
  DEFAULT_HEALTH_CHECK_GRACE_MS,
  STRANDED_RELEASE_RETRY_WINDOW_MS,
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

  it('pln#638 6c — TRANSPORT completion is not BUSINESS completion: the claim stays active', () => {
    // The effects boundary the ideation loop demanded ("un exit 0 n'est qu'une
    // fin de processus ; sans preuve métier, ni release ni review"), audited and
    // found ALREADY TRUE in the code — but unpinned, so a future "tidy-up" could
    // wire cascadeReleaseOnFailure's twin onto the completed path and nothing
    // would fail. Inference marks the RUN completed (observability); releasing
    // the claim belongs to the worker's own release call or to harvest, both of
    // which carry business proof (report + artifacts). The failure cascade
    // (trp#433, pinned below) is deliberately asymmetric.
    makeClaim({ status: 'active' });
    const repoDir = bootstrapGitWorktree();
    const run = makeRun({ worktree_path: repoDir });
    const sleepUntil = Date.now() + 1100;
    while (Date.now() < sleepUntil) { /* spin */ }
    commitInWorktree(repoDir, 'WORK.md', 'work');
    const result = reconcileAgentRun(run.id, ws.dir, {
      nowMs: new Date(run.created_at).getTime() + 90_000,
    });
    assert.equal(result.action, 'inferred_completed');
    assert.equal(
      loadClaim('clm_test', ws.dir).status, 'active',
      'an inferred completion must NOT release the claim — that is harvest\'s job, on business proof',
    );
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
    const assignment = makeAssignment();
    transitionAssignment(assignment.id, 'offered', { actor: 'test', syncAgentRun: false }, ws.dir);
    const repoDir = bootstrapGitWorktree();
    const run = makeRun({ pid: 999_999, worktree_path: repoDir });
    const sleepUntil = Date.now() + 1100; // git commit-time granularity is 1 s
    while (Date.now() < sleepUntil) { /* spin */ }
    commitInWorktree(repoDir, 'NEW.md', 'work');
    const result = reconcileDeadPidRunningAgentRunAtRead(run.id, ws.dir);
    assert.equal(result.action, 'inferred_completed');
    assert.equal(loadAgentRun(run.id, ws.dir)!.status, 'completed');
    assert.equal(loadAssignment(assignment.id, ws.dir)!.status, 'completed');
    assert.equal(reconcileDeadPidRunningAgentRunAtRead(run.id, ws.dir).action, 'no_op', 'replay is idempotent');
  });

  it('infers completion when a dead pid coincides with a released claim', () => {
    const assignment = makeAssignment();
    transitionAssignment(assignment.id, 'offered', { actor: 'test', syncAgentRun: false }, ws.dir);
    makeClaim({ status: 'released' });
    const run = makeRun({ pid: 999_999 });
    const result = reconcileDeadPidRunningAgentRunAtRead(run.id, ws.dir);
    assert.equal(result.action, 'inferred_completed');
    assert.equal(loadAssignment(assignment.id, ws.dir)!.status, 'offered', 'claim release alone is not success proof');
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

  it('infers FAILED when a dead pid persists past the stale window with no evidence (convergence)', () => {
    // pln#520 review (codex): the read path routes `running` runs through THIS
    // function, not reconcileAgentRun — so a genuine silent death MUST still
    // converge to `failed` here, just not prematurely.
    const assignment = makeAssignment();
    transitionAssignment(assignment.id, 'offered', { actor: 'test', syncAgentRun: false }, ws.dir);
    const run = makeRun({ pid: 999_999 });
    const result = reconcileDeadPidRunningAgentRunAtRead(run.id, ws.dir, {
      nowMs: new Date(run.created_at).getTime() + 31 * 60_000, // past 30-min stale
    });
    assert.equal(result.action, 'inferred_failed');
    const reloaded = loadAgentRun(run.id, ws.dir)!;
    assert.equal(reloaded.status, 'failed');
    assert.match(reloaded.status_reason ?? '', /silent_termination/);
    assert.equal(loadAssignment(assignment.id, ws.dir)!.status, 'failed');
  });

  it('does NOT fail or release claim when no-heartbeat dead-pid run has fresh fs activity', () => {
    makeClaim({ status: 'active' });
    const wt = fs.mkdtempSync(path.join(ws.dir, 'reconciler-active-wt-'));
    const run = makeRun({ pid: 999_999, worktree_path: wt });
    const nowMs = new Date(run.created_at).getTime() + 31 * 60_000;
    const activeFile = path.join(wt, 'active.ts');
    fs.writeFileSync(activeFile, 'still working');
    fs.utimesSync(activeFile, new Date(nowMs - 60_000), new Date(nowMs - 60_000));

    const result = reconcileDeadPidRunningAgentRunAtRead(run.id, ws.dir, { nowMs });

    assert.equal(result.action, 'no_op');
    assert.match(result.reason, /fs active/);
    assert.equal(loadAgentRun(run.id, ws.dir)!.status, 'running');
    assert.equal(loadClaim('clm_test', ws.dir).status, 'active');
  });

  it('does NOT fail a dead-pid run still inside the stale window (young)', () => {
    const run = makeRun({ pid: 999_999 });
    const result = reconcileDeadPidRunningAgentRunAtRead(run.id, ws.dir, {
      nowMs: new Date(run.created_at).getTime() + 5 * 60_000, // 5 min < 30 min stale
    });
    assert.equal(result.action, 'health_check_unverified');
    assert.equal(loadAgentRun(run.id, ws.dir)!.status, 'running');
  });

  it('trp#433 — auto-releases the linked claim when the run is reconciled to failed', () => {
    makeClaim({ status: 'active' });
    const run = makeRun({ pid: 999_999 });
    const result = reconcileDeadPidRunningAgentRunAtRead(run.id, ws.dir, {
      nowMs: new Date(run.created_at).getTime() + 31 * 60_000, // past stale → inferred failed
    });
    assert.equal(result.action, 'inferred_failed');
    assert.equal(loadClaim('clm_test', ws.dir).status, 'released', 'linked claim GC-released on failure');
  });

  it('trp#433 — leaves the claim active while the run has not failed (young dead pid)', () => {
    makeClaim({ status: 'active' });
    const run = makeRun({ pid: 999_999 });
    reconcileDeadPidRunningAgentRunAtRead(run.id, ws.dir, {
      nowMs: new Date(run.created_at).getTime() + 5 * 60_000, // inside stale window
    });
    assert.equal(loadClaim('clm_test', ws.dir).status, 'active', 'claim untouched while run still running');
  });

  // ── pln#641 (dec#151 option b) — turn-owned failure = loop business decision ──

  function makeTurnOwnedLane(): { loopId: string; turnId: string; runId: string; assignmentId: string } {
    const loop = openLoop({
      kind: 'review', title: 'turn-owned failure', created_by: 'coord', mode: 'symmetric',
      phases: [{ name: 'findings' }],
      stop_condition: { kind: 'reviewer_green' },
      slots: [{ slot_id: 'lsl_r', role: 'reviewer', agent: 'codex', status: 'assigned' }],
    }, ws.dir);
    const turnId = deriveTurnId(loop.id, 'lsl_r', 0);
    const { assignment_id, run_id } = deriveChildIds(turnId);
    reserve({
      turn_id: turnId, loop_id: loop.id, slot_id: 'lsl_r', target_slot_generation: 0,
      loop_version_at_reserve: loop.version, agent: 'codex', claim_id: 'clm_turn',
      phase: 'findings', iteration: 0, store_root: ws.dir, cwd: ws.dir,
      lease_deadline: new Date(Date.now() + 600_000).toISOString(),
    }, ws.dir);
    commitReservation(turnId, ws.dir);
    armLaunch(turnId, { token: 'gen-1', epoch: 1, lease_deadline: new Date(Date.now() + 600_000).toISOString() }, ws.dir);
    consumeLaunchGrant(turnId, 'gen-1', 1, ws.dir);
    makeClaim({ id: 'clm_turn' });
    makeAssignment({ id: assignment_id, claim_id: 'clm_turn' });
    createAgentRun({
      id: run_id, short_label: run_id, assignment_id, claim_id: 'clm_turn', agent: 'codex',
      transport: 'cli_spawn', scope: 'review-loop', description: 'turn-owned lane',
      status: 'running', pid: 999_999,
    }, ws.dir);
    return { loopId: loop.id, turnId, runId: run_id, assignmentId: assignment_id };
  }

  it('pln#641 — a TURN-OWNED transport failure releases the claim through the LOOP, never the GC cascade', () => {
    // dec#151 option (b): the lane's claim is business state owned by its loop.
    // The transport reconciler still infers the run failed (a transport fact),
    // but the claim release must arrive as a loop-recorded business decision —
    // slot marked failed via complete_turn, audited as such — in the SAME lazy
    // pass, so retry lanes are never starved.
    const { loopId, runId, assignmentId } = makeTurnOwnedLane();
    const run = loadAgentRun(runId, ws.dir)!;

    const result = reconcileAgentRun(runId, ws.dir, {
      nowMs: new Date(run.created_at).getTime() + 35 * 60_000, // past stale, dead pid, no evidence
    });
    assert.equal(result.action, 'inferred_failed');
    assert.equal(loadClaim('clm_turn', ws.dir).status, 'released', 'non-famine: released in the same lazy pass');
    assert.equal(loadAssignment(assignmentId, ws.dir)!.status, 'failed',
      'a lagging created assignment is advanced through legal FSM edges before failure');
    // The release is the LOOP's business decision, recorded and audited as such.
    const reloaded = getLoop(loopId, ws.dir)!;
    assert.equal(reloaded.slots.find((s) => s.slot_id === 'lsl_r')!.status, 'failed',
      'the loop journal carries the failure record');
    const events = listRuntimeEvents(ws.dir);
    assert.equal(events.filter((e) => e.status_reason === 'turn_failure_business_release').length, 1,
      'audited as a business release');
    assert.equal(events.filter((e) => e.status_reason === 'gc_cascade_release_on_failure').length, 0,
      'the transport GC cascade must NOT fire for a turn-owned lane (pln#638 6c)');
  });

  // ── pln#641 review P1 — the stranded-failure retry must be REACHABLE ──
  // The cascade fires only on the terminal TRANSITION; a convergence that
  // declined (lock contention) or crashed mid-way leaves a terminal run whose
  // claim is still active, and no read path revisited terminal runs.

  it('pln#641 P1 — a terminal run whose convergence never ran is retried at read (decline-before-WAL)', () => {
    const { loopId, runId } = makeTurnOwnedLane();
    // Simulate "cascade declined in the transition pass": run goes terminal
    // WITHOUT any business convergence (direct transition, no reconciler).
    transitionAgentRun(runId, 'failed', { actor: 'test', status_reason: 'stalled: simulated decline' }, ws.dir);
    assert.equal(loadClaim('clm_turn', ws.dir).status, 'active', 'precondition: claim stranded');

    const retried = reconcileStrandedFailureClaimAtRead(loadAgentRun(runId, ws.dir)!, ws.dir);
    assert.equal(retried, true);
    assert.equal(loadClaim('clm_turn', ws.dir).status, 'released', 'the read-path retry converges the release');
    assert.equal(getLoop(loopId, ws.dir)!.slots.find((s) => s.slot_id === 'lsl_r')!.status, 'failed',
      'the retry still records the failure ON the loop first');
  });

  it('pln#641 P1 — crash AFTER the loop WAL record but BEFORE the release: retry releases without double-recording', () => {
    const { loopId, runId } = makeTurnOwnedLane();
    // The WAL record landed (slot failed)…
    complete_turn({ id: loopId, slot_id: 'lsl_r', actor: 'test', outcome: 'failed', failure_reason: 'pre-crash record' }, ws.dir);
    // …then the process died before releasing: run terminal, claim active.
    transitionAgentRun(runId, 'failed', { actor: 'test', status_reason: 'crashed before release' }, ws.dir);
    assert.equal(loadClaim('clm_turn', ws.dir).status, 'active', 'precondition: claim stranded post-WAL');

    const retried = reconcileStrandedFailureClaimAtRead(loadAgentRun(runId, ws.dir)!, ws.dir);
    assert.equal(retried, true);
    assert.equal(loadClaim('clm_turn', ws.dir).status, 'released');
    assert.equal(listRuntimeEvents(ws.dir).filter((e) => e.status_reason === 'turn_failure_business_release').length, 1,
      'exactly one business release event — the terminal slot is not re-recorded');
  });

  it('pln#641 P1 — a FORCED lock decline retains the claim; the next read-path pass converges it', () => {
    const { loopId, runId } = makeTurnOwnedLane();
    transitionAgentRun(runId, 'failed', { actor: 'test', status_reason: 'stalled' }, ws.dir);
    const run = loadAgentRun(runId, ws.dir)!;
    // Hold the loop lock and attempt the retry from INSIDE it: the business
    // convergence must DEFER (LockTimeoutError → declined), never force a
    // release around the lock.
    withLoopLock({
      cwd: ws.dir, intent: 'test-hold', agentId: 'test',
      scope: { kind: 'loop', loopId },
      work: () => {
        reconcileStrandedFailureClaimAtRead(run, ws.dir);
        assert.equal(loadClaim('clm_turn', ws.dir).status, 'active',
          'under contention the claim is retained — never a forced release');
      },
    });
    // Lock released → the next read-path pass converges.
    const retried = reconcileStrandedFailureClaimAtRead(run, ws.dir);
    assert.equal(retried, true);
    assert.equal(loadClaim('clm_turn', ws.dir).status, 'released', 'the promised lazy retry actually lands');
  });

  it('pln#641 P1 — the retry recency window: an OLD terminal failure is the stale sweep\'s business', () => {
    const { runId } = makeTurnOwnedLane();
    transitionAgentRun(runId, 'failed', { actor: 'test', status_reason: 'ancient failure' }, ws.dir);
    const retried = reconcileStrandedFailureClaimAtRead(loadAgentRun(runId, ws.dir)!, ws.dir, {
      nowMs: Date.now() + STRANDED_RELEASE_RETRY_WINDOW_MS + 60_000,
    });
    assert.equal(retried, false);
    assert.equal(loadClaim('clm_turn', ws.dir).status, 'active', 'outside the window the sweep owns it');
  });

  it('pln#641 P1 — the ACTUAL read surface (listEntities agent_run) converges a stranded claim', () => {
    // trp#1292 discipline: test the delivered surface, not just the helper.
    const { runId } = makeTurnOwnedLane();
    transitionAgentRun(runId, 'failed', { actor: 'test', status_reason: 'stalled: stranded' }, ws.dir);
    assert.equal(loadClaim('clm_turn', ws.dir).status, 'active');
    listEntities('agent_run', ws.dir);
    assert.equal(loadClaim('clm_turn', ws.dir).status, 'released',
      'a plain bclaw_find(agent_run) read pass converges the stranded release');
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

  it('sweep candidate window is independent from the fail window', () => {
    const run = makeRun({ pid: 999_999 });
    const results = sweepDeadPidRunningAgentRunsAtRead(ws.dir, {
      nowMs: new Date(run.created_at).getTime() + 10 * 60_000,
      deadPidSweepCandidateAgeMs: 5 * 60_000,
      staleAfterMs: 30 * 60_000,
    });
    const r = results.find((x) => x.run_id === run.id);
    assert.ok(r, 'run should be selected by candidate window');
    assert.equal(r!.action, 'health_check_unverified');
    assert.equal(loadAgentRun(run.id, ws.dir)!.status, 'running');
  });
});
