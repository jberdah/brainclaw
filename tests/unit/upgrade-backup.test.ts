import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  BACKUP_DIR_PREFIX,
  BACKUP_MANIFEST_FILENAME,
  BackupError,
  ROLLBACK_PARKED_PREFIX,
  ROLLBACK_STAGING_PREFIX,
  createBackup,
  listBackups,
  readManifest,
  restoreBackup,
} from '../../src/core/upgrades/backup.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function storePathOf(workspace: TestWorkspace): string {
  return path.join(workspace.dir, '.brainclaw');
}

function seedFile(storePath: string, rel: string, body: string): void {
  const full = path.join(storePath, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, 'utf-8');
}

describe('core/upgrades/backup', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-upgrade-backup-' });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('creates a timestamped backup with a readable manifest', () => {
    const storePath = storePathOf(workspace);
    seedFile(storePath, 'memory/decisions/dec_001.json', '{"id":"dec_001"}');
    seedFile(storePath, 'coordination/plans/pln_001.json', '{"id":"pln_001"}');

    const handle = createBackup({ storePath, note: 'unit test' });

    assert.ok(handle.backupPath.startsWith(path.join(workspace.dir, BACKUP_DIR_PREFIX)));
    assert.ok(fs.existsSync(handle.backupPath));
    assert.ok(fs.existsSync(path.join(handle.backupPath, 'memory/decisions/dec_001.json')));
    assert.ok(fs.existsSync(path.join(handle.backupPath, 'coordination/plans/pln_001.json')));
    assert.ok(fs.existsSync(path.join(handle.backupPath, BACKUP_MANIFEST_FILENAME)));

    const manifest = readManifest(handle.backupPath);
    assert.ok(manifest, 'manifest should be readable');
    assert.equal(manifest.schema_version, 1);
    assert.equal(manifest.note, 'unit test');
    assert.ok(manifest.brainclaw_version.length > 0);
  });

  it('throws when the source store is missing', () => {
    const missing = path.join(workspace.dir, 'does-not-exist');
    assert.throws(() => createBackup({ storePath: missing }), (error: unknown) => {
      return error instanceof BackupError && error.code === 'source_missing';
    });
  });

  it('lists backups newest-first and skips .partial directories', () => {
    const storePath = storePathOf(workspace);
    seedFile(storePath, 'decisions/a.json', '{}');

    const older = new Date('2026-04-18T10:00:00.000Z');
    const newer = new Date('2026-04-18T11:00:00.000Z');
    const h1 = createBackup({ storePath, now: () => older });
    const h2 = createBackup({ storePath, now: () => newer });

    // Drop a fake staging dir that must be ignored.
    fs.mkdirSync(path.join(workspace.dir, `${BACKUP_DIR_PREFIX}junk.partial-999`), { recursive: true });

    const backups = listBackups(storePath);
    assert.equal(backups.length, 2);
    assert.equal(backups[0]!.backupPath, h2.backupPath);
    assert.equal(backups[1]!.backupPath, h1.backupPath);
  });

  it('round-trips: backup, mutate store, restore', () => {
    const storePath = storePathOf(workspace);
    seedFile(storePath, 'memory/traps/trp_001.json', '{"id":"trp_001","active":true}');

    const handle = createBackup({ storePath });

    // Mutate the live store after the backup.
    const livePath = path.join(storePath, 'memory/traps/trp_001.json');
    fs.writeFileSync(livePath, '{"id":"trp_001","active":false,"edited":true}', 'utf-8');
    seedFile(storePath, 'memory/traps/trp_002.json', '{"id":"trp_002"}');

    const result = restoreBackup({ storePath, backupPath: handle.backupPath });

    assert.ok(fs.existsSync(result.parkedPath), 'previous live store should be parked');
    assert.ok(fs.existsSync(livePath));
    const restored = JSON.parse(fs.readFileSync(livePath, 'utf-8'));
    assert.equal(restored.active, true);
    assert.equal(restored.edited, undefined);
    assert.equal(
      fs.existsSync(path.join(storePath, 'memory/traps/trp_002.json')),
      false,
      'trp_002 was not in the backup and should not reappear after restore',
    );
    assert.equal(
      fs.existsSync(path.join(storePath, BACKUP_MANIFEST_FILENAME)),
      false,
      'backup manifest should not leak into the restored live store',
    );
    // Backup itself remains available for a second rollback.
    assert.ok(fs.existsSync(handle.backupPath));
  });

  it('refuses to restore when the backup manifest is missing', () => {
    const storePath = storePathOf(workspace);
    seedFile(storePath, 'decisions/a.json', '{}');

    const handle = createBackup({ storePath });
    fs.unlinkSync(path.join(handle.backupPath, BACKUP_MANIFEST_FILENAME));

    assert.throws(
      () => restoreBackup({ storePath, backupPath: handle.backupPath }),
      (error: unknown) => error instanceof BackupError && error.code === 'manifest_invalid',
    );
  });

  it('refuses to restore when the manifest schema is not in the accepted set', () => {
    const storePath = storePathOf(workspace);
    seedFile(storePath, 'decisions/a.json', '{}');

    const handle = createBackup({ storePath, storeSchemaVersion: '0.6.0' });

    assert.throws(
      () => restoreBackup({
        storePath,
        backupPath: handle.backupPath,
        acceptSchemaVersions: ['0.7.0', '0.8.0'],
      }),
      (error: unknown) => error instanceof BackupError && error.code === 'schema_mismatch',
    );
  });

  it('cleans staged restore state when stripping the backup manifest fails', () => {
    const storePath = storePathOf(workspace);
    const fixedNow = () => new Date('2026-04-18T19:00:00.000Z');
    seedFile(storePath, 'memory/decisions/dec_001.json', '{"id":"dec_001","state":"live"}');

    const handle = createBackup({ storePath });
    const parent = path.dirname(storePath);
    const stagingPath = path.join(parent, `${ROLLBACK_STAGING_PREFIX}2026-04-18T19-00-00-000Z.pid-${process.pid}`);
    const parkedPath = path.join(parent, `${ROLLBACK_PARKED_PREFIX}2026-04-18T19-00-00-000Z`);

    const originalUnlinkSync = fs.unlinkSync;
    (fs as { unlinkSync: typeof fs.unlinkSync }).unlinkSync = ((target: fs.PathLike) => {
      if (String(target) === path.join(stagingPath, BACKUP_MANIFEST_FILENAME)) {
        throw new Error('simulated manifest strip failure');
      }
      return originalUnlinkSync(target);
    }) as typeof fs.unlinkSync;

    try {
      assert.throws(
        () => restoreBackup({ storePath, backupPath: handle.backupPath, now: fixedNow }),
        (error: unknown) => error instanceof BackupError && error.code === 'restore_manifest_strip_failed',
      );
    } finally {
      (fs as { unlinkSync: typeof fs.unlinkSync }).unlinkSync = originalUnlinkSync;
    }

    assert.equal(fs.existsSync(stagingPath), false, 'staging dir should be cleaned on manifest-strip failure');
    assert.equal(fs.existsSync(parkedPath), false, 'live store must not be parked before manifest strip succeeds');
    assert.equal(
      fs.readFileSync(path.join(storePath, 'memory/decisions/dec_001.json'), 'utf-8'),
      '{"id":"dec_001","state":"live"}',
    );
  });

  it('preserves parked and staged trees when swap and un-park both fail', () => {
    const storePath = storePathOf(workspace);
    const fixedNow = () => new Date('2026-04-18T20:00:00.000Z');
    seedFile(storePath, 'memory/traps/trp_001.json', '{"id":"trp_001","state":"live"}');

    const handle = createBackup({ storePath });
    fs.writeFileSync(path.join(storePath, 'memory/traps/trp_001.json'), '{"id":"trp_001","state":"mutated"}', 'utf-8');

    const parent = path.dirname(storePath);
    const stagingPath = path.join(parent, `${ROLLBACK_STAGING_PREFIX}2026-04-18T20-00-00-000Z.pid-${process.pid}`);
    const parkedPath = path.join(parent, `${ROLLBACK_PARKED_PREFIX}2026-04-18T20-00-00-000Z`);
    const originalRenameSync = fs.renameSync;

    (fs as { renameSync: typeof fs.renameSync }).renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      const src = String(from);
      const dst = String(to);
      if (src === stagingPath && dst === storePath) {
        throw new Error('simulated swap failure');
      }
      if (src === parkedPath && dst === storePath) {
        throw new Error('simulated unpark failure');
      }
      return originalRenameSync(from, to);
    }) as typeof fs.renameSync;

    try {
      assert.throws(
        () => restoreBackup({ storePath, backupPath: handle.backupPath, now: fixedNow }),
        (error: unknown) => {
          return error instanceof BackupError
            && error.code === 'restore_catastrophic'
            && error.message.includes(`parked=${parkedPath}`)
            && error.message.includes(`staged=${stagingPath}`);
        },
      );
    } finally {
      (fs as { renameSync: typeof fs.renameSync }).renameSync = originalRenameSync;
    }

    assert.equal(fs.existsSync(storePath), false, 'live store should remain absent in catastrophic rollback mode');
    assert.ok(fs.existsSync(parkedPath), 'parked live tree must be preserved for manual recovery');
    assert.ok(fs.existsSync(stagingPath), 'staged restore tree must be preserved for manual recovery');

    const parkedDisk = JSON.parse(fs.readFileSync(path.join(parkedPath, 'memory/traps/trp_001.json'), 'utf-8')) as { state: string };
    const stagedDisk = JSON.parse(fs.readFileSync(path.join(stagingPath, 'memory/traps/trp_001.json'), 'utf-8')) as { state: string };
    assert.equal(parkedDisk.state, 'mutated');
    assert.equal(stagedDisk.state, 'live');

    fs.rmSync(parkedPath, { recursive: true, force: true });
    fs.rmSync(stagingPath, { recursive: true, force: true });
  });
});
