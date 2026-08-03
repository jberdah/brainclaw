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
  detachWorktreeJunctions,
  resetWorktreeToRef,
  sanitizeBranchComponent,
  resolveWorktreeAddTimeoutMs,
  projectUsesNextjs,
  resolveWorktreeDepsMode,
  detectPackageManager,
  provisionWorktreeDeps,
} from '../../src/core/worktree.js';
import { saveConfig, defaultConfig } from '../../src/core/config.js';
import { buildProtocolSection } from '../../src/core/dispatcher.js';
import { createCoordinatorClaim, saveClaim, loadClaim } from '../../src/core/claims.js';
import { ensureMemoryDir } from '../../src/core/io.js';

// trp_37b05a15 — Next.js detection drives the Turbopack node_modules-symlink
// warning at worktree creation.
describe('projectUsesNextjs (Turbopack worktree warning)', () => {
  function tmpProject(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-next-'));
  }

  it('true when package.json has a `next` dependency', () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '16.0.0', react: '19' } }));
    assert.equal(projectUsesNextjs(dir), true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('true when next is a devDependency, or a next.config.* exists', () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { next: '16' } }));
    assert.equal(projectUsesNextjs(dir), true);
    fs.rmSync(dir, { recursive: true, force: true });

    const dir2 = tmpProject();
    fs.writeFileSync(path.join(dir2, 'package.json'), JSON.stringify({ dependencies: {} }));
    fs.writeFileSync(path.join(dir2, 'next.config.mjs'), 'export default {};\n');
    assert.equal(projectUsesNextjs(dir2), true);
    fs.rmSync(dir2, { recursive: true, force: true });
  });

  it('false for a non-Next project, and never throws on missing/malformed package.json', () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '19' } }));
    assert.equal(projectUsesNextjs(dir), false);
    fs.rmSync(dir, { recursive: true, force: true });

    const empty = tmpProject();
    assert.equal(projectUsesNextjs(empty), false, 'no package.json → false, no throw');
    fs.writeFileSync(path.join(empty, 'package.json'), '{ not valid json');
    assert.equal(projectUsesNextjs(empty), false, 'malformed package.json → false, no throw');
    fs.rmSync(empty, { recursive: true, force: true });
  });
});

// trp_37b05a15 — per-worktree dependency mode (link | install | copy | none).
describe('resolveWorktreeDepsMode', () => {
  function tmpProject(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-depsmode-'));
  }

  // Save/restore the env vars this resolver reads so tests never leak into each
  // other or inherit an agent shell's settings.
  function withCleanEnv<T>(fn: () => T): T {
    const saved = {
      mode: process.env.BRAINCLAW_WORKTREE_DEPS_MODE,
      noLink: process.env.BRAINCLAW_NO_LINK_DEPS,
    };
    delete process.env.BRAINCLAW_WORKTREE_DEPS_MODE;
    delete process.env.BRAINCLAW_NO_LINK_DEPS;
    try {
      return fn();
    } finally {
      if (saved.mode === undefined) delete process.env.BRAINCLAW_WORKTREE_DEPS_MODE;
      else process.env.BRAINCLAW_WORKTREE_DEPS_MODE = saved.mode;
      if (saved.noLink === undefined) delete process.env.BRAINCLAW_NO_LINK_DEPS;
      else process.env.BRAINCLAW_NO_LINK_DEPS = saved.noLink;
    }
  }

  it('defaults to `link` with no env and no config', () => {
    withCleanEnv(() => {
      const dir = tmpProject();
      assert.equal(resolveWorktreeDepsMode(dir), 'link');
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  it('env BRAINCLAW_WORKTREE_DEPS_MODE wins over everything (case-insensitive)', () => {
    withCleanEnv(() => {
      const dir = tmpProject();
      const cfg = defaultConfig('test');
      cfg.worktree = { shared_paths: [], exclude_shared: [], deps_mode: 'copy' };
      saveConfig(cfg, dir);
      process.env.BRAINCLAW_NO_LINK_DEPS = '1'; // would map to none…
      process.env.BRAINCLAW_WORKTREE_DEPS_MODE = 'INSTALL'; // …but the explicit mode wins
      assert.equal(resolveWorktreeDepsMode(dir), 'install');
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  it('BRAINCLAW_NO_LINK_DEPS=1 maps to `none` (backward compat), above config', () => {
    withCleanEnv(() => {
      const dir = tmpProject();
      const cfg = defaultConfig('test');
      cfg.worktree = { shared_paths: [], exclude_shared: [], deps_mode: 'install' };
      saveConfig(cfg, dir);
      process.env.BRAINCLAW_NO_LINK_DEPS = '1';
      assert.equal(resolveWorktreeDepsMode(dir), 'none');
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  it('reads config worktree.deps_mode when no env override', () => {
    withCleanEnv(() => {
      const dir = tmpProject();
      const cfg = defaultConfig('test');
      cfg.worktree = { shared_paths: [], exclude_shared: [], deps_mode: 'install' };
      saveConfig(cfg, dir);
      assert.equal(resolveWorktreeDepsMode(dir), 'install');
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  it('ignores an invalid env value and falls through to the default', () => {
    withCleanEnv(() => {
      const dir = tmpProject();
      process.env.BRAINCLAW_WORKTREE_DEPS_MODE = 'symlink'; // not a valid mode
      assert.equal(resolveWorktreeDepsMode(dir), 'link');
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
});

describe('detectPackageManager', () => {
  function tmpProject(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-pm-'));
  }

  it('detects each package manager from its lockfile', () => {
    const cases: Array<[string, string]> = [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['bun.lockb', 'bun'],
      ['package-lock.json', 'npm'],
    ];
    for (const [lockfile, expected] of cases) {
      const dir = tmpProject();
      fs.writeFileSync(path.join(dir, lockfile), '');
      assert.equal(detectPackageManager(dir), expected, `${lockfile} → ${expected}`);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lockfile beats the packageManager field', () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.0.0' }));
    assert.equal(detectPackageManager(dir), 'pnpm');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to the packageManager field, then to npm', () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.0.0' }));
    assert.equal(detectPackageManager(dir), 'yarn');
    fs.rmSync(dir, { recursive: true, force: true });

    const bare = tmpProject();
    assert.equal(detectPackageManager(bare), 'npm', 'no lockfile, no field → npm');
    fs.rmSync(bare, { recursive: true, force: true });
  });
});

describe('provisionWorktreeDeps', () => {
  function tmpPair(): { main: string; target: string } {
    const main = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-prov-main-'));
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-prov-tgt-'));
    return { main, target };
  }

  it('copy mode mirrors node_modules as a REAL in-root directory', () => {
    const { main, target } = tmpPair();
    try {
      fs.mkdirSync(path.join(main, 'node_modules', 'left-pad'), { recursive: true });
      fs.writeFileSync(path.join(main, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 0;');
      const warnings = provisionWorktreeDeps('copy', main, target, ['node_modules']);
      assert.deepEqual(warnings, []);
      const dest = path.join(target, 'node_modules', 'left-pad', 'index.js');
      assert.ok(fs.existsSync(dest), 'copied file exists in worktree');
      assert.ok(!fs.lstatSync(path.join(target, 'node_modules')).isSymbolicLink(), 'node_modules is a real dir, not a symlink');
    } finally {
      fs.rmSync(main, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('copy mode warns (does not throw) when there is nothing to copy but the project is JS', () => {
    const { main, target } = tmpPair();
    try {
      fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'x' }));
      const warnings = provisionWorktreeDeps('copy', main, target, ['node_modules']);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /no node_modules found in the main tree/);
    } finally {
      fs.rmSync(main, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('copy mode is a silent no-op for a non-JS project with nothing to copy', () => {
    const { main, target } = tmpPair();
    try {
      const warnings = provisionWorktreeDeps('copy', main, target, ['node_modules']);
      assert.deepEqual(warnings, []);
    } finally {
      fs.rmSync(main, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('install mode is a silent no-op when the worktree has no package.json (never shells out)', () => {
    const { main, target } = tmpPair();
    try {
      const warnings = provisionWorktreeDeps('install', main, target, []);
      assert.deepEqual(warnings, []);
      assert.ok(!fs.existsSync(path.join(target, 'node_modules')), 'no install ran');
    } finally {
      fs.rmSync(main, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  // Codex review P1: a SOURCE node_modules that is itself a symlink/junction must
  // be dereferenced so the copy is a REAL in-root dir (else Turbopack still rejects).
  it('copy mode dereferences a symlinked source node_modules into a real in-root dir', () => {
    const { main, target } = tmpPair();
    // The real node_modules lives elsewhere; main/node_modules is a junction to it
    // (mirrors a main tree whose node_modules is itself linked).
    const realStore = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-prov-store-'));
    try {
      fs.mkdirSync(path.join(realStore, 'left-pad'), { recursive: true });
      fs.writeFileSync(path.join(realStore, 'left-pad', 'index.js'), 'module.exports = 0;');
      try {
        fs.symlinkSync(realStore, path.join(main, 'node_modules'), 'junction');
      } catch {
        return; // environment can't create junctions — skip (link mode is the fallback anyway)
      }
      assert.ok(fs.lstatSync(path.join(main, 'node_modules')).isSymbolicLink(), 'precondition: source is a link');
      const warnings = provisionWorktreeDeps('copy', main, target, ['node_modules']);
      assert.deepEqual(warnings, []);
      const nm = path.join(target, 'node_modules');
      assert.ok(!fs.lstatSync(nm).isSymbolicLink(), 'dest node_modules is a REAL dir, not a re-copied link');
      assert.ok(fs.existsSync(path.join(nm, 'left-pad', 'index.js')), 'contents dereferenced through the link');
    } finally {
      fs.rmSync(main, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
      fs.rmSync(realStore, { recursive: true, force: true });
    }
  });
});

// Codex review P1 — the dispatch brief must reflect whether in-root provisioning
// actually succeeded, not just the requested mode.
describe('buildProtocolSection — deps-mode brief honesty (trp_37b05a15)', () => {
  function worktreeWithSidecar(sidecar: Record<string, unknown>): string {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-brief-'));
    fs.writeFileSync(path.join(wt, '.brainclaw-worktree.json'), JSON.stringify(sidecar));
    return wt;
  }

  it('install + deps_provisioned=true → tells the worker deps are ready (do NOT reinstall)', () => {
    const wt = worktreeWithSidecar({ deps_mode: 'install', deps_provisioned: true });
    const brief = buildProtocolSection({ worktreePath: wt });
    assert.match(brief, /real in-root directory \(deps_mode=install\)/);
    assert.match(brief, /do NOT reinstall/);
    fs.rmSync(wt, { recursive: true, force: true });
  });

  it('install + deps_provisioned=false → tells the worker provisioning FAILED, install first', () => {
    const wt = worktreeWithSidecar({ deps_mode: 'install', deps_provisioned: false });
    const brief = buildProtocolSection({ worktreePath: wt });
    assert.match(brief, /FAILED/);
    assert.match(brief, /Run the project's install/);
    assert.ok(!/do NOT reinstall/.test(brief), 'must not claim deps are ready on failure');
    fs.rmSync(wt, { recursive: true, force: true });
  });

  it('no sidecar → default link-mode dependency text', () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-brief-nolink-'));
    const brief = buildProtocolSection({ worktreePath: wt });
    assert.match(brief, /node_modules is linked from the main repo/);
    fs.rmSync(wt, { recursive: true, force: true });
  });
});

describe('createWorktree deps_mode wiring (trp_37b05a15)', () => {
  function initRepo(prefix: string): { repo: string; git: (args: string[]) => void } {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const git = (args: string[]): void => {
      const r = spawnSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=T', ...args], { cwd: repo, encoding: 'utf-8' });
      assert.equal(r.status, 0, r.stderr || r.stdout);
    };
    git(['init']);
    git(['commit', '--allow-empty', '-m', 'init']);
    return { repo, git };
  }

  function readSidecar(wt: string): { deps_mode?: string; deps_provisioned?: boolean; symlink_warnings?: string[] } {
    return JSON.parse(fs.readFileSync(path.join(wt, '.brainclaw-worktree.json'), 'utf-8'));
  }

  it('copy mode → node_modules is a real in-root dir, no Turbopack warning, sidecar records deps_mode', () => {
    const prev = process.env.BRAINCLAW_WORKTREE_DEPS_MODE;
    process.env.BRAINCLAW_WORKTREE_DEPS_MODE = 'copy';
    const { repo } = initRepo('bclaw-wt-copy-');
    // A Next.js project WITH a populated node_modules in the main tree.
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ dependencies: { next: '16.0.0' } }));
    fs.mkdirSync(path.join(repo, 'node_modules', 'next'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', 'next', 'index.js'), '');
    const targetPath = resolveWorktreePath(repo, 'feat/copy');
    try {
      const wt = createWorktree(repo, 'feat/copy');
      const nm = path.join(wt, 'node_modules');
      assert.ok(fs.existsSync(path.join(nm, 'next', 'index.js')), 'node_modules copied into worktree');
      assert.ok(!fs.lstatSync(nm).isSymbolicLink(), 'node_modules is a real dir, not an out-of-root symlink');
      const sidecar = readSidecar(wt);
      assert.equal(sidecar.deps_mode, 'copy');
      assert.ok(!(sidecar.symlink_warnings ?? []).some((w) => /Turbopack/.test(w)), 'no Turbopack warning in copy mode');
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', targetPath], { cwd: repo, encoding: 'utf-8' });
      fs.rmSync(targetPath, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
      if (prev === undefined) delete process.env.BRAINCLAW_WORKTREE_DEPS_MODE;
      else process.env.BRAINCLAW_WORKTREE_DEPS_MODE = prev;
    }
  });

  it('link mode (default) → Next.js project gets the Turbopack symlink warning', () => {
    const prev = process.env.BRAINCLAW_WORKTREE_DEPS_MODE;
    delete process.env.BRAINCLAW_WORKTREE_DEPS_MODE; // default → link
    const prevNoLink = process.env.BRAINCLAW_NO_LINK_DEPS;
    delete process.env.BRAINCLAW_NO_LINK_DEPS;
    const { repo } = initRepo('bclaw-wt-link-');
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ dependencies: { next: '16.0.0' } }));
    fs.mkdirSync(path.join(repo, 'node_modules', 'next'), { recursive: true });
    const targetPath = resolveWorktreePath(repo, 'feat/link');
    try {
      const wt = createWorktree(repo, 'feat/link');
      const sidecar = readSidecar(wt);
      assert.ok((sidecar.symlink_warnings ?? []).some((w) => /Turbopack/.test(w)), 'Turbopack warning present in link mode');
      assert.equal(sidecar.deps_mode, undefined, 'default link mode is not recorded in the sidecar');
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', targetPath], { cwd: repo, encoding: 'utf-8' });
      fs.rmSync(targetPath, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
      if (prev !== undefined) process.env.BRAINCLAW_WORKTREE_DEPS_MODE = prev;
      if (prevNoLink !== undefined) process.env.BRAINCLAW_NO_LINK_DEPS = prevNoLink;
    }
  });

  it('none mode → no node_modules provisioned at all', () => {
    const prev = process.env.BRAINCLAW_WORKTREE_DEPS_MODE;
    process.env.BRAINCLAW_WORKTREE_DEPS_MODE = 'none';
    const { repo } = initRepo('bclaw-wt-none-');
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ dependencies: { next: '16.0.0' } }));
    fs.mkdirSync(path.join(repo, 'node_modules', 'next'), { recursive: true });
    const targetPath = resolveWorktreePath(repo, 'feat/none');
    try {
      const wt = createWorktree(repo, 'feat/none');
      assert.ok(!fs.existsSync(path.join(wt, 'node_modules')), 'no node_modules in none mode');
      assert.equal(readSidecar(wt).deps_mode, 'none');
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', targetPath], { cwd: repo, encoding: 'utf-8' });
      fs.rmSync(targetPath, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
      if (prev === undefined) delete process.env.BRAINCLAW_WORKTREE_DEPS_MODE;
      else process.env.BRAINCLAW_WORKTREE_DEPS_MODE = prev;
    }
  });

  // Codex review P1: a failed best-effort provisioning must record deps_provisioned=false
  // so the brief can tell the worker to install. copy mode + a JS project with NO
  // node_modules in the main tree is a deterministic provisioning failure.
  it('copy mode with nothing to copy records deps_provisioned=false in the sidecar', () => {
    const prev = process.env.BRAINCLAW_WORKTREE_DEPS_MODE;
    process.env.BRAINCLAW_WORKTREE_DEPS_MODE = 'copy';
    const { repo, git } = initRepo('bclaw-wt-copyfail-');
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ dependencies: { next: '16.0.0' } }));
    // committed so the worktree checkout has it (the "nothing to copy but JS
    // project" warning checks the worktree root); deliberately NO node_modules.
    git(['add', 'package.json']);
    git(['commit', '-m', 'add package.json']);
    const targetPath = resolveWorktreePath(repo, 'feat/copyfail');
    try {
      const wt = createWorktree(repo, 'feat/copyfail');
      const sidecar = readSidecar(wt);
      assert.equal(sidecar.deps_mode, 'copy');
      assert.equal(sidecar.deps_provisioned, false, 'failed provisioning recorded');
      assert.ok(!fs.existsSync(path.join(wt, 'node_modules')), 'no node_modules materialized');
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', targetPath], { cwd: repo, encoding: 'utf-8' });
      fs.rmSync(targetPath, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
      if (prev === undefined) delete process.env.BRAINCLAW_WORKTREE_DEPS_MODE;
      else process.env.BRAINCLAW_WORKTREE_DEPS_MODE = prev;
    }
  });
});

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
        /Cannot (reset|reuse) branch feat\/live: it is checked out in worktree/,
      );
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', externalWorktree], { cwd: repo, encoding: 'utf-8' });
      fs.rmSync(targetPath, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(externalWorktree, { recursive: true, force: true });
    }
  });
});

describe('resetWorktreeToRef (pln#520 Tier 2 — reused-claim ref pinning)', () => {
  it('hard-resets an existing worktree to the given ref', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-wt-reset-ref-'));
    const targetPath = resolveWorktreePath(repo, 'feat/pinned');
    const git = (args: string[], cwd = repo) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result;
    };
    const headOf = (cwd: string) => spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf-8' }).stdout.trim();

    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      git(['init']);
      git(['-c', 'user.email=t@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'c1']);
      const firstSha = git(['rev-parse', 'HEAD']).stdout.trim();
      git(['-c', 'user.email=t@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'c2']);
      const secondSha = git(['rev-parse', 'HEAD']).stdout.trim();

      // Worktree starts at HEAD (c2).
      const wt = createWorktree(repo, 'feat/pinned', { baseRef: 'HEAD' });
      assert.equal(headOf(wt), secondSha);

      // Re-point it back to c1 — this is what a reused-claim ref dispatch needs.
      const res = resetWorktreeToRef(wt, firstSha);
      assert.ok(res.ok, res.stderr);
      assert.equal(headOf(wt), firstSha);
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', targetPath], { cwd: repo, encoding: 'utf-8' });
      fs.rmSync(targetPath, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('reports (does not silently keep) untracked residue left after the reset', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-wt-reset-residue-'));
    const targetPath = resolveWorktreePath(repo, 'feat/pinned');
    const git = (args: string[], cwd = repo) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result;
    };
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      git(['init']);
      git(['-c', 'user.email=t@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'c1']);
      const firstSha = git(['rev-parse', 'HEAD']).stdout.trim();
      git(['-c', 'user.email=t@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'c2']);

      const wt = createWorktree(repo, 'feat/pinned', { baseRef: 'HEAD' });
      // Simulate stale artefacts from a prior worker run (untracked, non-ignored).
      fs.writeFileSync(path.join(wt, 'stale-artifact.txt'), 'left over from last run');

      const res = resetWorktreeToRef(wt, firstSha);
      assert.equal(res.ok, false, 'untracked residue must be reported, not silently kept');
      assert.match(res.stderr, /untracked file\(s\) remain/);
      assert.match(res.stderr, /stale-artifact\.txt/);
      // HEAD did still move to the ref — the report is about leftover untracked files.
      assert.equal(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf-8' }).stdout.trim(), firstSha);
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', targetPath], { cwd: repo, encoding: 'utf-8' });
      fs.rmSync(targetPath, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('ignores the brainclaw sidecar when checking for residue (clean reset → ok)', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-wt-reset-sidecar-'));
    const targetPath = resolveWorktreePath(repo, 'feat/pinned');
    const git = (args: string[], cwd = repo) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result;
    };
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      git(['init']);
      git(['-c', 'user.email=t@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'c1']);
      const firstSha = git(['rev-parse', 'HEAD']).stdout.trim();
      git(['-c', 'user.email=t@example.com', '-c', 'user.name=Test', 'commit', '--allow-empty', '-m', 'c2']);

      // createWorktree writes .brainclaw-worktree.json (untracked) — it must NOT
      // be counted as residue.
      const wt = createWorktree(repo, 'feat/pinned', { baseRef: 'HEAD' });
      assert.ok(fs.existsSync(path.join(wt, '.brainclaw-worktree.json')));

      const res = resetWorktreeToRef(wt, firstSha);
      assert.ok(res.ok, `expected clean reset, got: ${res.stderr}`);
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', targetPath], { cwd: repo, encoding: 'utf-8' });
      fs.rmSync(targetPath, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('returns ok=false (never throws) for a non-existent worktree path', () => {
    const res = resetWorktreeToRef(path.join(os.tmpdir(), 'bclaw-no-such-worktree-xyz'), 'HEAD');
    assert.equal(res.ok, false);
    assert.match(res.stderr, /does not exist/);
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

// pln#498 — detachWorktreeJunctions runs before `git worktree remove` so
// git's recursive rm cannot follow node_modules junction back into the main
// repo. The unit test exercises the symlink-detach behaviour directly.
describe('detachWorktreeJunctions (pln#498)', () => {
  it('unlinks top-level symlinks while preserving the target', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-detach-target-'));
    const importantFile = path.join(target, 'important.txt');
    fs.writeFileSync(importantFile, 'must-survive');

    const fakeWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-detach-wt-'));
    const linkPath = path.join(fakeWorktree, 'node_modules');
    fs.symlinkSync(target, linkPath, 'dir');

    // Sanity: link is a symlink before detach.
    assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);

    detachWorktreeJunctions(fakeWorktree);

    assert.equal(fs.existsSync(linkPath), false, 'symlink unlinked');
    assert.equal(fs.existsSync(target), true, 'target dir survived');
    assert.equal(fs.existsSync(importantFile), true, 'file under target survived');
    assert.equal(fs.readFileSync(importantFile, 'utf-8'), 'must-survive');

    // Cleanup
    fs.rmSync(fakeWorktree, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  });

  it('leaves regular files and directories untouched', () => {
    const fakeWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-detach-keep-'));
    fs.writeFileSync(path.join(fakeWorktree, 'keep.txt'), 'x');
    fs.mkdirSync(path.join(fakeWorktree, 'sub'));
    fs.writeFileSync(path.join(fakeWorktree, 'sub', 'nested.txt'), 'y');

    detachWorktreeJunctions(fakeWorktree);

    assert.equal(fs.existsSync(path.join(fakeWorktree, 'keep.txt')), true);
    assert.equal(fs.existsSync(path.join(fakeWorktree, 'sub', 'nested.txt')), true);

    fs.rmSync(fakeWorktree, { recursive: true, force: true });
  });

  it('unlinks nested symlinks while preserving the target', () => {
    // trp#926 — nested monorepo shared paths must be detached too; leaving
    // these in place lets git's recursive remove follow them into the main repo.
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-detach-nested-target-'));
    fs.writeFileSync(path.join(target, 't.txt'), 'nested');

    const fakeWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-detach-nested-wt-'));
    const sub = path.join(fakeWorktree, 'sub');
    fs.mkdirSync(sub);
    const nestedLink = path.join(sub, 'inner-link');
    fs.symlinkSync(target, nestedLink, 'dir');

    detachWorktreeJunctions(fakeWorktree);

    assert.equal(fs.existsSync(nestedLink), false, 'nested symlink unlinked');
    assert.equal(fs.existsSync(path.join(target, 't.txt')), true, 'target survived');

    fs.rmSync(fakeWorktree, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  });

  it('throws when the recursive scan exceeds its depth cap', () => {
    const fakeWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-detach-deep-'));
    let deep = fakeWorktree;
    for (let i = 0; i < 10; i++) {
      deep = path.join(deep, `d${i}`);
      fs.mkdirSync(deep);
    }

    assert.throws(
      () => detachWorktreeJunctions(fakeWorktree),
      /scan depth exceeded/,
      'an incomplete scan must fail closed before git worktree remove can run',
    );

    fs.rmSync(fakeWorktree, { recursive: true, force: true });
  });

  it('is idempotent on a missing path', () => {
    const phantom = path.join(os.tmpdir(), 'bclaw-detach-phantom-' + Date.now());
    assert.doesNotThrow(() => detachWorktreeJunctions(phantom));
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

// Dogfood 1.10.1 — the branch slug derived from a multi-file scope must be a
// VALID git ref even after the 48-char length cap. Regression: the cap was the
// LAST step, so it could re-introduce a trailing dot the sanitizer had removed
// (`…IntegrationHubPage.astro` cut at 48 → `…IntegrationHubPage.` → git reject).
describe('sanitizeBranchComponent — cap never produces an invalid ref', () => {
  // Validate against real git ref-naming rules, not a hand-rolled regex.
  const gitAcceptsBranch = (slug: string): boolean =>
    spawnSync('git', ['check-ref-format', `refs/heads/feat/${slug}`], { encoding: 'utf-8' }).status === 0;

  it('does not leave a trailing dot when the 48-char cut lands on one (cleanup lane repro)', () => {
    const scope = 'src/data/agents.ts, src/views/IntegrationHubPage.astro';
    const slug = sanitizeBranchComponent(scope);
    assert.ok(slug.length <= 48, `slug too long: ${slug.length}`);
    assert.doesNotMatch(slug, /[.-]$/, `slug must not end in dot/dash: "${slug}"`);
    assert.ok(gitAcceptsBranch(slug), `git must accept feat/${slug}`);
  });

  it('keeps already-valid long multi-file scopes valid (docs-fixes / structure-init lanes)', () => {
    for (const scope of [
      'src/content/docs/canonical-grammar.mdx, src/content/docs/common-commands.mdx, src/content/docs/troubleshooting.mdx',
      'src/components/WhatIsBrainclaw.astro, src/views/DocsPage.astro, src/content/docs/quickstart.mdx',
    ]) {
      const slug = sanitizeBranchComponent(scope);
      assert.ok(slug.length <= 48, `slug too long for "${scope}": ${slug.length}`);
      assert.ok(gitAcceptsBranch(slug), `git must accept feat/${slug}`);
    }
  });

  it('still strips a leading dot (.github/workflows regression, can_45316d5c)', () => {
    const slug = sanitizeBranchComponent('.github/workflows/ci.yml');
    assert.doesNotMatch(slug, /^[.-]/, `slug must not start with dot/dash: "${slug}"`);
    assert.ok(gitAcceptsBranch(slug), `git must accept feat/${slug}`);
  });

  it('does not end in .lock even when the cut creates a `.lock` suffix', () => {
    // 43 chars + ".lock" = exactly 48 → the cap lands right after `.lock`.
    const scope = 'a'.repeat(43) + '.lock-then-more-text-after-the-cut';
    const slug = sanitizeBranchComponent(scope);
    assert.doesNotMatch(slug, /\.lock$/i, `slug must not end in .lock: "${slug}"`);
    assert.doesNotMatch(slug, /[.-]$/);
    assert.ok(gitAcceptsBranch(slug), `git must accept feat/${slug}`);
  });

  it('falls back to "scope" when the input sanitizes to empty', () => {
    assert.equal(sanitizeBranchComponent('...///...'), 'scope');
  });

  // trp#950 (dogfood 2026-07-15, β/γ): two distinct scopes sharing a >48-char
  // prefix used to collapse to the SAME branch → same worktree → the 2nd
  // claim/assign was refused. Repro prefix: applications/marketing_descriptions/
  // backend/app/… (exactly 48 chars before the distinguishing filename).
  it('does NOT collide when two long scopes share a >48-char prefix', () => {
    const scopeA = 'applications/marketing_descriptions/backend/app/serviceA.ts';
    const scopeB = 'applications/marketing_descriptions/backend/app/serviceB.ts';
    const slugA = sanitizeBranchComponent(scopeA);
    const slugB = sanitizeBranchComponent(scopeB);
    assert.notEqual(slugA, slugB, `distinct scopes must map to distinct branches; both gave "${slugA}"`);
    assert.ok(slugA.length <= 48 && slugB.length <= 48, 'both slugs must respect the cap');
    assert.ok(gitAcceptsBranch(slugA) && gitAcceptsBranch(slugB), 'git must accept both branches');
  });

  it('is deterministic — the same scope always yields the same slug (resume/re-assign)', () => {
    const scope = 'applications/marketing_descriptions/backend/app/serviceA.ts';
    assert.equal(sanitizeBranchComponent(scope), sanitizeBranchComponent(scope));
  });

  it('leaves short scopes (≤ cap) untouched — no hash suffix, backward compatible', () => {
    // No truncation → no digest suffix; output is the plain sanitized slug.
    assert.equal(sanitizeBranchComponent('src/core/foo.ts'), 'src-core-foo.ts');
    assert.doesNotMatch(sanitizeBranchComponent('src/core/foo.ts'), /-[0-9a-f]{8}$/);
  });
});

// Dogfood 1.10.1 — `git worktree add` checks out the whole tree; a flat 15s cap
// killed 662-file checkouts mid-stream. The add timeout is its own, larger knob.
describe('resolveWorktreeAddTimeoutMs', () => {
  const KEY = 'BRAINCLAW_WORKTREE_ADD_TIMEOUT_MS';
  const restore = (prev: string | undefined): void => {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
  };

  it('defaults to 120s and is far larger than the 15s query timeout', () => {
    const prev = process.env[KEY];
    delete process.env[KEY];
    try {
      assert.equal(resolveWorktreeAddTimeoutMs(), 120_000);
      assert.ok(resolveWorktreeAddTimeoutMs() >= 15000 * 4);
    } finally {
      restore(prev);
    }
  });

  it('honours a valid env override', () => {
    const prev = process.env[KEY];
    process.env[KEY] = '300000';
    try {
      assert.equal(resolveWorktreeAddTimeoutMs(), 300_000);
    } finally {
      restore(prev);
    }
  });

  it('ignores a non-positive / non-numeric override and uses the default', () => {
    const prev = process.env[KEY];
    try {
      for (const bad of ['0', '-5', 'abc', '']) {
        process.env[KEY] = bad;
        assert.equal(resolveWorktreeAddTimeoutMs(), 120_000, `bad value "${bad}" should fall back`);
      }
    } finally {
      restore(prev);
    }
  });
});

// pln#642 — re-dispatch hygiene (trp_e824d2af + trp_72b4e9b3). A loop-scoped
// dispatch derives the SAME branch/path every round, so round 2 either reused
// a worktree still carrying round 1's LANE-RESULT.json (a TERMINAL SIGNAL that
// then lied about the fresh worker), or collided on the path and wedged the
// scope. All observed live, 2026-08-02/03.
describe('re-dispatch hygiene (trp_e824d2af / trp_72b4e9b3)', () => {
  function initRepo(prefix: string): { repo: string; git: (args: string[]) => void } {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const git = (args: string[]): void => {
      const r = spawnSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=T', ...args], { cwd: repo, encoding: 'utf-8' });
      assert.equal(r.status, 0, r.stderr || r.stdout);
    };
    git(['init']);
    git(['commit', '--allow-empty', '-m', 'init']);
    return { repo, git };
  }

  function cleanup(repo: string, targetPath: string): void {
    spawnSync('git', ['worktree', 'remove', '--force', targetPath], { cwd: repo, encoding: 'utf-8' });
    fs.rmSync(targetPath, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }

  it('resetWorktreeToRef ARCHIVES a prior LANE-RESULT.json out of the signal path (trp_e824d2af)', () => {
    const { repo } = initRepo('bclaw-wt-lane-');
    const targetPath = resolveWorktreePath(repo, 'feat/lane-archive');
    try {
      const wt = createWorktree(repo, 'feat/lane-archive');
      fs.writeFileSync(path.join(wt, 'LANE-RESULT.json'), JSON.stringify({ assignment_id: 'asgn_round1', status: 'completed', summary: 'round 1 verdict' }));
      const reset = resetWorktreeToRef(wt, 'HEAD');
      assert.equal(reset.ok, true, `reset must pass once the terminal signal is archived: ${reset.stderr}`);
      assert.ok(!fs.existsSync(path.join(wt, 'LANE-RESULT.json')), 'the terminal-signal filename is freed for the next turn');
      const archived = fs.readdirSync(path.join(wt, '.brainclaw')).filter((f) => /^LANE-RESULT\.prev-\d+\.json$/.test(f));
      assert.equal(archived.length, 1, 'prior result preserved for forensics in the .brainclaw sidecar');
    } finally {
      cleanup(repo, targetPath);
    }
  });

  it('createWorktree ADOPTS an existing same-branch worktree instead of refusing (trp_72b4e9b3)', () => {
    const { repo, git } = initRepo('bclaw-wt-adopt-');
    const targetPath = resolveWorktreePath(repo, 'feat/adopt');
    try {
      const wt1 = createWorktree(repo, 'feat/adopt');
      fs.writeFileSync(path.join(wt1, 'LANE-RESULT.json'), JSON.stringify({ assignment_id: 'asgn_round1', status: 'completed', summary: 'round 1' }));
      // The base advances between rounds (a fix was merged).
      git(['commit', '--allow-empty', '-m', 'round 2 base']);
      const wt2 = createWorktree(repo, 'feat/adopt', { baseRef: 'HEAD', resetExistingBranch: true });
      assert.equal(path.resolve(wt2), path.resolve(wt1), 'same path adopted, not refused');
      assert.ok(!fs.existsSync(path.join(wt2, 'LANE-RESULT.json')), 'round 1 terminal signal archived on adoption');
      const headMain = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).stdout.trim();
      const headWt = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: wt2, encoding: 'utf-8' }).stdout.trim();
      assert.equal(headWt, headMain, 'adopted worktree re-pointed to the requested base');
      const sidecar = JSON.parse(fs.readFileSync(path.join(wt2, '.brainclaw-worktree.json'), 'utf-8'));
      assert.equal(sidecar.base_ref_sha, headMain, 'sidecar anchor re-stamped — commits_ahead counts from THIS round');
      assert.ok(sidecar.adopted_at, 'adoption is recorded');
    } finally {
      cleanup(repo, targetPath);
    }
  });

  it('adoption REFUSES when the branch carries unharvested commits (can_2e282880 contract preserved)', () => {
    const { repo, git } = initRepo('bclaw-wt-guard-');
    const targetPath = resolveWorktreePath(repo, 'feat/guard');
    try {
      const wt = createWorktree(repo, 'feat/guard');
      fs.writeFileSync(path.join(wt, 'WORK.md'), 'unharvested');
      const gitWt = (args: string[]) => spawnSync('git', ['-c', 'user.email=t@e.com', '-c', 'user.name=T', ...args], { cwd: wt, encoding: 'utf-8' });
      gitWt(['add', 'WORK.md']);
      gitWt(['commit', '-m', 'unharvested work']);
      git(['commit', '--allow-empty', '-m', 'new base']);
      assert.throws(
        () => createWorktree(repo, 'feat/guard', { baseRef: 'HEAD' }),
        /unharvested/i,
        'without an explicit reset pin, adoption must never destroy commits',
      );
    } finally {
      cleanup(repo, targetPath);
    }
  });

  it('a FOREIGN directory at the worktree path still refuses (adoption is worktree-of-this-repo only)', () => {
    const { repo } = initRepo('bclaw-wt-foreign-');
    const targetPath = resolveWorktreePath(repo, 'feat/foreign');
    try {
      fs.mkdirSync(targetPath, { recursive: true });
      fs.writeFileSync(path.join(targetPath, 'random.txt'), 'not a worktree');
      assert.throws(
        () => createWorktree(repo, 'feat/foreign'),
        /already exists/,
        'an unregistered directory is never adopted',
      );
    } finally {
      cleanup(repo, targetPath);
    }
  });

  it('createCoordinatorClaim HEALS a reused worktree-less claim instead of wedging the scope (trp_72b4e9b3)', () => {
    // The wedge: a claim persisted after a failed worktree creation had no
    // worktree_path, and every later dispatch reused it → "Reused claim has no
    // worktree to pin" → spawn refused, forever, until a human intervened.
    const { repo } = initRepo('bclaw-wt-heal-');
    ensureMemoryDir(repo);
    const scope = 'review-loop:lop_heal';
    saveClaim({
      schema_version: 2, id: 'clm_wedged', agent: 'codex', scope,
      description: 'claim persisted after a failed worktree creation',
      created_at: new Date().toISOString(), status: 'active',
    }, repo);
    const targetPath = resolveWorktreePath(repo, `feat/${sanitizeBranchComponent(scope)}`);
    try {
      const result = createCoordinatorClaim({
        agent: 'codex', scope, description: 'round 2 dispatch',
        dispatcherAgent: 'coord', cwd: repo, worktreeBaseRef: 'HEAD',
      });
      assert.equal(result.claimId, 'clm_wedged', 'the existing claim is reused, not duplicated');
      assert.ok(result.worktreePath, 'a worktree is provisioned for the healed claim');
      assert.equal(result.worktreeWarning, undefined, 'no more "has no worktree to pin" dead-end');
      assert.equal(loadClaim('clm_wedged', repo)?.worktree_path, result.worktreePath, 'the claim record is patched');
    } finally {
      cleanup(repo, targetPath);
    }
  });
});
