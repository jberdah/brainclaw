/**
 * Regression: default ignore patterns (node_modules/dist/...) must apply at ANY
 * depth, not just the repo root.
 *
 * Found by dogfooding `code-map refresh --all` on the real brainclaw repo: it
 * indexed 8208 files under nested node_modules (e.g. foo/node_modules/**) because
 * `node_modules/**` was compiled to a root-anchored regex. Bare single-segment
 * dir patterns now match the directory at any depth, like .gitignore.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refresh } from '../../../src/core/code-map/refresh.js';
import { JsonlBackend } from '../../../src/core/code-map/backend.js';

const cleanupDirs: string[] = [];
afterEach(() => {
  while (cleanupDirs.length > 0) fs.rmSync(cleanupDirs.pop() as string, { recursive: true, force: true });
});

function write(root: string, rel: string, contents: string) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

describe('code-map ignore — nested ignored directories', () => {
  it('excludes node_modules/dist at any depth, keeps real source', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-codemap-ignore-'));
    cleanupDirs.push(root);

    write(root, 'src/keep.ts', 'export function keepMe(): number { return 1; }');
    // nested node_modules — the exact shape that leaked on the real repo
    write(root, 'pkgs/widget/node_modules/dep/index.ts', 'export function depFn(): number { return 2; }');
    // top-level + nested dist
    write(root, 'dist/out.ts', 'export function distFn(): number { return 3; }');
    write(root, 'pkgs/widget/dist/bundle.ts', 'export function bundledFn(): number { return 4; }');

    const res = await refresh({
      projectId: 'prj_ignore',
      projectRoot: root,
      scope: 'all',
      cwd: root,
      disableGit: true,
    });
    assert.equal(res.ran, true);
    assert.equal(res.files_parsed, 1, 'only src/keep.ts is parsed; ignored dirs excluded at any depth');

    const be = new JsonlBackend();
    assert.ok((await be.find({ query: 'keepMe', cwd: root })).matches.length > 0, 'real source indexed');
    for (const ignored of ['depFn', 'distFn', 'bundledFn']) {
      assert.equal(
        (await be.find({ query: ignored, cwd: root })).matches.length,
        0,
        `${ignored} (under an ignored dir) must not be indexed`,
      );
    }
  });

  it('does not ignore real source under internal-docs, only vendored desktop runtime copies', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-codemap-ignore-'));
    cleanupDirs.push(root);

    write(root, 'internal-docs/real-source.ts', 'export function documentedSource(): number { return 1; }');
    write(
      root,
      'internal-docs/desktop-extensions/demo/runtime/mirror.ts',
      'export function runtimeMirror(): number { return 2; }',
    );

    const res = await refresh({
      projectId: 'prj_ignore_internal_docs',
      projectRoot: root,
      scope: 'all',
      cwd: root,
      disableGit: true,
    });
    assert.equal(res.ran, true);
    assert.equal(res.files_parsed, 1, 'generic internal-docs source is indexed; runtime mirror is ignored');

    const be = new JsonlBackend();
    assert.ok(
      (await be.find({ query: 'documentedSource', cwd: root })).matches.length > 0,
      'real source under internal-docs is indexed',
    );
    assert.equal(
      (await be.find({ query: 'runtimeMirror', cwd: root })).matches.length,
      0,
      'vendored desktop runtime mirror is ignored',
    );
  });
});
