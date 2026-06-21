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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-brief-path-'));
  cleanup.push(d);
  return d;
}
function write(root: string, rel: string, c: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, c, 'utf-8');
}

describe('brief on a path target ranks the exact file (pln#593 1b)', () => {
  it('a file-path target ranks that file #1, not a token-colliding namesake', async () => {
    const root = tmp();
    write(root, 'src/checkout.ts', 'export function applyCoupon(c: string) { return c.toUpperCase(); }\n');
    // a same-TOKEN namesake symbol that the old fuzzy gather would surface for the
    // 'checkout' token in the path target:
    write(root, 'src/checkoutHelper.ts', 'export function checkout() { return 1; }\n');
    write(root, 'tests/checkout.test.ts', "import { applyCoupon } from '../src/checkout.js';\napplyCoupon('X');\n");
    await refresh({ projectId: 'prj_briefpath', projectRoot: root, scope: 'all', cwd: root, disableGit: true });

    const be = new JsonlBackend();
    const res = await be.brief({ target: 'src/checkout.ts', cwd: root });

    assert.equal(
      res.suggested_files_to_read[0]?.path,
      'src/checkout.ts',
      'the exact path target ranks #1',
    );
    assert.match(res.suggested_files_to_read[0]?.reason ?? '', /defines/);
    // the token-colliding namesake must NOT outrank the exact file (it may still
    // appear lower via same-dir, but never above the path target).
    const idxTarget = res.suggested_files_to_read.findIndex((f) => f.path === 'src/checkout.ts');
    const idxHelper = res.suggested_files_to_read.findIndex((f) => f.path === 'src/checkoutHelper.ts');
    if (idxHelper >= 0) assert.ok(idxTarget < idxHelper, 'namesake never outranks the path target');
  });

  it('a bare symbol target still resolves by name (non-path path is unchanged)', async () => {
    const root = tmp();
    write(root, 'src/checkout.ts', 'export function applyCoupon(c: string) { return c; }\n');
    await refresh({ projectId: 'prj_briefsym', projectRoot: root, scope: 'all', cwd: root, disableGit: true });

    const be = new JsonlBackend();
    const res = await be.brief({ target: 'applyCoupon', cwd: root });
    assert.equal(res.suggested_files_to_read[0]?.path, 'src/checkout.ts', 'symbol resolves to its defining file');
  });
});
