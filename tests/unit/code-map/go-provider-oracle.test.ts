/**
 * Code Map langs batch 2 — Go provider oracle (fixtures-as-spec + real-repo dogfood).
 *
 * Layer 1 (correctness gate): a HAND-AUTHORED semantic spec (subtype:name defs +
 * source[names] imports + parseStatus), authored by reading the fixtures + the
 * provider's mapping rules, NOT generated from the provider. Layer 2: a real-repo
 * dogfood (spf13/cobra) asserting the queries survive real Go — parsed, nodes>0,
 * zero extraction_error — SKIPPED gracefully when the corpus isn't cloned (CI).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile } from '../../../src/core/code-map/core.js';
import { assertCaptureMapConforms } from '../../../src/core/code-map/lang/query-runtime.js';
import { goProvider } from '../../../src/core/code-map/lang/go/index.js';
import type { ExtractResult } from '../../../src/core/code-map/extractor.js';

const PROJECT = 'prj_go_oracle';
const MAX = 1024 * 1024;

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('go-provider-oracle: repo root not found');
}
const ROOT = repoRoot();
const FIX = path.join(ROOT, 'tests', 'fixtures', 'code-map', 'langs-go');

async function run(file: string, oversizedBytes?: number): Promise<ExtractResult> {
  const source = fs.readFileSync(path.join(FIX, file), 'utf-8');
  return extractFile({
    projectId: PROJECT, path: `src/${file}`, lang: 'go', source,
    sizeBytes: oversizedBytes ?? Buffer.byteLength(source), maxParseFileBytes: MAX,
  });
}
function project(r: ExtractResult): { defs: string[]; imports: string[] } {
  return {
    defs: r.nodes.filter((n) => n.kind === 'symbol').map((n) => `${n.subtype}:${n.name}`),
    imports: r.nodes.filter((n) => n.kind === 'module').map((n) => `${n.name}[${(n.imported_names || []).join(',')}]`),
  };
}

describe('code-map Go provider oracle', () => {
  it('captureMap conforms to the runtime convention', () => {
    assert.doesNotThrow(() => assertCaptureMapConforms(goProvider.queries.captureMap));
  });

  it('defs.go → functions/methods/struct(class)/interface/const/var in source order', async () => {
    const { defs, imports } = project(await run('defs.go'));
    assert.deepEqual(defs, [
      'package:widget',
      'constant:MaxSize',
      'variable:counter',
      'class:Config',
      'interface:Store',
      'function:New',
      'method:Describe',
    ]);
    assert.deepEqual(imports, ['fmt[]']);
  });

  it('imports.go → quote-stripped module paths (incl. a dotted vendored path)', async () => {
    const { imports } = project(await run('imports.go'));
    assert.deepEqual(imports, ['fmt[]', 'strings[]', 'github.com/spf13/cobra[]']);
  });

  it('oversized → skipped_too_large, no symbols/imports (file node aside)', async () => {
    const r = await run('defs.go', 8 * 1024 * 1024);
    assert.equal(r.parseStatus, 'skipped_too_large');
    const { defs, imports } = project(r);
    assert.deepEqual([...defs, ...imports], []);
  });

  describe('real-repo dogfood (spf13/cobra) — skipped if corpus absent', () => {
    const corpus = path.join(ROOT, '..', 'code-map-dogfood', 'go', 'cobra');
    let files: string[] = [];
    before(() => {
      if (!fs.existsSync(corpus)) return;
      files = fs.readdirSync(corpus)
        .filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'))
        .slice(0, 12)
        .map((f) => path.join(corpus, f));
    });
    it('parses real Go with zero extraction_error and non-trivial symbol yield', async (t) => {
      if (!fs.existsSync(corpus) || files.length === 0) { t.skip('cobra corpus not cloned'); return; }
      let totalSymbols = 0;
      for (const abs of files) {
        const source = fs.readFileSync(abs, 'utf-8');
        const r = await extractFile({ projectId: PROJECT, path: path.basename(abs), lang: 'go', source, sizeBytes: Buffer.byteLength(source), maxParseFileBytes: MAX });
        assert.notEqual(r.parseStatus, 'parse_error', `${path.basename(abs)} parsed`);
        assert.equal((r.diagnostics || []).filter((d) => /extraction_error/.test(String(d))).length, 0, `${path.basename(abs)} no extraction_error`);
        totalSymbols += r.nodes.filter((n) => n.kind === 'symbol').length;
      }
      assert.ok(totalSymbols > files.length, `expected many symbols across ${files.length} real files, got ${totalSymbols}`);
    });
  });
});
