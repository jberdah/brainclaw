import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refresh } from '../../../src/core/code-map/refresh.js';
import { JsonlBackend } from '../../../src/core/code-map/backend.js';
import { codeMapWorkSection } from '../../../src/core/code-map/work-section.js';

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
});

function tmpProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-freshness-unified-'));
  cleanup.push(root);
  return root;
}
function write(root: string, rel: string, content: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}
function detailShape(badge: { details: Record<string, unknown> }): { root: string[]; index: string[]; spot: string[] } {
  const details = badge.details as Record<string, Record<string, unknown>>;
  return {
    root: Object.keys(details).sort(),
    index: Object.keys(details.index).sort(),
    spot: Object.keys(details.spot_check).sort(),
  };
}

describe('pln#601 unified freshness across work/status/find/brief', () => {
  it('keeps one index freshness while a find/brief spot-check discovers a changed candidate', async () => {
    const root = tmpProject();
    write(root, 'src/util.ts', 'export function add(a: number, b: number) { return a + b; }\n');
    await refresh({ projectId: 'prj_unified_badge', projectRoot: root, scope: 'all', cwd: root, disableGit: true });

    // Deliberately change after indexing: only read-path candidate checks know it.
    write(root, 'src/util.ts', 'export function add(a: number, b: number) { return a + b + 1; }\n');
    const backend = new JsonlBackend({ gitHeadReader: () => null });
    const [status, find, brief, work] = await Promise.all([
      backend.status({ cwd: root }),
      backend.find({ query: 'add', cwd: root }),
      backend.brief({ target: 'add', cwd: root }),
      codeMapWorkSection(root, { query: 'add', backend }),
    ]);
    assert.ok(work, 'the enabled Code Map work section is the bclaw_work surface');

    const badges = [status.freshness_badge, find.freshness_badge, brief.freshness_badge, work!.freshness_badge];
    for (const badge of badges) {
      assert.equal(badge.freshness, 'fresh', 'the shared top-level signal remains the index state');
      const details = badge.details as Record<string, Record<string, unknown>>;
      assert.equal(details.index.status, 'fresh');
    }
    const expectedShape = detailShape(badges[0]!);
    for (const badge of badges.slice(1)) assert.deepEqual(detailShape(badge), expectedShape);

    const findDetails = find.freshness_badge.details as Record<string, Record<string, unknown>>;
    const briefDetails = brief.freshness_badge.details as Record<string, Record<string, unknown>>;
    assert.equal((status.freshness_badge.details as Record<string, Record<string, unknown>>).spot_check.status, 'not_run');
    assert.equal(findDetails.spot_check.status, 'stale');
    assert.equal(briefDetails.spot_check.status, 'stale');
  });
});