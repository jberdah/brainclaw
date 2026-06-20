/**
 * Code Map P1b — PYTHON provider oracle (cadrage §4 "Fixtures-as-spec" + §8 matrix).
 *
 * Python has NO legacy extractor, so the golden is NOT a self-bootstrapped snapshot:
 * `python-oracle-golden.json` was HAND-AUTHORED from the cadrage §5/§6 mapping rules
 * (subtype/name/span/imported_names/order/parseStatus per fixture, column arithmetic
 * verified by reading each `.py`); only the deterministic node/edge IDs were derived
 * from those hand-authored fields via the shipped `ids.ts`. The golden IS the spec.
 *
 * This test runs `core.extractFile` over every fixture and asserts an ORDER-SENSITIVE
 * `assert.deepStrictEqual` against that frozen golden — byte-identical ids, spans,
 * subtypes, imported_names, ORDER, parse_status, and diagnostics. Plus the invariant
 * suite (cadrage §4) and run-to-run determinism (cadrage §4).
 *
 * It does NOT auto-write or regenerate the golden: a drift is a real finding (the
 * provider moved away from the reviewed spec), not a snapshot to bless.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile } from '../../../src/core/code-map/core.js';
import { assertCaptureMapConforms } from '../../../src/core/code-map/lang/query-runtime.js';
import { pythonProvider } from '../../../src/core/code-map/lang/python/index.js';
import type { ExtractResult } from '../../../src/core/code-map/extractor.js';
import type { CodeLang } from '../../../src/core/code-map/types.js';

const PROJECT = 'prj_code_map_oracle';
const MAX_PARSE_FILE_BYTES = 1024 * 1024;

interface OracleCase {
  file: string;
  path: string;
  lang: CodeLang;
  oversizedBytes?: number;
}

/** The §8 Python fixture matrix — one logical case per file. */
const CASES: OracleCase[] = [
  { file: 'toplevel-def.py', path: 'src/p1b/toplevel-def.py', lang: 'python' },
  { file: 'class-methods.py', path: 'src/p1b/class-methods.py', lang: 'python' },
  { file: 'nested-def.py', path: 'src/p1b/nested-def.py', lang: 'python' },
  { file: 'module-vars.py', path: 'src/p1b/module-vars.py', lang: 'python' },
  { file: 'decorated.py', path: 'src/p1b/decorated.py', lang: 'python' },
  { file: 'imports.py', path: 'src/p1b/imports.py', lang: 'python' },
  { file: 'import-as.py', path: 'src/p1b/import-as.py', lang: 'python' },
  { file: 'import-repeat.py', path: 'src/p1b/import-repeat.py', lang: 'python' },
  // Reviewer-added adversarial cases:
  //  - paren-import: parenthesized `from . import (a, b)` / multi-line `from pkg import (c,\n d)`
  //    (grammar robustness + relative dots preserved across the parenthesized list).
  //  - toplevel-property: a `@property` on a MODULE-LEVEL def. Per cadrage §5 decorators
  //    drive CLASSIFICATION unconditionally (`@property` -> subtype `property`), so the
  //    provider emits `property` even outside a class body. This case LOCKS that behavior:
  //    if a future change conditions @property on class-membership it must do so deliberately
  //    (the golden will drift). Excluded from the ast-oracle (ast has no `property` notion —
  //    it reports a plain top-level def — so the two witnesses would disagree by design).
  { file: 'paren-import.py', path: 'src/p1b/paren-import.py', lang: 'python' },
  { file: 'toplevel-property.py', path: 'src/p1b/toplevel-property.py', lang: 'python' },
  { file: 'syntax-error.py', path: 'src/p1b/syntax-error.py', lang: 'python' },
  { file: 'oversized.py', path: 'src/p1b/oversized.py', lang: 'python', oversizedBytes: 8 * 1024 * 1024 },
];

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('python-provider-oracle: could not locate repo root from ' + fileURLToPath(import.meta.url));
}

const FIXTURES_DIR = path.join(repoRoot(), 'tests', 'fixtures', 'code-map', 'p1b-python');
const GOLDEN_PATH = path.join(FIXTURES_DIR, 'python-oracle-golden.json');

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

describe('code-map P1b python provider oracle (fixtures-as-spec)', () => {
  before(async () => {
    liveResults = new Map();
    for (const c of CASES) {
      liveResults.set(c.path, roundTrip(await runCase(c)));
    }
  });

  it('the hand-authored golden exists and covers exactly the fixture matrix', () => {
    assert.ok(fs.existsSync(GOLDEN_PATH), 'python-oracle-golden.json must exist (hand-authored spec)');
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf-8')) as Golden;
    const goldenKeys = Object.keys(golden).sort();
    const caseKeys = CASES.map((c) => c.path).sort();
    assert.deepStrictEqual(goldenKeys, caseKeys, 'golden keys must match the case matrix exactly');
  });

  // One assertion per fixture so a drift names the exact fixture that moved away
  // from the reviewed spec.
  for (const c of CASES) {
    it(`provider extraction equals the hand-authored spec: ${c.file}`, () => {
      const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf-8')) as Golden;
      const entry = golden[c.path];
      assert.ok(entry, `golden entry missing for ${c.path}`);
      assert.equal(entry.lang, c.lang, 'golden lang tag must match the case');
      const live = liveResults.get(c.path)!;
      // ORDER-SENSITIVE: any drift in node/edge order, ids, spans, subtypes,
      // imported_names, parse_status, or diagnostics fails here.
      assert.deepStrictEqual(live, entry.result);
    });
  }

  it('extraction is deterministic run-to-run (re-extract == frozen spec)', async () => {
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf-8')) as Golden;
    for (const c of CASES) {
      const again = roundTrip(await runCase(c));
      assert.deepStrictEqual(again, golden[c.path]!.result, `non-deterministic output for ${c.file}`);
    }
  });

  // --- Invariants (cadrage §4) over every fixture. ---
  describe('invariants over every fixture', () => {
    it('exactly one file node, and it is first', () => {
      for (const c of CASES) {
        const r = liveResults.get(c.path)!;
        const fileNodes = r.nodes.filter((n) => n.kind === 'file');
        assert.equal(fileNodes.length, 1, `${c.file}: exactly one file node`);
        assert.equal(r.nodes[0]!.kind, 'file', `${c.file}: file node must be first`);
      }
    });

    it('every symbol node has both a contains and a defines edge from the file node', () => {
      for (const c of CASES) {
        const r = liveResults.get(c.path)!;
        const fileNode = r.nodes[0]!.id;
        for (const sym of r.nodes.filter((n) => n.kind === 'symbol')) {
          const contains = r.edges.find((e) => e.kind === 'contains' && e.from === fileNode && e.to === sym.id);
          const defines = r.edges.find((e) => e.kind === 'defines' && e.from === fileNode && e.to === sym.id);
          assert.ok(contains, `${c.file}: symbol ${sym.name} missing contains edge`);
          assert.ok(defines, `${c.file}: symbol ${sym.name} missing defines edge`);
        }
      }
    });

    it('every module node has exactly one imports edge', () => {
      for (const c of CASES) {
        const r = liveResults.get(c.path)!;
        const fileNode = r.nodes[0]!.id;
        for (const mod of r.nodes.filter((n) => n.kind === 'module')) {
          const importsEdges = r.edges.filter((e) => e.kind === 'imports' && e.from === fileNode && e.to === mod.id);
          assert.equal(importsEdges.length, 1, `${c.file}: module ${mod.name} must have exactly one imports edge`);
        }
      }
    });

    it('no duplicate node ids', () => {
      for (const c of CASES) {
        const r = liveResults.get(c.path)!;
        const ids = r.nodes.map((n) => n.id);
        assert.equal(new Set(ids).size, ids.length, `${c.file}: duplicate node id`);
      }
    });

    it('every symbol and module node has a non-null span', () => {
      for (const c of CASES) {
        const r = liveResults.get(c.path)!;
        for (const n of r.nodes.filter((x) => x.kind === 'symbol' || x.kind === 'module')) {
          assert.ok(n.span, `${c.file}: ${n.kind} ${n.name} must have a non-null span`);
        }
      }
    });

    it('every subtype is provider-declared', () => {
      const declared = new Set<string>(pythonProvider.vocabulary.nodeSubtypes);
      for (const c of CASES) {
        const r = liveResults.get(c.path)!;
        for (const sym of r.nodes.filter((n) => n.kind === 'symbol')) {
          assert.ok(sym.subtype, `${c.file}: symbol ${sym.name} must have a subtype`);
          assert.ok(declared.has(sym.subtype!), `${c.file}: subtype ${sym.subtype} not provider-declared`);
        }
      }
    });

    it('all imported names are source-side (no aliases / wildcard preserved)', () => {
      // Aliases (`as c`) are dropped: the golden never carries a local alias.
      // We assert the live import names match the reviewed golden (the spec of
      // source-side names) — and never include a known alias token.
      const aliasTokens = new Set(['L', 'DF', 'np']);
      for (const c of CASES) {
        const r = liveResults.get(c.path)!;
        for (const mod of r.nodes.filter((n) => n.kind === 'module')) {
          for (const name of mod.imported_names) {
            assert.ok(!aliasTokens.has(name), `${c.file}: imported name ${name} is a local alias, not source-side`);
          }
        }
      }
    });
  });

  // cadrage §3.4 captureMap honesty: the Python provider's declared captureMap must
  // be a faithful mirror of the hard-coded capture convention (no invented roles).
  it('the Python provider captureMap conforms to the hard-coded capture convention', () => {
    assert.deepStrictEqual(assertCaptureMapConforms(pythonProvider.queries.captureMap), []);
  });
});
