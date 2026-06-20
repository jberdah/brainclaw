/**
 * Code Map P1b — INDEPENDENT Python `ast` oracle (cadrage §4 "the key addition").
 *
 * For each clean fixture we shell out to Python's OWN stdlib `ast` module (via the
 * vendored `ast_oracle.py` helper next to the fixtures) and obtain the SEMANTIC FACT
 * SET — top-level + class-method def names, async flag, class names, nested-def
 * names, module-level var names, and import source/names/relative-level. We then
 * assert the brainclaw provider extraction AGREES on that fact set. This is a third,
 * independent witness: neither tree-sitter (the provider's grammar) nor the
 * provider's own finalizer produced it. We compare the SYMBOL / IMPORT SET only —
 * NOT tree-sitter spans or finalizer node ids (those stay the provider's job).
 *
 * Python detection: we spawn `python --version` then `python3 --version`. If neither
 * is present the whole describe block is SKIPPED with a clear message (CI without a
 * Python toolchain must not fail). The skip is reported, never a silent pass.
 *
 * The syntax-error and oversized fixtures are EXCLUDED here: `ast.parse` raises on a
 * syntax error (the provider yields parse_error → file node only), and the oversized
 * case is a size-gate, not a semantic case. Both are covered by the provider-oracle.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractFile } from '../../../src/core/code-map/core.js';
import type { ExtractResult } from '../../../src/core/code-map/extractor.js';

const PROJECT = 'prj_code_map_oracle';
const MAX_PARSE_FILE_BYTES = 1024 * 1024;

/** Clean (parseable) fixtures only — syntax-error / oversized are not semantic cases. */
const FIXTURES = [
  'toplevel-def.py',
  'class-methods.py',
  'nested-def.py',
  'module-vars.py',
  'decorated.py',
  'imports.py',
  'import-as.py',
  'import-repeat.py',
  // Reviewer-added: parenthesized + multi-line from-import. `ast` normalizes the parens
  // away (names a,b / c,d), so this is a clean third-witness case for the provider's
  // grammar handling of `from . import (a, b)` and `from pkg import (c,\n d)`.
  'paren-import.py',
  // NOTE: toplevel-property.py is deliberately NOT here — it has no semantic-fact
  // agreement with `ast` (ast reports a plain top-level def; the provider classifies it
  // `property` per cadrage §5). It is asserted by the provider-oracle golden only.
];

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('python-ast-oracle: could not locate repo root from ' + fileURLToPath(import.meta.url));
}

const FIXTURES_DIR = path.join(repoRoot(), 'tests', 'fixtures', 'code-map', 'p1b-python');
const HELPER = path.join(FIXTURES_DIR, 'ast_oracle.py');

/** Probe `python` then `python3`; return the working interpreter or null. */
function detectPython(): string | null {
  for (const exe of ['python', 'python3']) {
    try {
      const r = spawnSync(exe, ['--version'], { encoding: 'utf-8' });
      // The Windows Store `python3` shim exits non-zero with a German/English nag on
      // stderr and never prints "Python X.Y" — require a real version banner.
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      if (r.status === 0 && /Python \d+\.\d+/.test(out)) return exe;
    } catch {
      /* not found — try next */
    }
  }
  return null;
}

interface AstImport {
  source: string;
  names: string[];
  relative_level: number;
}
interface AstFacts {
  top_level_defs: Array<{ name: string; async: boolean }>;
  classes: Array<{ name: string; methods: Array<{ name: string; async: boolean }> }>;
  nested_defs: string[];
  module_vars: string[];
  imports: AstImport[];
}

function astFactsFor(python: string, fixture: string): AstFacts {
  const r = spawnSync(python, [HELPER, path.join(FIXTURES_DIR, fixture)], { encoding: 'utf-8' });
  assert.equal(r.status, 0, `ast_oracle.py failed on ${fixture}: ${r.stderr}`);
  return JSON.parse(r.stdout) as AstFacts;
}

async function providerExtract(fixture: string): Promise<ExtractResult> {
  const abs = path.join(FIXTURES_DIR, fixture);
  const source = fs.readFileSync(abs, 'utf-8');
  return extractFile({
    projectId: PROJECT,
    path: `src/p1b/${fixture}`,
    lang: 'python',
    source,
    sizeBytes: Buffer.byteLength(source),
    maxParseFileBytes: MAX_PARSE_FILE_BYTES,
  });
}

const PYTHON = detectPython();

describe('code-map P1b independent Python ast oracle', { skip: PYTHON ? false : 'no python interpreter found (python / python3) — skipping the independent ast oracle' }, () => {
  const liveResults = new Map<string, ExtractResult>();
  const astResults = new Map<string, AstFacts>();

  before(async () => {
    for (const f of FIXTURES) {
      liveResults.set(f, await providerExtract(f));
      astResults.set(f, astFactsFor(PYTHON as string, f));
    }
  });

  it('reports which interpreter ran the oracle', () => {
    assert.ok(PYTHON, 'this block only runs when an interpreter was detected');
    // Visible in the test log so a run can be told apart from a skip.
    console.log(`[python-ast-oracle] running against interpreter: ${PYTHON}`);
  });

  for (const f of FIXTURES) {
    it(`provider symbol/import set agrees with the ast oracle: ${f}`, () => {
      const facts = astResults.get(f)!;
      const live = liveResults.get(f)!;

      // --- Build the EXPECTED symbol-name set from the ast facts. ---
      // top-level defs + nested defs -> function symbols; class -> class symbol;
      // class-body defs -> method/property symbols; module vars -> variable/constant.
      // We compare by (name) within each provider subtype bucket, so the witness is
      // the SET of symbols, not tree-sitter spans/ids.
      const astFunctionNames = [
        ...facts.top_level_defs.map((d) => d.name),
        ...facts.nested_defs,
      ].sort();
      const astClassNames = facts.classes.map((c) => c.name).sort();
      // class-body defs become method/property in the provider (subtype split is the
      // provider's decorator job). The ast oracle is decorator-agnostic, so the union
      // of provider method+property names must equal the ast class-method names.
      const astMethodNames = facts.classes.flatMap((c) => c.methods.map((m) => m.name)).sort();
      const astVarNames = facts.module_vars.sort();

      const symFunctions = live.nodes.filter((n) => n.kind === 'symbol' && n.subtype === 'function').map((n) => n.name).sort();
      const symClasses = live.nodes.filter((n) => n.kind === 'symbol' && n.subtype === 'class').map((n) => n.name).sort();
      const symMethodsAndProps = live.nodes.filter((n) => n.kind === 'symbol' && (n.subtype === 'method' || n.subtype === 'property')).map((n) => n.name).sort();
      const symVars = live.nodes.filter((n) => n.kind === 'symbol' && (n.subtype === 'variable' || n.subtype === 'constant')).map((n) => n.name).sort();

      assert.deepStrictEqual(symFunctions, astFunctionNames, `${f}: function symbol set must match ast top-level+nested defs`);
      assert.deepStrictEqual(symClasses, astClassNames, `${f}: class symbol set must match ast classes`);
      assert.deepStrictEqual(symMethodsAndProps, astMethodNames, `${f}: method/property symbol set must match ast class methods`);
      assert.deepStrictEqual(symVars, astVarNames, `${f}: variable/constant symbol set must match ast module vars`);

      // --- Async-ness is classification-only (NOT persisted), but every async def in
      // the ast set MUST still appear as a function/method symbol (it is not dropped). ---
      const asyncDefNames = [
        ...facts.top_level_defs.filter((d) => d.async).map((d) => d.name),
        ...facts.classes.flatMap((c) => c.methods.filter((m) => m.async).map((m) => m.name)),
      ];
      const allSymNames = new Set(live.nodes.filter((n) => n.kind === 'symbol').map((n) => n.name));
      for (const name of asyncDefNames) {
        assert.ok(allSymNames.has(name), `${f}: async def ${name} must still be emitted as a symbol`);
      }

      // --- Imports: source + source-side names, ORDER-SENSITIVE. The relative-import
      // level is encoded verbatim in `source` (leading dots), so matching source
      // already validates the relative level — but we assert it explicitly too. ---
      const modules = live.nodes.filter((n) => n.kind === 'module');
      assert.equal(modules.length, facts.imports.length, `${f}: module-node count must match ast import count`);
      for (let i = 0; i < facts.imports.length; i++) {
        const expected = facts.imports[i]!;
        const mod = modules[i]!;
        assert.equal(mod.name, expected.source, `${f}: import #${i} source mismatch`);
        assert.deepStrictEqual(mod.imported_names, expected.names, `${f}: import #${i} names mismatch`);
        // Recompute the relative level from the recorded source (leading dots) and
        // check it equals the ast-reported level — proving the dots survived verbatim.
        const leadingDots = /^\.*/.exec(mod.name)![0].length;
        assert.equal(leadingDots, expected.relative_level, `${f}: import #${i} relative level (leading dots) mismatch`);
      }
    });
  }
});
