/**
 * pln#534 — worktree-as-contract: integrate a worker's lane on its behalf.
 *
 * Exercises the real git surface: a LINKED worktree with an uncommitted diff +
 * LANE-RESULT.json, dispatched to a sandboxed worker (codex, dispatchCanCommit
 * =false). brainclaw must commit the diff on the branch, complete the
 * assignment, and release the claim with plan cascade — without ever touching
 * the main repo.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { integrateLaneResults, getLaneResultPath } from '../../src/commands/harvest.js';
import { commitWorktreeOnBehalf, isLinkedWorktree } from '../../src/core/worktree.js';
import { openLoop, advance, turn, getLoop } from '../../src/core/loops/index.js';
import { saveAssignment, loadAssignment } from '../../src/core/assignments.js';
import { saveClaim, loadClaim } from '../../src/core/claims.js';
import { persistState, loadState } from '../../src/core/state.js';
import type { Assignment, Claim, PlanItem } from '../../src/core/schema.js';
import { nowISO } from '../../src/core/ids.js';

function git(cwd: string, ...args: string[]): { ok: boolean; stdout: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  return { ok: r.status === 0, stdout: (r.stdout ?? '').trim() };
}

/** git-init the workspace store + one commit so worktrees can branch from it. */
function gitInit(dir: string): void {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'lane-integrate@brainclaw.local');
  git(dir, 'config', 'user.name', 'Lane Integrate Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'bootstrap');
}

function makePlan(id: string, text: string): PlanItem {
  return {
    id, text, created_at: nowISO(), updated_at: nowISO(),
    author: 'test', status: 'in_progress', priority: 'medium', tags: [], depends_on: [],
  };
}

function seedClaim(ws: TestWorkspace, id: string, overrides: Partial<Claim>): Claim {
  const claim: Claim = {
    schema_version: 2, id, agent: 'codex', agent_id: 'agt_codex',
    scope: 'lane-scope', description: 'lane work', created_at: nowISO(), status: 'active',
    ...overrides,
  };
  saveClaim(claim, ws.dir);
  return claim;
}

function seedAssignment(ws: TestWorkspace, id: string, overrides: Partial<Assignment>): Assignment {
  const a: Assignment = {
    schema_version: 2, id, short_label: id,
    claim_id: 'clm_x', agent: 'codex', dispatcher_agent: 'coordinator',
    scope: 'lane-scope', description: 'lane work', status: 'offered',
    created_at: nowISO(), updated_at: nowISO(), offered_at: nowISO(), last_heartbeat_at: nowISO(),
    artifacts: [], retry_count: 0, max_retries: 2,
    heartbeat_ttl_ms: 30 * 60_000, acceptance_ttl_ms: 15 * 60_000, tags: [],
    ...overrides,
  };
  saveAssignment(a, ws.dir);
  return a;
}

/** Create a real linked worktree off the workspace repo and return its path. */
function addLinkedWorktree(repoDir: string, branch: string): string {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-lane-wt-'));
  fs.rmSync(wt, { recursive: true, force: true }); // git worktree add needs a non-existent path
  const r = git(repoDir, 'worktree', 'add', '-b', branch, wt, 'HEAD');
  assert.ok(r.ok, `git worktree add should succeed`);
  return wt;
}

describe('isLinkedWorktree + commitWorktreeOnBehalf — guards', () => {
  let ws: TestWorkspace;
  const created: string[] = [];
  beforeEach(() => { ws = createTestWorkspace({ prefix: 'bclaw-lane-' }); gitInit(ws.dir); });
  afterEach(() => {
    for (const wt of created.splice(0)) { try { git(ws.dir, 'worktree', 'remove', '--force', wt); } catch { /* */ } fs.rmSync(wt, { recursive: true, force: true }); }
    ws.cleanup();
  });

  it('isLinkedWorktree: true for a linked worktree, false for the main repo', () => {
    const wt = addLinkedWorktree(ws.dir, 'feat/guard'); created.push(wt);
    assert.equal(isLinkedWorktree(wt), true);
    assert.equal(isLinkedWorktree(ws.dir), false, 'main repo must NOT look like a linked worktree');
  });

  it('commitWorktreeOnBehalf REFUSES to commit in the main repo (main-repo guard)', () => {
    fs.writeFileSync(path.join(ws.dir, 'dirty.txt'), 'should never be committed by on-behalf');
    const r = commitWorktreeOnBehalf(ws.dir, 'nope');
    assert.equal(r.committed, false);
    assert.match(r.reason, /main-repo guard|not a linked/);
  });

  it('commitWorktreeOnBehalf: clean worktree → nothing to commit', () => {
    const wt = addLinkedWorktree(ws.dir, 'feat/clean'); created.push(wt);
    const r = commitWorktreeOnBehalf(wt, 'noop');
    assert.equal(r.committed, false);
    assert.match(r.reason, /clean/);
  });

  it('commitWorktreeOnBehalf: commits a dirty diff onto the linked worktree branch', () => {
    const wt = addLinkedWorktree(ws.dir, 'feat/dirty'); created.push(wt);
    fs.writeFileSync(path.join(wt, 'new-file.ts'), 'export const x = 1;\n');
    const before = git(wt, 'rev-parse', 'HEAD').stdout;
    const r = commitWorktreeOnBehalf(wt, 'feat: on-behalf');
    assert.equal(r.committed, true);
    assert.ok(r.sha);
    assert.ok(r.files_changed.includes('new-file.ts'));
    assert.notEqual(git(wt, 'rev-parse', 'HEAD').stdout, before, 'HEAD moved');
  });

  it('commitWorktreeOnBehalf: excludes node_modules + .brainclaw-worktree.json from the commit (trp_01a2ba2a)', () => {
    const wt = addLinkedWorktree(ws.dir, 'feat/exclusions'); created.push(wt);
    // The real deliverable…
    fs.writeFileSync(path.join(wt, 'deliverable.ts'), 'export const ok = 1;\n');
    // …alongside brainclaw-provisioned / transient artefacts that a field report
    // (Codex on macOS) caught landing in a lane commit.
    fs.writeFileSync(path.join(wt, '.brainclaw-worktree.json'), '{"marker":true}\n');
    fs.mkdirSync(path.join(wt, 'node_modules', 'left-pad'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
    fs.mkdirSync(path.join(wt, 'packages', 'api', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'packages', 'api', 'node_modules', 'dep.js'), 'x\n');
    // A real file inside a package (NOT node_modules) must still be committed.
    fs.writeFileSync(path.join(wt, 'packages', 'api', 'src.ts'), 'export const y = 2;\n');
    // Similarly-named deliverables that must NOT be caught by the exclusion
    // (component-bounded pathspecs — Codex review of #88 MINOR).
    fs.writeFileSync(path.join(wt, 'node_modules_helper.ts'), 'export const helper = 1;\n');
    fs.mkdirSync(path.join(wt, 'docs', 'node_modules_guide'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'docs', 'node_modules_guide', 'readme.md'), '# guide\n');

    const r = commitWorktreeOnBehalf(wt, 'feat: with exclusions');
    assert.equal(r.committed, true, 'the real deliverable is committable');
    assert.ok(r.files_changed.includes('deliverable.ts'));
    assert.ok(r.files_changed.some((f) => f.replace(/\\/g, '/') === 'packages/api/src.ts'), 'real package source is committed');
    for (const excluded of r.files_changed) {
      const norm = excluded.replace(/\\/g, '/');
      // A path whose COMPONENT is node_modules is excluded; a similarly-named
      // file/dir (node_modules_helper.ts, node_modules_guide/) is NOT.
      assert.ok(!/(^|\/)node_modules(\/|$)/.test(norm), `node_modules component must be excluded, got ${norm}`);
      assert.notEqual(norm, '.brainclaw-worktree.json', '.brainclaw-worktree.json must be excluded');
    }
    // And prove it against the actual commit, not just the reported list.
    const committed = git(wt, 'log', '-1', '--name-only', '--format=').stdout.replace(/\\/g, '/');
    assert.doesNotMatch(committed, /(^|\/)node_modules(\/|$)/m, 'no node_modules-component path in the commit');
    assert.doesNotMatch(committed, /\.brainclaw-worktree\.json/, 'no worktree marker in the commit');
    assert.match(committed, /deliverable\.ts/);
    assert.match(committed, /node_modules_helper\.ts/, 'similarly-named deliverable is NOT excluded');
    assert.match(committed, /node_modules_guide\/readme\.md/, 'similarly-named dir is NOT excluded');
    // The excluded files remain in the worktree (untracked), not lost.
    assert.ok(fs.existsSync(path.join(wt, '.brainclaw-worktree.json')));
    assert.ok(fs.existsSync(path.join(wt, 'node_modules', 'left-pad', 'index.js')));
  });

  it('KEEPS a change to a VENDORED/tracked node_modules file — does not drop the deliverable (#88 BLOCKING)', () => {
    const wt = addLinkedWorktree(ws.dir, 'feat/vendored-nm'); created.push(wt);
    // Vendor node_modules: commit it as tracked at the worktree HEAD (a project
    // that intentionally commits its dependencies).
    fs.mkdirSync(path.join(wt, 'node_modules', 'vendored'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'node_modules', 'vendored', 'dep.js'), 'export const v = 1;\n');
    assert.ok(git(wt, 'add', 'node_modules/vendored/dep.js').ok);
    assert.ok(git(wt, 'commit', '-q', '-m', 'vendor: track node_modules').ok);

    // Worker patches the vendored file (a REAL deliverable) + a normal file.
    fs.writeFileSync(path.join(wt, 'node_modules', 'vendored', 'dep.js'), 'export const v = 2; // patched\n');
    fs.writeFileSync(path.join(wt, 'app.ts'), 'export const app = 1;\n');

    const r = commitWorktreeOnBehalf(wt, 'feat: patch vendored dep');
    assert.equal(r.committed, true);
    const committed = git(wt, 'log', '-1', '--name-only', '--format=').stdout.replace(/\\/g, '/');
    assert.match(committed, /app\.ts/);
    assert.match(committed, /node_modules\/vendored\/dep\.js/, 'a TRACKED node_modules change must be KEPT, not silently dropped');
  });
});

describe('integrateLaneResults — worktree-as-contract (pln#534)', () => {
  let ws: TestWorkspace;
  const created: string[] = [];
  beforeEach(() => { ws = createTestWorkspace({ prefix: 'bclaw-lane-int-' }); gitInit(ws.dir); });
  afterEach(() => {
    for (const wt of created.splice(0)) { try { git(ws.dir, 'worktree', 'remove', '--force', wt); } catch { /* */ } fs.rmSync(wt, { recursive: true, force: true }); }
    ws.cleanup();
  });

  it('sandboxed worker (codex): commits on behalf, completes assignment, releases claim, cascades plan', () => {
    const wt = addLinkedWorktree(ws.dir, 'feat/lane-codex'); created.push(wt);
    persistState({
      version: 1, write_version: 1, active_constraints: [], recent_decisions: [],
      known_traps: [], open_handoffs: [], plan_items: [makePlan('pln_lane', 'Lane work')],
    }, ws.dir);
    seedClaim(ws, 'clm_lane', { plan_id: 'pln_lane', worktree_path: wt });
    seedAssignment(ws, 'asgn_lane', { claim_id: 'clm_lane', agent: 'codex', worktree_path: wt });

    // Worker leaves an uncommitted diff + its LANE-RESULT.json (no self-commit).
    fs.writeFileSync(path.join(wt, 'feature.ts'), 'export const feature = true;\n');
    fs.writeFileSync(getLaneResultPath(wt), JSON.stringify({
      assignment_id: 'asgn_lane', status: 'completed',
      summary: 'Implemented the feature in the worktree.', files_changed: ['feature.ts'],
    }));

    const res = integrateLaneResults({ worktreePaths: [wt], cwd: ws.dir });
    assert.equal(res.integrated.length, 1);
    const e = res.integrated[0]!;
    assert.equal(e.worker_can_commit, false, 'codex is sandboxed');
    assert.equal(e.committed_on_behalf, true);
    assert.ok(e.commit_sha);
    assert.equal(e.assignment_completed, true);
    assert.equal(e.claim_released, true);

    // Durable state converged.
    assert.equal(loadAssignment('asgn_lane', ws.dir)?.status, 'completed');
    assert.equal(loadClaim('clm_lane', ws.dir).status, 'released');
    const plan = loadState(ws.dir).plan_items.find((p) => p.id === 'pln_lane');
    assert.equal(plan?.status, 'done', 'last-claim release cascades the plan to done');

    // The deliverable diff is on the lane branch now…
    const committed = git(wt, 'log', '-1', '--name-only', '--format=').stdout;
    assert.match(committed, /feature\.ts/);
    // …but the worker's transient LANE-RESULT.json must NOT be committed (it would
    // otherwise pollute the branch and master on merge).
    assert.doesNotMatch(committed, /LANE-RESULT\.json/, 'LANE-RESULT.json must be excluded from the on-behalf commit');
    // The only thing left dirty is that excluded report file (still untracked).
    assert.equal(git(wt, 'status', '--porcelain').stdout.trim(), '?? LANE-RESULT.json', 'only the transient report remains uncommitted');
  });

  it('worker that CAN self-commit (claude-code): lifecycles but does NOT author a commit', () => {
    const wt = addLinkedWorktree(ws.dir, 'feat/lane-claude'); created.push(wt);
    persistState({
      version: 1, write_version: 1, active_constraints: [], recent_decisions: [],
      known_traps: [], open_handoffs: [], plan_items: [makePlan('pln_cc', 'CC work')],
    }, ws.dir);
    seedClaim(ws, 'clm_cc', { plan_id: 'pln_cc', agent: 'claude-code', worktree_path: wt });
    seedAssignment(ws, 'asgn_cc', { claim_id: 'clm_cc', agent: 'claude-code', worktree_path: wt });
    fs.writeFileSync(path.join(wt, 'uncommitted.ts'), 'export const y = 2;\n');
    fs.writeFileSync(getLaneResultPath(wt), JSON.stringify({
      assignment_id: 'asgn_cc', status: 'completed', summary: 'done',
    }));

    const res = integrateLaneResults({ worktreePaths: [wt], cwd: ws.dir });
    const e = res.integrated[0]!;
    assert.equal(e.worker_can_commit, true);
    assert.equal(e.committed_on_behalf, false, 'brainclaw must not author commits for a self-committing agent');
    assert.equal(e.assignment_completed, true);
    assert.equal(e.claim_released, true);
    // The worktree diff is left for the worker's own handoff — still dirty.
    assert.notEqual(git(wt, 'status', '--porcelain').stdout, '');
  });

  it('sandboxed worker with ONLY a LANE-RESULT.json (no deliverable diff): nothing committed, but still lifecycled', () => {
    const wt = addLinkedWorktree(ws.dir, 'feat/lane-empty'); created.push(wt);
    persistState({
      version: 1, write_version: 1, active_constraints: [], recent_decisions: [],
      known_traps: [], open_handoffs: [], plan_items: [makePlan('pln_empty', 'Empty work')],
    }, ws.dir);
    seedClaim(ws, 'clm_empty', { plan_id: 'pln_empty', worktree_path: wt });
    seedAssignment(ws, 'asgn_empty', { claim_id: 'clm_empty', agent: 'codex', worktree_path: wt });
    // Only the transient report — no actual code change.
    fs.writeFileSync(getLaneResultPath(wt), JSON.stringify({
      assignment_id: 'asgn_empty', status: 'completed', summary: 'reported only',
    }));

    const res = integrateLaneResults({ worktreePaths: [wt], cwd: ws.dir });
    const e = res.integrated[0]!;
    assert.equal(e.committed_on_behalf, false, 'a lone LANE-RESULT.json is not a committable change');
    assert.match(e.reason, /only transient/);
    assert.equal(e.assignment_completed, true, 'lifecycle still converges');
    assert.equal(e.claim_released, true);
    // No commit was authored on the lane branch.
    assert.equal(git(wt, 'log', '--oneline').stdout.split(/\r?\n/).filter(Boolean).length, 1, 'only the bootstrap commit exists');
  });

  it('review-loop lane with review_verdict=approve → integrate auto-closes the loop (pln#628 Focus 4B)', () => {
    const wt = addLinkedWorktree(ws.dir, 'feat/lane-review'); created.push(wt);
    // Open a review loop, advance to findings, assign the reviewer — the state a
    // reviewer turn runs in — then tie an assignment to it via the review scope.
    const loop = openLoop({
      kind: 'review', title: 'integrate review', created_by: 'agt_test',
      slots: [
        { role: 'author', agent: 'claude-code', agent_id: 'agt_author' },
        { role: 'reviewer', agent: 'codex', agent_id: 'agt_reviewer' },
      ],
    }, ws.dir);
    advance({ id: loop.id, actor: 'agt_test' }, ws.dir); // change_summary → findings
    const reviewer = getLoop(loop.id, ws.dir)!.slots.find((s) => s.role === 'reviewer')!;
    turn({ id: loop.id, slot_id: reviewer.slot_id, actor: 'agt_test' }, ws.dir);

    const scope = `review-loop:${loop.id}`;
    seedClaim(ws, 'clm_rev', { scope, worktree_path: wt });
    seedAssignment(ws, 'asgn_rev', { claim_id: 'clm_rev', agent: 'codex', scope, worktree_path: wt });
    // Reviewer reports via LANE-RESULT.json carrying the machine-readable verdict.
    fs.writeFileSync(getLaneResultPath(wt), JSON.stringify({
      assignment_id: 'asgn_rev', status: 'completed', summary: 'reviewed the diff',
      review_verdict: 'approve', review_summary: 'LGTM',
    }));

    const res = integrateLaneResults({ worktreePaths: [wt], cwd: ws.dir });
    const e = res.integrated[0]!;
    assert.equal(e.assignment_completed, true, 'assignment lifecycled');
    assert.ok(e.review_loop, 'integrate records the review-loop close on the entry');
    assert.equal(e.review_loop!.action, 'closed');
    assert.equal(
      getLoop(loop.id, ws.dir)!.status, 'completed',
      'the review loop auto-closed on approve straight from harvest — no human drove complete_turn/advance',
    );
  });

  it('dry-run: reports the plan but writes no commit, no lifecycle', () => {
    const wt = addLinkedWorktree(ws.dir, 'feat/lane-dry'); created.push(wt);
    persistState({
      version: 1, write_version: 1, active_constraints: [], recent_decisions: [],
      known_traps: [], open_handoffs: [], plan_items: [makePlan('pln_dry', 'Dry work')],
    }, ws.dir);
    seedClaim(ws, 'clm_dry', { plan_id: 'pln_dry', worktree_path: wt });
    seedAssignment(ws, 'asgn_dry', { claim_id: 'clm_dry', agent: 'codex', worktree_path: wt });
    fs.writeFileSync(path.join(wt, 'wip.ts'), 'export const z = 3;\n');
    fs.writeFileSync(getLaneResultPath(wt), JSON.stringify({
      assignment_id: 'asgn_dry', status: 'completed', summary: 'wip',
    }));

    const res = integrateLaneResults({ worktreePaths: [wt], cwd: ws.dir, dryRun: true });
    assert.equal(res.integrated[0]!.committed_on_behalf, false);
    assert.equal(loadAssignment('asgn_dry', ws.dir)?.status, 'offered', 'no lifecycle in dry-run');
    assert.equal(loadClaim('clm_dry', ws.dir).status, 'active', 'claim untouched in dry-run');
    assert.notEqual(git(wt, 'status', '--porcelain').stdout, '', 'no commit in dry-run');
  });

  it('missing assignment record → skipped + error, no crash', () => {
    const wt = addLinkedWorktree(ws.dir, 'feat/lane-orphan'); created.push(wt);
    fs.writeFileSync(getLaneResultPath(wt), JSON.stringify({
      assignment_id: 'asgn_ghost', status: 'completed', summary: 'orphan',
    }));
    const res = integrateLaneResults({ worktreePaths: [wt], cwd: ws.dir });
    assert.equal(res.integrated.length, 0);
    assert.ok(res.skipped.includes('asgn_ghost'));
    assert.ok(res.errors.some((e) => e.includes('asgn_ghost')));
  });
});
