import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { cleanMergedWorktrees, gcWorktreeIfHarvested } from '../../src/core/worktree.js';

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

  it('fails closed — keeps a directory whose git status cannot be read (never force-removes on a probe failure)', () => {
    const { repo } = makeRepoWithWorktree('lane/failclosed');
    // A real directory that is NOT a git worktree: `git status` errors, so the
    // dirty-check cannot be proven. Pre-fix this fell through to a force remove;
    // it must now KEEP the directory.
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-gc-failclosed-'));
    cleanup.push(plain);
    const d = gcWorktreeIfHarvested(repo, plain);
    assert.equal(d.removed, false);
    assert.match(d.reason, /fail-closed|could not (read|verify)/);
    assert.equal(fs.existsSync(plain), true, 'directory preserved when status is unreadable');
  });

  it('is a safe no-op for a path that no longer exists', () => {
    const d = gcWorktreeIfHarvested(os.tmpdir(), path.join(os.tmpdir(), 'bclaw-gc-missing-zzz'));
    assert.equal(d.removed, false);
    assert.equal(d.reason, 'already gone');
  });
});

/**
 * Incident 2026-08-10 — the post-merge `worktree clean` destroyed a LIVE
 * dispatched lane during its startup window: a fresh lane branch has no commits
 * (→ ancestor of HEAD → "merged" by both probes) and the agent had not written
 * yet (→ no uncommitted changes). Both historical gates passed and
 * `cleanMergedWorktrees` emptied the worktree under the running agent.
 *
 * The coordination store is the authority on liveness: a worktree referenced by
 * an ACTIVE, non-expired claim is untouchable — merged or not, clean or not,
 * force or not. The escape hatch is releasing the claim, never bypassing it.
 */
describe('cleanMergedWorktrees — active-claim gate (incident 2026-08-10)', () => {
  /**
   * Physical-identity key, mirroring the production comparison. On the Windows
   * CI runner os.tmpdir() goes through an 8.3 short name (`RUNNER~1`) while git
   * reports long canonical paths — plain path.resolve equality never matches.
   * Capture the key while the path still EXISTS (realpath fails after removal);
   * paths reported by cleanMergedWorktrees are git-canonical long forms, so the
   * resolve fallback compares correctly against a pre-captured long key.
   */
  function pathKey(p: string): string {
    let resolved: string;
    try {
      resolved = fs.realpathSync.native(p);
    } catch {
      resolved = path.resolve(p);
    }
    return resolved.replace(/\\/g, '/').toLowerCase();
  }

  function writeClaim(
    repo: string,
    wt: string,
    overrides: Record<string, unknown> = {},
  ): void {
    const dir = path.join(repo, '.brainclaw', 'coordination', 'claims');
    fs.mkdirSync(dir, { recursive: true });
    const claim = {
      id: 'clm_test0001',
      agent: 'codex',
      scope: 'src/x.ts',
      description: 'lane under test',
      created_at: new Date().toISOString(),
      status: 'active',
      worktree_path: wt,
      ...overrides,
    };
    fs.writeFileSync(path.join(dir, `${claim.id as string}.json`), JSON.stringify(claim));
  }

  it('NEVER removes a fresh no-commit lane worktree with an active claim (the incident shape)', () => {
    const { repo, wt } = makeRepoWithWorktree('lane/live-fresh');
    writeClaim(repo, wt);
    const wtKey = pathKey(wt);
    const result = cleanMergedWorktrees(repo, {});
    assert.equal(fs.existsSync(path.join(wt, '.git')), true, 'worktree left fully intact');
    assert.ok(
      result.skipped.some((s) => pathKey(s.path) === wtKey && s.reason === 'active claim'),
      `expected an 'active claim' skip, got: ${JSON.stringify(result.skipped)} / removed: ${JSON.stringify(result.removed)}`,
    );
    assert.ok(!result.removed.some((p) => pathKey(p) === wtKey), 'not in removed');
  });

  it('the active claim beats --force (escape hatch = release the claim, not bypass it)', () => {
    const { repo, wt } = makeRepoWithWorktree('lane/live-force');
    writeClaim(repo, wt);
    const wtKey = pathKey(wt);
    const result = cleanMergedWorktrees(repo, { force: true });
    assert.equal(fs.existsSync(path.join(wt, '.git')), true, 'worktree survives --force');
    assert.ok(result.skipped.some((s) => pathKey(s.path) === wtKey && s.reason === 'active claim'));
  });

  it('a released claim does not protect — the same worktree becomes GC-able again', () => {
    const { repo, wt } = makeRepoWithWorktree('lane/released');
    writeClaim(repo, wt, { status: 'released' });
    const wtKey = pathKey(wt);
    const result = cleanMergedWorktrees(repo, {});
    assert.ok(result.removed.some((p) => pathKey(p) === wtKey), 'released lane is GC-able');
    assert.equal(fs.existsSync(wt), false);
  });

  it('an EXPIRED active claim does not protect (zombie claims must not block GC forever)', () => {
    const { repo, wt } = makeRepoWithWorktree('lane/zombie');
    writeClaim(repo, wt, { expires_at: new Date(Date.now() - 60_000).toISOString() });
    const wtKey = pathKey(wt);
    const result = cleanMergedWorktrees(repo, {});
    assert.ok(result.removed.some((p) => pathKey(p) === wtKey), 'expired claim is not a shield');
  });

  it('an unreadable claim file never blocks GC of other worktrees (lenient parse)', () => {
    const { repo, wt } = makeRepoWithWorktree('lane/garbage-claim');
    const dir = path.join(repo, '.brainclaw', 'coordination', 'claims');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'clm_broken.json'), '{not json');
    const wtKey = pathKey(wt);
    const result = cleanMergedWorktrees(repo, {});
    assert.ok(result.removed.some((p) => pathKey(p) === wtKey), 'GC proceeds past the broken record');
  });

  it('protects an ORPHAN dir (git admin gone) that an active claim still references', () => {
    const { repo, wt } = makeRepoWithWorktree('lane/orphan-live');
    // Simulate the corrupted-admin state the incident left behind: the git
    // worktree registration disappears but the dir (and the agent in it) remain.
    git(['worktree', 'remove', '--force', wt], repo);
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, 'agent-scratch.txt'), 'still working here\n');
    writeClaim(repo, wt);
    const wtKey = pathKey(wt);
    // Orphan cleaning only touches dirs under the brainclaw worktrees base for
    // this repo — our temp `wt` lives elsewhere, so drive the gate directly.
    const result = cleanMergedWorktrees(repo, {});
    assert.equal(fs.existsSync(path.join(wt, 'agent-scratch.txt')), true, 'orphan dir with active claim preserved');
    assert.ok(!result.removed.some((p) => pathKey(p) === wtKey));
  });
});
