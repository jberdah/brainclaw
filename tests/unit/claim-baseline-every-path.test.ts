/**
 * trp#1292 — every claim-creation path must stamp the baseline.
 *
 * WHAT WENT WRONG. `base_sha` shipped in 1.19.0 and was stamped from exactly ONE
 * place: inside `acquireClaimScope`. Nothing user-facing calls that function. All
 * four real creation paths build their claim literal inline and call `saveClaim`
 * directly, so NO real claim ever got a baseline — and the whole pln#636 C2
 * conformity reconcile, which returns `unverifiable` without one, was inert in
 * production. Two shipped feature PRs did nothing.
 *
 * WHY THE TESTS MISSED IT. `claim-base-sha.test.ts` calls `acquireClaimScope`
 * directly. It was green while the surface an agent actually calls was never
 * exercised. That is the ideation critic's V6 finding — "test the DELIVERED brief
 * after buildCoordinateBrief, not just the assembler" — reproduced one level up,
 * on the same day it was raised.
 *
 * SO THIS SUITE IS STRUCTURAL, not example-based: it enumerates the creation sites
 * from the SOURCE and fails when one of them does not stamp. A new fifth path
 * added next year fails here instead of silently shipping a third inert feature.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

function findRepoRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'src'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`repo root not found from ${import.meta.dirname}`);
}

const SRC = path.join(findRepoRoot(), 'src');

/**
 * Every module that PERSISTS a newly-created claim. Listed with intent: the point
 * is that adding a path here (or a new `saveClaim` site anywhere) forces the
 * baseline question to be answered rather than skipped.
 */
const CREATION_SITES = [
  { file: 'commands/mcp.ts', what: 'bclaw_work(intent="execute") — the entry point the session protocol mandates' },
  { file: 'commands/mcp-write-claims.ts', what: 'bclaw_claim' },
  { file: 'commands/claim.ts', what: 'CLI `claim create`' },
  { file: 'core/claims.ts', what: 'acquireClaimScope + createCoordinatorClaim (dispatched lanes)' },
];

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf-8');
}

/** Strip comments so a doc-comment mentioning the helper cannot fake a pass. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/[^\n]*/gm, '$1');
}

describe('trp#1292 — the claim baseline reaches every creation path', () => {
  it('each known creation module actually calls claimBaselineFields', () => {
    // stripComments matters: this very file's rationale names the helper, and so
    // do the explanatory comments at each site. Only executable code counts.
    const missing: string[] = [];
    for (const site of CREATION_SITES) {
      const code = stripComments(read(site.file));
      if (!/claimBaselineFields\s*\(/.test(code)) missing.push(`${site.file} — ${site.what}`);
    }
    assert.deepEqual(
      missing, [],
      `these claim-creation paths do not stamp the baseline, so pln#636 C2 is inert for the claims they create:\n${missing.join('\n')}`,
    );
  });

  it('finds no claim-persisting site outside the enumerated list', () => {
    // The guard that makes the list above self-maintaining. A fifth creation path
    // shows up here as an unreviewed site rather than as a silent gap — the
    // failure mode that produced trp#1292 in the first place.
    const known = new Set(CREATION_SITES.map((s) => s.file));
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const rel = path.relative(SRC, full).split(path.sep).join('/');
        if (known.has(rel)) continue;
        const code = stripComments(fs.readFileSync(full, 'utf-8'));
        // A CREATION site persists a claim literal — `saveClaim({` / `saveClaimUnlocked({`.
        // Spreading an existing record (`saveClaim({ ...oldClaim`) is an UPDATE and is
        // deliberately excluded: re-stamping there would move an immutable baseline.
        for (const m of code.matchAll(/saveClaim(?:Unlocked)?\(\s*\{\s*(\.\.\.)?/g)) {
          if (m[1]) continue; // spread → update, not creation
          offenders.push(rel);
          break;
        }
      }
    };
    walk(SRC);
    assert.deepEqual(
      offenders, [],
      `new claim-creation site(s) found. Add the baseline (…claimBaselineFields(cwd)) and list them in CREATION_SITES:\n${offenders.join('\n')}`,
    );
  });

  it('the baseline helper omits the key entirely when there is no git repo', () => {
    // "Optional, never backfilled" is the schema contract. `{ base_sha: undefined }`
    // would serialize away anyway, but an explicitly absent key is what downstream
    // reads as `unverifiable` rather than as an empty string.
    const code = stripComments(read('core/claims.ts'));
    assert.match(
      code,
      /return base_sha \? \{ base_sha \} : \{\}/,
      'claimBaselineFields must return {} — not { base_sha: undefined } — outside a git repo',
    );
  });

  it('the baseline is NOT stamped inside saveClaim itself', () => {
    // saveClaim also persists updates (release, adopt, patch). Stamping there
    // would re-baseline on every write, which is precisely the moving-ground
    // problem that made `git diff HEAD` unusable and motivated base_sha.
    const code = stripComments(read('core/claims.ts'));
    const saveClaimBody = /export function saveClaim\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(code)?.[1] ?? '';
    assert.ok(saveClaimBody.length > 0, 'could not locate saveClaim — update this test rather than deleting it');
    assert.doesNotMatch(
      saveClaimBody,
      /claimBaselineFields/,
      'saveClaim persists UPDATES too; stamping the baseline there would break its immutability',
    );
  });
});
