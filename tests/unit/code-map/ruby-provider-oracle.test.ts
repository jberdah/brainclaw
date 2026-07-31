/**
 * Code Map langs batch 2 — Ruby provider oracle (fixtures-as-spec + real-repo dogfood).
 *
 * Layer 1 (correctness gate): a HAND-AUTHORED semantic spec (subtype:name defs +
 * source[names] imports + parseStatus), authored by reading the fixtures + the
 * provider's mapping rules, NOT generated from the provider. Layer 2: a real-repo
 * dogfood (sinatra) asserting the queries survive real Ruby — parsed, symbols>files,
 * zero extraction_error — SKIPPED gracefully when the corpus isn't cloned (CI).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile } from '../../../src/core/code-map/core.js';
import { assertCaptureMapConforms } from '../../../src/core/code-map/lang/query-runtime.js';
import { rubyProvider } from '../../../src/core/code-map/lang/ruby/index.js';
import type { ExtractResult } from '../../../src/core/code-map/extractor.js';

const PROJECT = 'prj_ruby_oracle';
const MAX = 1024 * 1024;

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('ruby-provider-oracle: repo root not found');
}
const ROOT = repoRoot();
const FIX = path.join(ROOT, 'tests', 'fixtures', 'code-map', 'langs-ruby');

async function run(file: string, oversizedBytes?: number): Promise<ExtractResult> {
  const source = fs.readFileSync(path.join(FIX, file), 'utf-8');
  return extractFile({
    projectId: PROJECT, path: `src/${file}`, lang: 'ruby', source,
    sizeBytes: oversizedBytes ?? Buffer.byteLength(source), maxParseFileBytes: MAX,
  });
}
function project(r: ExtractResult): { defs: string[]; imports: string[] } {
  return {
    defs: r.nodes.filter((n) => n.kind === 'symbol').map((n) => `${n.subtype}:${n.name}`),
    imports: r.nodes.filter((n) => n.kind === 'module').map((n) => `${n.name}[${(n.imported_names || []).join(',')}]`),
  };
}

/** Recursively collect `.rb` files under `dir`. */
function collectRb(dir: string, acc: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) collectRb(abs, acc);
    else if (entry.isFile() && entry.name.endsWith('.rb')) acc.push(abs);
  }
}

describe('code-map Ruby provider oracle', () => {
  it('captureMap conforms to the runtime convention', () => {
    assert.doesNotThrow(() => assertCaptureMapConforms(rubyProvider.queries.captureMap));
  });

  it('defs.rb → class/module(namespace)/method/singleton/constant + top-level def→function', async () => {
    const { defs, imports } = project(await run('defs.rb'));
    assert.deepEqual(defs, [
      'constant:MAX_SIZE',
      'namespace:Widget',
      'constant:VERSION',
      'class:Config',
      'method:initialize',
      'method:describe',
      'method:build',
      'method:helper',
      'function:top_level_fn',
    ]);
    assert.deepEqual(imports, ['set[]']);
  });

  it('imports.rb → require/require_relative sources (quote-stripped); non-require calls ignored', async () => {
    const { defs, imports } = project(await run('imports.rb'));
    assert.deepEqual(imports, ['sinatra[]', 'json[]', './helpers[]', 'active_support/core_ext[]']);
    // `def use` is a top-level def → function; `puts`/`JSON.parse` are not definitions.
    assert.deepEqual(defs, ['function:use']);
  });

  it('oversized → skipped_too_large, no symbols/imports (file node aside)', async () => {
    const r = await run('defs.rb', 8 * 1024 * 1024);
    assert.equal(r.parseStatus, 'skipped_too_large');
    const { defs, imports } = project(r);
    assert.deepEqual([...defs, ...imports], []);
  });

  describe('real-repo dogfood (sinatra) — skipped if corpus absent', () => {
    const corpus = path.join(ROOT, '..', 'code-map-dogfood', 'ruby', 'sinatra', 'lib');
    let files: string[] = [];
    before(() => {
      if (!fs.existsSync(corpus)) return;
      const acc: string[] = [];
      collectRb(corpus, acc);
      files = acc.slice(0, 12);
    });
    it('parses real Ruby with zero extraction_error and non-trivial symbol yield', async (t) => {
      if (!fs.existsSync(corpus) || files.length === 0) { t.skip('sinatra corpus not cloned'); return; }
      let totalSymbols = 0;
      for (const abs of files) {
        const source = fs.readFileSync(abs, 'utf-8');
        const r = await extractFile({ projectId: PROJECT, path: path.basename(abs), lang: 'ruby', source, sizeBytes: Buffer.byteLength(source), maxParseFileBytes: MAX });
        assert.notEqual(r.parseStatus, 'parse_error', `${path.basename(abs)} parsed`);
        assert.equal((r.diagnostics || []).filter((d) => /extraction_error/.test(String(d))).length, 0, `${path.basename(abs)} no extraction_error`);
        totalSymbols += r.nodes.filter((n) => n.kind === 'symbol').length;
      }
      assert.ok(totalSymbols > files.length, `expected many symbols across ${files.length} real files, got ${totalSymbols}`);
    });
  });
});
