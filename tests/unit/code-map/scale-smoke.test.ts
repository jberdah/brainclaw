/**
 * Code Map scale smoke test — a PROXY for spec §12.2 (Brainclaw repo self-test)
 * that never touches the real <repo>/.brainclaw/code store.
 *
 * §12.2 wants a full refresh of a real-sized project to complete, queries to be
 * fast, and "no materialized JSONL committed by default". Running the actual
 * §12.2 against the live repo would write into the repo's own store — forbidden
 * by the test rules. So we synthesize ~300 .ts/.tsx files into an os.tmpdir()
 * project, refresh --all there, and assert the same shape of guarantees:
 *  - completes with sane, non-zero shard + symbol counts;
 *  - find() on a known generated symbol returns it;
 *  - queries still answer after materialized/ is deleted (rebuildable cache);
 *  - the materialized JSONL lives under .brainclaw/code/ which is gitignored
 *    (so it cannot be "committed by default").
 *
 * LATENCY POLICY: measure + log full-refresh ms; assert only a generous ceiling.
 * The §12.2 bar (full refresh <30s) is for a CALM machine, not this overloaded
 * Windows CI box.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { refresh } from '../../../src/core/code-map/refresh.js';
import { JsonlBackend } from '../../../src/core/code-map/backend.js';
import { listShards, readManifest, readSymbolsIndex } from '../../../src/core/code-map/store.js';
import { codeMapDir, materializedDir, materializedNodesPath } from '../../../src/core/code-map/paths.js';

const PROJECT = 'prj_scale_smoke';
const FILE_COUNT = 300; // within the 200-400 band the brief asks for.
const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    fs.rmSync(cleanupDirs.pop() as string, { recursive: true, force: true });
  }
});

function writeSrc(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

/**
 * Generate ~FILE_COUNT synthetic source files with deterministic, unique symbol
 * names and realistic import edges (each module imports the previous module's
 * util), spread across nested dirs. Mix .ts utility modules and .tsx components.
 */
function generateProject(): { root: string; sampleSymbol: string; sampleComponent: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-codemap-scale-'));
  cleanupDirs.push(root);

  for (let i = 0; i < FILE_COUNT; i++) {
    const dir = `src/mod${Math.floor(i / 25)}`;
    if (i % 4 === 0) {
      // a .tsx component module
      writeSrc(
        root,
        `${dir}/Widget${i}.tsx`,
        `import React from 'react';
${i > 0 ? `import { compute${i - 1} } from '../mod${Math.floor((i - 1) / 25)}/util${i - 1}.js';\n` : ''}export interface Widget${i}Props { id: number; }
export const Widget${i} = ({ id }: Widget${i}Props) => <div data-id={id}>w${i}</div>;
`,
      );
    } else {
      // a .ts utility module
      writeSrc(
        root,
        `${dir}/util${i}.ts`,
        `${i > 1 ? `import { compute${i - 2} } from '../mod${Math.floor((i - 2) / 25)}/util${i - 2}.js';\n` : ''}export type Tag${i} = 'a${i}' | 'b${i}';
export function compute${i}(x: number): number { return x + ${i}; }
export const CONST_${i} = ${i};
`,
      );
    }
  }
  // a known, unique symbol guaranteed to exist (i=1 is a util module).
  return { root, sampleSymbol: 'compute1', sampleComponent: 'Widget0' };
}

describe('code-map scale smoke (proxy for spec §12.2)', () => {
  it('full refresh completes with sane non-zero counts; queries work; materialized is rebuildable + ignored', async () => {
    const { root, sampleSymbol, sampleComponent } = generateProject();

    const t0 = performance.now();
    const res = await refresh({
      projectId: PROJECT,
      projectRoot: root,
      scope: 'all',
      cwd: root,
      disableGit: true,
    });
    const refreshMs = performance.now() - t0;
    console.log(
      `[§12.2 proxy] full refresh of ${FILE_COUNT} files = ${(refreshMs / 1000).toFixed(2)}s ` +
        `(spec target <30s, calm-machine only)`,
    );

    // --- completion + sane counts ---
    assert.equal(res.ran, true);
    assert.equal(res.lock_acquired, true);
    assert.equal(res.files_parsed, FILE_COUNT, 'every generated file parsed');

    const shards = listShards(root);
    assert.equal(shards.length, FILE_COUNT, 'one shard per file');

    const manifest = readManifest(root);
    assert.ok(manifest);
    assert.equal(manifest!.stats.files_indexed, FILE_COUNT);
    assert.ok(manifest!.stats.nodes >= FILE_COUNT, `nodes non-zero/sane (${manifest!.stats.nodes})`);
    assert.ok(manifest!.stats.edges >= FILE_COUNT, `edges non-zero/sane (${manifest!.stats.edges})`);
    assert.equal(manifest!.freshness.status, 'fresh');

    const symbols = readSymbolsIndex(root);
    assert.ok(symbols);
    assert.ok(Object.keys(symbols!.entries).length > 0, 'symbol index non-empty');

    // --- find() returns a known generated symbol ---
    const be = new JsonlBackend();
    const found = await be.find({ query: sampleSymbol, cwd: root });
    assert.ok(
      found.matches.some((m) => m.name === sampleSymbol),
      `find("${sampleSymbol}") returns the generated function`,
    );
    const foundComp = await be.find({ query: sampleComponent, cwd: root });
    assert.ok(
      foundComp.matches.some((m) => m.name === sampleComponent && m.subtype === 'component'),
      `find("${sampleComponent}") returns the generated component`,
    );

    // --- materialized JSONL is rebuildable: queries still answer after deletion ---
    assert.ok(fs.existsSync(materializedNodesPath(root)), 'materialized written by refresh');
    fs.rmSync(materializedDir(root), { recursive: true, force: true });
    assert.equal(fs.existsSync(materializedDir(root)), false);

    const afterDelete = await be.find({ query: sampleSymbol, cwd: root });
    assert.ok(
      afterDelete.matches.some((m) => m.name === sampleSymbol),
      'find() still answers from indexes/shards with materialized/ deleted',
    );
    assert.equal(listShards(root).length, FILE_COUNT, 'shards remain authoritative');

    // generous ceiling only — see latency policy header. 120s is ~4x the 30s
    // spec bar to absorb this box's variable load; the real check is on a calm
    // machine.
    assert.ok(
      refreshMs < 120_000,
      `full refresh sane (${(refreshMs / 1000).toFixed(2)}s < 120s generous ceiling)`,
    );
  });

  it('materialized JSONL lives under .brainclaw/code/ (gitignored — cannot be committed by default)', async () => {
    const { root } = generateProject();
    await refresh({
      projectId: PROJECT,
      projectRoot: root,
      scope: 'all',
      cwd: root,
      disableGit: true,
    });

    // structural guarantee: materialized/ is a child of the code store dir, which
    // is itself under .brainclaw/ (the repo gitignores all of .brainclaw/).
    const store = codeMapDir(root);
    const mat = materializedDir(root);
    assert.ok(mat.startsWith(store), 'materialized/ nested under .brainclaw/code/');
    assert.ok(
      store.split(path.sep).includes('.brainclaw'),
      'code store lives under the .brainclaw/ dir',
    );

    // belt-and-braces: ask the REAL repo git whether a materialized path under
    // .brainclaw/code/ would be ignored (the spec §12.2 "no materialized JSONL
    // committed by default" guarantee). check-ignore exits 0 when ignored.
    const repoRoot = process.cwd();
    let ignored = false;
    try {
      execFileSync(
        'git',
        ['check-ignore', '-q', '.brainclaw/code/materialized/nodes.v1.jsonl'],
        { cwd: repoRoot, stdio: 'ignore' },
      );
      ignored = true;
    } catch {
      ignored = false;
    }
    assert.ok(ignored, '.brainclaw/code/materialized/** is gitignored in the repo');
  });
});
