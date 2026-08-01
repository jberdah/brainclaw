/**
 * pln#636 C2 — server-side lazy conformity reconcile.
 *
 * The acceptance bar set by the design (and by review F3) is not "detects
 * violations" — it is **zero false accusations on the real corpus**, because
 * 42.4% of live claim scopes are not path-resolvable at all. A gate that
 * false-accuses teaches agents to ignore the channel, which is strictly worse
 * than shipping nothing. So most of these tests assert SILENCE.
 *
 * FIXTURE NOTE: raw temp dirs, not `createTestWorkspace` — see
 * claim-liveness-file-evidence.test.ts. These suites need a git repo and a
 * directory, never an identity or a store, and that helper mutates process-wide
 * env which is not safe under node's concurrent test-FILE execution.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectTouchedPaths, reconcileClaimConformity } from '../../src/core/claim-conformity.js';
import { classifyClaimScope } from '../../src/core/claim-scope.js';
import type { Claim } from '../../src/core/schema.js';

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function commitAll(cwd: string, message: string): string {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

describe('claim conformity — the footprint since the baseline', { concurrency: false }, () => {
  let repo: string;
  let baseSha: string;

  function claim(overrides: Partial<Claim> = {}): Claim {
    return {
      id: 'clm_conf',
      agent: 'codex',
      scope: 'src/core',
      description: 'work on core',
      created_at: new Date().toISOString(),
      status: 'active',
      base_sha: baseSha,
      ...overrides,
    } as Claim;
  }

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-conformity-'));
    for (const dir of ['src/core', 'src/commands', 'docs']) {
      fs.mkdirSync(path.join(repo, ...dir.split('/')), { recursive: true });
    }
    fs.writeFileSync(path.join(repo, 'src', 'core', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(repo, 'src', 'commands', 'b.ts'), 'export const b = 1;\n');
    git(repo, 'init', '-q');
    baseSha = commitAll(repo, 'base');
  });

  afterEach(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('sees an UNCOMMITTED stray — the dirty set counts', () => {
    fs.writeFileSync(path.join(repo, 'src', 'commands', 'b.ts'), 'export const b = 2;\n');
    const result = reconcileClaimConformity(claim(), repo);
    assert.equal(result.verdict.kind, 'out_of_scope');
    assert.equal(result.warning?.code, 'wrote_outside_claim_scope');
    assert.deepEqual(result.warning?.data?.unexpected_paths, ['src/commands/b.ts']);
  });

  it('sees a COMMITTED stray — and this is why base_sha exists (review F3)', () => {
    // The case that killed both options the design originally offered: the lane
    // commits mid-work, so `git status` is clean and `git diff HEAD` is empty.
    // Only a diff against the recorded baseline still sees the write.
    fs.writeFileSync(path.join(repo, 'src', 'commands', 'b.ts'), 'export const b = 3;\n');
    commitAll(repo, 'mid-work commit');
    assert.equal(git(repo, 'status', '--porcelain'), '', 'the worktree must be clean for this test to mean anything');

    const result = reconcileClaimConformity(claim(), repo);
    assert.equal(result.verdict.kind, 'out_of_scope', 'a committed stray must still be seen');
    assert.deepEqual(result.warning?.data?.unexpected_paths, ['src/commands/b.ts']);
  });

  it('stays SILENT when every write lands inside the declared scope', () => {
    fs.writeFileSync(path.join(repo, 'src', 'core', 'a.ts'), 'export const a = 2;\n');
    fs.writeFileSync(path.join(repo, 'src', 'core', 'new.ts'), 'export const n = 1;\n');
    const result = reconcileClaimConformity(claim(), repo);
    assert.equal(result.verdict.kind, 'in_scope');
    assert.equal(result.warning, undefined, 'in-scope work must emit nothing at all');
  });

  it('reports a brand-new untracked directory file-by-file, not as a directory', () => {
    // -uall matters: git's default collapses an untracked dir to `docs/new/`,
    // which no pathspec comparison would resolve.
    fs.mkdirSync(path.join(repo, 'docs', 'new'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'docs', 'new', 'x.md'), '# x\n');
    const touched = collectTouchedPaths(claim(), repo);
    assert.ok(touched.paths.includes('docs/new/x.md'), `expected the file, got ${JSON.stringify(touched.paths)}`);
  });

  it('parses an UNSTAGED edit at its true path, prefix column intact', () => {
    // Regression guard for a false accusation that hit every unstaged edit: the
    // porcelain prefix is fixed-width (` M src/x.ts`), so trimming the line
    // before slicing off 3 chars yields `rc/x.ts` — a path matching no pathspec,
    // reported as a stray. An in-scope edit must simply read as in scope.
    fs.writeFileSync(path.join(repo, 'src', 'core', 'a.ts'), 'export const a = 7;\n');
    const touched = collectTouchedPaths(claim(), repo);
    assert.ok(touched.paths.includes('src/core/a.ts'), `got ${JSON.stringify(touched.paths)}`);
    assert.ok(
      !touched.paths.some((p) => p === 'rc/core/a.ts'),
      'a truncated path proves the porcelain prefix was mangled',
    );
    assert.equal(reconcileClaimConformity(claim(), repo).verdict.kind, 'in_scope');
  });

  it('records the destination of a rename, not the arrow form', () => {
    git(repo, 'mv', 'src/commands/b.ts', 'src/commands/renamed.ts');
    const touched = collectTouchedPaths(claim(), repo);
    assert.ok(
      touched.paths.some((p) => p === 'src/commands/renamed.ts'),
      `expected the rename destination, got ${JSON.stringify(touched.paths)}`,
    );
    assert.ok(!touched.paths.some((p) => p.includes('->')), 'the raw porcelain arrow form must never leak through');
  });

  it('never accuses anyone of writing to the coordination store', () => {
    // Every brainclaw call rewrites .brainclaw/, so counting it would accuse
    // literally every agent on every claim.
    fs.mkdirSync(path.join(repo, '.brainclaw', 'coordination'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.brainclaw', 'coordination', 'x.json'), '{}');
    fs.writeFileSync(path.join(repo, 'src', 'core', 'a.ts'), 'export const a = 9;\n');
    const result = reconcileClaimConformity(claim(), repo);
    assert.equal(result.verdict.kind, 'in_scope');
    assert.equal(result.warning, undefined);
  });

  it('a declared paths[] footprint outranks the prose scope', () => {
    // C0-b made paths[] optional-but-additive precisely so a semantically-scoped
    // claim can still state a machine-readable footprint.
    fs.writeFileSync(path.join(repo, 'src', 'commands', 'b.ts'), 'export const b = 4;\n');
    const result = reconcileClaimConformity(
      claim({ scope: 'a prose scope nobody can path-match', paths: ['src/commands'] }),
      repo,
    );
    assert.equal(result.verdict.kind, 'in_scope', 'the declared footprint must be honoured');
  });

  it('joins a multi-path footprint the way the resolver parses it', () => {
    // Regression guard: the resolver splits on ',' and treats whitespace inside a
    // token as proof of prose, so a space-joined list silently degrades to
    // unverifiable — a signal that looks like success while emitting nothing.
    fs.writeFileSync(path.join(repo, 'src', 'commands', 'b.ts'), 'export const b = 5;\n');
    fs.writeFileSync(path.join(repo, 'docs', 'd.md'), '# d\n');
    const result = reconcileClaimConformity(
      claim({ scope: 'prose', paths: ['src/commands', 'docs'] }),
      repo,
    );
    assert.equal(result.verdict.kind, 'in_scope', 'both declared paths must resolve');
  });
});

describe('claim conformity — silent on every doubt', { concurrency: false }, () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-conformity-silent-'));
    fs.mkdirSync(path.join(repo, 'src', 'core'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'core', 'a.ts'), '1');
  });

  afterEach(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('no base_sha → unverifiable, never an accusation', () => {
    const result = reconcileClaimConformity(
      { id: 'c', agent: 'a', scope: 'src/core', description: 'd', created_at: new Date().toISOString(), status: 'active' } as Claim,
      repo,
    );
    assert.equal(result.verdict.kind, 'unverifiable');
    assert.equal(result.warning, undefined);
  });

  it('an unreachable base_sha → unverifiable, not a phantom clean slate', () => {
    // A pruned lane branch makes `git diff <sha>` fail. Reading that failure as
    // "touched nothing" would silently disable the check; reading it as a
    // violation would be a false accusation. Neither: say we cannot tell.
    git(repo, 'init', '-q');
    commitAll(repo, 'base');
    const result = reconcileClaimConformity(
      { id: 'c', agent: 'a', scope: 'src/core', description: 'd', created_at: new Date().toISOString(), status: 'active', base_sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' } as Claim,
      repo,
    );
    assert.equal(result.verdict.kind, 'unverifiable');
    assert.match((result.verdict as { reason: string }).reason, /no longer reachable/);
  });

  it('a vanished worktree → unverifiable', () => {
    const result = reconcileClaimConformity(
      { id: 'c', agent: 'a', scope: 'src/core', description: 'd', created_at: new Date().toISOString(), status: 'active', base_sha: 'abc1234', worktree_path: path.join(repo, 'gone') } as Claim,
      repo,
    );
    assert.equal(result.verdict.kind, 'unverifiable');
    assert.equal(result.warning, undefined);
  });

  it('a loop-ref scope is never accused, whatever was touched', () => {
    // 22.8% of the live corpus, and growing — coordinator lane claims are the
    // ones being minted (the reviewer's independent census confirmed this).
    const result = reconcileClaimConformity(
      { id: 'c', agent: 'a', scope: 'review-loop:lop_abc', description: 'd', created_at: new Date().toISOString(), status: 'active', base_sha: 'x' } as Claim,
      repo,
      { touchedPaths: ['anything/at/all.ts', 'src/core/a.ts'] },
    );
    assert.equal(result.verdict.kind, 'unverifiable');
    assert.equal(result.warning, undefined);
  });

  it('an explicit footprint needs no git at all — the MCP-less harvest path', () => {
    // The tier C2 exists for: by harvest time the lane's worktree may be reaped,
    // so the worker's own `files_changed` declaration is the only usable source.
    const result = reconcileClaimConformity(
      { id: 'c', agent: 'a', scope: 'src/core', description: 'd', created_at: new Date().toISOString(), status: 'active' } as Claim,
      repo,
      { touchedPaths: ['src/core/a.ts', 'src/other/stray.ts'] },
    );
    assert.equal(result.verdict.kind, 'out_of_scope', 'no base_sha needed when the footprint is declared');
    assert.deepEqual(result.warning?.data?.unexpected_paths, ['src/other/stray.ts']);
  });

  it('an empty declared footprint says nothing rather than "clean"', () => {
    const result = reconcileClaimConformity(
      { id: 'c', agent: 'a', scope: 'src/core', description: 'd', created_at: new Date().toISOString(), status: 'active' } as Claim,
      repo,
      { touchedPaths: [] },
    );
    assert.equal(result.verdict.kind, 'unverifiable');
  });

  it('carries a recovery path, because a dead-end warning is noise', () => {
    const result = reconcileClaimConformity(
      { id: 'clm_x', agent: 'a', scope: 'src/core', description: 'd', created_at: new Date().toISOString(), status: 'active' } as Claim,
      repo,
      { touchedPaths: ['src/core/a.ts', 'elsewhere/x.ts'] },
    );
    const actions = result.warning?.next_actions ?? [];
    assert.ok(actions.length >= 2, 'the agent must be told what to DO about it');
    assert.ok(actions.some((a) => a.tool === 'bclaw_update'), 'widening the claim must be offered');
  });
});

describe('claim conformity — ACCEPTANCE: zero false accusations on the real corpus', () => {
  it('never accuses a non-path scope across every live claim', () => {
    // The design's acceptance criterion, replayed through the FULL C2 path
    // (claim-scope.test.ts covers the classifier alone). Every real claim is fed
    // a deliberately unrelated footprint: a correct implementation stays silent
    // unless the scope genuinely resolves to paths that exclude it.
    const claimsDir = path.join(process.cwd(), '.brainclaw', 'coordination', 'claims');
    if (!fs.existsSync(claimsDir)) return; // not running against a real store

    const claims: Claim[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.json')) continue;
        try { claims.push(JSON.parse(fs.readFileSync(full, 'utf-8')) as Claim); } catch { /* skip unreadable */ }
      }
    };
    walk(claimsDir);
    assert.ok(claims.length > 100, `expected a real corpus, got ${claims.length} claims`);

    const wrongful: string[] = [];
    for (const c of claims) {
      if (typeof c.scope !== 'string') continue;
      const result = reconcileClaimConformity(c, process.cwd(), {
        touchedPaths: ['some/unrelated/file.ts'],
      });
      if (!result.warning) continue;
      // A path-resolvable scope legitimately flags an unrelated file. The bar is
      // that every accusation is EXPLAINED by a real path scope — never by a
      // loop-ref or prose one.
      if (classifyClaimScope(c.scope, process.cwd()).kind !== 'paths') wrongful.push(c.scope);
    }

    assert.deepEqual(
      wrongful,
      [],
      `these non-path scopes were wrongly accused (the exact failure this design forbids):\n${wrongful.slice(0, 10).join('\n')}`,
    );
  });
});
