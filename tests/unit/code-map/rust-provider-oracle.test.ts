/**
 * Code Map langs batch 2 — Rust provider oracle (fixtures-as-spec + real-repo dogfood).
 *
 * Layer 1 (correctness gate): a HAND-AUTHORED semantic spec (subtype:name defs +
 * source[names] imports + parseStatus), authored by reading the fixtures + the
 * provider's mapping rules, NOT generated from the provider. Layer 2: a real-repo
 * dogfood (clap-rs/clap) asserting the queries survive real Rust — parsed, nodes>0,
 * zero extraction_error — SKIPPED gracefully when the corpus isn't cloned (CI). Clap
 * is a cargo workspace (crates nested under each crate's src dir), so the dogfood
 * walks recursively for `.rs` files rather than a flat readdir.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile } from '../../../src/core/code-map/core.js';
import { assertCaptureMapConforms } from '../../../src/core/code-map/lang/query-runtime.js';
import { rustProvider } from '../../../src/core/code-map/lang/rust/index.js';
import type { ExtractResult } from '../../../src/core/code-map/extractor.js';

const PROJECT = 'prj_rust_oracle';
const MAX = 1024 * 1024;

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('rust-provider-oracle: repo root not found');
}
const ROOT = repoRoot();
const FIX = path.join(ROOT, 'tests', 'fixtures', 'code-map', 'langs-rust');

async function run(file: string, oversizedBytes?: number): Promise<ExtractResult> {
  const source = fs.readFileSync(path.join(FIX, file), 'utf-8');
  return extractFile({
    projectId: PROJECT, path: `src/${file}`, lang: 'rust', source,
    sizeBytes: oversizedBytes ?? Buffer.byteLength(source), maxParseFileBytes: MAX,
  });
}
function project(r: ExtractResult): { defs: string[]; imports: string[] } {
  return {
    defs: r.nodes.filter((n) => n.kind === 'symbol').map((n) => `${n.subtype}:${n.name}`),
    imports: r.nodes.filter((n) => n.kind === 'module').map((n) => `${n.name}[${(n.imported_names || []).join(',')}]`),
  };
}

/** Recursively collect up to `limit` `.rs` files (clap is a nested cargo workspace). */
function collectRs(dir: string, acc: string[], limit: number): void {
  if (acc.length >= limit) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (acc.length >= limit) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'target' || entry.name === '.git') continue;
      collectRs(full, acc, limit);
    } else if (entry.name.endsWith('.rs')) {
      acc.push(full);
    }
  }
}

describe('code-map Rust provider oracle', () => {
  it('captureMap conforms to the runtime convention', () => {
    assert.doesNotThrow(() => assertCaptureMapConforms(rustProvider.queries.captureMap));
  });

  it('defs.rs → const/static(constant)/type/struct(class)/enum/trait(rust.trait)/mod(namespace)/fn/impl-fn/macro in source order', async () => {
    const { defs, imports } = project(await run('defs.rs'));
    assert.deepEqual(defs, [
      'constant:MAX_SIZE',
      'constant:COUNTER',
      'type:NodeId',
      'class:Config',
      'enum:Store',
      'rust.trait:Describe',
      'namespace:inner',
      'function:helper',
      'function:new_config',
      'function:describe',
      'macro:my_macro',
    ]);
    assert.deepEqual(imports, ['std::fmt[]']);
  });

  it('imports.rs → simple path + group-use expansion + `as` alias + `*` wildcard', async () => {
    const { imports } = project(await run('imports.rs'));
    assert.deepEqual(imports, [
      'std::fmt[]',
      'std::collections[HashMap,BTreeMap]',
      'std::path::Path[FsPath]',
      'serde[*]',
    ]);
  });

  it('oversized → skipped_too_large, no symbols/imports (file node aside)', async () => {
    const r = await run('defs.rs', 8 * 1024 * 1024);
    assert.equal(r.parseStatus, 'skipped_too_large');
    const { defs, imports } = project(r);
    assert.deepEqual([...defs, ...imports], []);
  });

  describe('real-repo dogfood (clap-rs/clap) — skipped if corpus absent', () => {
    const corpus = path.join(ROOT, '..', 'code-map-dogfood', 'rust', 'clap');
    let files: string[] = [];
    before(() => {
      if (!fs.existsSync(corpus)) return;
      const acc: string[] = [];
      collectRs(corpus, acc, 20);
      files = acc;
    });
    it('parses real Rust with zero extraction_error and non-trivial symbol yield', async (t) => {
      if (!fs.existsSync(corpus) || files.length === 0) { t.skip('clap corpus not cloned'); return; }
      let totalSymbols = 0;
      for (const abs of files) {
        const source = fs.readFileSync(abs, 'utf-8');
        const r = await extractFile({ projectId: PROJECT, path: path.basename(abs), lang: 'rust', source, sizeBytes: Buffer.byteLength(source), maxParseFileBytes: MAX });
        assert.notEqual(r.parseStatus, 'parse_error', `${path.basename(abs)} parsed`);
        assert.equal((r.diagnostics || []).filter((d) => /extraction_error/.test(String(d))).length, 0, `${path.basename(abs)} no extraction_error`);
        totalSymbols += r.nodes.filter((n) => n.kind === 'symbol').length;
      }
      assert.ok(totalSymbols > files.length, `expected many symbols across ${files.length} real files, got ${totalSymbols}`);
    });
  });
});
