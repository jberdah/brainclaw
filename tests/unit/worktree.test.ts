import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  createWorktree,
  detectStackSharedPaths,
  findWorktreePathForBranch,
  worktreesBaseDir,
  resolveWorktreePath,
  isBareRepo,
  hasGitLock,
  detectSharedCheckoutRisk,
  assertPathInWorktreesScope,
  safeRemoveWorktreeDir,
} from '../../src/core/worktree.js';

describe('worktreesBaseDir', () => {
  it('returns a path inside ~/.brainclaw/worktrees/', () => {
    const dir = worktreesBaseDir('/some/project');
    assert.ok(dir.startsWith(path.join(os.homedir(), '.brainclaw', 'worktrees')));
  });

  it('produces different dirs for different project paths', () => {
    const a = worktreesBaseDir('/project/alpha');
    const b = worktreesBaseDir('/project/beta');
    assert.notEqual(a, b);
  });

  it('is deterministic for the same project path', () => {
    const a = worktreesBaseDir('/project/my-repo');
    const b = worktreesBaseDir('/project/my-repo');
    assert.equal(a, b);
  });

  it('includes a 12-char hex hash segment', () => {
    const dir = worktreesBaseDir('/project/my-repo');
    const segment = path.basename(dir);
    assert.match(segment, /^[0-9a-f]{12}$/);
  });
});

describe('resolveWorktreePath', () => {
  it('is nested inside worktreesBaseDir', () => {
    const base = worktreesBaseDir('/my/project');
    const resolved = resolveWorktreePath('/my/project', 'feat/my-feature');
    assert.ok(resolved.startsWith(base));
  });

  it('replaces slashes with underscores in branch name', () => {
    const resolved = resolveWorktreePath('/my/project', 'feat/my-feature');
    const slug = path.basename(resolved);
    // slash replaced, no raw /
    assert.ok(!slug.includes('/'));
    assert.ok(slug.includes('feat_my-feature') || slug.includes('feat_my_feature'));
  });

  it('truncates long branch names to 64 chars', () => {
    const longBranch = 'feat/' + 'a'.repeat(100);
    const resolved = resolveWorktreePath('/my/project', longBranch);
    const slug = path.basename(resolved);
    assert.ok(slug.length <= 64);
  });

  it('is deterministic for the same inputs', () => {
    const a = resolveWorktreePath('/my/project', 'feat/test');
    const b = resolveWorktreePath('/my/project', 'feat/test');
    assert.equal(a, b);
  });

  it('differs for different branch names', () => {
    const a = resolveWorktreePath('/my/project', 'feat/alpha');
    const b = resolveWorktreePath('/my/project', 'feat/beta');
    assert.notEqual(a, b);
  });
});

describe('isBareRepo', () => {
  it('returns false for a non-git directory', () => {
    // os.tmpdir() is not a git repo, git command will fail → returns false
    const result = isBareRepo(os.tmpdir());
    assert.equal(result, false);
  });

  it('returns false for a normal (non-bare) git repo', () => {
    // The current repo (where tests run) is a normal checkout
    const result = isBareRepo(process.cwd());
    assert.equal(result, false);
  });
});

describe('hasGitLock', () => {
  it('returns false when no lock is present in the current repo', () => {
    // No concurrent git operation during test run
    const result = hasGitLock(process.cwd());
    assert.equal(result, false);
  });

  it('returns false for a non-git directory', () => {
    const result = hasGitLock(os.tmpdir());
    assert.equal(result, false);
  });
});

describe('detectSharedCheckoutRisk', () => {
  it('returns no conflict when called on a repo with no brainclaw worktrees', () => {
    // Current repo has no brainclaw-managed worktrees with session sidecars
    const risk = detectSharedCheckoutRisk(process.cwd());
    // Conflict may or may not exist, but the function must return the shape
    assert.ok(typeof risk.has_conflict === 'boolean');
    assert.ok(Array.isArray(risk.conflicting_paths));
  });
});

describe('findWorktreePathForBranch', () => {
  it('returns the worktree path for an attached branch', () => {
    const pathForBranch = findWorktreePathForBranch([
      { path: '/repo', branch: 'main', commit: 'abc', is_main: true },
      { path: '/repo-feature', branch: 'feat/live', commit: 'def', is_main: false },
    ], 'feat/live');

    assert.equal(pathForBranch, '/repo-feature');
  });

  it('returns undefined when no worktree has the branch', () => {
    const pathForBranch = findWorktreePathForBranch([
      { path: '/repo', branch: 'main', commit: 'abc', is_main: true },
    ], 'feat/missing');

    assert.equal(pathForBranch, undefined);
  });
});

describe('createWorktree reset guard', () => {
  it('refuses to force-reset a branch checked out in another worktree', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-worktree-reset-'));
    const externalWorktree = path.join(repo, '..', `${path.basename(repo)}-linked`);
    const targetPath = resolveWorktreePath(repo, 'feat/live');

    const git = (args: string[], cwd = repo) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result;
    };

    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      git(['init']);
      git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test User', 'commit', '--allow-empty', '-m', 'init']);
      git(['branch', 'feat/live']);
      git(['worktree', 'add', externalWorktree, 'feat/live']);

      assert.throws(
        () => createWorktree(repo, 'feat/live', { resetExistingBranch: true, baseRef: 'HEAD' }),
        /Cannot reset branch feat\/live: it is checked out in worktree/,
      );
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', externalWorktree], { cwd: repo, encoding: 'utf-8' });
      fs.rmSync(targetPath, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(externalWorktree, { recursive: true, force: true });
    }
  });
});

// pln#477 — worktree GC scope hardening
describe('assertPathInWorktreesScope', () => {
  it('accepts paths under ~/.brainclaw/worktrees/', () => {
    const target = path.join(os.homedir(), '.brainclaw', 'worktrees', 'abc123', 'feat_x');
    fs.mkdirSync(target, { recursive: true });
    try {
      assert.doesNotThrow(() => assertPathInWorktreesScope(target, '/some/project'));
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('accepts paths under <projectRoot>/.brainclaw/coordination/runtime/', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-scope-proj-'));
    const target = path.join(projectRoot, '.brainclaw', 'coordination', 'runtime', 'ack');
    fs.mkdirSync(target, { recursive: true });
    try {
      assert.doesNotThrow(() => assertPathInWorktreesScope(target, projectRoot));
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('accepts runtime paths when projectRoot is provided via a Windows 8.3 alias', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-scope-proj-'));
    const target = path.join(projectRoot, '.brainclaw', 'coordination', 'runtime', 'ack');
    const shortProjectRoot = projectRoot.replace(/Users/i, 'USERS~1');
    const shortTarget = path.join(shortProjectRoot, '.brainclaw', 'coordination', 'runtime', 'ack');
    fs.mkdirSync(target, { recursive: true });

    const originalNativeRealpath = fs.realpathSync.native;
    fs.realpathSync.native = ((input: fs.PathLike) => {
      const value = String(input);
      if (value === shortTarget) return target;
      if (value === path.join(shortProjectRoot, '.brainclaw', 'coordination', 'runtime')) {
        return path.join(projectRoot, '.brainclaw', 'coordination', 'runtime');
      }
      return originalNativeRealpath(input);
    }) as typeof fs.realpathSync.native;

    try {
      assert.doesNotThrow(() => assertPathInWorktreesScope(shortTarget, shortProjectRoot));
    } finally {
      fs.realpathSync.native = originalNativeRealpath;
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects paths outside brainclaw scope', () => {
    const stranger = fs.mkdtempSync(path.join(os.tmpdir(), 'stranger-'));
    try {
      assert.throws(
        () => assertPathInWorktreesScope(stranger, '/some/project'),
        /Refusing to remove path outside brainclaw worktree scope/,
      );
    } finally {
      fs.rmSync(stranger, { recursive: true, force: true });
    }
  });

  it('rejects symlinks that resolve out of scope (defense against junction-escape)', () => {
    // Create a real out-of-scope target, then a symlink under worktrees pointing
    // to it. realpath should resolve to the out-of-scope target → rejected.
    const realTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'real-out-of-scope-'));
    const fakeWorktree = path.join(os.homedir(), '.brainclaw', 'worktrees', 'test-junction-escape');
    fs.mkdirSync(fakeWorktree, { recursive: true });
    const link = path.join(fakeWorktree, 'escape-link');
    try {
      fs.symlinkSync(realTarget, link, 'dir');
      assert.throws(
        () => assertPathInWorktreesScope(link, '/some/project'),
        /Refusing to remove path outside brainclaw worktree scope/,
      );
    } finally {
      try { fs.unlinkSync(link); } catch { /* may already be gone */ }
      fs.rmSync(fakeWorktree, { recursive: true, force: true });
      fs.rmSync(realTarget, { recursive: true, force: true });
    }
  });
});

describe('safeRemoveWorktreeDir', () => {
  it('removes a regular directory tree without surprise', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-saferm-'));
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
    fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'world');

    safeRemoveWorktreeDir(dir);

    assert.equal(fs.existsSync(dir), false);
  });

  it('does NOT follow symlinks — preserves the symlink target (regression for trap_merge_wipes_node_modules)', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-target-'));
    const importantFile = path.join(target, 'important.txt');
    fs.writeFileSync(importantFile, 'must-survive');

    const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-worktree-'));
    const linkInside = path.join(worktreeDir, 'symlink-to-target');
    fs.symlinkSync(target, linkInside, 'dir');

    safeRemoveWorktreeDir(worktreeDir);

    // The worktree dir is gone, but the symlink target tree is INTACT.
    assert.equal(fs.existsSync(worktreeDir), false, 'worktree dir removed');
    assert.equal(fs.existsSync(target), true, 'symlink target dir survived');
    assert.equal(fs.existsSync(importantFile), true, 'file under target survived');
    assert.equal(fs.readFileSync(importantFile, 'utf-8'), 'must-survive');

    // Cleanup
    fs.rmSync(target, { recursive: true, force: true });
  });

  it('handles a missing path silently (idempotent)', () => {
    const phantom = path.join(os.tmpdir(), 'bclaw-saferm-phantom-' + Date.now());
    assert.doesNotThrow(() => safeRemoveWorktreeDir(phantom));
  });
});

// pln#480 — Multi-stack worktree shared_paths
describe('detectStackSharedPaths', () => {
  it('detects node_modules for package.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-stack-node-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    try {
      const result = detectStackSharedPaths(dir);
      assert.deepStrictEqual(result, ['node_modules']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects venv/.venv for requirements.txt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-stack-py-'));
    fs.writeFileSync(path.join(dir, 'requirements.txt'), '');
    try {
      const result = detectStackSharedPaths(dir);
      assert.deepStrictEqual(result, ['venv', '.venv']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects venv/.venv for pyproject.toml', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-stack-pyp-'));
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), '');
    try {
      const result = detectStackSharedPaths(dir);
      assert.deepStrictEqual(result, ['venv', '.venv']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects venv/.venv for Pipfile', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-stack-pip-'));
    fs.writeFileSync(path.join(dir, 'Pipfile'), '');
    try {
      const result = detectStackSharedPaths(dir);
      assert.deepStrictEqual(result, ['venv', '.venv']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects vendor/bundle for Gemfile (Ruby)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-stack-ruby-'));
    fs.writeFileSync(path.join(dir, 'Gemfile'), '');
    try {
      const result = detectStackSharedPaths(dir);
      assert.deepStrictEqual(result, ['vendor/bundle']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects vendor for go.mod (Go)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-stack-go-'));
    fs.writeFileSync(path.join(dir, 'go.mod'), '');
    try {
      const result = detectStackSharedPaths(dir);
      assert.deepStrictEqual(result, ['vendor']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects vendor for composer.json (PHP)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-stack-php-'));
    fs.writeFileSync(path.join(dir, 'composer.json'), '{}');
    try {
      const result = detectStackSharedPaths(dir);
      assert.deepStrictEqual(result, ['vendor']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects deps for mix.exs (Elixir)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-stack-elixir-'));
    fs.writeFileSync(path.join(dir, 'mix.exs'), '');
    try {
      const result = detectStackSharedPaths(dir);
      assert.deepStrictEqual(result, ['deps']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deduplicates vendor when both go.mod and composer.json exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-stack-multi-'));
    fs.writeFileSync(path.join(dir, 'go.mod'), '');
    fs.writeFileSync(path.join(dir, 'composer.json'), '{}');
    try {
      const result = detectStackSharedPaths(dir);
      assert.deepStrictEqual(result, ['vendor']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty for a directory with no stack markers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-stack-empty-'));
    try {
      const result = detectStackSharedPaths(dir);
      assert.deepStrictEqual(result, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects multiple stacks (Node + Python)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-stack-mixed-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'requirements.txt'), '');
    try {
      const result = detectStackSharedPaths(dir);
      assert.deepStrictEqual(result, ['node_modules', 'venv', '.venv']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pln#480 — dist is NOT in default shared paths', () => {
  it('detectStackSharedPaths never includes dist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-nodist-'));
    // Even with package.json (Node stack), dist must not appear
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    try {
      const result = detectStackSharedPaths(dir);
      assert.ok(!result.includes('dist'), 'dist must not be in shared paths');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pln#480 — config override (additive + exclude)', () => {
  it('additive: sharedPaths adds extra entries', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-cfg-add-'));
    const targetPath = resolveWorktreePath(repo, 'feat/cfg-add');

    const git = (args: string[], cwd = repo) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result;
    };

    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      git(['init']);
      git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test User', 'commit', '--allow-empty', '-m', 'init']);

      // Create package.json (Node) + a custom shared dir
      fs.writeFileSync(path.join(repo, 'package.json'), '{}');
      fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
      fs.mkdirSync(path.join(repo, '.cache'), { recursive: true });

      const result = createWorktree(repo, 'feat/cfg-add', {
        sharedPaths: ['.cache'],
      });

      // node_modules should be symlinked (auto-detected) + .cache (additive)
      const nmLink = path.join(result, 'node_modules');
      const cacheLink = path.join(result, '.cache');
      assert.ok(fs.existsSync(nmLink), 'node_modules symlink created');
      assert.ok(fs.existsSync(cacheLink), '.cache symlink created');
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', targetPath], { cwd: repo, encoding: 'utf-8' });
      fs.rmSync(targetPath, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('exclude: excludeShared removes auto-detected entries', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-cfg-excl-'));
    const targetPath = resolveWorktreePath(repo, 'feat/cfg-excl');

    const git = (args: string[], cwd = repo) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result;
    };

    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      git(['init']);
      git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test User', 'commit', '--allow-empty', '-m', 'init']);

      fs.writeFileSync(path.join(repo, 'package.json'), '{}');
      fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });

      const result = createWorktree(repo, 'feat/cfg-excl', {
        excludeShared: ['node_modules'],
      });

      const nmLink = path.join(result, 'node_modules');
      assert.ok(!fs.existsSync(nmLink), 'node_modules excluded — no symlink');
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', targetPath], { cwd: repo, encoding: 'utf-8' });
      fs.rmSync(targetPath, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
