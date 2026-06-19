/**
 * Code Map P1a migration ORACLE (spec §10 / §12).
 *
 * Purpose
 * -------
 * P1a migrates the 541-line imperative `extractor.ts` into a generic,
 * query-driven CodeLanguageProvider with ZERO behavior change. The oracle is the
 * safety net for that migration: it runs the CURRENT legacy extractor
 * (`src/core/code-map/extractor.ts` → `extractFile`) over a fixed fixture set and
 * FREEZES its output as a golden baseline (`oracle-golden.json`, committed next
 * to the fixtures).
 *
 * In a LATER sprint the new provider pipeline will be diffed against the SAME
 * golden via deep-equal `ExtractResult` (byte-identical node/edge IDs, spans,
 * confidence, ORDER, parse_status, diagnostics). For Sprint 1 this file is a
 * SELF-CONSISTENCY check: the legacy extractor must reproduce the frozen baseline
 * exactly, and it must be deterministic run-to-run.
 *
 * The comparator is order-SENSITIVE: `assert.deepStrictEqual` compares arrays
 * positionally, so any drift in node/edge ORDER, IDs, spans, parse_status, or
 * diagnostics fails the oracle — which is exactly what a zero-behavior-change
 * migration must catch.
 *
 * Regenerating the baseline (only when a behavior change is INTENDED and reviewed):
 *   CODE_MAP_ORACLE_UPDATE=1 node dist-test/tests/unit/code-map/oracle.test.js
 * The baseline is also auto-written on first run when absent (bootstrap), so the
 * very first green run records the frozen legacy output.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile, type ExtractResult } from '../../../src/core/code-map/extractor.js';
import type { CodeLang } from '../../../src/core/code-map/types.js';

const PROJECT = 'prj_code_map_oracle';

/**
 * One oracle case. `path` is the store-identity POSIX relative path (it feeds the
 * node/edge id hashes and MUST be stable), `file` is the on-disk fixture
 * basename, `lang` is the Code Map language the refresh pipeline would resolve
 * for that extension. `oversizedBytes`, when set, drives the legacy
 * skipped_too_large branch without needing a genuinely huge file on disk (the
 * oversized branch never reads the source).
 */
interface OracleCase {
  file: string;
  path: string;
  lang: CodeLang;
  oversizedBytes?: number;
}

/**
 * The §10 fixture matrix. Exactly the spec cases:
 *  - simple fn / class / type / interface           → declarations.ts
 *  - lexical multi-declarator (const a=1,b=2)        → lexical-multi.ts
 *  - arrow / var                                     → arrow-var.ts
 *  - React component + hook                          → react-component.tsx
 *  - named / default / namespace imports             → imports-basic.ts
 *  - multiple imports of one module                  → imports-multiple.ts
 *  - export declarations                             → export-declarations.ts
 *  - `export { a }` AFTER the declaration            → export-clause-after.ts
 *  - `export { a }` BEFORE the declaration           → export-clause-before.ts
 *  - alias imports / exports                         → alias.ts
 *  - re-exports from / *                             → reexport.ts
 *  - default-identifier export                       → default-export.ts
 *  - syntax-error file                               → syntax-error.ts
 *  - oversized file                                  → oversized.ts (oversizedBytes)
 *  - .js / .ts / .tsx / .jsx extension coverage      → plain.js / *.ts / *.tsx / component.jsx
 */
const CASES: OracleCase[] = [
  { file: 'declarations.ts', path: 'src/p1a/declarations.ts', lang: 'typescript' },
  { file: 'lexical-multi.ts', path: 'src/p1a/lexical-multi.ts', lang: 'typescript' },
  { file: 'arrow-var.ts', path: 'src/p1a/arrow-var.ts', lang: 'typescript' },
  { file: 'react-component.tsx', path: 'src/p1a/react-component.tsx', lang: 'tsx' },
  { file: 'imports-basic.ts', path: 'src/p1a/imports-basic.ts', lang: 'typescript' },
  { file: 'imports-multiple.ts', path: 'src/p1a/imports-multiple.ts', lang: 'typescript' },
  { file: 'export-declarations.ts', path: 'src/p1a/export-declarations.ts', lang: 'typescript' },
  { file: 'export-clause-after.ts', path: 'src/p1a/export-clause-after.ts', lang: 'typescript' },
  { file: 'export-clause-before.ts', path: 'src/p1a/export-clause-before.ts', lang: 'typescript' },
  { file: 'alias.ts', path: 'src/p1a/alias.ts', lang: 'typescript' },
  { file: 'reexport.ts', path: 'src/p1a/reexport.ts', lang: 'typescript' },
  { file: 'default-export.ts', path: 'src/p1a/default-export.ts', lang: 'typescript' },
  { file: 'syntax-error.ts', path: 'src/p1a/syntax-error.ts', lang: 'typescript' },
  // Oversized: drive the skipped_too_large branch with an inflated sizeBytes.
  { file: 'oversized.ts', path: 'src/p1a/oversized.ts', lang: 'typescript', oversizedBytes: 8 * 1024 * 1024 },
  // .js extension coverage (javascript grammar).
  { file: 'plain.js', path: 'src/p1a/plain.js', lang: 'javascript' },
  // .jsx extension coverage (resolves to the tsx grammar — mirrors langForExtension).
  { file: 'component.jsx', path: 'src/p1a/component.jsx', lang: 'tsx' },
];

const MAX_PARSE_FILE_BYTES = 1024 * 1024;

/** Walk up from this compiled module to the repo root (the dir holding package.json). */
function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('oracle: could not locate repo root (package.json) from ' + fileURLToPath(import.meta.url));
}

const FIXTURES_DIR = path.join(repoRoot(), 'tests', 'fixtures', 'code-map', 'p1a');
const GOLDEN_PATH = path.join(FIXTURES_DIR, 'oracle-golden.json');

interface GoldenEntry {
  path: string;
  lang: CodeLang;
  result: ExtractResult;
}
type Golden = Record<string, GoldenEntry>;

/** Run the legacy extractor over one case exactly as the refresh pipeline would. */
async function runCase(c: OracleCase): Promise<ExtractResult> {
  const abs = path.join(FIXTURES_DIR, c.file);
  const source = fs.readFileSync(abs, 'utf-8');
  const realBytes = Buffer.byteLength(source);
  return extractFile({
    projectId: PROJECT,
    path: c.path,
    lang: c.lang,
    source,
    sizeBytes: c.oversizedBytes ?? realBytes,
    maxParseFileBytes: MAX_PARSE_FILE_BYTES,
  });
}

/** Stable round-trip so frozen-vs-live compare on identical JSON shapes. */
function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

let liveResults: Map<string, ExtractResult>;

describe('code-map P1a migration oracle', () => {
  before(async () => {
    liveResults = new Map();
    for (const c of CASES) {
      liveResults.set(c.path, roundTrip(await runCase(c)));
    }

    // Bootstrap / regenerate the frozen baseline when absent or explicitly asked.
    const wantUpdate = process.env.CODE_MAP_ORACLE_UPDATE === '1';
    if (wantUpdate || !fs.existsSync(GOLDEN_PATH)) {
      const golden: Golden = {};
      for (const c of CASES) {
        golden[c.path] = {
          path: c.path,
          lang: c.lang,
          result: liveResults.get(c.path)!,
        };
      }
      fs.mkdirSync(FIXTURES_DIR, { recursive: true });
      fs.writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 2) + '\n', 'utf-8');
    }
  });

  it('the frozen golden baseline exists and covers exactly the fixture matrix', () => {
    assert.ok(fs.existsSync(GOLDEN_PATH), 'oracle-golden.json must exist (auto-written on first run)');
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf-8')) as Golden;
    const goldenKeys = Object.keys(golden).sort();
    const caseKeys = CASES.map((c) => c.path).sort();
    assert.deepStrictEqual(goldenKeys, caseKeys, 'golden keys must match the case matrix exactly');
  });

  // One assertion per case so a drift names the exact fixture that moved.
  for (const c of CASES) {
    it(`legacy extractor reproduces the frozen baseline: ${c.file}`, () => {
      const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf-8')) as Golden;
      const entry = golden[c.path];
      assert.ok(entry, `golden entry missing for ${c.path}`);
      assert.equal(entry.lang, c.lang, 'golden lang tag must match the case');
      const live = liveResults.get(c.path)!;
      // ORDER-SENSITIVE: deepStrictEqual compares arrays positionally, so any
      // drift in node/edge ORDER, ids, spans, confidence, parse_status, or
      // diagnostics fails here — exactly what a zero-behavior-change migration
      // must catch.
      assert.deepStrictEqual(live, entry.result);
    });
  }

  it('legacy extraction is deterministic run-to-run (re-extract == frozen)', async () => {
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf-8')) as Golden;
    for (const c of CASES) {
      const again = roundTrip(await runCase(c));
      assert.deepStrictEqual(again, golden[c.path]!.result, `non-deterministic output for ${c.file}`);
    }
  });

  it('the matrix covers every §10 case + all four extensions', () => {
    const exts = new Set(CASES.map((c) => path.extname(c.file)));
    for (const ext of ['.ts', '.tsx', '.js', '.jsx']) {
      assert.ok(exts.has(ext), `fixture matrix must include a ${ext} file`);
    }
    // Spec-named cases must each be represented by a fixture file.
    const files = new Set(CASES.map((c) => c.file));
    for (const required of [
      'declarations.ts',
      'lexical-multi.ts',
      'arrow-var.ts',
      'react-component.tsx',
      'imports-basic.ts',
      'imports-multiple.ts',
      'export-declarations.ts',
      'export-clause-after.ts',
      'export-clause-before.ts',
      'alias.ts',
      'reexport.ts',
      'default-export.ts',
      'syntax-error.ts',
      'oversized.ts',
    ]) {
      assert.ok(files.has(required), `missing required §10 fixture: ${required}`);
    }
    // The oversized case must exercise the skipped_too_large branch.
    const oversized = liveResults.get('src/p1a/oversized.ts')!;
    assert.equal(oversized.parseStatus, 'skipped_too_large');
    assert.equal(oversized.nodes.length, 1);
    assert.equal(oversized.edges.length, 0);
    // The syntax-error case must land on parse_error without throwing.
    const broken = liveResults.get('src/p1a/syntax-error.ts')!;
    assert.equal(broken.parseStatus, 'parse_error');
  });
});
