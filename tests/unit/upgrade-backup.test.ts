import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  BACKUP_DIR_PREFIX,
  BACKUP_MANIFEST_FILENAME,
  BackupError,
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
});
