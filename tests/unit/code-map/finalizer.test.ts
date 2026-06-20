/**
 * Code Map P1a — CORE finalizer-from-drafts test (spec §10 step 2, §12 step 3).
 *
 * This locks IDENTITY (ids), default-edge SEMANTICS, and LEGACY APPEND ORDER
 * independently of any query runtime: we hand-write {@link ExtractionDraft}s that
 * mirror exactly what the legacy `extractor.ts` traversal would have produced for
 * a set of oracle fixtures, run them through `finalize()`, and assert the result
 * DEEP-EQUALS the matching entry in the frozen `oracle-golden.json`.
 *
 * The comparator is order-SENSITIVE (`assert.deepStrictEqual` compares arrays
 * positionally) — so any drift in node/edge ORDER, ids, spans, the `exported`
 * flag, confidence, or `imported_names` fails here. The drafts carry only the
 * LEGACY IDENTITY span per item (for lexical multi-declarators that is the shared
 * enclosing-statement span) plus an `ordinal` — the finalizer owns everything else.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalize } from '../../../src/core/code-map/finalizer.js';
import type {
  DefinitionDraft,
  ExportDraft,
  ExtractionDraft,
  ImportDraft,
} from '../../../src/core/code-map/drafts.js';
import type { ExtractInput, ExtractResult } from '../../../src/core/code-map/extractor.js';
import type { CodeLang, NodeSubtype, Span } from '../../../src/core/code-map/types.js';

const PROJECT = 'prj_code_map_oracle';
const MAX_PARSE_FILE_BYTES = 1024 * 1024;

/** Compact span helper. */
function sp(sl: number, sc: number, el: number, ec: number): Span {
  return { start_line: sl, start_col: sc, end_line: el, end_col: ec };
}

let ordinalCounter = 0;
function nextOrdinal(): number {
  return ordinalCounter++;
}
function resetOrdinals(): void {
  ordinalCounter = 0;
}

/** Definition-draft builder; ordinal auto-assigned in call order. */
function def(
  name: string,
  subtype: NodeSubtype,
  span: Span,
  exported = false,
  captureName = `@definition.${subtype}.node`,
): DefinitionDraft {
  return { ordinal: nextOrdinal(), captureName, name, subtype, span, exported };
}

/** Import / re-export-source draft builder. */
function imp(source: string, span: Span, importedNames: string[], isReExport = false): ImportDraft {
  return { ordinal: nextOrdinal(), source, span, importedNames, isReExport };
}

/** Export-clause / default-identifier draft builder. */
function exp(name: string, span: Span): ExportDraft {
  return { ordinal: nextOrdinal(), name, span };
}

/** Assemble a `parsed` draft from the per-kind lists (ordinals already embedded). */
function draftOf(
  filePath: string,
  parts: {
    definitions?: DefinitionDraft[];
    imports?: ImportDraft[];
    exports?: ExportDraft[];
  },
): ExtractionDraft {
  return {
    file: { path: filePath },
    definitions: parts.definitions ?? [],
    imports: parts.imports ?? [],
    exports: parts.exports ?? [],
    tests: [],
    facts: [],
    attributes: { parseStatus: 'parsed' },
  };
}

function inputFor(filePath: string, lang: CodeLang): ExtractInput {
  return {
    projectId: PROJECT,
    path: filePath,
    lang,
    source: '',
    sizeBytes: 0,
    maxParseFileBytes: MAX_PARSE_FILE_BYTES,
  };
}

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('finalizer.test: could not locate repo root');
}

const GOLDEN_PATH = path.join(
  repoRoot(),
  'tests',
  'fixtures',
  'code-map',
  'p1a',
  'oracle-golden.json',
);

interface GoldenEntry {
  path: string;
  lang: CodeLang;
  result: ExtractResult;
}
type Golden = Record<string, GoldenEntry>;

let golden: Golden;

/** Stable round-trip so finalized objects compare as plain JSON shapes vs golden. */
function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Each case hand-writes the drafts that the legacy extraction would have produced
 * for the matching fixture. The expected output is the frozen golden entry — so a
 * case proves `finalize()` reproduces the legacy ids/edges/order byte-for-byte.
 */
interface Case {
  key: string;
  lang: CodeLang;
  build: () => ExtractionDraft;
}

const CASES: Case[] = [
  {
    // simple fn / class / type / interface (non-exported + exported mix)
    key: 'src/p1a/declarations.ts',
    lang: 'typescript',
    build: () =>
      draftOf('src/p1a/declarations.ts', {
        definitions: [
          def('UserShape', 'interface', sp(2, 1, 4, 2), false),
          def('AdminShape', 'interface', sp(6, 8, 8, 2), true),
          def('UserId', 'type', sp(10, 1, 10, 22), false),
          def('AdminId', 'type', sp(12, 8, 12, 30), true),
          def('InternalStore', 'class', sp(14, 1, 18, 2), false),
          def('PublicStore', 'class', sp(20, 8, 22, 2), true),
          def('helper', 'function', sp(24, 1, 26, 2), false),
          def('compute', 'function', sp(28, 8, 30, 2), true),
        ],
      }),
  },
  {
    // lexical multi-declarator: every declarator shares the ENCLOSING statement span
    key: 'src/p1a/lexical-multi.ts',
    lang: 'typescript',
    build: () =>
      draftOf('src/p1a/lexical-multi.ts', {
        definitions: [
          def('a', 'variable', sp(3, 1, 5, 9), false),
          def('b', 'variable', sp(3, 1, 5, 9), false),
          def('c', 'variable', sp(3, 1, 5, 9), false),
          def('d', 'variable', sp(7, 8, 8, 10), true),
          def('e', 'variable', sp(7, 8, 8, 10), true),
          def('mutableX', 'variable', sp(10, 1, 11, 16), false),
          def('mutableY', 'variable', sp(10, 1, 11, 16), false),
        ],
      }),
  },
  {
    // React component + hook subtypes; one import (default + named).
    key: 'src/p1a/react-component.tsx',
    lang: 'tsx',
    build: () =>
      draftOf('src/p1a/react-component.tsx', {
        imports: [imp('react', sp(2, 1, 2, 42), ['default', 'useEffect'])],
        definitions: [
          def('useAuth', 'hook', sp(4, 8, 8, 2), true),
          def('Panel', 'component', sp(10, 8, 13, 3), true),
          def('Widget', 'component', sp(15, 1, 17, 2), false),
          def('notAComponent', 'function', sp(19, 1, 19, 32), false),
        ],
      }),
  },
  {
    // multiple imports of one module — one module node per import site.
    key: 'src/p1a/imports-multiple.ts',
    lang: 'typescript',
    build: () =>
      draftOf('src/p1a/imports-multiple.ts', {
        imports: [
          imp('./shared', sp(3, 1, 3, 30), ['a']),
          imp('./shared', sp(4, 1, 4, 30), ['b']),
          imp('./shared', sp(5, 1, 5, 38), ['default']),
        ],
      }),
  },
  {
    // `export { a }` BEFORE the declaration: clause fabricates `export` symbols
    // (no prior binding), THEN the later declarations add their own symbols.
    key: 'src/p1a/export-clause-before.ts',
    lang: 'typescript',
    build: () =>
      draftOf('src/p1a/export-clause-before.ts', {
        exports: [exp('gamma', sp(4, 1, 4, 25)), exp('delta', sp(4, 1, 4, 25))],
        definitions: [
          def('gamma', 'function', sp(6, 1, 6, 26), false),
          def('delta', 'variable', sp(8, 1, 8, 17), false),
        ],
      }),
  },
  {
    // `export { a }` AFTER the declaration: declarations first, then the clause
    // flips `exported` + emits exports edges.
    key: 'src/p1a/export-clause-after.ts',
    lang: 'typescript',
    build: () =>
      draftOf('src/p1a/export-clause-after.ts', {
        definitions: [
          def('alpha', 'function', sp(3, 1, 3, 26), false),
          def('beta', 'variable', sp(5, 1, 5, 16), false),
        ],
        exports: [exp('alpha', sp(7, 1, 7, 19)), exp('beta', sp(7, 1, 7, 19))],
      }),
  },
  {
    // re-exports from / *: module node + imports edge, NO phantom symbol.
    key: 'src/p1a/reexport.ts',
    lang: 'typescript',
    build: () =>
      draftOf('src/p1a/reexport.ts', {
        imports: [
          imp('./helper', sp(2, 1, 2, 47), ['helper', 'other'], true),
          imp('./star', sp(3, 1, 3, 24), ['*'], true),
          imp('./local', sp(4, 1, 4, 39), ['localImport']),
        ],
      }),
  },
  {
    // default-identifier export: function symbol, then exports edge on it.
    key: 'src/p1a/default-export.ts',
    lang: 'typescript',
    build: () =>
      draftOf('src/p1a/default-export.ts', {
        definitions: [def('mainEntry', 'function', sp(3, 1, 3, 30), false)],
        exports: [exp('mainEntry', sp(5, 1, 5, 19))],
      }),
  },

  // ── REVIEWER-ADDED CASES (the 6 oracle fixtures the implementer did NOT cover) ──
  // Each hand-builds the drafts the legacy traversal would have produced and asserts
  // finalize() deep-equals the frozen golden. Spans/subtypes/imported-names are the
  // legacy IDENTITY facts; the finalizer owns ids/edges/order/flag.
  {
    // arrow / var: arrow & function-expression classify as `function`; plain const /
    // `var` classify as `variable`. Every declarator's identity span = the ENCLOSING
    // statement span (multiplyArrow span starts at the `export` keyword: 4:8).
    key: 'src/p1a/arrow-var.ts',
    lang: 'typescript',
    build: () =>
      draftOf('src/p1a/arrow-var.ts', {
        definitions: [
          def('addArrow', 'function', sp(2, 1, 2, 58), false),
          def('multiplyArrow', 'function', sp(4, 8, 4, 70), true),
          def('plainValue', 'variable', sp(6, 1, 6, 23), false),
          def('legacyVar', 'variable', sp(8, 1, 8, 23), false),
          def('fnExpr', 'function', sp(10, 1, 12, 3), false),
        ],
      }),
  },
  {
    // named / default / namespace imports — module node per import, source-side names.
    key: 'src/p1a/imports-basic.ts',
    lang: 'typescript',
    build: () =>
      draftOf('src/p1a/imports-basic.ts', {
        imports: [
          imp('node:fs', sp(2, 1, 2, 40), ['readFileSync']),
          imp('./helper', sp(3, 1, 3, 38), ['default']),
          imp('./utils', sp(4, 1, 4, 34), ['*']),
          imp('node:path', sp(5, 1, 5, 43), ['join', 'resolve']),
        ],
      }),
  },
  {
    // export declarations: exported-in-place → exported:true, NO exports edge.
    // (Proves the exported FLAG is separated from the exports EDGE.)
    key: 'src/p1a/export-declarations.ts',
    lang: 'typescript',
    build: () =>
      draftOf('src/p1a/export-declarations.ts', {
        definitions: [
          def('exportedFn', 'function', sp(2, 8, 2, 38), true),
          def('ExportedClass', 'class', sp(4, 8, 4, 30), true),
          def('ExportedType', 'type', sp(6, 8, 6, 35), true),
          def('ExportedIface', 'interface', sp(8, 8, 10, 2), true),
          def('exportedConst', 'variable', sp(12, 8, 12, 32), true),
        ],
      }),
  },
  {
    // alias imports/exports: import records SOURCE-side names (original/other, not
    // renamed/o); `export { localThing as exportedName }` keys on the SOURCE name
    // `localThing`, matches the existing symbol → flips flag + ONE exports edge, no
    // new node. The exports edge lands AFTER contains/defines (later ordinal).
    key: 'src/p1a/alias.ts',
    lang: 'typescript',
    build: () =>
      draftOf('src/p1a/alias.ts', {
        imports: [imp('./source', sp(2, 1, 2, 60), ['original', 'other'])],
        definitions: [def('localThing', 'function', sp(4, 1, 4, 31), false)],
        exports: [exp('localThing', sp(6, 1, 6, 38))],
      }),
  },
  {
    // .js extension coverage (javascript grammar). import then exported decls + local.
    key: 'src/p1a/plain.js',
    lang: 'javascript',
    build: () =>
      draftOf('src/p1a/plain.js', {
        imports: [imp('react', sp(2, 1, 2, 34), ['useState'])],
        definitions: [
          def('makeCounter', 'function', sp(4, 8, 6, 2), true),
          def('PI', 'variable', sp(8, 8, 8, 24), true),
          def('localOnly', 'variable', sp(10, 1, 10, 21), false),
        ],
      }),
  },
  {
    // .jsx extension coverage (resolves to tsx). useToggle → hook (use* even without
    // JSX); Box → component (PascalCase arrow returning JSX). `export default Box`
    // matches the existing Box symbol → flips flag + exports edge, no new node.
    key: 'src/p1a/component.jsx',
    lang: 'tsx',
    build: () =>
      draftOf('src/p1a/component.jsx', {
        imports: [imp('react', sp(2, 1, 2, 27), ['default'])],
        definitions: [
          def('useToggle', 'hook', sp(4, 8, 6, 2), true),
          def('Box', 'component', sp(8, 8, 10, 3), true),
        ],
        exports: [exp('Box', sp(12, 1, 12, 19))],
      }),
  },
];

describe('code-map P1a finalizer (drafts → ExtractResult, vs frozen golden)', () => {
  before(() => {
    assert.ok(fs.existsSync(GOLDEN_PATH), 'oracle-golden.json must exist (Sprint 1 froze it)');
    golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf-8')) as Golden;
  });

  for (const c of CASES) {
    it(`finalize() reproduces the frozen legacy output: ${c.key}`, () => {
      resetOrdinals();
      const draft = c.build();
      const out = roundTrip(finalize(draft, inputFor(c.key, c.lang)));
      const expected = golden[c.key];
      assert.ok(expected, `golden entry missing for ${c.key}`);
      assert.equal(expected.lang, c.lang, 'case lang must match the golden lang tag');
      // ORDER-SENSITIVE deep-equal: ids, spans, exported flag, confidence,
      // imported_names, AND node/edge append order must all match the legacy.
      assert.deepStrictEqual(out, expected.result);
    });
  }
});

/**
 * REVIEWER-ADDED structural tests — independent of any golden. They attack the
 * exact failure modes the brief flags: (1) append/ordinal order must win over the
 * draft array grouping/sort order; (2) exported-in-place declarations emit NO
 * exports edge while clauses/defaults do.
 */
describe('code-map P1a finalizer (structural order + edge invariants)', () => {
  it('preserves ORDINAL (append) order across interleaved kinds, NOT array grouping', () => {
    // Hand-assign ordinals so the SOURCE order interleaves def/import/export:
    //   ordinal 0 def A | 1 import m1 | 2 def B | 3 export A | 4 import m2
    // but list them grouped (all defs, then all imports, then exports) in the draft
    // arrays — the WRONG order if the finalizer naively concatenated by kind.
    const draft: ExtractionDraft = {
      file: { path: 'src/order.ts' },
      definitions: [
        { ordinal: 0, captureName: '@definition.function.node', name: 'A', subtype: 'function', span: sp(1, 1, 1, 10), exported: false },
        { ordinal: 2, captureName: '@definition.function.node', name: 'B', subtype: 'function', span: sp(3, 1, 3, 10), exported: false },
      ],
      imports: [
        { ordinal: 1, source: 'm1', span: sp(2, 1, 2, 10), importedNames: ['x'] },
        { ordinal: 4, source: 'm2', span: sp(5, 1, 5, 10), importedNames: ['y'] },
      ],
      exports: [{ ordinal: 3, name: 'A', span: sp(4, 1, 4, 10) }],
      tests: [],
      facts: [],
      attributes: { parseStatus: 'parsed' },
    };
    const out = finalize(draft, inputFor('src/order.ts', 'typescript'));

    // Node order must follow ASCENDING ORDINAL, not the per-kind array grouping:
    //   file, sym A (0), module m1 (1), sym B (2), [export 3 flips A in place], module m2 (4)
    assert.deepStrictEqual(
      out.nodes.map((n) => `${n.kind}:${n.name}`),
      ['file:src/order.ts', 'symbol:A', 'module:m1', 'symbol:B', 'module:m2'],
      'nodes must emit in ordinal order (interleaved), not grouped by kind',
    );

    // Edge order: A contains+defines (ord 0), m1 imports (ord 1), B contains+defines
    // (ord 2), A exports (ord 3 — AFTER B's edges), m2 imports (ord 4).
    assert.deepStrictEqual(
      out.edges.map((e) => `${e.kind}@${e.source?.line}`),
      ['contains@1', 'defines@1', 'imports@2', 'contains@3', 'defines@3', 'exports@4', 'imports@5'],
      'edges must interleave by ordinal; the exports edge lands at its clause site',
    );

    // The export clause at ordinal 3 flipped A in place (no fabricated `export` node).
    const a = out.nodes.find((n) => n.name === 'A')!;
    assert.equal(a.exported, true, 'export clause flips the existing symbol exported flag');
    assert.equal(out.nodes.filter((n) => n.subtype === 'export').length, 0, 'no phantom export symbol');
  });

  it('exported-in-place declarations emit NO exports edge; only clauses/defaults do', () => {
    const draft: ExtractionDraft = {
      file: { path: 'src/flag.ts' },
      definitions: [
        // exported in place — flag only, NO edge.
        { ordinal: 0, captureName: '@definition.function.node', name: 'inPlace', subtype: 'function', span: sp(1, 1, 1, 30), exported: true },
        // not exported, but later named by a clause.
        { ordinal: 1, captureName: '@definition.function.node', name: 'viaClause', subtype: 'function', span: sp(2, 1, 2, 30), exported: false },
      ],
      imports: [],
      exports: [{ ordinal: 2, name: 'viaClause', span: sp(3, 1, 3, 20) }],
      tests: [],
      facts: [],
      attributes: { parseStatus: 'parsed' },
    };
    const out = finalize(draft, inputFor('src/flag.ts', 'typescript'));

    const exportsEdges = out.edges.filter((e) => e.kind === 'exports');
    assert.equal(exportsEdges.length, 1, 'exactly ONE exports edge (from the clause, not the in-place decl)');

    const inPlace = out.nodes.find((n) => n.name === 'inPlace')!;
    const viaClause = out.nodes.find((n) => n.name === 'viaClause')!;
    assert.equal(inPlace.exported, true, 'in-place export sets the flag');
    assert.equal(viaClause.exported, true, 'clause flips the referenced symbol flag');
    // The single exports edge must point at viaClause, never inPlace.
    assert.equal(exportsEdges[0]!.to, viaClause.id, 'exports edge targets the clause symbol');
    assert.notEqual(exportsEdges[0]!.to, inPlace.id, 'in-place exported decl gets NO exports edge');
  });

  it('re-export source emits a module node + imports edge, never a phantom symbol', () => {
    const draft: ExtractionDraft = {
      file: { path: 'src/re.ts' },
      definitions: [],
      imports: [{ ordinal: 0, source: './m', span: sp(1, 1, 1, 40), importedNames: ['a', 'b'], isReExport: true }],
      exports: [],
      tests: [],
      facts: [],
      attributes: { parseStatus: 'parsed' },
    };
    const out = finalize(draft, inputFor('src/re.ts', 'typescript'));
    assert.deepStrictEqual(out.nodes.map((n) => n.kind), ['file', 'module'], 're-export = file + module only');
    assert.deepStrictEqual(out.edges.map((e) => e.kind), ['imports'], 're-export = a single imports edge');
    assert.equal(out.nodes.filter((n) => n.subtype === 'export').length, 0, 'no phantom export symbol for re-export');
  });
});
