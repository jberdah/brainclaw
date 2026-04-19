import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ARCHIVE_CANDIDATES_SUBPATH,
  CANDIDATE_ARCHIVE_MANIFEST,
  CandidateArchiveManifestSchema,
  PENDING_INBOX_SUBPATH,
  archivePendingCandidates,
} from '../../src/core/upgrades/patches/candidate-archive.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function storePathOf(workspace: TestWorkspace): string {
  return path.join(workspace.dir, '.brainclaw');
}

function writeCandidate(
  storePath: string,
  opts: {
    id: string;
    shortLabel?: string;
    status?: 'pending' | 'accepted' | 'rejected';
    type?: 'decision' | 'trap' | 'constraint' | 'handoff';
    subdir?: 'pending' | 'accepted' | 'rejected';
  },
): void {
  const subdir = opts.subdir ?? opts.status ?? 'pending';
  const dir = subdir === 'pending'
    ? path.join(storePath, PENDING_INBOX_SUBPATH)
    : path.join(storePath, PENDING_INBOX_SUBPATH, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const body = {
    id: opts.id,
    short_label: opts.shortLabel ?? `cnd#${opts.id.slice(-3)}`,
    type: opts.type ?? 'decision',
    text: `Candidate ${opts.id}`,
    created_at: '2026-04-18T10:00:00.000Z',
    author: 'testuser',
    tags: [],
    status: opts.status ?? 'pending',
  };
  fs.writeFileSync(path.join(dir, `${opts.id}.json`), JSON.stringify(body, null, 2), 'utf-8');
}

describe('core/upgrades/patches/candidate-archive', () => {
  let workspace: TestWorkspace;
  const fixedNow = () => new Date('2026-04-18T14:30:00.000Z');

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-candidate-archive-' });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('returns noop when there are no pending candidates', () => {
    const storePath = storePathOf(workspace);
    fs.mkdirSync(path.join(storePath, PENDING_INBOX_SUBPATH), { recursive: true });

    const result = archivePendingCandidates({ storePath, now: fixedNow });
    assert.equal(result.status, 'noop');
    assert.equal(result.moved.length, 0);
    assert.equal(result.manifestPath, null);
  });

  it('archives pending candidates and writes a dated manifest', () => {
    const storePath = storePathOf(workspace);
    writeCandidate(storePath, { id: 'cnd_aaa', shortLabel: 'cnd#001' });
    writeCandidate(storePath, { id: 'cnd_bbb', shortLabel: 'cnd#002', type: 'trap' });
    writeCandidate(storePath, { id: 'cnd_ccc', shortLabel: 'cnd#003', status: 'accepted', subdir: 'accepted' });
    writeCandidate(storePath, { id: 'cnd_ddd', shortLabel: 'cnd#004', status: 'rejected', subdir: 'rejected' });

    const result = archivePendingCandidates({ storePath, now: fixedNow });

    assert.equal(result.status, 'archived');
    assert.equal(result.moved.length, 2);

    const expectedArchiveDir = path.join(storePath, ARCHIVE_CANDIDATES_SUBPATH, '2026-04-18');
    assert.equal(result.archiveDir, expectedArchiveDir);
    assert.ok(fs.existsSync(path.join(expectedArchiveDir, 'cnd_aaa.json')));
    assert.ok(fs.existsSync(path.join(expectedArchiveDir, 'cnd_bbb.json')));

    // Accepted / rejected candidates must stay put.
    assert.ok(fs.existsSync(path.join(storePath, PENDING_INBOX_SUBPATH, 'accepted', 'cnd_ccc.json')));
    assert.ok(fs.existsSync(path.join(storePath, PENDING_INBOX_SUBPATH, 'rejected', 'cnd_ddd.json')));

    // Pending copies are gone from the live inbox root.
    assert.equal(fs.existsSync(path.join(storePath, PENDING_INBOX_SUBPATH, 'cnd_aaa.json')), false);
    assert.equal(fs.existsSync(path.join(storePath, PENDING_INBOX_SUBPATH, 'cnd_bbb.json')), false);

    const manifestPath = path.join(expectedArchiveDir, CANDIDATE_ARCHIVE_MANIFEST);
    const manifest = CandidateArchiveManifestSchema.parse(
      JSON.parse(fs.readFileSync(manifestPath, 'utf-8')),
    );
    assert.equal(manifest.count, 2);
    assert.equal(manifest.entries.length, 2);
    const ids = manifest.entries.map((e) => e.id).sort();
    assert.deepEqual(ids, ['cnd_aaa', 'cnd_bbb']);
    assert.ok(manifest.entries.every((e) => e.original_path.startsWith('coordination/inbox/')));
    assert.ok(manifest.entries.every((e) => e.archived_path.startsWith('archive/candidates/2026-04-18/')));
  });

  it('is idempotent — second run is a noop', () => {
    const storePath = storePathOf(workspace);
    writeCandidate(storePath, { id: 'cnd_once', shortLabel: 'cnd#100' });

    const first = archivePendingCandidates({ storePath, now: fixedNow });
    assert.equal(first.status, 'archived');

    const second = archivePendingCandidates({ storePath, now: fixedNow });
    assert.equal(second.status, 'noop');
    assert.equal(second.moved.length, 0);
  });

  it('dry-run plans without moving files or writing a manifest', () => {
    const storePath = storePathOf(workspace);
    writeCandidate(storePath, { id: 'cnd_plan', shortLabel: 'cnd#200' });

    const result = archivePendingCandidates({ storePath, now: fixedNow, dryRun: true });

    assert.equal(result.status, 'planned');
    assert.equal(result.moved.length, 1);
    assert.ok(fs.existsSync(path.join(storePath, PENDING_INBOX_SUBPATH, 'cnd_plan.json')));
    assert.equal(
      fs.existsSync(path.join(storePath, ARCHIVE_CANDIDATES_SUBPATH, '2026-04-18', CANDIDATE_ARCHIVE_MANIFEST)),
      false,
    );
  });

  it('fails loudly on a corrupt candidate JSON rather than skipping', () => {
    const storePath = storePathOf(workspace);
    const inboxDir = path.join(storePath, PENDING_INBOX_SUBPATH);
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(path.join(inboxDir, 'cnd_bad.json'), '{not json', 'utf-8');

    assert.throws(() => archivePendingCandidates({ storePath, now: fixedNow }));
  });

  it('archives legacy-shape candidates (e.g. status="proposed") and records the parse error', () => {
    const storePath = storePathOf(workspace);
    const inboxDir = path.join(storePath, PENDING_INBOX_SUBPATH);
    fs.mkdirSync(inboxDir, { recursive: true });
    // Legacy candidate: `status: "proposed"` is no longer a valid enum value,
    // and `text` is missing. The patch must still archive it, not crash.
    fs.writeFileSync(
      path.join(inboxDir, 'cnd_legacy.json'),
      JSON.stringify({
        id: 'cnd_legacy',
        short_label: 'cnd#legacy',
        type: 'decision',
        status: 'proposed',
        author: 'legacy-agent',
        created_at: '2025-01-01T00:00:00.000Z',
        tags: [],
      }),
      'utf-8',
    );

    const result = archivePendingCandidates({ storePath, now: fixedNow });

    assert.equal(result.status, 'archived');
    assert.equal(result.moved.length, 1);
    const entry = result.moved[0]!;
    assert.equal(entry.id, 'cnd_legacy');
    assert.equal(entry.status, 'proposed');
    assert.ok(entry.parse_error, 'parse error should be captured in manifest');
    assert.ok(typeof entry.parse_error === 'string' && entry.parse_error.length > 0);
  });
});
