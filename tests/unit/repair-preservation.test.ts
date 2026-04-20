/**
 * Preservation invariants for the repair module (pln#397 stp_7ad66f68).
 *
 * These are source-level invariants that fail the suite if a future commit
 * introduces a destructive path. Complementary functional coverage of the
 * repair flow lives in repair-flow.test.ts (stp_6d5c80f1).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// dist-test mirrors tree as dist-test/tests/unit/... while source is src/commands/repair.ts.
// Walk up to repo root, then down to the source file (resolves from either layout).
function findRepoRoot(start: string): string {
  let cur = start;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(cur, 'package.json'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new Error('could not locate repo root from ' + start);
}
const repoRoot = findRepoRoot(here);
const repairSrc = fs.readFileSync(
  path.join(repoRoot, 'src', 'commands', 'repair.ts'),
  'utf-8',
);

describe('repair — preservation invariants', () => {
  it('never calls fs.unlinkSync (no file deletion)', () => {
    assert.ok(
      !/fs\.unlinkSync\s*\(/.test(repairSrc),
      'repair module must not delete files; use rename to a parking directory',
    );
  });

  it('never calls fs.rmSync (no directory deletion)', () => {
    assert.ok(
      !/fs\.rmSync\s*\(/.test(repairSrc),
      'repair module must not remove directories',
    );
  });

  it('never calls fs.rmdirSync', () => {
    assert.ok(!/fs\.rmdirSync\s*\(/.test(repairSrc));
  });

  it('never calls fs.truncate', () => {
    assert.ok(!/fs\.truncate\w*\(/.test(repairSrc));
  });

  it('unsafe actions log an explicit relocation warning before running', () => {
    // The banner runs only when !json && !dryRun && includeUnsafe && unsafe.length > 0.
    assert.match(
      repairSrc,
      /Preservation notice[\s\S]*?RELOCATE files \(never delete\)/,
      'repair must print a preservation banner before unsafe actions',
    );
  });

  it('unsafe outcomes default to skipped with a helpful reason when includeUnsafe is absent', () => {
    assert.match(
      repairSrc,
      /unsafe — pass --include-unsafe to execute/,
    );
  });
});
