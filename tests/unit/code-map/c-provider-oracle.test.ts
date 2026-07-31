/**
 * Code Map langs batch 2 — C provider oracle (fixtures-as-spec + real-repo dogfood).
 *
 * Layer 1 (correctness gate): a HAND-AUTHORED semantic spec (subtype:name defs +
 * source[names] imports + parseStatus), authored by reading the fixtures + the
 * provider's mapping rules, NOT generated from the provider. Layer 2: a real-repo
 * dogfood (DaveGamble/cJSON) asserting the queries survive real C — parsed, nodes>0,
 * zero extraction_error — SKIPPED gracefully when the corpus isn't cloned (CI).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile } from '../../../src/core/code-map/core.js';
import { assertCaptureMapConforms } from '../../../src/core/code-map/lang/query-runtime.js';
import { cProvider } from '../../../src/core/code-map/lang/c/index.js';
import type { ExtractResult } from '../../../src/core/code-map/extractor.js';

const PROJECT = 'prj_c_oracle';
const MAX = 1024 * 1024;

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('c-provider-oracle: repo root not found');
}
const ROOT = repoRoot();
const FIX = path.join(ROOT, 'tests', 'fixtures', 'code-map', 'langs-c');

async function run(file: string, oversizedBytes?: number): Promise<ExtractResult> {
  const source = fs.readFileSync(path.join(FIX, file), 'utf-8');
  return extractFile({
    projectId: PROJECT, path: `src/${file}`, lang: 'c', source,
    sizeBytes: oversizedBytes ?? Buffer.byteLength(source), maxParseFileBytes: MAX,
  });
}
function project(r: ExtractResult): { defs: string[]; imports: string[] } {
  return {
    defs: r.nodes.filter((n) => n.kind === 'symbol').map((n) => `${n.subtype}:${n.name}`),
    imports: r.nodes.filter((n) => n.kind === 'module').map((n) => `${n.name}[${(n.imported_names || []).join(',')}]`),
  };
}

describe('code-map C provider oracle', () => {
  it('captureMap conforms to the runtime convention', () => {
    assert.doesNotThrow(() => assertCaptureMapConforms(cProvider.queries.captureMap));
  });

  it('defs.c → macros/struct(class)/union/enum/typedef(type)/functions in source order', async () => {
    const { defs, imports } = project(await run('defs.c'));
    assert.deepEqual(defs, [
      'macro:MAX_SIZE',
      'macro:SQUARE',
      'class:Point',
      'c.union:Value',
      'enum:Color',
      'type:PointT',
      'type:Counter',
      'function:add',
      'function:make_label',
      'function:matrix',
    ]);
    assert.deepEqual(imports, ['stdlib.h[]']);
  });

  it('imports.c → bracket/quote-stripped header paths (system <> and local "")', async () => {
    const { imports } = project(await run('imports.c'));
    assert.deepEqual(imports, ['stdio.h[]', 'sys/types.h[]', 'config.h[]', 'lib/helpers.h[]']);
  });

  it('oversized → skipped_too_large, no symbols/imports (file node aside)', async () => {
    const r = await run('defs.c', 8 * 1024 * 1024);
    assert.equal(r.parseStatus, 'skipped_too_large');
    const { defs, imports } = project(r);
    assert.deepEqual([...defs, ...imports], []);
  });

  describe('real-repo dogfood (DaveGamble/cJSON) — skipped if corpus absent', () => {
    const corpus = path.join(ROOT, '..', 'code-map-dogfood', 'c', 'cJSON');
    let files: string[] = [];
    before(() => {
      if (!fs.existsSync(corpus)) return;
      files = fs.readdirSync(corpus)
        .filter((f) => (f.endsWith('.c') || f.endsWith('.h')) && !f.startsWith('test'))
        .slice(0, 12)
        .map((f) => path.join(corpus, f));
    });
    // NB: unlike the Go/cobra dogfood, we do NOT assert `parseStatus !== 'parse_error'`.
    // Real C leans on the preprocessor: cJSON wraps its public declarations in a
    // function-like macro (`CJSON_PUBLIC(cJSON *) cJSON_Parse(...)`) which, WITHOUT
    // expansion, tree-sitter-c flags as ERROR nodes → `rootNode.hasError` →
    // `parse_error` status. That is inherent to parsing unexpanded C, not a provider
    // bug: tree-sitter is error-tolerant, so the queries still extract the well-formed
    // subtrees. The meaningful robustness invariants for real C are therefore ZERO
    // extraction_error (queries never throw) + a non-trivial symbol yield.
    it('extracts real C with zero extraction_error and non-trivial symbol yield', async (t) => {
      if (!fs.existsSync(corpus) || files.length === 0) { t.skip('cJSON corpus not cloned'); return; }
      let totalSymbols = 0;
      for (const abs of files) {
        const source = fs.readFileSync(abs, 'utf-8');
        const r = await extractFile({ projectId: PROJECT, path: path.basename(abs), lang: 'c', source, sizeBytes: Buffer.byteLength(source), maxParseFileBytes: MAX });
        assert.notEqual(r.parseStatus, 'skipped_too_large', `${path.basename(abs)} not skipped`);
        assert.equal((r.diagnostics || []).filter((d) => /extraction_error/.test(String(d))).length, 0, `${path.basename(abs)} no extraction_error`);
        totalSymbols += r.nodes.filter((n) => n.kind === 'symbol').length;
      }
      assert.ok(totalSymbols > files.length, `expected many symbols across ${files.length} real files, got ${totalSymbols}`);
    });
  });
});
