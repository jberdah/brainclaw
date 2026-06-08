import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  buildTypecheckPreCommitScript,
  installWorktreeTypecheckGate,
  createWorktree,
  resolveWorktreePath,
  WORKTREE_HOOKS_DIRNAME,
} from '../../src/core/worktree.js';

// pln#479 — opt-in per-worktree typecheck gate. Isolated to the dispatched
// worktree via `--worktree core.hooksPath` so the main repo's commits are never
// affected.

function git(repo: string, args: string[], cwd = repo) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r.stdout;
}

describe('buildTypecheckPreCommitScript (pln#479)', () => {
  it('runs tsc --noEmit, skips gracefully without typescript, and documents the bypass', () => {
    const script = buildTypecheckPreCommitScript();
    assert.match(script, /tsc --noEmit/);
    assert.match(script, /node_modules\/typescript\/bin\/tsc/);
    assert.match(script, /typescript not found/); // degrades to a warning, not a block
    assert.match(script, /--no-verify/);          // bypass documented
    assert.match(script, /^#!\/bin\/sh/);
  });
});

describe('installWorktreeTypecheckGate (pln#479)', () => {
  it('no-ops when the worktree has no tsconfig.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-gate-none-'));
    try {
      const res = installWorktreeTypecheckGate(dir, dir);
      assert.equal(res.installed, false);
      assert.match(res.reason ?? '', /tsconfig/);
      assert.equal(fs.existsSync(path.join(dir, WORKTREE_HOOKS_DIRNAME)), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('installs an isolated hook + worktree-scoped hooksPath when tsconfig is present', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-gate-repo-'));
    const targetPath = resolveWorktreePath(repo, 'feat/gate');
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      git(repo, ['init']);
      fs.writeFileSync(path.join(repo, 'tsconfig.json'), '{}');
      git(repo, ['add', 'tsconfig.json']);
      git(repo, ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', 'commit', '-m', 'init']);
      const wt = createWorktree(repo, 'feat/gate'); // tsconfig.json checked out from HEAD

      const res = installWorktreeTypecheckGate(repo, wt);
      assert.equal(res.installed, true, res.reason);

      // Hook file written into the worktree-local hooks dir.
      const hook = path.join(wt, WORKTREE_HOOKS_DIRNAME, 'pre-commit');
      assert.equal(fs.existsSync(hook), true, 'pre-commit hook written');
      assert.match(fs.readFileSync(hook, 'utf-8'), /tsc --noEmit/);

      // hooksPath is set at WORKTREE scope (isolated) and points at our dir.
      const hooksPath = git(wt, ['config', '--worktree', 'core.hooksPath']).trim();
      assert.ok(hooksPath.endsWith(WORKTREE_HOOKS_DIRNAME), `hooksPath=${hooksPath}`);
      // extensions.worktreeConfig enabled so the --worktree override is honored.
      assert.equal(git(repo, ['config', 'extensions.worktreeConfig']).trim(), 'true');

      // The MAIN repo is NOT given a hooksPath override (isolation).
      const mainHooks = spawnSync('git', ['config', '--local', 'core.hooksPath'], { cwd: repo, encoding: 'utf-8' });
      assert.notEqual(mainHooks.stdout.trim(), hooksPath, 'main repo must not inherit the worktree hooksPath');
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', targetPath], { cwd: repo, encoding: 'utf-8' });
      fs.rmSync(targetPath, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('createWorktree — typecheck gate is opt-in (pln#479)', () => {
  const withEnv = (value: string | undefined, fn: () => void) => {
    const prev = process.env.BRAINCLAW_WORKTREE_TYPECHECK_GATE;
    if (value === undefined) delete process.env.BRAINCLAW_WORKTREE_TYPECHECK_GATE;
    else process.env.BRAINCLAW_WORKTREE_TYPECHECK_GATE = value;
    try { fn(); } finally {
      if (prev === undefined) delete process.env.BRAINCLAW_WORKTREE_TYPECHECK_GATE;
      else process.env.BRAINCLAW_WORKTREE_TYPECHECK_GATE = prev;
    }
  };

  const makeRepoWithTsconfig = () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-gate-wt-'));
    git(repo, ['init']);
    fs.writeFileSync(path.join(repo, 'tsconfig.json'), '{}');
    git(repo, ['add', 'tsconfig.json']);
    git(repo, ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', 'commit', '-m', 'init']);
    return repo;
  };

  it('installs the gate when BRAINCLAW_WORKTREE_TYPECHECK_GATE=1', () => {
    const repo = makeRepoWithTsconfig();
    const targetPath = resolveWorktreePath(repo, 'feat/on');
    try {
      withEnv('1', () => {
        const wt = createWorktree(repo, 'feat/on');
        assert.equal(fs.existsSync(path.join(wt, WORKTREE_HOOKS_DIRNAME, 'pre-commit')), true);
        const meta = JSON.parse(fs.readFileSync(path.join(wt, '.brainclaw-worktree.json'), 'utf-8'));
        assert.equal(meta.typecheck_gate, true);
      });
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', targetPath], { cwd: repo, encoding: 'utf-8' });
      fs.rmSync(targetPath, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does NOT install the gate by default (no env)', () => {
    const repo = makeRepoWithTsconfig();
    const targetPath = resolveWorktreePath(repo, 'feat/off');
    try {
      withEnv(undefined, () => {
        const wt = createWorktree(repo, 'feat/off');
        assert.equal(fs.existsSync(path.join(wt, WORKTREE_HOOKS_DIRNAME)), false, 'gate must be opt-in');
        const meta = JSON.parse(fs.readFileSync(path.join(wt, '.brainclaw-worktree.json'), 'utf-8'));
        assert.equal(meta.typecheck_gate, undefined);
      });
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', targetPath], { cwd: repo, encoding: 'utf-8' });
      fs.rmSync(targetPath, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
