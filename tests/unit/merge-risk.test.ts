import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { analyzeMergeRisk } from '../../src/core/merge-risk.js';

function git(args: string[], cwd: string): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

function write(root: string, rel: string, content: string): void {
  const fp = path.join(root, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content, 'utf-8');
}

/** A bare-ish main repo on `master` + N worktree branches, each editing files. */
function makeRepo(): { main: string; worktreesRoot: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-mergerisk-'));
  const main = path.join(root, 'main');
  fs.mkdirSync(main, { recursive: true });
  git(['init', '-q', '-b', 'master'], main);
  git(['config', 'user.email', 't@t'], main);
  git(['config', 'user.name', 'tester'], main);
  write(main, 'src/a.ts', 'export const a = 1;\n');
  write(main, 'src/b.ts', 'export const b = 1;\n');
  write(main, 'src/c.ts', 'export const c = 1;\n');
  git(['add', '-A'], main);
  git(['commit', '-q', '-m', 'init'], main);
  return { main, worktreesRoot: root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function addLane(main: string, root: string, branch: string, edits: Record<string, string>, commit = true): string {
  const wtPath = path.join(root, branch);
  git(['worktree', 'add', '-q', '-b', branch, wtPath], main);
  for (const [rel, content] of Object.entries(edits)) write(wtPath, rel, content);
  if (commit) {
    git(['add', '-A'], wtPath);
    git(['commit', '-q', '-m', `${branch} edits`], wtPath);
  }
  return wtPath;
}

describe('merge-risk: pre-merge conflict detection (pln#396)', () => {
  let repo: ReturnType<typeof makeRepo>;
  beforeEach(() => { repo = makeRepo(); });
  afterEach(() => {
    // Remove worktrees before the temp dir to avoid git admin churn.
    try { git(['worktree', 'prune'], repo.main); } catch { /* ignore */ }
    repo.cleanup();
  });

  it('flags files touched by more than one lane; disjoint lanes carry no risk', () => {
    addLane(repo.main, repo.worktreesRoot, 'laneA', { 'src/a.ts': 'export const a = 2;\n', 'src/shared.ts': 'export const s = "A";\n' });
    addLane(repo.main, repo.worktreesRoot, 'laneB', { 'src/b.ts': 'export const b = 2;\n', 'src/shared.ts': 'export const s = "B";\n' });
    addLane(repo.main, repo.worktreesRoot, 'laneC', { 'src/c.ts': 'export const c = 2;\n' });

    const report = analyzeMergeRisk(repo.main, { baseRef: 'master' });

    assert.equal(report.lanes.length, 3);
    assert.equal(report.has_risk, true);
    // Only src/shared.ts is multi-lane.
    assert.equal(report.overlaps.length, 1);
    assert.equal(report.overlaps[0].file, 'src/shared.ts');
    assert.deepEqual(report.overlaps[0].branches.sort(), ['laneA', 'laneB']);
    // laneC (disjoint) is a lane but appears in no overlap.
    assert.ok(report.lanes.find(l => l.branch === 'laneC'));
    assert.ok(!report.overlaps.some(o => o.branches.includes('laneC')));
  });

  it('all-disjoint lanes → has_risk false, safe-in-any-order summary', () => {
    addLane(repo.main, repo.worktreesRoot, 'laneA', { 'src/a.ts': 'export const a = 9;\n' });
    addLane(repo.main, repo.worktreesRoot, 'laneB', { 'src/b.ts': 'export const b = 9;\n' });

    const report = analyzeMergeRisk(repo.main, { baseRef: 'master' });
    assert.equal(report.has_risk, false);
    assert.equal(report.overlaps.length, 0);
    assert.match(report.summary, /disjoint/);
  });

  it('counts uncommitted tracked changes as part of a lane (a worker spawned from HEAD)', () => {
    // laneA commits a.ts; laneB leaves shared.ts uncommitted but tracked.
    addLane(repo.main, repo.worktreesRoot, 'laneA', { 'src/shared.ts': 'export const s = "A";\n' });
    const wtB = addLane(repo.main, repo.worktreesRoot, 'laneB', {}, false);
    write(wtB, 'src/shared.ts', 'export const s = "B-uncommitted";\n');
    git(['add', 'src/shared.ts'], wtB); // tracked, staged, not committed

    const report = analyzeMergeRisk(repo.main, { baseRef: 'master', includeDirty: true });
    const laneB = report.lanes.find(l => l.branch === 'laneB')!;
    assert.ok(laneB.dirty_files.includes('src/shared.ts'), 'uncommitted tracked file counted');
    assert.ok(report.overlaps.some(o => o.file === 'src/shared.ts' && o.branches.includes('laneB')));
  });

  it('ignores .brainclaw/ and .gitignore as conflict surface', () => {
    addLane(repo.main, repo.worktreesRoot, 'laneA', { '.gitignore': 'node_modules/\nfoo\n', '.brainclaw/x.json': '{}', 'src/a.ts': 'export const a = 5;\n' });
    addLane(repo.main, repo.worktreesRoot, 'laneB', { '.gitignore': 'node_modules/\nbar\n', '.brainclaw/x.json': '{"b":1}', 'src/b.ts': 'export const b = 5;\n' });

    const report = analyzeMergeRisk(repo.main, { baseRef: 'master' });
    // Both touch .gitignore + .brainclaw/x.json, but those are excluded → no overlap.
    assert.equal(report.has_risk, false, `unexpected overlaps: ${JSON.stringify(report.overlaps)}`);
  });

  it('attributes a lane to the active claim whose worktree_path matches', () => {
    const wtA = addLane(repo.main, repo.worktreesRoot, 'laneA', { 'src/a.ts': 'export const a = 7;\n' });
    // Minimal brainclaw claim store so listClaims finds an active claim on laneA's worktree.
    const claimsDir = path.join(repo.main, '.brainclaw', 'coordination', 'claims');
    fs.mkdirSync(claimsDir, { recursive: true });
    fs.writeFileSync(path.join(claimsDir, 'clm_test.json'), JSON.stringify({
      schema_version: 2, id: 'clm_test', agent: 'claude-code', scope: 'src/a.ts',
      description: 'lane A', created_at: '2026-01-01T00:00:00.000Z', status: 'active',
      worktree_path: wtA,
    }), 'utf-8');

    const report = analyzeMergeRisk(repo.main, { baseRef: 'master' });
    const laneA = report.lanes.find(l => l.branch === 'laneA')!;
    assert.equal(laneA.claim_id, 'clm_test');
    assert.equal(laneA.agent, undefined); // no sidecar; agent comes from worktree meta only
  });

  it('no lanes → empty report, no risk', () => {
    const report = analyzeMergeRisk(repo.main, { baseRef: 'master' });
    assert.equal(report.lanes.length, 0);
    assert.equal(report.has_risk, false);
    assert.match(report.summary, /No parallel worktree lanes/);
  });
});
