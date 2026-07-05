import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  readWorkspacePatterns,
  detectWorkspaceNodeModules,
  createWorktree,
  resolveWorktreePath,
  resolveGitToplevel,
} from '../../src/core/worktree.js';

// pln#523 — monorepo per-package node_modules provisioning for dispatched
// worktrees. The root-only junction (detectStackSharedPaths) left workers unable
// to build/typecheck sub-packages that keep a local node_modules.

describe('readWorkspacePatterns (pln#523)', () => {
  it('reads npm/yarn workspaces array', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-ws-arr-'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*', 'apps/api'] }),
    );
    try {
      assert.deepStrictEqual(readWorkspacePatterns(dir).sort(), ['apps/api', 'packages/*']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the workspaces.packages object form', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-ws-obj-'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ workspaces: { packages: ['libs/*'] } }),
    );
    try {
      assert.deepStrictEqual(readWorkspacePatterns(dir), ['libs/*']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads pnpm-workspace.yaml packages', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-ws-pnpm-'));
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n  - "tools/cli"\n');
    try {
      assert.deepStrictEqual(readWorkspacePatterns(dir).sort(), ['packages/*', 'tools/cli']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty for a non-workspace package.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-ws-none-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    try {
      assert.deepStrictEqual(readWorkspacePatterns(dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty (never throws) when there are no manifests', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-ws-empty-'));
    try {
      assert.deepStrictEqual(readWorkspacePatterns(dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('detectWorkspaceNodeModules (pln#523)', () => {
  it('finds per-package node_modules via a wildcard pattern, skipping packages without one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-mono-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    fs.mkdirSync(path.join(dir, 'packages', 'a', 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'packages', 'b', 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'packages', 'c'), { recursive: true }); // hoisted: no local node_modules
    try {
      assert.deepStrictEqual(
        detectWorkspaceNodeModules(dir).sort(),
        ['packages/a/node_modules', 'packages/b/node_modules'],
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds node_modules for an exact (non-wildcard) package path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-mono-exact-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ workspaces: ['apps/api'] }));
    fs.mkdirSync(path.join(dir, 'apps', 'api', 'node_modules'), { recursive: true });
    try {
      assert.deepStrictEqual(detectWorkspaceNodeModules(dir), ['apps/api/node_modules']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips negation patterns and returns [] for a fully hoisted monorepo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-mono-hoist-'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*', '!packages/excluded'] }),
    );
    fs.mkdirSync(path.join(dir, 'packages', 'a'), { recursive: true }); // no local node_modules
    try {
      assert.deepStrictEqual(detectWorkspaceNodeModules(dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty for a non-workspace project', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-mono-plain-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    try {
      assert.deepStrictEqual(detectWorkspaceNodeModules(dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createWorktree — monorepo per-package node_modules links (pln#523)', () => {
  it('junction-links each workspace package node_modules into the worktree', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-mono-wt-'));
    const targetPath = resolveWorktreePath(repo, 'feat/mono');
    const git = (args: string[], cwd = repo) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result;
    };
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      git(['init']);
      git(['-c', 'user.email=t@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'init']);

      fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
      fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
      fs.mkdirSync(path.join(repo, 'packages', 'a', 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'packages', 'a', 'node_modules', 'marker.txt'), 'dep');

      const wt = createWorktree(repo, 'feat/mono');

      assert.ok(fs.existsSync(path.join(wt, 'node_modules')), 'root node_modules linked');
      assert.ok(
        fs.existsSync(path.join(wt, 'packages', 'a', 'node_modules')),
        'per-package node_modules linked',
      );
      assert.equal(
        fs.readFileSync(path.join(wt, 'packages', 'a', 'node_modules', 'marker.txt'), 'utf-8'),
        'dep',
        'linked package node_modules resolves to the real dependency tree',
      );
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', targetPath], { cwd: repo, encoding: 'utf-8' });
      fs.rmSync(targetPath, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('in-tree project: creates the worktree under the repo-root hash, not the subdir (pln#614)', () => {
    // Reproduces the leazzy monorepo case (trp_28025248): the project dir sits
    // INSIDE a larger repo, so the git root is an ancestor. createWorktree must
    // resolve the toplevel — run `git worktree add` from the repo root and hash
    // the worktree dir off it — instead of the project subdir.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-intree-'));
    const projectDir = path.join(repo, 'applications', 'leazzy');
    const expectedTop = resolveWorktreePath(repo, 'feat/intree');
    const subdirHash = resolveWorktreePath(projectDir, 'feat/intree');
    const git = (args: string[], cwd = repo) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result;
    };
    try {
      fs.rmSync(expectedTop, { recursive: true, force: true });
      fs.rmSync(subdirHash, { recursive: true, force: true });
      git(['init']);
      git(['-c', 'user.email=t@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'init']);
      fs.mkdirSync(projectDir, { recursive: true });

      // Called from the project subdir — previously ran `git worktree add` from
      // here and (with an empty .git) failed; now resolves the toplevel.
      const wt = createWorktree(projectDir, 'feat/intree');

      assert.equal(path.resolve(wt), path.resolve(expectedTop), 'worktree lives under the repo-root hash');
      assert.notEqual(path.resolve(wt), path.resolve(subdirHash), 'NOT under the project-subdir hash');
      assert.ok(fs.existsSync(wt), 'worktree materialised (git worktree add ran from the toplevel)');
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', expectedTop], { cwd: repo, encoding: 'utf-8' });
      fs.rmSync(expectedTop, { recursive: true, force: true });
      fs.rmSync(subdirHash, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('resolveGitToplevel returns the repo root from a subdir, falls back for a non-git dir (pln#614)', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-toplevel-'));
    const sub = path.join(repo, 'a', 'b');
    const git = (args: string[], cwd = repo) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result;
    };
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-nongit-'));
    try {
      git(['init']);
      fs.mkdirSync(sub, { recursive: true });
      // realpath both sides: macOS temp (/var → /private/var) differs from git's output.
      assert.equal(fs.realpathSync(resolveGitToplevel(sub)), fs.realpathSync(repo), 'resolves the repo root from a nested subdir');
      assert.equal(resolveGitToplevel(nonGit), nonGit, 'falls back to the input for a non-git dir');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it('honors BRAINCLAW_NO_LINK_DEPS=1 by skipping auto dependency linking', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-mono-nolink-'));
    const targetPath = resolveWorktreePath(repo, 'feat/nolink');
    const git = (args: string[], cwd = repo) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result;
    };
    const prev = process.env.BRAINCLAW_NO_LINK_DEPS;
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      git(['init']);
      git(['-c', 'user.email=t@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'init']);
      fs.writeFileSync(path.join(repo, 'package.json'), '{}');
      fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });

      process.env.BRAINCLAW_NO_LINK_DEPS = '1';
      const wt = createWorktree(repo, 'feat/nolink');
      assert.ok(!fs.existsSync(path.join(wt, 'node_modules')), 'node_modules NOT linked when disabled');
    } finally {
      if (prev === undefined) delete process.env.BRAINCLAW_NO_LINK_DEPS;
      else process.env.BRAINCLAW_NO_LINK_DEPS = prev;
      spawnSync('git', ['worktree', 'remove', '--force', targetPath], { cwd: repo, encoding: 'utf-8' });
      fs.rmSync(targetPath, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
