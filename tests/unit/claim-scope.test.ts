/**
 * pln#636 C0-a — claim scope grammar + conformity verdict.
 *
 * The acceptance criterion set in the design is the last test here: replayed
 * against the REAL claim corpus, the conformity check must produce ZERO
 * accusations. A gate that false-accuses teaches agents to ignore it, which is
 * worse than shipping nothing (the pln#634 failure mode).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESERVED_SCOPE_PREFIXES,
  assessScopeConformity,
  classifyClaimScope,
  toRepoRelative,
} from '../../src/core/claim-scope.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

// concurrency:false — see claim-liveness-file-evidence.test.ts: under
// --test-isolation=none a suite's tests run concurrently, so a shared
// `workspace` reassigned in beforeEach can be stomped mid-test.
describe('claim scope grammar — classification', { concurrency: false }, () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-claim-scope-' });
    fs.mkdirSync(path.join(workspace.dir, 'src', 'core'), { recursive: true });
    fs.writeFileSync(path.join(workspace.dir, 'src', 'core', 'thing.ts'), 'export const x = 1;\n');
  });

  afterEach(() => workspace.cleanup());

  it('classifies a path scope as paths', () => {
    const c = classifyClaimScope('src/core/thing.ts', workspace.dir);
    assert.equal(c.kind, 'paths');
    assert.deepEqual(c.pathspecs, ['src/core/thing.ts']);
  });

  it('classifies each reserved loop prefix found in production', () => {
    // All three variants live in the real store: review-loop (133), ideate-loop
    // (5) and ideation-loop (2). dirty-scope only knew the first.
    for (const prefix of RESERVED_SCOPE_PREFIXES) {
      const c = classifyClaimScope(`${prefix}:lop_abc123`, workspace.dir);
      assert.equal(c.kind, 'loop_ref', `${prefix} must classify as loop_ref`);
      assert.equal(c.loopRef?.prefix, prefix);
      assert.equal(c.loopRef?.loopId, 'lop_abc123');
    }
  });

  it('parses the slot id out of a lane scope', () => {
    const c = classifyClaimScope('ideate-loop:lop_abc:lsl_def', workspace.dir);
    assert.equal(c.loopRef?.loopId, 'lop_abc');
    assert.equal(c.loopRef?.slotId, 'lsl_def');
  });

  it('does NOT read a Windows drive letter as a semantic prefix', () => {
    // Straight out of the census: one live claim scope is an absolute Windows
    // path. A naive /^[a-z-]+:/i would classify `C:/…` as a prefixed scope and
    // stop treating it as a path.
    const c = classifyClaimScope('C:/Users/dev/project/src/core', workspace.dir);
    assert.notEqual(c.kind, 'loop_ref', 'C: is a drive letter, not a reserved prefix');
  });

  it('treats an UNKNOWN word: prefix as prose, not as a loop reference', () => {
    // Also from the census: `project-resolution:` and `worktree-as-contract:`
    // are prose that happen to contain a colon. The reserved set is enumerated
    // precisely so shape alone never promotes a string to a loop reference.
    for (const scope of ['project-resolution: the gate', 'worktree-as-contract: design']) {
      const c = classifyClaimScope(scope, workspace.dir);
      assert.notEqual(c.kind, 'loop_ref', `${scope} must not be read as a loop ref`);
    }
  });

  it('classifies free prose as prose, with a reason', () => {
    const c = classifyClaimScope('Loop engine residuals #1-4 (dispatch wiring)', workspace.dir);
    assert.equal(c.kind, 'prose');
    assert.ok(c.reason && c.reason.length > 0, 'a non-path scope must explain itself');
  });

  it('classifies an absent scope as empty', () => {
    assert.equal(classifyClaimScope(undefined, workspace.dir).kind, 'empty');
    assert.equal(classifyClaimScope('   ', workspace.dir).kind, 'empty');
  });
});

describe('claim scope conformity — SILENT on doubt (inverted default)', { concurrency: false }, () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-claim-conformity-' });
    for (const dir of ['src/core', 'src/commands', 'docs']) {
      fs.mkdirSync(path.join(workspace.dir, ...dir.split('/')), { recursive: true });
    }
    fs.writeFileSync(path.join(workspace.dir, 'src', 'core', 'a.ts'), '1');
    fs.writeFileSync(path.join(workspace.dir, 'src', 'commands', 'b.ts'), '1');
  });

  afterEach(() => workspace.cleanup());

  it('reports in_scope when every touched file sits under the declared scope', () => {
    const v = assessScopeConformity({
      scope: 'src/core',
      cwd: workspace.dir,
      touchedPaths: ['src/core/a.ts', 'src/core/nested/c.ts'],
    });
    assert.equal(v.kind, 'in_scope');
  });

  it('reports out_of_scope ONLY for a path scope with concrete strays', () => {
    const v = assessScopeConformity({
      scope: 'src/core',
      cwd: workspace.dir,
      touchedPaths: ['src/core/a.ts', 'src/commands/b.ts'],
    });
    assert.equal(v.kind, 'out_of_scope');
    assert.ok(v.kind === 'out_of_scope');
    assert.deepEqual(v.unexpected, ['src/commands/b.ts']);
  });

  it('is UNVERIFIABLE — never out_of_scope — for a loop-ref scope', () => {
    // The whole point of the inverted default. A coordinator lane claim can
    // never be path-matched, and 22.8% of the live corpus looks like this.
    const v = assessScopeConformity({
      scope: 'review-loop:lop_abc',
      cwd: workspace.dir,
      touchedPaths: ['src/core/a.ts', 'anything/else.ts'],
    });
    assert.equal(v.kind, 'unverifiable');
  });

  it('is UNVERIFIABLE for prose and for an absent scope', () => {
    for (const scope of ['Loop engine residuals #1-4', undefined, '']) {
      const v = assessScopeConformity({ scope, cwd: workspace.dir, touchedPaths: ['x/y.ts'] });
      assert.equal(v.kind, 'unverifiable', `scope=${String(scope)} must stay silent`);
    }
  });

  it('is UNVERIFIABLE rather than approximate when the scope is a glob', () => {
    const v = assessScopeConformity({
      scope: 'src/**/*.ts',
      cwd: workspace.dir,
      touchedPaths: ['src/core/a.ts'],
    });
    assert.equal(v.kind, 'unverifiable', 'globs belong to git, not to a hand-rolled matcher');
  });

  it('never counts the coordination store or git internals as out of scope', () => {
    // Every brainclaw call rewrites .brainclaw/, so counting it would accuse
    // literally every agent on every claim.
    const v = assessScopeConformity({
      scope: 'src/core',
      cwd: workspace.dir,
      touchedPaths: ['src/core/a.ts', '.brainclaw/coordination/claims/x.json', '.git/index'],
    });
    assert.equal(v.kind, 'in_scope');
  });

  it('stays silent when there is nothing to compare', () => {
    const v = assessScopeConformity({ scope: 'src/core', cwd: workspace.dir, touchedPaths: [] });
    assert.equal(v.kind, 'unverifiable');
  });

  it('normalises absolute paths against the repo root', () => {
    const abs = path.join(workspace.dir, 'src', 'core', 'a.ts');
    assert.equal(toRepoRelative(abs, workspace.dir), 'src/core/a.ts');
    assert.equal(toRepoRelative('src/core/a.ts', workspace.dir), 'src/core/a.ts');
  });
});

describe('claim scope conformity — ACCEPTANCE: zero accusations on the real corpus', () => {
  it('produces no out_of_scope verdict across every live claim scope', () => {
    // The design's acceptance criterion. Replays the actual store: for each real
    // claim scope, feed a touched-file list that is deliberately UNRELATED. Any
    // `out_of_scope` here would be a false accusation on real data — which is
    // the failure this whole design exists to prevent.
    const claimsDir = path.join(process.cwd(), '.brainclaw', 'coordination', 'claims');
    if (!fs.existsSync(claimsDir)) return; // not running against a real store

    const scopes: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.json')) continue;
        try {
          const claim = JSON.parse(fs.readFileSync(full, 'utf-8')) as { scope?: string };
          if (typeof claim.scope === 'string') scopes.push(claim.scope);
        } catch { /* skip unreadable */ }
      }
    };
    walk(claimsDir);
    assert.ok(scopes.length > 100, `expected a real corpus, got ${scopes.length} scopes`);

    const accusations: string[] = [];
    for (const scope of scopes) {
      const verdict = assessScopeConformity({
        scope,
        cwd: process.cwd(),
        // An unrelated file: a correct implementation stays silent unless the
        // scope genuinely resolves to paths that exclude it.
        touchedPaths: ['some/unrelated/file.ts'],
      });
      if (verdict.kind === 'out_of_scope') accusations.push(scope);
    }

    // A path-resolvable scope legitimately flags an unrelated file, so the bar is
    // not "zero verdicts" — it is that every accusation is EXPLAINED by a real
    // path scope, never by a loop-ref or prose one.
    const wrongful = accusations.filter((scope) => classifyClaimScope(scope, process.cwd()).kind !== 'paths');
    assert.deepEqual(
      wrongful,
      [],
      `these non-path scopes were wrongly accused (the exact failure the design forbids):\n${wrongful.slice(0, 10).join('\n')}`,
    );
  });
});
