import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refresh } from '../../../src/core/code-map/refresh.js';
import {
  readManifest,
  readSymbolsIndex,
  readImportsIndex,
  listShards,
} from '../../../src/core/code-map/store.js';
import {
  materializedDir,
  materializedNodesPath,
  symbolsIndexPath,
  importsIndexPath,
} from '../../../src/core/code-map/paths.js';
import { fileId } from '../../../src/core/code-map/ids.js';

const cleanupDirs: string[] = [];

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-codemap-refresh-'));
  cleanupDirs.push(dir);
  return dir;
}

function writeSrc(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    fs.rmSync(cleanupDirs.pop() as string, { recursive: true, force: true });
  }
});

const PROJECT = 'prj_refresh_test';

function fixture(root: string): void {
  writeSrc(
    root,
    'src/App.tsx',
    `import React from 'react';
export const App = () => <div>app</div>;
export default App;
`,
  );
  writeSrc(
    root,
    'src/hooks/useAuth.ts',
    `import { useState } from 'react';
export function useAuth() { return useState(null); }
`,
  );
  writeSrc(
    root,
    'src/util.ts',
    `export function add(a: number, b: number) { return a + b; }
`,
  );
  // an ignored file must never be parsed
  writeSrc(root, 'node_modules/pkg/index.js', `export const x = 1;`);
}

async function runAll(root: string) {
  return refresh({
    projectId: PROJECT,
    projectRoot: root,
    scope: 'all',
    cwd: root,
    disableGit: true,
  });
}

describe('code-map refresh --all', () => {
  it('writes shards + indexes + materialized; ignores node_modules', async () => {
    const root = tmpProject();
    fixture(root);
    const res = await runAll(root);

    assert.equal(res.ran, true);
    assert.equal(res.lock_acquired, true);
    assert.equal(res.files_parsed, 3, 'three supported files (node_modules ignored)');

    const shards = listShards(root);
    assert.equal(shards.length, 3);
    assert.ok(!shards.some((s) => s.path.includes('node_modules')));

    // indexes exist + findable
    assert.ok(fs.existsSync(symbolsIndexPath(root)));
    assert.ok(fs.existsSync(importsIndexPath(root)));
    const symbols = readSymbolsIndex(root);
    assert.ok(symbols);
    assert.ok(symbols!.entries['app'], 'App symbol indexed under lowercase token');
    assert.ok(symbols!.entries['useauth'], 'useAuth indexed');

    const imports = readImportsIndex(root);
    assert.ok(imports);
    assert.ok(imports!.entries['react'], 'react import indexed');
    // spec §5.7: imported[] carries the named bindings, not just the module.
    const useAuthReact = imports!.entries['react']!.find((e) => e.path === 'src/hooks/useAuth.ts');
    assert.ok(useAuthReact, 'useAuth.ts imports react');
    assert.deepEqual(useAuthReact!.imported, ['useState'], 'named binding captured in index');

    // materialized rebuilt
    assert.ok(fs.existsSync(materializedNodesPath(root)));
    const manifest = readManifest(root);
    assert.ok(manifest);
    assert.equal(manifest!.stats.files_indexed, 3);
    assert.ok(manifest!.stats.nodes > 0);
    assert.equal(manifest!.freshness.status, 'fresh');
  });

  it('queries (indexes/shards) still work with materialized/ deleted', async () => {
    const root = tmpProject();
    fixture(root);
    await runAll(root);

    // delete the rebuildable cache
    fs.rmSync(materializedDir(root), { recursive: true, force: true });
    assert.equal(fs.existsSync(materializedDir(root)), false);

    // indexes + shards remain authoritative
    const symbols = readSymbolsIndex(root);
    assert.ok(symbols!.entries['app'], 'symbol still queryable without materialized/');
    const shards = listShards(root);
    assert.equal(shards.length, 3, 'shards answer queries with no materialized cache');
  });

  it('refresh --changed re-parses only a touched file', async () => {
    const root = tmpProject();
    fixture(root);
    await runAll(root);

    const utilId = fileId(PROJECT, 'src/util.ts');
    const appId = fileId(PROJECT, 'src/App.tsx');
    const before = listShards(root).find((s) => s.file_id === utilId)!;
    const appBefore = listShards(root).find((s) => s.file_id === appId)!;

    // touch util.ts content only
    writeSrc(
      root,
      'src/util.ts',
      `export function add(a: number, b: number) { return a + b; }
export function sub(a: number, b: number) { return a - b; }
`,
    );

    // explicit changed-set seam: only util.ts is reported changed.
    const res = await refresh({
      projectId: PROJECT,
      projectRoot: root,
      scope: 'changed',
      cwd: root,
      changedPaths: ['src/util.ts'],
    });
    assert.equal(res.ran, true);
    assert.equal(res.files_parsed, 1, 'only the touched file was parsed');

    const after = listShards(root).find((s) => s.file_id === utilId)!;
    assert.notEqual(after.file_hash, before.file_hash, 'util.ts re-hashed');
    assert.ok(
      after.nodes.some((n) => n.name === 'sub'),
      'new symbol picked up on changed refresh',
    );

    // the untouched App.tsx shard is unchanged (not re-parsed).
    const appAfter = listShards(root).find((s) => s.file_id === appId)!;
    assert.equal(appAfter.file_hash, appBefore.file_hash, 'untouched file not re-parsed');
  });

  it('a deleted file is compacted out on refresh --all', async () => {
    const root = tmpProject();
    fixture(root);
    await runAll(root);
    assert.equal(listShards(root).length, 3);

    fs.rmSync(path.join(root, 'src/util.ts'));
    const res = await runAll(root);

    assert.equal(res.files_compacted, 1, 'orphan shard compacted');
    const shards = listShards(root);
    assert.equal(shards.length, 2);
    assert.ok(!shards.some((s) => s.path === 'src/util.ts'));

    // index no longer surfaces the deleted file's symbol
    const symbols = readSymbolsIndex(root);
    const addEntries = symbols!.entries['add'] ?? [];
    assert.ok(!addEntries.some((e) => e.path === 'src/util.ts'), 'deleted symbol not discoverable');
  });
});
