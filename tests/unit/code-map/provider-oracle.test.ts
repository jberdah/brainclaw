/**
 * Code Map P1a — PROVIDER ORACLE / migration GATE (spec §5 / §11 / §12).
 *
 * This is the zero-diff migration proof: the NEW query-driven pipeline
 * (`core.extractFile` = registry → TypeScriptProvider.extractDraft → refine →
 * finalize) must reproduce the FROZEN legacy `ExtractResult` exactly. We diff the
 * provider path against the SAME `oracle-golden.json` the legacy oracle froze, with
 * an ORDER-SENSITIVE `assert.deepStrictEqual` — byte-identical node/edge IDs,
 * spans, confidence, ORDER, parse_status, and diagnostics.
 *
 * If this is green over all 16 fixtures, query-driven == legacy.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile } from '../../../src/core/code-map/core.js';
import type { ExtractResult } from '../../../src/core/code-map/extractor.js';
import type { CodeLang } from '../../../src/core/code-map/types.js';

const PROJECT = 'prj_code_map_oracle';

interface OracleCase {
  file: string;
  path: string;
  lang: CodeLang;
  oversizedBytes?: number;
}

/** Same matrix as the legacy oracle (oracle.test.ts) — the golden was frozen from it. */
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
  { file: 'oversized.ts', path: 'src/p1a/oversized.ts', lang: 'typescript', oversizedBytes: 8 * 1024 * 1024 },
  { file: 'plain.js', path: 'src/p1a/plain.js', lang: 'javascript' },
  { file: 'component.jsx', path: 'src/p1a/component.jsx', lang: 'tsx' },
];

const MAX_PARSE_FILE_BYTES = 1024 * 1024;

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('provider-oracle: could not locate repo root from ' + fileURLToPath(import.meta.url));
}

const FIXTURES_DIR = path.join(repoRoot(), 'tests', 'fixtures', 'code-map', 'p1a');
const GOLDEN_PATH = path.join(FIXTURES_DIR, 'oracle-golden.json');

interface GoldenEntry {
  path: string;
  lang: CodeLang;
  result: ExtractResult;
}
type Golden = Record<string, GoldenEntry>;

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

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

let liveResults: Map<string, ExtractResult>;

describe('code-map P1a provider oracle (query-driven == legacy)', () => {
  before(async () => {
    liveResults = new Map();
    for (const c of CASES) {
      liveResults.set(c.path, roundTrip(await runCase(c)));
    }
  });

  it('the frozen golden baseline exists and covers exactly the fixture matrix', () => {
    assert.ok(fs.existsSync(GOLDEN_PATH), 'oracle-golden.json must exist (frozen by the legacy oracle)');
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf-8')) as Golden;
    const goldenKeys = Object.keys(golden).sort();
    const caseKeys = CASES.map((c) => c.path).sort();
    assert.deepStrictEqual(goldenKeys, caseKeys, 'golden keys must match the case matrix exactly');
  });

  // One assertion per fixture so a drift names the exact fixture that moved.
  for (const c of CASES) {
    it(`provider path reproduces the frozen legacy baseline: ${c.file}`, () => {
      const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf-8')) as Golden;
      const entry = golden[c.path];
      assert.ok(entry, `golden entry missing for ${c.path}`);
      const live = liveResults.get(c.path)!;
      assert.deepStrictEqual(live, entry.result);
    });
  }
});
