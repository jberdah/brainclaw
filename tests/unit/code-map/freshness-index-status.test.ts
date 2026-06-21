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

describe('freshness labeling: index_status vs this call spot-check (pln#593 #2)', () => {
  it('a fresh index + fresh spot-check carries NO index_status (no contradiction, no noise)', async () => {
    const root = tmp();
    write(root, 'src/util.ts', 'export function add(a: number, b: number) { return a + b; }\n');
    await refresh({ projectId: 'prj_fl1', projectRoot: root, scope: 'all', cwd: root, disableGit: true });

    const res = await new JsonlBackend().find({ query: 'add', cwd: root });
    assert.equal(res.freshness_badge.status, 'fresh');
    assert.equal(
      res.freshness_badge.details.index_status,
      undefined,
      'status == index status -> no redundant index_status',
    );
  });

  it('a spot-check change over a fresh index surfaces index_status=fresh (not a contradiction)', async () => {
    const root = tmp();
    write(root, 'src/util.ts', 'export function add(a: number, b: number) { return a + b; }\n');
    await refresh({ projectId: 'prj_fl2', projectRoot: root, scope: 'all', cwd: root, disableGit: true });

    // mutate the live file so the read-path spot-check detects drift while the
    // index MANIFEST stays fresh (we did not refresh after the edit).
    write(root, 'src/util.ts', 'export function add(a: number, b: number) { return a + b + 1; }\n');

    const res = await new JsonlBackend().find({ query: 'add', cwd: root });
    assert.equal(res.freshness_badge.status, 'stale_changed_files', 'call-level spot-check sees the change');
    assert.equal(
      res.freshness_badge.details.index_status,
      'fresh',
      'index itself was fresh — the divergence is explained, not contradictory',
    );
  });
});
