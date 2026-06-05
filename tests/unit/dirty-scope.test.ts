import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assessDirtyDispatchGuard,
  isSystemDirtyPath,
  parsePorcelainZ,
  resolveScopeToPathspecs,
  type GitStatusRunner,
} from '../../src/core/dirty-scope.js';

/** Build a porcelain=v1 -z record. Rename callers pass [new, old]. */
function entry(status: string, ...paths: string[]): string {
  // "XY <path>\0[<origPath>\0]" — status is always 2 chars.
  return `${status} ${paths.join('\0')}\0`;
}

/**
 * Mock git runner: the scoped probe is the one carrying a `--` pathspec
 * separator; the global probe has none. Lets each test drive the two calls
 * independently without a real repo.
 */
function mockGit(opts: { global?: string; scoped?: string; ok?: boolean; refExists?: boolean }): GitStatusRunner {
  return (_cwd, args) => {
    if (opts.ok === false) return { ok: false, stdout: '' };
    if (args[0] === 'rev-parse') {
      const exists = opts.refExists !== false; // default: the ref resolves
      return { ok: exists, stdout: exists ? 'deadbeef\n' : '' };
    }
    const isScoped = args.includes('--');
    return { ok: true, stdout: (isScoped ? opts.scoped : opts.global) ?? '' };
  };
}

describe('parsePorcelainZ', () => {
  it('parses modified + untracked entries', () => {
    const out = entry(' M', 'src/a.ts') + entry('??', 'src/b.ts');
    assert.deepEqual(parsePorcelainZ(out), ['src/a.ts', 'src/b.ts']);
  });

  it('keeps BOTH sides of a rename (new path then original)', () => {
    const out = entry('R ', 'src/new.ts', 'src/old.ts');
    assert.deepEqual(parsePorcelainZ(out), ['src/new.ts', 'src/old.ts']);
  });

  it('handles a copy entry like a rename', () => {
    const out = entry('C ', 'src/copy.ts', 'src/origin.ts');
    assert.deepEqual(parsePorcelainZ(out), ['src/copy.ts', 'src/origin.ts']);
  });

  it('ignores empty output and malformed short entries', () => {
    assert.deepEqual(parsePorcelainZ(''), []);
    assert.deepEqual(parsePorcelainZ('XY\0'), []); // too short to carry a path
  });

  it('does not mis-consume a normal entry that follows a rename', () => {
    const out = entry('R ', 'src/new.ts', 'src/old.ts') + entry(' M', 'src/c.ts');
    assert.deepEqual(parsePorcelainZ(out), ['src/new.ts', 'src/old.ts', 'src/c.ts']);
  });
});

describe('isSystemDirtyPath', () => {
  it('flags the coordination store and git dir (both slash styles)', () => {
    assert.equal(isSystemDirtyPath('.brainclaw/coordination/claims/clm_x.json'), true);
    assert.equal(isSystemDirtyPath('.brainclaw\\coordination\\x.json'), true);
    assert.equal(isSystemDirtyPath('.git/index'), true);
    assert.equal(isSystemDirtyPath('.brainclaw'), true);
  });

  it('flags per-agent local config dirs (trp#371): .claude, .cursor, .codex', () => {
    assert.equal(isSystemDirtyPath('.claude/settings.json'), true);
    assert.equal(isSystemDirtyPath('.claude'), true);
    assert.equal(isSystemDirtyPath('.cursor/rules/x.md'), true);
    assert.equal(isSystemDirtyPath('.codex/config.toml'), true);
  });

  it('does not flag real source paths', () => {
    assert.equal(isSystemDirtyPath('src/core/dirty-scope.ts'), false);
    assert.equal(isSystemDirtyPath('.brainclawignore'), false); // not a .brainclaw/ child
    assert.equal(isSystemDirtyPath('.clauderc'), false); // not a .claude/ child
  });
});

describe('resolveScopeToPathspecs', () => {
  const cwd = process.cwd();

  it('returns unknown for empty / missing scope', () => {
    assert.equal(resolveScopeToPathspecs(undefined, cwd).kind, 'unknown');
    assert.equal(resolveScopeToPathspecs('   ', cwd).kind, 'unknown');
  });

  it('returns unknown for entity ids and loop refs', () => {
    assert.equal(resolveScopeToPathspecs('pln#520', cwd).kind, 'unknown');
    assert.equal(resolveScopeToPathspecs('pln_03408ada', cwd).kind, 'unknown');
    assert.equal(resolveScopeToPathspecs('review-loop:lop_5fc24cc8', cwd).kind, 'unknown');
    assert.equal(resolveScopeToPathspecs('clm_abcd1234', cwd).kind, 'unknown');
  });

  it('returns unknown for prose (whitespace) scopes', () => {
    const r = resolveScopeToPathspecs('refactor src/auth before tests', cwd);
    assert.equal(r.kind, 'unknown');
  });

  it('resolves a known top-level prefix even if it is not on disk', () => {
    const r = resolveScopeToPathspecs('src/does/not/exist/yet.ts', cwd);
    assert.equal(r.kind, 'pathspecs');
    assert.deepEqual(r.kind === 'pathspecs' && r.pathspecs, ['src/does/not/exist/yet.ts']);
  });

  it('resolves an on-disk path that is not a known top-level', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-scope-'));
    try {
      fs.writeFileSync(path.join(dir, 'weird.txt'), 'x');
      const r = resolveScopeToPathspecs('weird.txt', dir);
      assert.equal(r.kind, 'pathspecs');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns unknown for a non-existent, non-top-level token (e.g. an agent name)', () => {
    assert.equal(resolveScopeToPathspecs('cursor', cwd).kind, 'unknown');
  });

  it('delegates globs to a git :(glob) pathspec', () => {
    const r = resolveScopeToPathspecs('src/content/**/*.fr.mdx', cwd);
    assert.equal(r.kind, 'pathspecs');
    assert.deepEqual(r.kind === 'pathspecs' && r.pathspecs, [':(glob)src/content/**/*.fr.mdx']);
  });

  it('normalises Windows backslashes', () => {
    const r = resolveScopeToPathspecs('src\\core\\x.ts', cwd);
    assert.equal(r.kind, 'pathspecs');
    assert.deepEqual(r.kind === 'pathspecs' && r.pathspecs, ['src/core/x.ts']);
  });

  it('is all-or-nothing across comma tokens (one unresolvable → whole unknown)', () => {
    const r = resolveScopeToPathspecs('src/a.ts, pln#520', cwd);
    assert.equal(r.kind, 'unknown');
  });

  it('resolves a comma list of paths', () => {
    const r = resolveScopeToPathspecs('src/a.ts, docs/b.md', cwd);
    assert.equal(r.kind, 'pathspecs');
    assert.deepEqual(r.kind === 'pathspecs' && r.pathspecs, ['src/a.ts', 'docs/b.md']);
  });
});

describe('assessDirtyDispatchGuard', () => {
  const cwd = '/repo';

  it('allows when cwd is not a git repo (probe fails)', () => {
    const r = assessDirtyDispatchGuard({ cwd, scope: 'src/a.ts', runGit: mockGit({ ok: false }) });
    assert.equal(r.decision, 'allow');
  });

  it('allows a clean tree', () => {
    const r = assessDirtyDispatchGuard({ cwd, scope: 'src/a.ts', runGit: mockGit({ global: '' }) });
    assert.equal(r.decision, 'allow');
    assert.equal(r.dirtyCount, 0);
  });

  it('allows when only .brainclaw/ is dirty (system noise from dispatching)', () => {
    const global = entry(' M', '.brainclaw/coordination/claims/clm_x.json');
    const r = assessDirtyDispatchGuard({ cwd, scope: 'pln#520', runGit: mockGit({ global }) });
    assert.equal(r.decision, 'allow');
    assert.equal(r.dirtyCount, 0);
    assert.equal(r.ignoredSystemDirty.length, 1);
  });

  it('allows when a RESOLVABLE ref is given even with a dirty in-scope file', () => {
    const global = entry(' M', 'src/a.ts');
    const r = assessDirtyDispatchGuard({
      cwd, scope: 'src/a.ts', checkoutRef: 'abc123',
      runGit: mockGit({ global, scoped: global, refExists: true }),
    });
    assert.equal(r.decision, 'allow');
    assert.match(r.reason, /abc123/);
  });

  it('does NOT bypass on an UNRESOLVABLE ref — falls through to the scope-aware block', () => {
    const dirty = entry(' M', 'src/a.ts');
    const r = assessDirtyDispatchGuard({
      cwd, scope: 'src/a.ts', checkoutRef: 'no-such-ref',
      runGit: mockGit({ global: dirty, scoped: dirty, refExists: false }),
    });
    assert.equal(r.decision, 'block');
  });

  it('allows when dirty files do not overlap a resolvable scope', () => {
    const global = entry(' M', 'docs/readme.md');
    const r = assessDirtyDispatchGuard({
      cwd, scope: 'src/a.ts',
      runGit: mockGit({ global, scoped: '' }), // scoped probe finds nothing in scope
    });
    assert.equal(r.decision, 'allow');
    assert.equal(r.dirtyCount, 1);
    assert.equal(r.overlapping.length, 0);
  });

  it('blocks when dirty files overlap a resolvable scope', () => {
    const dirty = entry(' M', 'src/a.ts');
    const r = assessDirtyDispatchGuard({
      cwd, scope: 'src/a.ts',
      runGit: mockGit({ global: dirty, scoped: dirty }),
    });
    assert.equal(r.decision, 'block');
    assert.deepEqual(r.overlapping, ['src/a.ts']);
  });

  it('downgrades an in-scope overlap to a warning when allow_dirty=true', () => {
    const dirty = entry(' M', 'src/a.ts');
    const r = assessDirtyDispatchGuard({
      cwd, scope: 'src/a.ts', allowDirty: true,
      runGit: mockGit({ global: dirty, scoped: dirty }),
    });
    assert.equal(r.decision, 'warn');
    assert.match(r.reason, /allow_dirty=true/);
  });

  it('blocks when scope is unresolvable and the tree is dirty (conservative)', () => {
    const dirty = entry(' M', 'src/a.ts');
    const r = assessDirtyDispatchGuard({
      cwd, scope: 'review-loop:lop_x', runGit: mockGit({ global: dirty }),
    });
    assert.equal(r.decision, 'block');
    assert.equal(r.scopeResolution, 'unknown');
  });

  it('downgrades an unresolvable-scope block to a warning when allow_dirty=true', () => {
    const dirty = entry(' M', 'src/a.ts');
    const r = assessDirtyDispatchGuard({
      cwd, scope: 'review-loop:lop_x', allowDirty: true, runGit: mockGit({ global: dirty }),
    });
    assert.equal(r.decision, 'warn');
  });

  it('blocks on an untracked file inside the scope (worker never sees it)', () => {
    const dirty = entry('??', 'src/brand-new.ts');
    const r = assessDirtyDispatchGuard({
      cwd, scope: 'src/brand-new.ts',
      runGit: mockGit({ global: dirty, scoped: dirty }),
    });
    assert.equal(r.decision, 'block');
  });

  it('blocks on a rename whose original side is in scope', () => {
    const dirty = entry('R ', 'lib/new.ts', 'src/old.ts');
    const r = assessDirtyDispatchGuard({
      cwd, scope: 'src/old.ts',
      // git would surface the rename entry for the in-scope original path
      runGit: mockGit({ global: dirty, scoped: dirty }),
    });
    assert.equal(r.decision, 'block');
    assert.ok(r.overlapping.includes('src/old.ts'));
  });

  it('falls back conservatively when the scoped probe fails mid-flight', () => {
    const dirty = entry(' M', 'src/a.ts');
    const runGit: GitStatusRunner = (_cwd, args) =>
      args.includes('--') ? { ok: false, stdout: '' } : { ok: true, stdout: dirty };
    const r = assessDirtyDispatchGuard({ cwd, scope: 'src/a.ts', runGit });
    assert.equal(r.decision, 'block'); // scoped probe failure → treat as overlap
  });
});
