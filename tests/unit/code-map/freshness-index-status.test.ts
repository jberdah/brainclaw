import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refresh } from '../../../src/core/code-map/refresh.js';
import { JsonlBackend } from '../../../src/core/code-map/backend.js';

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-flabel-'));
  cleanup.push(d);
  return d;
}
function write(root: string, rel: string, c: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, c, 'utf-8');
}

describe('freshness labeling: index vs this-call spot-check (pln#601)', () => {
  it('a fresh index + fresh spot-check carries the canonical structured diagnostics', async () => {
    const root = tmp();
    write(root, 'src/util.ts', 'export function add(a: number, b: number) { return a + b; }\n');
    await refresh({ projectId: 'prj_fl1', projectRoot: root, scope: 'all', cwd: root, disableGit: true });

    const res = await new JsonlBackend().find({ query: 'add', cwd: root });
    assert.equal(res.freshness_badge.status, 'fresh');
    const details = res.freshness_badge.details as Record<string, Record<string, unknown>>;
    assert.equal(res.freshness_badge.freshness, 'fresh');
    assert.equal(details.index.status, 'fresh');
    assert.equal(details.spot_check.status, 'fresh');
  });

  it('a spot-check change does not replace the fresh top-line index badge', async () => {
    const root = tmp();
    write(root, 'src/util.ts', 'export function add(a: number, b: number) { return a + b; }\n');
    await refresh({ projectId: 'prj_fl2', projectRoot: root, scope: 'all', cwd: root, disableGit: true });

    // mutate the live file so the read-path spot-check detects drift while the
    // index MANIFEST stays fresh (we did not refresh after the edit).
    write(root, 'src/util.ts', 'export function add(a: number, b: number) { return a + b + 1; }\n');

    const res = await new JsonlBackend().find({ query: 'add', cwd: root });
    assert.equal(res.freshness_badge.freshness, 'fresh', 'top-line remains the shared index signal');
    const details = res.freshness_badge.details as Record<string, Record<string, unknown>>;
    assert.equal(details.index.status, 'fresh');
    assert.equal(details.spot_check.status, 'stale');
    assert.deepEqual(details.spot_check.stale_changed_files, ['src/util.ts']);
  });
});
