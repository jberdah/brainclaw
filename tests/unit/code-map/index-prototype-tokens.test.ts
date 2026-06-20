/**
 * Regression: symbol-name tokens that collide with Object.prototype members.
 *
 * Found by dogfooding `code-map refresh --all` on the real brainclaw repo, which
 * crashed with "entries[token].push is not a function" because the symbols index
 * used a plain object as a token->array map: for a symbol named `constructor`,
 * `entries['constructor']` resolved to the inherited Object.prototype.constructor
 * function instead of undefined. The synthetic/tiny-react fixtures had no such
 * symbol, so the bug stayed hidden. Both the write side (indexes.ts, null-proto
 * maps) and the read side (store.ts, re-homed entries) are now prototype-safe.
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

function tempProject(file: string, contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-codemap-proto-'));
  cleanupDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', file), contents);
  return dir;
}

async function refreshAll(root: string) {
  return refresh({ projectId: 'prj_proto', projectRoot: root, scope: 'all', cwd: root, disableGit: true });
}

describe('code-map index — Object.prototype token collisions', () => {
  it('refresh + find work when a symbol is named `constructor` (write side)', async () => {
    // `constructor` is a legal identifier; lowercased it still collides with
    // Object.prototype.constructor — the exact token that crashed on the real repo.
    const root = tempProject(
      'proto.ts',
      [
        'export const constructor = 1;',
        'export function valueOf(): number { return 2; }',
        'export function useNormalHook(): number { return 3; }',
      ].join('\n'),
    );

    const res = await refreshAll(root);
    assert.equal(res.ran, true, 'refresh ran without throwing on the constructor token');
    assert.ok(res.files_parsed >= 1);

    const be = new JsonlBackend();
    const found = await be.find({ query: 'constructor', cwd: root });
    assert.ok(
      found.matches.some((m) => m.name === 'constructor' && m.path === 'src/proto.ts'),
      'a symbol named `constructor` is findable',
    );
  });

  it('find("constructor") on an index WITHOUT it returns nothing, no crash (read side)', async () => {
    const root = tempProject('plain.ts', 'export function useNormalHook(): number { return 1; }');
    await refreshAll(root);

    const be = new JsonlBackend();
    // Pre-fix, a JSON-parsed plain object would resolve entries['constructor'] to
    // Object.prototype.constructor (a non-iterable function) -> TypeError on iteration.
    const found = await be.find({ query: 'constructor', cwd: root });
    assert.equal(found.matches.length, 0, 'no false match from a prototype member');
  });
});
