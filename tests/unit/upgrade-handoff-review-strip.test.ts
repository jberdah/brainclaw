import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  HANDOFFS_SUBPATH,
  HANDOFF_REVIEW_STRIP_LOG,
  HandoffReviewStripLogSchema,
  MIGRATIONS_ARCHIVE_SUBPATH,
  stripHandoffReview,
} from '../../src/core/upgrades/patches/handoff-review-strip.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function storePathOf(workspace: TestWorkspace): string {
  return path.join(workspace.dir, '.brainclaw');
}

function writeHandoff(
  storePath: string,
  id: string,
  overrides: Record<string, unknown> = {},
): string {
  const dir = path.join(storePath, HANDOFFS_SUBPATH);
  fs.mkdirSync(dir, { recursive: true });
  const body = {
    id,
    short_label: `hdf#${id.slice(-3)}`,
    from: 'agent-a',
    to: 'agent-b',
    text: 'narrative',
    created_at: '2026-04-18T10:00:00.000Z',
    author: 'testuser',
    status: 'open',
    tags: [],
    ...overrides,
  };
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2), 'utf-8');
  return file;
}

describe('core/upgrades/patches/handoff-review-strip', () => {
  let workspace: TestWorkspace;
  const fixedNow = () => new Date('2026-04-18T15:00:00.000Z');

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-handoff-strip-' });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('returns noop when no handoffs carry a review block', () => {
    const storePath = storePathOf(workspace);
    writeHandoff(storePath, 'hdf_noreview');

    const result = stripHandoffReview({ storePath, now: fixedNow });

    assert.equal(result.status, 'noop');
    assert.equal(result.stripped.length, 0);
    assert.equal(result.scanned, 1);
    assert.equal(result.logPath, null);
  });

  it('strips review blocks and writes a migration log', () => {
    const storePath = storePathOf(workspace);
    writeHandoff(storePath, 'hdf_001', {
      review: {
        requester: 'agt_a',
        reviewer: 'agt_b',
        verdict: 'approved',
        blocking_issues: [],
      },
    });
    writeHandoff(storePath, 'hdf_002'); // no review, must be untouched
    writeHandoff(storePath, 'hdf_003', {
      review: { requester: 'agt_c', verdict: 'request_changes' },
    });

    const result = stripHandoffReview({ storePath, now: fixedNow });

    assert.equal(result.status, 'stripped');
    assert.equal(result.scanned, 3);
    assert.equal(result.stripped.length, 2);
    const ids = result.stripped.map((e) => e.handoff_id).sort();
    assert.deepEqual(ids, ['hdf_001', 'hdf_003']);

    // Files no longer carry review.
    const h1 = JSON.parse(fs.readFileSync(path.join(storePath, HANDOFFS_SUBPATH, 'hdf_001.json'), 'utf-8'));
    const h2 = JSON.parse(fs.readFileSync(path.join(storePath, HANDOFFS_SUBPATH, 'hdf_002.json'), 'utf-8'));
    const h3 = JSON.parse(fs.readFileSync(path.join(storePath, HANDOFFS_SUBPATH, 'hdf_003.json'), 'utf-8'));
    assert.equal(h1.review, undefined);
    assert.equal(h2.review, undefined);
    assert.equal(h3.review, undefined);
    assert.equal(h1.id, 'hdf_001');

    const log = HandoffReviewStripLogSchema.parse(
      JSON.parse(fs.readFileSync(result.logPath as string, 'utf-8')),
    );
    assert.equal(log.count, 2);
    assert.ok(log.entries.every((e) => e.handoff_path.startsWith('coordination/handoffs/')));
    const expectedLogPath = path.join(
      storePath,
      MIGRATIONS_ARCHIVE_SUBPATH,
      '2026-04-18',
      HANDOFF_REVIEW_STRIP_LOG,
    );
    assert.equal(result.logPath, expectedLogPath);
  });

  it('preserves unknown fields when rewriting a handoff', () => {
    const storePath = storePathOf(workspace);
    writeHandoff(storePath, 'hdf_extra', {
      review: { requester: 'agt_a' },
      // Field not declared in the current Zod schema — a future branch
      // might add it; the patch must not drop it.
      future_field: { nested: 'value', list: [1, 2, 3] },
    });

    stripHandoffReview({ storePath, now: fixedNow });

    const disk = JSON.parse(fs.readFileSync(path.join(storePath, HANDOFFS_SUBPATH, 'hdf_extra.json'), 'utf-8'));
    assert.equal(disk.review, undefined);
    assert.deepEqual(disk.future_field, { nested: 'value', list: [1, 2, 3] });
  });

  it('is idempotent — second run is a noop', () => {
    const storePath = storePathOf(workspace);
    writeHandoff(storePath, 'hdf_once', { review: { verdict: 'approved' } });

    const first = stripHandoffReview({ storePath, now: fixedNow });
    assert.equal(first.status, 'stripped');

    const second = stripHandoffReview({ storePath, now: fixedNow });
    assert.equal(second.status, 'noop');
    assert.equal(second.stripped.length, 0);
  });

  it('dry-run does not modify files or write a log', () => {
    const storePath = storePathOf(workspace);
    writeHandoff(storePath, 'hdf_dry', { review: { verdict: 'approved' } });

    const result = stripHandoffReview({ storePath, now: fixedNow, dryRun: true });

    assert.equal(result.status, 'planned');
    assert.equal(result.stripped.length, 1);
    const disk = JSON.parse(fs.readFileSync(path.join(storePath, HANDOFFS_SUBPATH, 'hdf_dry.json'), 'utf-8'));
    assert.ok(disk.review, 'dry-run must not rewrite the file');
    assert.equal(
      fs.existsSync(path.join(storePath, MIGRATIONS_ARCHIVE_SUBPATH, '2026-04-18', HANDOFF_REVIEW_STRIP_LOG)),
      false,
    );
  });
});
