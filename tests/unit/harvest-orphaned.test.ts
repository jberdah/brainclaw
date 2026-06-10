/**
 * pln#554 step 3 — `harvest --orphaned`: recover a dead worker that left NO
 * LANE-RESULT. Exercises the real git surface: a linked worktree with
 * uncommitted tracked changes, an assignment + claim to converge, and the
 * non-destructive guarantees (never delete/reset; clean worktree untouched).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { harvestOrphaned, ORPHANED_COMMIT_MARKER, getLaneResultPath } from '../../src/commands/harvest.js';
import { saveAssignment, loadAssignment } from '../../src/core/assignments.js';
import { saveClaim, loadClaim } from '../../src/core/claims.js';
import type { Assignment, Claim } from '../../src/core/schema.js';
import { nowISO } from '../../src/core/ids.js';

function git(cwd: string, ...args: string[]): { ok: boolean; stdout: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  return { ok: r.status === 0, stdout: (r.stdout ?? '').trim() };
}

function gitInit(dir: string): string {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'orphaned@brainclaw.local');
  git(dir, 'config', 'user.name', 'Orphaned Harvest Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'original\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'bootstrap');
  return git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').stdout; // base ref name
}

function addLinkedWorktree(repoDir: string, branch: string): string {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-orph-wt-'));
  fs.rmSync(wt, { recursive: true, force: true }); // git worktree add needs a non-existent path
  const r = git(repoDir, 'worktree', 'add', '-b', branch, wt, 'HEAD');
  assert.ok(r.ok, 'git worktree add should succeed');
  return wt;
}

function seedClaim(ws: TestWorkspace, id: string, overrides: Partial<Claim> = {}): Claim {
  const claim: Claim = {
    schema_version: 2, id, agent: 'codex', agent_id: 'agt_codex',
    scope: 'orph-scope', description: 'orphaned lane', created_at: nowISO(), status: 'active',
    ...overrides,
  };
  saveClaim(claim, ws.dir);
  return claim;
}

function seedAssignment(ws: TestWorkspace, id: string, overrides: Partial<Assignment> = {}): Assignment {
  const a: Assignment = {
    schema_version: 2, id, short_label: id,
    claim_id: 'clm_x', agent: 'codex', dispatcher_agent: 'coordinator',
    scope: 'orph-scope', description: 'orphaned lane', status: 'started',
    created_at: nowISO(), updated_at: nowISO(), offered_at: nowISO(), last_heartbeat_at: nowISO(),
    artifacts: [], retry_count: 0, max_retries: 2,
    heartbeat_ttl_ms: 30 * 60_000, acceptance_ttl_ms: 15 * 60_000, tags: [],
    ...overrides,
  };
  saveAssignment(a, ws.dir);
  return a;
}

describe('harvestOrphaned — dead worker without LANE-RESULT (pln#554)', () => {
  let ws: TestWorkspace;
  let baseRef: string;
  const worktrees: string[] = [];

  beforeEach(() => {
    process.env.BRAINCLAW_TEST_MODE = '1';
    ws = createTestWorkspace({ prefix: 'bclaw-orph-' });
    baseRef = gitInit(ws.dir);
  });

  afterEach(() => {
    for (const wt of worktrees.splice(0)) {
      git(ws.dir, 'worktree', 'remove', '--force', wt);
      fs.rmSync(wt, { recursive: true, force: true });
    }
    ws.cleanup();
    delete process.env.BRAINCLAW_TEST_MODE;
  });

  it('recovers uncommitted tracked changes: commit on behalf with the marker, lifecycle, release', () => {
    const wt = addLinkedWorktree(ws.dir, 'lane-orph-1');
    worktrees.push(wt);
    fs.writeFileSync(path.join(wt, 'tracked.txt'), 'worker output before dying\n');
    fs.writeFileSync(path.join(wt, 'new-module.ts'), 'export const recovered = true;\n');
    seedClaim(ws, 'clm_orph1', { worktree_path: wt });
    seedAssignment(ws, 'asgn_orph1', { claim_id: 'clm_orph1', status: 'started' });

    const report = harvestOrphaned({ assignmentId: 'asgn_orph1', baseRef, cwd: ws.dir });

    assert.equal(report.errors.length, 0, `no errors expected: ${report.errors.join('; ')}`);
    assert.equal(report.committed_on_behalf, true);
    assert.ok(report.commit_sha);
    assert.ok(report.files_changed.includes('tracked.txt'));
    assert.ok(report.files_changed.includes('new-module.ts'));
    // no node_modules in the fixture worktree → graceful skip with junction hint
    assert.equal(report.typecheck, 'skipped_no_node_modules');
    assert.match(report.typecheck_output ?? '', /junction/i);

    const log = git(wt, 'log', '-1', '--format=%B').stdout;
    assert.ok(log.includes(ORPHANED_COMMIT_MARKER), 'commit must carry the standard on-behalf marker');

    assert.equal(report.assignment_completed, true);
    assert.equal(loadAssignment('asgn_orph1', ws.dir)?.status, 'completed');
    assert.equal(report.claim_released, true);
    assert.equal(loadClaim('clm_orph1', ws.dir).status, 'released');
    assert.match(report.recommended_next_action, /targeted tests/i);
    assert.match(report.recommended_next_action, /merge/i);
  });

  it('reports "nothing to recover" and leaves all state untouched for a clean worktree', () => {
    const wt = addLinkedWorktree(ws.dir, 'lane-orph-2');
    worktrees.push(wt);
    seedClaim(ws, 'clm_orph2', { worktree_path: wt });
    seedAssignment(ws, 'asgn_orph2', { claim_id: 'clm_orph2', status: 'started' });

    const report = harvestOrphaned({ assignmentId: 'asgn_orph2', baseRef, cwd: ws.dir });

    assert.equal(report.nothing_to_recover, true);
    assert.equal(report.committed_on_behalf, false);
    assert.match(report.recommended_next_action, /nothing to recover/i);
    // state untouched
    assert.equal(loadAssignment('asgn_orph2', ws.dir)?.status, 'started');
    assert.equal(loadClaim('clm_orph2', ws.dir).status, 'active');
  });

  it('refuses when LANE-RESULT.json exists — that lane is not orphaned', () => {
    const wt = addLinkedWorktree(ws.dir, 'lane-orph-3');
    worktrees.push(wt);
    fs.writeFileSync(path.join(wt, 'tracked.txt'), 'changed\n');
    fs.writeFileSync(getLaneResultPath(wt), JSON.stringify({
      assignment_id: 'asgn_orph3', status: 'completed', summary: 'done',
    }));
    seedClaim(ws, 'clm_orph3', { worktree_path: wt });
    seedAssignment(ws, 'asgn_orph3', { claim_id: 'clm_orph3', status: 'started' });

    const report = harvestOrphaned({ assignmentId: 'asgn_orph3', baseRef, cwd: ws.dir });

    assert.equal(report.committed_on_behalf, false);
    assert.ok(report.errors.some((e) => /not orphaned/i.test(e)));
    assert.equal(loadAssignment('asgn_orph3', ws.dir)?.status, 'started');
    // worker changes untouched
    assert.equal(fs.readFileSync(path.join(wt, 'tracked.txt'), 'utf-8'), 'changed\n');
  });

  it('worker committed then died (clean tree, commits ahead): lifecycle + release without a new commit', () => {
    const wt = addLinkedWorktree(ws.dir, 'lane-orph-4');
    worktrees.push(wt);
    fs.writeFileSync(path.join(wt, 'tracked.txt'), 'committed by the worker\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'worker delivered before dying');
    seedClaim(ws, 'clm_orph4', { worktree_path: wt });
    seedAssignment(ws, 'asgn_orph4', { claim_id: 'clm_orph4', status: 'started' });

    const report = harvestOrphaned({ assignmentId: 'asgn_orph4', baseRef, cwd: ws.dir });

    assert.equal(report.commits_ahead, 1);
    assert.equal(report.dirty_tracked, 0);
    assert.equal(report.committed_on_behalf, false, 'must not author a commit when there is nothing to commit');
    assert.equal(report.assignment_completed, true);
    assert.equal(report.claim_released, true);
    const head = git(wt, 'log', '-1', '--format=%s').stdout;
    assert.equal(head, 'worker delivered before dying', 'worker history must be untouched');
  });

  it('dry-run inspects without committing or lifecycling', () => {
    const wt = addLinkedWorktree(ws.dir, 'lane-orph-5');
    worktrees.push(wt);
    fs.writeFileSync(path.join(wt, 'tracked.txt'), 'pending recovery\n');
    seedClaim(ws, 'clm_orph5', { worktree_path: wt });
    seedAssignment(ws, 'asgn_orph5', { claim_id: 'clm_orph5', status: 'started' });

    const report = harvestOrphaned({ assignmentId: 'asgn_orph5', baseRef, dryRun: true, cwd: ws.dir });

    assert.equal(report.dirty_tracked, 1);
    assert.equal(report.committed_on_behalf, false);
    assert.match(report.recommended_next_action, /dry-run/i);
    assert.equal(loadAssignment('asgn_orph5', ws.dir)?.status, 'started');
    assert.equal(loadClaim('clm_orph5', ws.dir).status, 'active');
    const status = git(wt, 'status', '--short').stdout;
    assert.ok(status.includes('tracked.txt'), 'worktree diff must survive a dry-run');
  });

  it('errors cleanly when no worktree can be resolved', () => {
    seedClaim(ws, 'clm_orph6');
    seedAssignment(ws, 'asgn_orph6', { claim_id: 'clm_orph6', status: 'started' });

    const report = harvestOrphaned({ assignmentId: 'asgn_orph6', baseRef, cwd: ws.dir });

    assert.ok(report.errors.some((e) => /no worktree resolved/i.test(e)));
    assert.equal(report.committed_on_behalf, false);
    assert.equal(loadAssignment('asgn_orph6', ws.dir)?.status, 'started');
  });
});
