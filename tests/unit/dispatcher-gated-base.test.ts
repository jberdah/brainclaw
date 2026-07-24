import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { resolveGatedLaneBase } from '../../src/core/dispatcher.js';
import { sanitizeBranchComponent } from '../../src/core/worktree.js';
import type { SequenceItem } from '../../src/core/schema.js';

// pln#529 (dec#122 B+A) — a gated lane's fork base is resolved by CONTENT, not
// ancestry: predecessor integrated on HEAD → HEAD; committed-but-unintegrated →
// fork from its branch (B); ≥2 unintegrated → gate stays CLOSED (A).

const gitGlobalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-git-g-'));
fs.writeFileSync(path.join(gitGlobalDir, 'config'), '');
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: path.join(gitGlobalDir, 'config') };
const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
});

function git(args: string[], cwd: string): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', env: gitEnv });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr || r.stdout}`);
}

/** A git repo on its default branch with one initial commit. */
function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-gated-'));
  cleanup.push(repo);
  git(['init'], repo);
  git(['config', 'user.email', 't@t.dev'], repo);
  git(['config', 'user.name', 'T'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# base\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'init'], repo);
  return repo;
}

function writeCommitOnBranch(repo: string, branch: string, file: string, content: string): void {
  git(['checkout', '-b', branch], repo);
  fs.writeFileSync(path.join(repo, file), content);
  git(['add', '.'], repo);
  git(['commit', '-m', `work on ${branch}`], repo);
  git(['checkout', '-'], repo); // back to the previous (default) branch
}

const item = (planId: string, scopeHint: string): SequenceItem =>
  ({ planId, scope_hint: scopeHint, hard_after: [], soft_after: [] } as unknown as SequenceItem);
const branchOf = (scope: string) => `feat/${sanitizeBranchComponent(scope)}`;

describe('pln#529 resolveGatedLaneBase — content-aware fork base', () => {
  it('no hard_after → empty selection (non-gated lane untouched)', () => {
    const repo = makeRepo();
    assert.deepEqual(resolveGatedLaneBase([], new Map(), repo), {});
  });

  it('predecessor committed on its branch but NOT on HEAD → fork from that branch (B)', () => {
    const repo = makeRepo();
    writeCommitOnBranch(repo, branchOf('pred-a'), 'a.ts', 'export const a = 1;\n');
    const idx = new Map([['pln_a', item('pln_a', 'pred-a')]]);
    const base = resolveGatedLaneBase(['pln_a'], idx, repo);
    assert.equal(base.baseRef, branchOf('pred-a'), 'forks from the un-integrated predecessor branch');
    assert.equal(base.resetExistingBranch, true);
    assert.match(base.reason!, /not yet integrated on HEAD/);
    assert.equal(base.gateBlocked, undefined);
  });

  it('predecessor content-integrated on HEAD → baseRef HEAD (socle already present)', () => {
    const repo = makeRepo();
    writeCommitOnBranch(repo, branchOf('pred-a'), 'a.ts', 'export const a = 1;\n');
    // Put the SAME content on HEAD (simulates a squash-merge — same patch, new SHA).
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    git(['add', '.'], repo);
    git(['commit', '-m', 'squash-merge pred-a'], repo);
    const idx = new Map([['pln_a', item('pln_a', 'pred-a')]]);
    const base = resolveGatedLaneBase(['pln_a'], idx, repo);
    assert.equal(base.baseRef, 'HEAD', 'code is on HEAD by content → HEAD is a valid base');
    assert.equal(base.gateBlocked, undefined);
  });

  it('predecessor branch absent (merged + cleaned up) → baseRef HEAD (cannot prove otherwise)', () => {
    const repo = makeRepo();
    const idx = new Map([['pln_ghost', item('pln_ghost', 'ghost')]]);
    const base = resolveGatedLaneBase(['pln_ghost'], idx, repo);
    assert.equal(base.baseRef, 'HEAD');
    assert.equal(base.gateBlocked, undefined);
  });

  it('≥2 predecessors committed on separate un-integrated branches → gate BLOCKED (A)', () => {
    const repo = makeRepo();
    writeCommitOnBranch(repo, branchOf('pred-a'), 'a.ts', 'export const a = 1;\n');
    writeCommitOnBranch(repo, branchOf('pred-b'), 'b.ts', 'export const b = 2;\n');
    const idx = new Map([
      ['pln_a', item('pln_a', 'pred-a')],
      ['pln_b', item('pln_b', 'pred-b')],
    ]);
    const base = resolveGatedLaneBase(['pln_a', 'pln_b'], idx, repo);
    assert.equal(base.baseRef, undefined, 'no single base — gate must not open');
    assert.ok(base.gateBlocked, 'gate is blocked');
    assert.deepEqual(base.gateBlocked!.unintegrated.sort(), ['pln_a', 'pln_b']);
    assert.match(base.gateBlocked!.reason, /Integrate them onto HEAD/);
  });

  it('mixed: one integrated on HEAD + one un-integrated → forks from the single un-integrated branch', () => {
    const repo = makeRepo();
    // pred-a integrated on HEAD:
    writeCommitOnBranch(repo, branchOf('pred-a'), 'a.ts', 'export const a = 1;\n');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
    git(['add', '.'], repo); git(['commit', '-m', 'merge a'], repo);
    // pred-b un-integrated:
    writeCommitOnBranch(repo, branchOf('pred-b'), 'b.ts', 'export const b = 2;\n');
    const idx = new Map([
      ['pln_a', item('pln_a', 'pred-a')],
      ['pln_b', item('pln_b', 'pred-b')],
    ]);
    const base = resolveGatedLaneBase(['pln_a', 'pln_b'], idx, repo);
    assert.equal(base.baseRef, branchOf('pred-b'), 'only the un-integrated predecessor drives the fork base');
    assert.equal(base.gateBlocked, undefined);
  });
});
