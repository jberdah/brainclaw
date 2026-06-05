import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  cleanMergedWorktrees,
  worktreeHasOnlyBirthNoise,
  createWorktree,
  resolveWorktreePath,
} from '../../src/core/worktree.js';

// pln#525 — `worktree clean` used to skip EVERY merged brainclaw worktree
// because each carries birth-noise (the .brainclaw-worktree.json sidecar +
// a .gitignore flagged ` M` by Windows autocrlf). Worktrees then accumulated
// forever (observed: 84 worktrees, clean removed 0 / skipped 69, all on this
// false-positive). The clean now ignores birth-noise but still protects real
// uncommitted source work.

describe('worktreeHasOnlyBirthNoise (pln#525)', () => {
  const entry = (status: string, p: string) => `${status} ${p}\0`;

  it('is true for fully clean output', () => {
    assert.equal(worktreeHasOnlyBirthNoise(''), true);
  });

  it('is true when only .gitignore (autocrlf) is modified', () => {
    assert.equal(worktreeHasOnlyBirthNoise(entry(' M', '.gitignore')), true);
  });

  it('is true for the untracked sidecar + coordination store', () => {
    assert.equal(
      worktreeHasOnlyBirthNoise(entry('??', '.brainclaw-worktree.json') + entry(' M', '.brainclaw/coordination/x.json')),
      true,
    );
  });

  it('is false when a real source file is dirty', () => {
    assert.equal(worktreeHasOnlyBirthNoise(entry(' M', 'src/core/foo.ts')), false);
  });

  it('is false when real work is mixed with birth-noise', () => {
    assert.equal(
      worktreeHasOnlyBirthNoise(entry(' M', '.gitignore') + entry('??', 'src/new.ts')),
      false,
    );
  });
});

describe('cleanMergedWorktrees — birth-noise tolerance (pln#525)', () => {
  const git = (repo: string, args: string[], cwd = repo) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result;
  };

  it('removes a merged worktree whose only changes are birth-noise', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-gc-noise-'));
    const targetPath = resolveWorktreePath(repo, 'feat/noise');
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      git(repo, ['init']);
      // A tracked .gitignore so createWorktree copies it (the autocrlf noise source).
      fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
      git(repo, ['add', '.gitignore']);
      git(repo, ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', 'commit', '-m', 'init']);

      // Branch tip == HEAD ⇒ "merged into HEAD". createWorktree adds the sidecar
      // (untracked) and copies .gitignore ⇒ birth-noise only, no user work.
      const wt = createWorktree(repo, 'feat/noise');
      assert.ok(fs.existsSync(wt));

      const result = cleanMergedWorktrees(repo, {});
      // Assert on the filesystem (robust to git's path-string form) + that it was
      // NOT skipped as dirty.
      assert.equal(
        fs.existsSync(wt), false,
        `merged noise-only worktree should be GC-ed; removed=${JSON.stringify(result.removed)} skipped=${JSON.stringify(result.skipped)}`,
      );
      assert.equal(
        result.skipped.some((s) => s.reason === 'uncommitted changes'),
        false,
        'noise-only worktree must not be skipped as dirty',
      );
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', targetPath], { cwd: repo, encoding: 'utf-8' });
      fs.rmSync(targetPath, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('still skips a merged worktree with real uncommitted source work', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-gc-real-'));
    const targetPath = resolveWorktreePath(repo, 'feat/real');
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      git(repo, ['init']);
      git(repo, ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'init']);

      const wt = createWorktree(repo, 'feat/real');
      // Real (non-noise) untracked work left behind by a worker.
      fs.writeFileSync(path.join(wt, 'real-work.txt'), 'WIP — must not be GC-ed');

      const result = cleanMergedWorktrees(repo, {});
      // Path-form-robust: the worktree must NOT be GC-ed and the real work survives.
      assert.equal(
        fs.existsSync(wt), true,
        `worktree with real work must be preserved; removed=${JSON.stringify(result.removed)} skipped=${JSON.stringify(result.skipped)}`,
      );
      assert.equal(fs.existsSync(path.join(wt, 'real-work.txt')), true, 'real work preserved');
      assert.ok(
        result.skipped.some((s) => s.reason === 'uncommitted changes'),
        `expected a skip for uncommitted changes; got ${JSON.stringify(result.skipped)}`,
      );
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', targetPath], { cwd: repo, encoding: 'utf-8' });
      fs.rmSync(targetPath, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
