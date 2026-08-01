/**
 * pln#636 C0-b — the immutable baseline a claim starts from.
 *
 * The design review settled this by rejecting BOTH options the design offered:
 * neither `git diff` against HEAD nor the worktree's dirty set is authoritative,
 * because a lane that commits mid-work moves the ground under both. A commit
 * recorded once, at creation, is the only honest basis.
 *
 * The tests that matter most are the degradation ones: acquiring a claim must
 * never fail, and must never block, because a conformity nicety could not be
 * computed.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { acquireClaimScope, loadClaim, resolveClaimBaseSha } from '../../src/core/claims.js';
import { assessScopeConformity } from '../../src/core/claim-scope.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
}

describe('claim base_sha — recorded at creation', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-base-sha-' });
    fs.writeFileSync(path.join(workspace.dir, '.gitignore'), '.brainclaw/\n');
    fs.mkdirSync(path.join(workspace.dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspace.dir, 'src', 'a.ts'), 'export const a = 1;\n');
    git(workspace.dir, 'init', '-q');
    git(workspace.dir, 'add', '-A');
    git(workspace.dir, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'base');
  });

  afterEach(() => workspace.cleanup());

  it('resolves HEAD as a full sha', () => {
    const sha = resolveClaimBaseSha(workspace.dir);
    assert.ok(sha, 'a git repo must yield a baseline');
    assert.match(sha, /^[0-9a-f]{7,40}$/i);
  });

  it('stamps base_sha on a newly acquired claim', () => {
    const head = resolveClaimBaseSha(workspace.dir);
    const result = acquireClaimScope(
      { scope: 'src', agent: 'testuser', description: 'work on src' },
      workspace.dir,
    );
    assert.equal(result.acquired, true);
    assert.equal(result.claim?.base_sha, head);
    // Persisted, not just returned in memory.
    assert.equal(loadClaim(result.claim!.id, workspace.dir).base_sha, head);
  });

  it('does NOT move when HEAD advances — the baseline is a fixed point', () => {
    // The whole reason base_sha exists: a lane that commits mid-work must not
    // silently redefine what "since the start" means.
    const claim = acquireClaimScope(
      { scope: 'src', agent: 'testuser', description: 'work on src' },
      workspace.dir,
    ).claim!;
    const original = claim.base_sha;

    fs.writeFileSync(path.join(workspace.dir, 'src', 'b.ts'), 'export const b = 2;\n');
    git(workspace.dir, 'add', '-A');
    git(workspace.dir, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'mid-work');

    assert.notEqual(resolveClaimBaseSha(workspace.dir), original, 'HEAD must have advanced for this test to mean anything');
    assert.equal(loadClaim(claim.id, workspace.dir).base_sha, original, 'the recorded baseline must be unchanged');
  });

  it('records a declared paths[] footprint when the creator supplies one', () => {
    const claim = acquireClaimScope(
      { scope: 'a semantic description', agent: 'testuser', description: 'x', paths: ['src/a.ts'] },
      workspace.dir,
    ).claim!;
    assert.deepEqual(loadClaim(claim.id, workspace.dir).paths, ['src/a.ts']);
  });

  it('omits paths[] entirely when none is declared (never an empty array)', () => {
    const claim = acquireClaimScope(
      { scope: 'src', agent: 'testuser', description: 'x' },
      workspace.dir,
    ).claim!;
    assert.equal(loadClaim(claim.id, workspace.dir).paths, undefined);
  });
});

describe('claim base_sha — degrades silently, never blocks acquisition', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    // Deliberately NOT a git repo.
    workspace = createTestWorkspace({ prefix: 'bclaw-base-sha-nogit-' });
  });

  afterEach(() => workspace.cleanup());

  it('yields undefined outside a git repo instead of throwing', () => {
    assert.doesNotThrow(() => resolveClaimBaseSha(workspace.dir));
    assert.equal(resolveClaimBaseSha(workspace.dir), undefined);
  });

  it('still acquires the claim, with no base_sha field', () => {
    // Non-negotiable: a conformity nicety may not break the core workflow.
    const result = acquireClaimScope(
      { scope: 'src', agent: 'testuser', description: 'work without git' },
      workspace.dir,
    );
    assert.equal(result.acquired, true);
    assert.equal(result.claim?.base_sha, undefined);
  });

  it('a claim with no baseline reads as unverifiable downstream, not as a violation', () => {
    // The inverted default of C0-a, end to end: missing baseline means we cannot
    // tell, and cannot-tell means silence.
    const verdict = assessScopeConformity({
      scope: 'review-loop:lop_x',
      cwd: workspace.dir,
      touchedPaths: ['src/anything.ts'],
    });
    assert.equal(verdict.kind, 'unverifiable');
  });
});
