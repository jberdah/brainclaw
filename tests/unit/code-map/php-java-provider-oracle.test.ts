/**
 * Code Map langs#3-4 — PHP + Java provider oracle (cadrage v2 §4 + §8 matrix).
 *
 * PHP and Java have NO independent parser oracle available in this environment
 * (`php` absent; only a Java JRE, no JDK parser). So correctness rests on THREE
 * layers (Codex R1 required mitigation):
 *
 *  1. HAND-AUTHORED SEMANTIC SPEC (`SPEC` below) — the independent correctness
 *     gate. Each fixture's expected (subtype:name) symbol sequence + (source[names])
 *     import sequence + parseStatus was authored by reading the FIXTURE SOURCE and
 *     applying the cadrage v2 mapping rules, NOT by running the provider. The test
 *     asserts the live output's semantic projection equals this spec.
 *  2. FROZEN PARSER WITNESS (`<lang>-witness.json`) — the FULL ExtractResult
 *     (byte-identical ids/spans/order) plus the tree-sitter captures + draft. It is
 *     explicitly a "parser witness, NOT an independent oracle" (tree-sitter's own
 *     view); its job is to make the spec reviewable and to CATCH DRIFT: any change
 *     to a query/refine/grammar flips the deep-equal and forces a conscious
 *     regenerate (`scripts` gen-witness) + re-review. The test never auto-blesses.
 *  3. INVARIANTS + DETERMINISM + captureMap conformance (cadrage §4).
 *
 * The semantic spec (layer 1) and the frozen witness (layer 2) are cross-checked
 * against each other here too, so the committed witness can't silently disagree
 * with the reviewed spec.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile } from '../../../src/core/code-map/core.js';
import { assertCaptureMapConforms } from '../../../src/core/code-map/lang/query-runtime.js';
import { phpProvider } from '../../../src/core/code-map/lang/php/index.js';
import { javaProvider } from '../../../src/core/code-map/lang/java/index.js';
import type { ExtractResult } from '../../../src/core/code-map/extractor.js';
import type { CodeLang } from '../../../src/core/code-map/types.js';

const PROJECT = 'prj_code_map_oracle';
const MAX_PARSE_FILE_BYTES = 1024 * 1024;

interface OracleCase {
  lang: CodeLang;
  file: string;
  path: string;
  oversizedBytes?: number;
}

interface FixtureSpec {
  defs: string[]; // "subtype:name" in source/node order
  imports: string[]; // "source[name,name]" in source/node order
  parseStatus: ExtractResult['parseStatus'];
}

/**
 * THE HAND-AUTHORED SPEC (layer 1). Authored from reading each fixture + cadrage v2;
 * NOT generated from the provider.
 */
const SPEC: Record<string, FixtureSpec> = {
  // --- PHP ---
  'src/defs-class.php': {
    defs: [
      'namespace:App\\Models', 'class:User', 'constant:ROLE', 'property:id', 'property:name',
      'constructor:__construct', 'method:getName', 'method:make',
    ],
    imports: [],
    parseStatus: 'parsed',
  },
  'src/defs-types.php': {
    defs: [
      'namespace:App\\Contracts', 'interface:Repo', 'method:find', 'method:all',
      'php.trait:Timestamps', 'method:touch', 'enum:Status', 'constant:Active', 'constant:Inactive',
      'method:label', 'function:make_repo', 'constant:APP_VERSION',
    ],
    imports: [],
    parseStatus: 'parsed',
  },
  'src/imports-simple.php': {
    defs: ['namespace:App'],
    imports: [
      'App\\Contracts\\Repo[]', 'App\\Models\\User[]', 'App\\Util\\Helper[]', 'App\\Util\\Logger[]', 'Closure[]',
    ],
    parseStatus: 'parsed',
  },
  'src/imports-group.php': {
    defs: ['namespace:App'],
    imports: [
      'App\\Util\\Helper[]', 'App\\Util\\Logger[]', 'App\\Models\\User[]', 'App\\Models\\Account[]', 'App\\Models\\Role[]',
    ],
    parseStatus: 'parsed',
  },
  'src/imports-funcconst.php': {
    defs: ['namespace:App'],
    imports: ['App\\Fns\\helper[]', 'App\\Config\\MAX_SIZE[]', 'App\\Math\\add[]', 'App\\Math\\sub[]'],
    parseStatus: 'parsed',
  },
  'src/syntax-error.php': {
    defs: ['namespace:App', 'class:Broken', 'method:ok'],
    imports: [],
    parseStatus: 'parse_error',
  },
  'src/oversized.php': { defs: [], imports: [], parseStatus: 'skipped_too_large' },

  // --- Java ---
  'src/defs-class.java': {
    defs: [
      'package:com.example.app', 'class:App', 'field:count', 'field:NAME', 'constructor:App',
      'method:run', 'method:total', 'class:Inner', 'method:helper',
    ],
    imports: [],
    parseStatus: 'parsed',
  },
  'src/defs-types.java': {
    defs: [
      'package:com.example.types', 'interface:Service', 'method:run', 'method:total',
      'enum:Color', 'constant:RED', 'constant:GREEN', 'constant:BLUE', 'method:isPrimary',
      'java.annotation:MyAnnotation', 'method:value', 'method:count', 'java.record:Point', 'method:sum',
    ],
    imports: [],
    parseStatus: 'parsed',
  },
  'src/imports.java': {
    defs: ['package:com.example.app', 'class:Importer'],
    imports: [
      'java.util.List[]', 'java.util.Map[]', 'java.util[*]', 'java.lang.Math[PI]',
      'java.lang.Math[max]', 'java.util.Collections[*]',
    ],
    parseStatus: 'parsed',
  },
  'src/multi-field.java': {
    defs: [
      'package:com.example.fields', 'class:Box', 'field:width', 'field:height', 'field:depth',
      'field:label', 'field:E', 'field:TAU',
    ],
    imports: [],
    parseStatus: 'parsed',
  },
  'src/generics.java': {
    defs: ['package:com.example.generic', 'class:Container', 'field:value', 'method:transform'],
    imports: [],
    parseStatus: 'parsed',
  },
  'src/syntax-error.java': {
    defs: ['package:com.example.broken', 'class:Broken', 'method:ok'],
    imports: [],
    parseStatus: 'parse_error',
  },
  'src/oversized.java': { defs: [], imports: [], parseStatus: 'skipped_too_large' },
};

const CASES: OracleCase[] = [
  { lang: 'php', file: 'defs-class.php', path: 'src/defs-class.php' },
  { lang: 'php', file: 'defs-types.php', path: 'src/defs-types.php' },
  { lang: 'php', file: 'imports-simple.php', path: 'src/imports-simple.php' },
  { lang: 'php', file: 'imports-group.php', path: 'src/imports-group.php' },
  { lang: 'php', file: 'imports-funcconst.php', path: 'src/imports-funcconst.php' },
  { lang: 'php', file: 'syntax-error.php', path: 'src/syntax-error.php' },
  { lang: 'php', file: 'oversized.php', path: 'src/oversized.php', oversizedBytes: 8 * 1024 * 1024 },
  { lang: 'java', file: 'defs-class.java', path: 'src/defs-class.java' },
  { lang: 'java', file: 'defs-types.java', path: 'src/defs-types.java' },
  { lang: 'java', file: 'imports.java', path: 'src/imports.java' },
  { lang: 'java', file: 'multi-field.java', path: 'src/multi-field.java' },
  { lang: 'java', file: 'generics.java', path: 'src/generics.java' },
  { lang: 'java', file: 'syntax-error.java', path: 'src/syntax-error.java' },
  { lang: 'java', file: 'oversized.java', path: 'src/oversized.java', oversizedBytes: 8 * 1024 * 1024 },
];

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('php-java-provider-oracle: could not locate repo root');
}

const ROOT = repoRoot();
const DIRS: Record<string, string> = {
  php: path.join(ROOT, 'tests', 'fixtures', 'code-map', 'langs-php'),
  java: path.join(ROOT, 'tests', 'fixtures', 'code-map', 'langs-java'),
};

interface WitnessEntry {
  path: string;
  lang: CodeLang;
  result: ExtractResult;
}

function loadWitness(lang: string): Record<string, WitnessEntry> {
  const p = path.join(DIRS[lang]!, `${lang}-witness.json`);
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, WitnessEntry>;
}

async function runCase(c: OracleCase): Promise<ExtractResult> {
  const abs = path.join(DIRS[c.lang]!, c.file);
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

/** Project a finalized result onto the hand-authored spec shape (node order). */
function project(r: ExtractResult): { defs: string[]; imports: string[] } {
  const defs = r.nodes.filter((n) => n.kind === 'symbol').map((n) => `${n.subtype}:${n.name}`);
  const imports = r.nodes
    .filter((n) => n.kind === 'module')
    .map((n) => `${n.name}[${(n.imported_names || []).join(',')}]`);
  return { defs, imports };
}

const PROVIDERS = { php: phpProvider, java: javaProvider } as const;

let liveResults: Map<string, ExtractResult>;
let witnesses: Record<string, Record<string, WitnessEntry>>;

describe('code-map langs#3-4 PHP + Java provider oracle (fixtures-as-spec)', () => {
  before(async () => {
    liveResults = new Map();
    for (const c of CASES) liveResults.set(c.path, roundTrip(await runCase(c)));
    witnesses = { php: loadWitness('php'), java: loadWitness('java') };
  });

  it('the frozen witness exists per language and covers exactly the fixture matrix', () => {
    for (const lang of ['php', 'java'] as const) {
      const w = witnesses[lang]!;
      const witnessKeys = Object.keys(w).sort();
      const caseKeys = CASES.filter((c) => c.lang === lang).map((c) => c.path).sort();
      assert.deepStrictEqual(witnessKeys, caseKeys, `${lang} witness keys must match the case matrix`);
    }
  });

  // Layer 1 — the independent hand-authored spec.
  for (const c of CASES) {
    it(`semantic projection equals the hand-authored spec: ${c.file}`, () => {
      const spec = SPEC[c.path]!;
      assert.ok(spec, `spec missing for ${c.path}`);
      const live = liveResults.get(c.path)!;
      const proj = project(live);
      assert.deepStrictEqual(proj.defs, spec.defs, `${c.file}: symbol (subtype:name) sequence`);
      assert.deepStrictEqual(proj.imports, spec.imports, `${c.file}: import (source[names]) sequence`);
      assert.equal(live.parseStatus, spec.parseStatus, `${c.file}: parseStatus`);
    });
  }

  // Layer 2 — frozen witness deep-equal (ids/spans/order drift detection).
  for (const c of CASES) {
    it(`live extraction byte-equals the frozen parser witness: ${c.file}`, () => {
      const entry = witnesses[c.lang]![c.path]!;
      assert.ok(entry, `witness entry missing for ${c.path}`);
      assert.equal(entry.lang, c.lang);
      assert.deepStrictEqual(liveResults.get(c.path)!, entry.result);
    });
  }

  // The committed witness must itself satisfy the hand-authored spec (no silent
  // disagreement between layers 1 and 2).
  it('the frozen witness agrees with the hand-authored spec', () => {
    for (const c of CASES) {
      const proj = project(witnesses[c.lang]![c.path]!.result);
      assert.deepStrictEqual(proj.defs, SPEC[c.path]!.defs, `${c.file}: witness defs vs spec`);
      assert.deepStrictEqual(proj.imports, SPEC[c.path]!.imports, `${c.file}: witness imports vs spec`);
    }
  });

  it('extraction is deterministic run-to-run', async () => {
    for (const c of CASES) {
      const again = roundTrip(await runCase(c));
      assert.deepStrictEqual(again, witnesses[c.lang]![c.path]!.result, `non-deterministic: ${c.file}`);
    }
  });

  describe('invariants over every fixture (cadrage §4)', () => {
    it('exactly one file node, and it is first', () => {
      for (const c of CASES) {
        const r = liveResults.get(c.path)!;
        assert.equal(r.nodes.filter((n) => n.kind === 'file').length, 1, `${c.file}: one file node`);
        assert.equal(r.nodes[0]!.kind, 'file', `${c.file}: file node first`);
      }
    });

    it('every symbol node has a contains and a defines edge from the file node', () => {
      for (const c of CASES) {
        const r = liveResults.get(c.path)!;
        const fileNode = r.nodes[0]!.id;
        for (const sym of r.nodes.filter((n) => n.kind === 'symbol')) {
          assert.ok(
            r.edges.find((e) => e.kind === 'contains' && e.from === fileNode && e.to === sym.id),
            `${c.file}: ${sym.name} missing contains`,
          );
          assert.ok(
            r.edges.find((e) => e.kind === 'defines' && e.from === fileNode && e.to === sym.id),
            `${c.file}: ${sym.name} missing defines`,
          );
        }
      }
    });

    it('every module node has exactly one imports edge', () => {
      for (const c of CASES) {
        const r = liveResults.get(c.path)!;
        const fileNode = r.nodes[0]!.id;
        for (const mod of r.nodes.filter((n) => n.kind === 'module')) {
          assert.equal(
            r.edges.filter((e) => e.kind === 'imports' && e.from === fileNode && e.to === mod.id).length,
            1,
            `${c.file}: module ${mod.name} must have exactly one imports edge`,
          );
        }
      }
    });

    it('no duplicate node ids', () => {
      for (const c of CASES) {
        const ids = liveResults.get(c.path)!.nodes.map((n) => n.id);
        assert.equal(new Set(ids).size, ids.length, `${c.file}: duplicate node id`);
      }
    });

    it('every symbol and module node has a non-null span', () => {
      for (const c of CASES) {
        for (const n of liveResults.get(c.path)!.nodes.filter((x) => x.kind === 'symbol' || x.kind === 'module')) {
          assert.ok(n.span, `${c.file}: ${n.kind} ${n.name} must have a non-null span`);
        }
      }
    });

    it('every subtype is provider-declared for its language', () => {
      for (const c of CASES) {
        const declared = new Set<string>(PROVIDERS[c.lang as 'php' | 'java'].vocabulary.nodeSubtypes);
        for (const sym of liveResults.get(c.path)!.nodes.filter((n) => n.kind === 'symbol')) {
          assert.ok(sym.subtype, `${c.file}: ${sym.name} must have a subtype`);
          assert.ok(declared.has(sym.subtype!), `${c.file}: subtype ${sym.subtype} not declared by ${c.lang} provider`);
        }
      }
    });
  });

  it('PHP + Java captureMaps conform to the hard-coded capture convention', () => {
    assert.deepStrictEqual(assertCaptureMapConforms(phpProvider.queries.captureMap), []);
    assert.deepStrictEqual(assertCaptureMapConforms(javaProvider.queries.captureMap), []);
  });
});
