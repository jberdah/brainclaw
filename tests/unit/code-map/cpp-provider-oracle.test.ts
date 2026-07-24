/**
 * Code Map langs batch 2 — C++ provider oracle (fixtures-as-spec + real-repo dogfood).
 *
 * Layer 1 (correctness gate): a HAND-AUTHORED semantic spec (subtype:name defs +
 * source[names] imports + parseStatus), authored by reading the fixtures + the
 * provider's mapping rules, NOT generated from the provider. Layer 2: a real-repo
 * dogfood (fmtlib/fmt) asserting the queries survive real, heavily-templated C++ —
 * zero extraction_error, zero duplicate ids, non-trivial symbol yield — SKIPPED
 * gracefully when the corpus isn't cloned (CI).
 *
 * C++-SPECIFIC dogfood note: unlike the Go/Java oracles, the C++ dogfood does NOT
 * assert `parseStatus !== 'parse_error'`. tree-sitter-cpp sets `rootNode.hasError`
 * on real modern C++ (fmt leans on C++20 concepts, `if constexpr`, and dense macro
 * expansion the grammar can't fully parse), so most files report `parse_error`.
 * Tree-sitter's error recovery keeps the tree usable, so extraction still yields
 * thousands of symbols with ZERO extraction_error — the honest gate for "the
 * queries survive real C++" is extraction_error + yield + id-uniqueness, not a
 * clean parse.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile } from '../../../src/core/code-map/core.js';
import { assertCaptureMapConforms } from '../../../src/core/code-map/lang/query-runtime.js';
import { cppProvider } from '../../../src/core/code-map/lang/cpp/index.js';
import type { ExtractResult } from '../../../src/core/code-map/extractor.js';

const PROJECT = 'prj_cpp_oracle';
const MAX = 1024 * 1024;

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('cpp-provider-oracle: repo root not found');
}
const ROOT = repoRoot();
const FIX = path.join(ROOT, 'tests', 'fixtures', 'code-map', 'langs-cpp');

async function run(file: string, oversizedBytes?: number): Promise<ExtractResult> {
  const source = fs.readFileSync(path.join(FIX, file), 'utf-8');
  return extractFile({
    projectId: PROJECT, path: `src/${file}`, lang: 'cpp', source,
    sizeBytes: oversizedBytes ?? Buffer.byteLength(source), maxParseFileBytes: MAX,
  });
}
function project(r: ExtractResult): { defs: string[]; imports: string[] } {
  return {
    defs: r.nodes.filter((n) => n.kind === 'symbol').map((n) => `${n.subtype}:${n.name}`),
    imports: r.nodes.filter((n) => n.kind === 'module').map((n) => `${n.name}[${(n.imported_names || []).join(',')}]`),
  };
}

describe('code-map C++ provider oracle', () => {
  it('captureMap conforms to the runtime convention', () => {
    assert.doesNotThrow(() => assertCaptureMapConforms(cppProvider.queries.captureMap));
  });

  it('defs.cpp → macros/namespace/typedef+using/enums/struct+class/methods/function in source order', async () => {
    const { defs, imports } = project(await run('defs.cpp'));
    assert.deepEqual(defs, [
      'macro:MAX_SIZE',
      'macro:SQUARE',
      'namespace:widget',
      'type:handle_t',
      'type:Id',
      'enum:Color',
      'enum:Mode',
      'class:Point',
      'class:Config',
      'method:size',
      'method:reset',
      'function:freefn',
    ]);
    // `#include <string>` → angle-brackets stripped to the bare path, no names.
    assert.deepEqual(imports, ['string[]']);
  });

  it('imports.cpp → delimiter-stripped include paths (system <...> and quoted "...")', async () => {
    const { imports } = project(await run('imports.cpp'));
    assert.deepEqual(imports, ['vector[]', 'sys/types.h[]', 'widget/config.h[]', 'util.hpp[]']);
  });

  it('oversized → skipped_too_large, no symbols/imports (file node aside)', async () => {
    const r = await run('defs.cpp', 8 * 1024 * 1024);
    assert.equal(r.parseStatus, 'skipped_too_large');
    const { defs, imports } = project(r);
    assert.deepEqual([...defs, ...imports], []);
  });

  describe('real-repo dogfood (fmtlib/fmt) — skipped if corpus absent', () => {
    const corpus = path.join(ROOT, '..', 'code-map-dogfood', 'cpp', 'fmt');
    const exts = new Set(['.h', '.hpp', '.hh', '.cc', '.cpp', '.cxx']);
    let files: string[] = [];
    before(() => {
      if (!fs.existsSync(corpus)) return;
      const dirs = [path.join(corpus, 'include', 'fmt'), path.join(corpus, 'src')];
      for (const d of dirs) {
        if (!fs.existsSync(d)) continue;
        for (const f of fs.readdirSync(d)) {
          if (exts.has(path.extname(f))) files.push(path.join(d, f));
        }
      }
      files = files.slice(0, 12);
    });
    it('parses real C++ with zero extraction_error, unique ids, non-trivial symbol yield', async (t) => {
      if (!fs.existsSync(corpus) || files.length === 0) { t.skip('fmt corpus not cloned'); return; }
      let totalSymbols = 0;
      for (const abs of files) {
        const source = fs.readFileSync(abs, 'utf-8');
        const r = await extractFile({ projectId: PROJECT, path: path.basename(abs), lang: 'cpp', source, sizeBytes: Buffer.byteLength(source), maxParseFileBytes: 8 * 1024 * 1024 });
        // C++ reality: `parse_error` (tree.rootNode.hasError) is EXPECTED on modern
        // C++; error recovery still yields symbols. Gate on extraction_error, not parse.
        assert.equal((r.diagnostics || []).filter((d) => /extraction_error/.test(JSON.stringify(d))).length, 0, `${path.basename(abs)} no extraction_error`);
        const ids = r.nodes.map((n) => n.id);
        assert.equal(ids.length, new Set(ids).size, `${path.basename(abs)} has unique node ids (no duplicate-id)`);
        totalSymbols += r.nodes.filter((n) => n.kind === 'symbol').length;
      }
      assert.ok(totalSymbols > files.length, `expected many symbols across ${files.length} real files, got ${totalSymbols}`);
    });
  });
});
