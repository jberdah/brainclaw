/**
 * Code Map langs batch 2 — C# provider oracle (fixtures-as-spec + real-repo dogfood).
 *
 * Layer 1 (correctness gate): a HAND-AUTHORED semantic spec (subtype:name defs +
 * source[names] imports + parseStatus), authored by reading the fixtures + the
 * provider's mapping rules, NOT generated from the provider. Layer 2: a real-repo
 * dogfood (JamesNK/Newtonsoft.Json) asserting the queries survive real C# — parsed,
 * nodes>0, zero extraction_error — SKIPPED gracefully when the corpus isn't cloned
 * (CI). The corpus keeps its `.cs` under `Src/`, so the walk recurses.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile } from '../../../src/core/code-map/core.js';
import { assertCaptureMapConforms } from '../../../src/core/code-map/lang/query-runtime.js';
import { csharpProvider } from '../../../src/core/code-map/lang/csharp/index.js';
import type { ExtractResult } from '../../../src/core/code-map/extractor.js';

const PROJECT = 'prj_csharp_oracle';
const MAX = 1024 * 1024;

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('csharp-provider-oracle: repo root not found');
}
const ROOT = repoRoot();
const FIX = path.join(ROOT, 'tests', 'fixtures', 'code-map', 'langs-csharp');

async function run(file: string, oversizedBytes?: number): Promise<ExtractResult> {
  const source = fs.readFileSync(path.join(FIX, file), 'utf-8');
  return extractFile({
    projectId: PROJECT, path: `src/${file}`, lang: 'csharp', source,
    sizeBytes: oversizedBytes ?? Buffer.byteLength(source), maxParseFileBytes: MAX,
  });
}
function project(r: ExtractResult): { defs: string[]; imports: string[] } {
  return {
    defs: r.nodes.filter((n) => n.kind === 'symbol').map((n) => `${n.subtype}:${n.name}`),
    imports: r.nodes.filter((n) => n.kind === 'module').map((n) => `${n.name}[${(n.imported_names || []).join(',')}]`),
  };
}

/** Recursively collect `.cs` files under `dir` (the corpus keeps them in Src/). */
function collectCs(dir: string, out: string[], limit: number): void {
  if (out.length >= limit) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= limit) return;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectCs(abs, out, limit);
    } else if (entry.name.endsWith('.cs') && !entry.name.endsWith('.Tests.cs') && entry.name !== 'AssemblyInfo.cs') {
      out.push(abs);
    }
  }
}

describe('code-map C# provider oracle', () => {
  it('captureMap conforms to the runtime convention', () => {
    assert.doesNotThrow(() => assertCaptureMapConforms(csharpProvider.queries.captureMap));
  });

  it('defs.cs → namespace/delegate/interface/enum/struct/record/class/members in source order', async () => {
    const { defs, imports } = project(await run('defs.cs'));
    assert.deepEqual(defs, [
      'namespace:Widget.Core',
      'csharp.delegate:Transformer',
      'interface:IStore',
      'method:Save',
      'enum:Color',
      'constant:Red',
      'constant:Green',
      'csharp.struct:Point',
      'field:X',
      'csharp.record:Money',
      'class:Config',
      'field:MaxSize',
      'field:_counter',
      'property:Name',
      'constructor:Config',
      'method:Save',
      'method:Describe',
    ]);
    assert.deepEqual(imports, ['System[]']);
  });

  it('imports.cs → plain/dotted/static module paths + alias binding (using X = A.B)', async () => {
    const { imports } = project(await run('imports.cs'));
    assert.deepEqual(imports, [
      'System[]',
      'System.Text[]',
      'System.Math[]',
      'Newtonsoft.Json[Json]',
      'System.Collections.Generic[]',
    ]);
  });

  it('oversized → skipped_too_large, no symbols/imports (file node aside)', async () => {
    const r = await run('defs.cs', 8 * 1024 * 1024);
    assert.equal(r.parseStatus, 'skipped_too_large');
    const { defs, imports } = project(r);
    assert.deepEqual([...defs, ...imports], []);
  });

  describe('real-repo dogfood (Newtonsoft.Json) — skipped if corpus absent', () => {
    const corpus = path.join(ROOT, '..', 'code-map-dogfood', 'csharp', 'Newtonsoft.Json');
    let files: string[] = [];
    before(() => {
      if (!fs.existsSync(corpus)) return;
      const collected: string[] = [];
      collectCs(corpus, collected, 20);
      files = collected;
    });
    it('parses real C# with zero extraction_error and non-trivial symbol yield', async (t) => {
      if (!fs.existsSync(corpus) || files.length === 0) { t.skip('Newtonsoft.Json corpus not cloned'); return; }
      let totalSymbols = 0;
      for (const abs of files) {
        const source = fs.readFileSync(abs, 'utf-8');
        const r = await extractFile({ projectId: PROJECT, path: path.basename(abs), lang: 'csharp', source, sizeBytes: Buffer.byteLength(source), maxParseFileBytes: MAX });
        assert.notEqual(r.parseStatus, 'parse_error', `${path.basename(abs)} parsed`);
        assert.equal((r.diagnostics || []).filter((d) => /extraction_error/.test(String(d))).length, 0, `${path.basename(abs)} no extraction_error`);
        totalSymbols += r.nodes.filter((n) => n.kind === 'symbol').length;
      }
      assert.ok(totalSymbols > files.length, `expected many symbols across ${files.length} real files, got ${totalSymbols}`);
    });
  });
});
