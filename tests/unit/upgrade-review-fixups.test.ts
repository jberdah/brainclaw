import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  BACKUP_DIR_PREFIX,
  BackupError,
  ROLLBACK_STAGING_PREFIX,
  createBackup,
  restoreBackup,
} from '../../src/core/upgrades/backup.js';
import { stripHandoffReview, HANDOFFS_SUBPATH } from '../../src/core/upgrades/patches/handoff-review-strip.js';
import { rolloutProvenance } from '../../src/core/upgrades/patches/provenance-rollout.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function storePathOf(workspace: TestWorkspace): string {
  return path.join(workspace.dir, '.brainclaw');
}

describe('codex review fixups', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-review-fixups-' });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  describe('finding #1 — rollback failure atomicity', () => {
    it('stages the restore and removes the manifest before swap', () => {
      const storePath = storePathOf(workspace);
      const liveFile = path.join(storePath, 'memory/decisions/dec_001.json');
      fs.mkdirSync(path.dirname(liveFile), { recursive: true });
      fs.writeFileSync(liveFile, '{"id":"dec_001","state":"pre-backup"}', 'utf-8');

      const handle = createBackup({ storePath });

      // Mutate the live store after backup.
      fs.writeFileSync(liveFile, '{"id":"dec_001","state":"mutated"}', 'utf-8');

      const result = restoreBackup({ storePath, backupPath: handle.backupPath });

      // Live store is back to the backup state, no backup.json leaks in.
      const disk = JSON.parse(fs.readFileSync(liveFile, 'utf-8'));
      assert.equal(disk.state, 'pre-backup');
      assert.equal(fs.existsSync(path.join(storePath, 'backup.json')), false);
      assert.ok(result.parkedPath.length > 0);
      assert.ok(fs.existsSync(result.parkedPath));
    });

    it('cleans the staging dir and leaves the live store untouched when staging copy fails', () => {
      const storePath = storePathOf(workspace);
      const liveFile = path.join(storePath, 'memory/traps/trp_001.json');
      fs.mkdirSync(path.dirname(liveFile), { recursive: true });
      fs.writeFileSync(liveFile, '{"id":"trp_001","text":"live"}', 'utf-8');

      const handle = createBackup({ storePath });
      // Delete the backup content so cpSync fails but manifest read still succeeded.
      // We keep the backup dir so the manifest check passes, then remove its contents
      // after reading the manifest — we rely on the manifest being loaded before copy.
      // Simpler: point at a backup dir that no longer has readable payload by deleting
      // then re-creating an empty shell with just the manifest.
      const manifestRaw = fs.readFileSync(path.join(handle.backupPath, 'backup.json'), 'utf-8');
      fs.rmSync(handle.backupPath, { recursive: true, force: true });
      fs.mkdirSync(handle.backupPath, { recursive: true });
      fs.writeFileSync(path.join(handle.backupPath, 'backup.json'), manifestRaw, 'utf-8');
      // Create a file that will collide on staging → source lookup by planting a
      // pre-existing staging dir that cpSync should reject (errorOnExist: true).
      const parent = path.dirname(storePath);
      const stagingSibling = path.join(parent, `${ROLLBACK_STAGING_PREFIX}2030-01-01T00-00-00-000Z.pid-${process.pid}`);
      fs.mkdirSync(stagingSibling, { recursive: true });

      // Mutate live so we can detect rollback mutation if it happened.
      fs.writeFileSync(liveFile, '{"id":"trp_001","text":"mutated"}', 'utf-8');

      // Try to rollback — the staging copy will fail because cpSync is told
      // errorOnExist: true and target existed. Even with a fixed clock the
      // staging path uses an ISO timestamp so the collision above is not
      // deterministic; guarantee the failure by pointing cpSync at a missing
      // backup tree. We deleted + re-created an empty backupPath above, so
      // cpSync will create an empty staging dir (not a failure). Instead,
      // provoke a staging failure by passing a backupPath whose content
      // conflicts with an already-present file inside the staging target.
      // Simpler: mutate BackupError path by using an invalid backup location
      // via monkey-patching fs.cpSync.
      const originalCpSync = fs.cpSync;
      (fs as { cpSync: typeof fs.cpSync }).cpSync = () => {
        throw new Error('simulated copy failure');
      };
      try {
        assert.throws(
          () => restoreBackup({ storePath, backupPath: handle.backupPath }),
          (err: unknown) => err instanceof BackupError && err.code === 'restore_copy_failed',
        );
      } finally {
        (fs as { cpSync: typeof fs.cpSync }).cpSync = originalCpSync;
      }

      // Live store is unchanged.
      const disk = JSON.parse(fs.readFileSync(liveFile, 'utf-8'));
      assert.equal(disk.text, 'mutated');

      // No orphan staging dir for this process.
      const orphans = fs.readdirSync(parent)
        .filter((name) => name.startsWith(ROLLBACK_STAGING_PREFIX) && name.includes(`pid-${process.pid}`));
      assert.equal(orphans.length, 1, 'only the sibling we planted — none from the failed restore');

      // Cleanup planted sibling.
      fs.rmSync(stagingSibling, { recursive: true, force: true });
    });
  });

  describe('finding #4 — provenance shape check', () => {
    const fixedNow = () => new Date('2026-04-18T16:30:00.000Z');

    it('accepts valid v1 provenance kinds as already migrated', () => {
      const storePath = storePathOf(workspace);
      const file = path.join(storePath, 'memory/decisions/dec_ok.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        id: 'dec_ok',
        provenance: { kind: 'legacy' },
      }), 'utf-8');

      const result = rolloutProvenance({ storePath, now: fixedNow });
      assert.equal(result.status, 'noop');
    });

    it('rejects malformed provenance loudly instead of treating it as migrated', () => {
      const storePath = storePathOf(workspace);
      const file = path.join(storePath, 'memory/decisions/dec_bad.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        id: 'dec_bad',
        provenance: { kind: 'not-a-real-kind' },
      }), 'utf-8');

      assert.throws(
        () => rolloutProvenance({ storePath, now: fixedNow }),
        /malformed `provenance` field/,
      );
    });

    it('rejects provenance that is not an object', () => {
      const storePath = storePathOf(workspace);
      const file = path.join(storePath, 'memory/traps/trp_bad.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ id: 'trp_bad', provenance: 'legacy' }), 'utf-8');

      assert.throws(
        () => rolloutProvenance({ storePath, now: fixedNow }),
        /malformed `provenance`/,
      );
    });
  });

  describe('finding #5 — plain-object guards', () => {
    const fixedNow = () => new Date('2026-04-18T16:45:00.000Z');

    it('handoff-review-strip fails loudly on a JSON array root', () => {
      const storePath = storePathOf(workspace);
      const dir = path.join(storePath, HANDOFFS_SUBPATH);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'hdf_arr.json'), JSON.stringify([1, 2, 3]), 'utf-8');

      assert.throws(
        () => stripHandoffReview({ storePath, now: fixedNow }),
        /is not a JSON object/,
      );
    });

    it('provenance-rollout fails loudly on a JSON array root', () => {
      const storePath = storePathOf(workspace);
      const file = path.join(storePath, 'memory/decisions/dec_arr.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify([1, 2]), 'utf-8');

      assert.throws(
        () => rolloutProvenance({ storePath, now: fixedNow }),
        /is not a JSON object/,
      );
    });
  });
});
