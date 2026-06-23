import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { gcWorktreeIfHarvested } from '../../src/core/worktree.js';

/**
 * pln#594 — gcWorktreeIfHarvested: safe garbage-collection of a dispatched
 * sub-agent worktree once its work is harvested. The guards (alive / dirty /
 * un-integrated) are the whole point, so each gets a case.
 */
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

/** A repo with one commit, plus a linked worktree on `branch` (at HEAD by default). */
function makeRepoWithWorktree(branch = 'lane/x'): { repo: string; wt: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-gc-repo-'));
  cleanup.push(repo);
  git(['init', '-b', 'master'], repo);
  git(['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '--allow-empty', '-m', 'init'], repo);
  const wt = path.join(repo, '..', `${path.basename(repo)}-wt`);
  cleanup.push(wt);
  git(['worktree', 'add', '-b', branch, wt, 'HEAD'], repo);
  return { repo, wt };
}

describe('gcWorktreeIfHarvested (pln#594)', () => {
  it('removes a clean, merged worktree and deletes its branch', () => {
    const { repo, wt } = makeRepoWithWorktree('lane/clean');
    const d = gcWorktreeIfHarvested(repo, wt);
    assert.equal(d.removed, true, d.reason);
    assert.equal(fs.existsSync(wt), false, 'worktree dir is gone');
    const branches = spawnSync('git', ['branch', '--list', 'lane/clean'], { cwd: repo, encoding: 'utf-8' }).stdout.trim();
    assert.equal(branches, '', 'dispatch branch deleted');
  });

  it('removes a worktree whose only untracked files are brainclaw birth-noise / LANE-RESULT', () => {
    const { repo, wt } = makeRepoWithWorktree('lane/noise');
    fs.writeFileSync(path.join(wt, 'LANE-RESULT.json'), '{"status":"completed"}\n');
    const hb = path.join(wt, '.brainclaw-heartbeat-asgn_x');
    fs.writeFileSync(hb, '');
    const old = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago → not alive
    fs.utimesSync(hb, old, old);
    const d = gcWorktreeIfHarvested(repo, wt);
    assert.equal(d.removed, true, d.reason);
    assert.equal(fs.existsSync(wt), false);
  });

  it('keeps a worktree with un-harvested (real) edits', () => {
    const { repo, wt } = makeRepoWithWorktree('lane/dirty');
    fs.writeFileSync(path.join(wt, 'work.txt'), 'real uncommitted work\n');
    const d = gcWorktreeIfHarvested(repo, wt);
    assert.equal(d.removed, false);
    assert.match(d.reason, /un-harvested/);
    assert.equal(fs.existsSync(wt), true, 'worktree preserved');
  });

  it('keeps a worktree whose lane branch has un-integrated commits', () => {
    const { repo, wt } = makeRepoWithWorktree('lane/ahead');
    fs.writeFileSync(path.join(wt, 'feature.ts'), 'export const x = 1;\n');
    git(['add', '-A'], wt);
    git(['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-m', 'unmerged work'], wt);
    const d = gcWorktreeIfHarvested(repo, wt);
    assert.equal(d.removed, false);
    assert.match(d.reason, /un-integrated/);
    assert.equal(fs.existsSync(wt), true);
  });

  it('keeps a worktree whose worker still looks alive (recent heartbeat) — even with force', () => {
    const { repo, wt } = makeRepoWithWorktree('lane/alive');
    fs.writeFileSync(path.join(wt, '.brainclaw-heartbeat-asgn_live'), ''); // fresh mtime = now
    const d = gcWorktreeIfHarvested(repo, wt, { force: true });
    assert.equal(d.removed, false);
    assert.match(d.reason, /still active/);
    assert.equal(fs.existsSync(wt), true);
  });

  it('force removes a dirty worktree (bypasses the dirty + unmerged guards, not liveness)', () => {
    const { repo, wt } = makeRepoWithWorktree('lane/force');
    fs.writeFileSync(path.join(wt, 'work.txt'), 'uncommitted\n');
    const d = gcWorktreeIfHarvested(repo, wt, { force: true });
    assert.equal(d.removed, true, d.reason);
    assert.equal(fs.existsSync(wt), false);
  });

  it('is a safe no-op for a path that no longer exists', () => {
    const d = gcWorktreeIfHarvested(os.tmpdir(), path.join(os.tmpdir(), 'bclaw-gc-missing-zzz'));
    assert.equal(d.removed, false);
    assert.equal(d.reason, 'already gone');
  });
});
