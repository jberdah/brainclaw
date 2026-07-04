/**
 * trp#926 — squash-aware "merged" detection + junction-recursive safe remove
 * + creation-ref anchored dispatch evidence.
 *
 * Coverage:
 *   1. isBranchMergedByContent flags a squash-merged lane as merged, keeps a
 *      lane with a truly unique commit un-merged.
 *   2. cleanMergedWorktrees GCs a squash-merged worktree; preserves a lane
 *      whose patch is NOT on HEAD.
 *   3. gcWorktreeIfHarvested removes a squash-merged worktree (ancestry-only
 *      would have kept it forever).
 *   4. detachWorktreeJunctions unlinks a NESTED junction (monorepo
 *      apps/<pkg>/node_modules pattern) and leaves the junction target intact.
 *   5. dispatch-status gitEvidence anchors commits_ahead on the worktree's
 *      recorded creation SHA (sidecar `base_ref_sha`), not on a moved master,
 *      and refines the count via patch-id (squash-merged commits → 0).
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  cleanMergedWorktrees,
  createWorktree,
  detachWorktreeJunctions,
  gcWorktreeIfHarvested,
  isBranchMergedByContent,
  resolveWorktreePath,
} from '../../src/core/worktree.js';
import { gitEvidence } from '../../src/core/dispatch-status.js';

const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length > 0) {
    const p = cleanup.pop() as string;
    try { spawnSync('git', ['worktree', 'remove', '--force', p], { cwd: path.dirname(p), encoding: 'utf-8' }); } catch { /* ignore */ }
    fs.rmSync(p, { recursive: true, force: true });
  }
});

function git(args: string[], cwd: string): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
}

function gitOk(args: string[], cwd: string): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/**
 * A repo on master with one initial commit + one linked worktree on `branch`.
 * The worktree adds a single commit changing `file` to `content` — that commit
 * is then either squash-merged (patch on master, SHA not) or left ahead
 * depending on the test.
 */
function makeRepoWithLaneCommit(branch: string, file = 'src/x.ts', content = 'export const x = 42;\n'): { repo: string; wt: string; laneSha: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-squash-'));
  cleanup.push(repo);
  git(['init', '-b', 'master'], repo);
  git(['config', 'user.email', 't@e.com'], repo);
  git(['config', 'user.name', 'T'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# init\n');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'init'], repo);

  const wt = path.join(repo, '..', `${path.basename(repo)}-wt-${branch.replace(/[^a-z0-9]+/gi, '_')}`);
  cleanup.push(wt);
  git(['worktree', 'add', '-b', branch, wt, 'HEAD'], repo);

  const target = path.join(wt, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  git(['add', '-A'], wt);
  git(['commit', '-m', `${branch}: add ${file}`], wt);
  const laneSha = gitOk(['rev-parse', 'HEAD'], wt);
  return { repo, wt, laneSha };
}

/** Squash-merge `branch` onto master in `repo` (main repo path). */
function squashMerge(repo: string, branch: string, file: string, content: string): void {
  // Apply the same content that lives on `branch` — this is what a GitHub
  // squash-merge produces: a NEW commit on master with the branch's patch,
  // but ancestry does NOT link to the branch's original commits.
  const target = path.join(repo, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  git(['add', '-A'], repo);
  git(['commit', '-m', `squash-merge ${branch}`], repo);
}

describe('trp#926 — isBranchMergedByContent (patch-id detection)', () => {
  it('returns true for a squash-merged lane whose SHA is NOT an ancestor of HEAD', () => {
    const { repo, wt } = makeRepoWithLaneCommit('lane/squashed');
    // Simulate GitHub squash-merge: master gets the same patch under a new SHA.
    squashMerge(repo, 'lane/squashed', 'src/x.ts', 'export const x = 42;\n');

    // Sanity: ancestry says NOT merged.
    const ancestry = spawnSync('git', ['branch', '--merged', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).stdout;
    assert.ok(!ancestry.includes('lane/squashed'), 'ancestry check must NOT flag squash-merged lanes — that is the whole bug');

    // Content check: patch is on master → merged.
    assert.equal(isBranchMergedByContent(repo, 'lane/squashed', 'HEAD'), true);
    // Silence the "unused" lint on wt via a defensive existence check.
    assert.ok(fs.existsSync(wt));
  });

  it('returns false for a lane whose commit patch is genuinely new to base', () => {
    const { repo } = makeRepoWithLaneCommit('lane/unique');
    // No squash-merge, master unchanged — the lane's patch is not on master.
    assert.equal(isBranchMergedByContent(repo, 'lane/unique', 'HEAD'), false);
  });

  it('returns true for a lane with zero commits ahead of base (trivial merged)', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-squash-'));
    cleanup.push(repo);
    git(['init', '-b', 'master'], repo);
    git(['config', 'user.email', 't@e.com'], repo);
    git(['config', 'user.name', 'T'], repo);
    git(['commit', '--allow-empty', '-m', 'init'], repo);
    git(['branch', 'lane/zero'], repo);
    assert.equal(isBranchMergedByContent(repo, 'lane/zero', 'HEAD'), true);
  });
});

describe('trp#926 — cleanMergedWorktrees is squash-aware', () => {
  it('GCs a worktree whose lane branch was squash-merged into HEAD', () => {
    const { repo, wt } = makeRepoWithLaneCommit('lane/squash-gc');
    squashMerge(repo, 'lane/squash-gc', 'src/x.ts', 'export const x = 42;\n');

    const result = cleanMergedWorktrees(repo, {});
    assert.equal(
      fs.existsSync(wt), false,
      `squash-merged worktree must be GCed; removed=${JSON.stringify(result.removed)} skipped=${JSON.stringify(result.skipped)}`,
    );
  });

  it('preserves a worktree whose lane has commits not yet on HEAD (unique patches)', () => {
    const { repo, wt } = makeRepoWithLaneCommit('lane/keep-me');
    // NO squash — master is behind the lane.
    const result = cleanMergedWorktrees(repo, {});
    assert.equal(
      fs.existsSync(wt), true,
      `un-merged worktree must be preserved; removed=${JSON.stringify(result.removed)} skipped=${JSON.stringify(result.skipped)}`,
    );
  });
});

describe('trp#926 — gcWorktreeIfHarvested is squash-aware', () => {
  it('removes a squash-merged worktree that ancestry alone would keep', () => {
    const { repo, wt } = makeRepoWithLaneCommit('lane/squash-solo');
    squashMerge(repo, 'lane/squash-solo', 'src/x.ts', 'export const x = 42;\n');

    // Ancestry check would return "not an ancestor" — pre-fix behavior kept the worktree.
    const d = gcWorktreeIfHarvested(repo, wt);
    assert.equal(d.removed, true, `expected removal, got reason=${d.reason}`);
    assert.equal(fs.existsSync(wt), false);
  });

  it('keeps a lane with genuinely un-integrated commits (no squash on base)', () => {
    const { repo, wt } = makeRepoWithLaneCommit('lane/still-open');
    const d = gcWorktreeIfHarvested(repo, wt);
    assert.equal(d.removed, false);
    assert.match(d.reason, /un-integrated/);
    assert.equal(fs.existsSync(wt), true);
  });
});

describe('trp#926 — detachWorktreeJunctions detects nested junctions', () => {
  it('unlinks a manually-created nested junction and leaves its target intact', () => {
    // Two directories: `target` (the "main repo" whose contents must survive)
    // and `worktree` (the "linked worktree" that will be walked for detach).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-nest-junc-'));
    cleanup.push(root);
    const targetDir = path.join(root, 'target-node_modules');
    fs.mkdirSync(targetDir, { recursive: true });
    const canaryFile = path.join(targetDir, 'canary.txt');
    fs.writeFileSync(canaryFile, 'MUST_SURVIVE');

    const worktree = path.join(root, 'worktree');
    fs.mkdirSync(path.join(worktree, 'apps', 'api'), { recursive: true });
    const junctionPath = path.join(worktree, 'apps', 'api', 'node_modules');
    try {
      fs.symlinkSync(targetDir, junctionPath, 'junction');
    } catch (err) {
      // Non-Windows / non-privileged environment: fall back to a plain
      // directory symlink. The recursion + lstat treats both identically.
      fs.symlinkSync(targetDir, junctionPath, 'dir');
    }
    // Sanity: the junction resolves to the target's contents.
    assert.ok(fs.existsSync(path.join(junctionPath, 'canary.txt')));

    // Under scrutiny: the recursive detach must unlink the nested junction.
    detachWorktreeJunctions(worktree);

    // Junction gone.
    assert.equal(fs.existsSync(junctionPath), false, 'nested junction must be unlinked');
    // Target contents intact — the whole point of the fix.
    assert.equal(fs.existsSync(canaryFile), true, 'junction target must NOT be walked into / wiped');
    assert.equal(fs.readFileSync(canaryFile, 'utf-8'), 'MUST_SURVIVE');
  });

  it('also unlinks a top-level junction (backward compatibility)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-top-junc-'));
    cleanup.push(root);
    const targetDir = path.join(root, 'target-deps');
    fs.mkdirSync(targetDir, { recursive: true });
    const canary = path.join(targetDir, 'keep.txt');
    fs.writeFileSync(canary, 'top-canary');

    const worktree = path.join(root, 'worktree');
    fs.mkdirSync(worktree, { recursive: true });
    const junctionPath = path.join(worktree, 'node_modules');
    try {
      fs.symlinkSync(targetDir, junctionPath, 'junction');
    } catch {
      fs.symlinkSync(targetDir, junctionPath, 'dir');
    }

    detachWorktreeJunctions(worktree);
    assert.equal(fs.existsSync(junctionPath), false);
    assert.equal(fs.existsSync(canary), true);
  });
});

describe('trp#926 — gitEvidence anchors on the worktree creation ref', () => {
  it('uses the sidecar base_ref_sha (not the moving master) to count worker commits', () => {
    // Setup: create a repo, create a worktree AT master's current tip, then
    // advance master with an unrelated commit. commits_ahead vs the creation
    // ref must stay 0 (worker did nothing); vs current master would also be 0
    // here — but the point is the SIDECAR anchor is honored, so we assert on
    // baseRef too.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-anchor-'));
    cleanup.push(repo);
    git(['init', '-b', 'master'], repo);
    git(['config', 'user.email', 't@e.com'], repo);
    git(['config', 'user.name', 'T'], repo);
    git(['commit', '--allow-empty', '-m', 'init'], repo);

    // Use createWorktree so the sidecar records base_ref_sha.
    const wt = createWorktree(repo, 'feat/anchor-test');
    cleanup.push(wt);
    const sidecar = JSON.parse(fs.readFileSync(path.join(wt, '.brainclaw-worktree.json'), 'utf-8'));
    assert.ok(sidecar.base_ref_sha, 'createWorktree must record base_ref_sha');

    // Advance master with a commit unrelated to the lane.
    fs.writeFileSync(path.join(repo, 'other.txt'), 'unrelated\n');
    git(['add', '-A'], repo);
    git(['commit', '-m', 'unrelated master advance'], repo);

    // Worker committed nothing on the lane.
    const ev = gitEvidence(wt, 'master');
    assert.ok(ev, 'gitEvidence must return a report');
    assert.equal(ev.commitsAhead, 0, 'no commits added by worker → commits_ahead=0');
    assert.equal(ev.baseRef, sidecar.base_ref_sha, 'baseRef used must be the sidecar-recorded creation SHA');
  });

  it('refines commits_ahead via patch-id: a squash-merged commit counts as 0', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-refine-'));
    cleanup.push(repo);
    git(['init', '-b', 'master'], repo);
    git(['config', 'user.email', 't@e.com'], repo);
    git(['config', 'user.name', 'T'], repo);
    git(['commit', '--allow-empty', '-m', 'init'], repo);

    const wt = createWorktree(repo, 'feat/squash-refine');
    cleanup.push(wt);

    // Worker commits on lane. Target-adds the source file only — the sidecar
    // (.brainclaw-worktree.json) is untracked by design; `git add -A` would
    // sweep it in and break patch-equivalence with the squash-merge commit.
    const laneFile = path.join(wt, 'src/y.ts');
    fs.mkdirSync(path.dirname(laneFile), { recursive: true });
    fs.writeFileSync(laneFile, 'export const y = 7;\n');
    git(['add', 'src/y.ts'], wt);
    git(['commit', '-m', 'lane change'], wt);

    // Squash-merge onto master (same file content, same commit-level tree diff).
    squashMerge(repo, 'feat/squash-refine', 'src/y.ts', 'export const y = 7;\n');

    // Now `master..laneHead` = 1 commit ancestry-wise (raw), but patch is on
    // master → refined commits_ahead should be 0.
    const ev = gitEvidence(wt, 'master');
    assert.ok(ev);
    assert.equal(ev.commitsAheadRaw, 1, 'raw ancestry count still sees the lane commit');
    assert.equal(ev.commitsAhead, 0, 'patch-id refinement must collapse squash-merged commits to 0');
  });

  it('flags a truly un-integrated lane: commits_ahead>0, dirty_tracked=0', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-honest-'));
    cleanup.push(repo);
    git(['init', '-b', 'master'], repo);
    git(['config', 'user.email', 't@e.com'], repo);
    git(['config', 'user.name', 'T'], repo);
    git(['commit', '--allow-empty', '-m', 'init'], repo);

    const wt = createWorktree(repo, 'feat/honest-work');
    cleanup.push(wt);

    fs.writeFileSync(path.join(wt, 'src.ts'), 'export const z = 1;\n');
    git(['add', 'src.ts'], wt);
    git(['commit', '-m', 'honest work'], wt);

    const ev = gitEvidence(wt, 'master');
    assert.ok(ev);
    assert.equal(ev.commitsAhead, 1, 'un-integrated commit must count');
    assert.equal(ev.dirtyTracked, 0);
  });
});
