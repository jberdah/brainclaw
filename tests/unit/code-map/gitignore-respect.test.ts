import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { refresh } from '../../../src/core/code-map/refresh.js';
import { listShards } from '../../../src/core/code-map/store.js';

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-gitignore-'));
  cleanup.push(d);
  return d;
}
function write(root: string, rel: string, c: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, c, 'utf-8');
}

// `generated/` is intentionally NOT in DEFAULT_IGNORE_PATTERNS — so any exclusion
// here is proof the .gitignore was honored (not a hardcoded default).
describe('code-map honors .gitignore (pln#593 1a)', () => {
  it('excludes a gitignored dir from the index, keeps non-ignored source', async () => {
    const root = tmp();
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
    write(root, '.gitignore', 'generated/\n');
    write(root, 'src/keep.ts', 'export const a = 1;\n');
    write(root, 'generated/skip.ts', 'export const b = 2;\n');

    await refresh({ projectId: 'prj_gi', projectRoot: root, scope: 'all', cwd: root }); // git ENABLED

    const paths = listShards(root).map((s) => s.path);
    assert.ok(paths.includes('src/keep.ts'), 'non-ignored source is indexed');
    assert.ok(
      !paths.some((p) => p.startsWith('generated/')),
      'gitignored dir is excluded from the index',
    );
  });

  it('honors a nested .gitignore + negation (git check-ignore semantics, not a reimpl)', async () => {
    const root = tmp();
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
    write(root, '.gitignore', 'build/\n');
    write(root, 'pkg/.gitignore', '*.gen.ts\n!keep.gen.ts\n'); // nested ignore + negation
    write(root, 'pkg/a.gen.ts', 'export const a = 1;\n'); // ignored by nested rule
    write(root, 'pkg/keep.gen.ts', 'export const k = 1;\n'); // re-included by negation
    write(root, 'pkg/normal.ts', 'export const n = 1;\n');
    write(root, 'build/out.ts', 'export const o = 1;\n'); // ignored by root rule

    await refresh({ projectId: 'prj_gi_nested', projectRoot: root, scope: 'all', cwd: root });

    const paths = listShards(root).map((s) => s.path);
    assert.ok(paths.includes('pkg/normal.ts'), 'normal source indexed');
    assert.ok(paths.includes('pkg/keep.gen.ts'), 'negated (!keep.gen.ts) re-included');
    assert.ok(!paths.includes('pkg/a.gen.ts'), 'nested *.gen.ts rule honored');
    assert.ok(!paths.some((p) => p.startsWith('build/')), 'root build/ rule honored');
  });

  it('disableGit keeps the hardcoded-only behaviour (gitignored file IS indexed)', async () => {
    const root = tmp();
    write(root, '.gitignore', 'generated/\n');
    write(root, 'src/keep.ts', 'export const a = 1;\n');
    write(root, 'generated/skip.ts', 'export const b = 2;\n');

    // disableGit -> no check-ignore. `generated/` is not a hardcoded default, so it
    // IS indexed — proving the exclusion above is genuinely git-driven.
    await refresh({ projectId: 'prj_gi2', projectRoot: root, scope: 'all', cwd: root, disableGit: true });

    const paths = listShards(root).map((s) => s.path);
    assert.ok(paths.includes('generated/skip.ts'), 'without git, .gitignore is not consulted');
  });
});
