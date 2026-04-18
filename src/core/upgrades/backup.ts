import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getInstalledBrainclawVersion } from '../brainclaw-version.js';

export const BACKUP_DIR_PREFIX = '.brainclaw.bak-';
export const BACKUP_MANIFEST_FILENAME = 'backup.json';
export const ROLLBACK_PARKED_PREFIX = '.brainclaw.rollback-';

export const BackupManifestSchema = z.object({
  schema_version: z.literal(1),
  created_at: z.string().datetime(),
  source_path: z.string(),
  brainclaw_version: z.string(),
  store_schema_version: z.string().nullable(),
  note: z.string().optional(),
});
export type BackupManifest = z.infer<typeof BackupManifestSchema>;

export interface BackupHandle {
  backupPath: string;
  manifest: BackupManifest;
}

export interface CreateBackupOptions {
  storePath: string;
  now?: () => Date;
  note?: string;
  storeSchemaVersion?: string | null;
}

export class BackupError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'BackupError';
  }
}

function isoTimestamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

function parentOf(storePath: string): string {
  return path.dirname(storePath);
}

/**
 * Atomically copy a `.brainclaw/` tree to a sibling backup directory.
 * Copy happens into a `.partial-*` staging path first, then renamed
 * into place so an interrupted copy never produces a backup that
 * pretends to be complete.
 */
export function createBackup(options: CreateBackupOptions): BackupHandle {
  const { storePath } = options;
  if (!fs.existsSync(storePath)) {
    throw new BackupError('source_missing', `Source store not found: ${storePath}`);
  }
  const stat = fs.statSync(storePath);
  if (!stat.isDirectory()) {
    throw new BackupError('source_not_dir', `Source is not a directory: ${storePath}`);
  }

  const now = (options.now ?? (() => new Date()))();
  const stamp = isoTimestamp(now);
  const parent = parentOf(storePath);
  const finalPath = path.join(parent, `${BACKUP_DIR_PREFIX}${stamp}`);
  const stagingPath = path.join(parent, `${BACKUP_DIR_PREFIX}${stamp}.partial-${process.pid}`);

  if (fs.existsSync(finalPath)) {
    throw new BackupError('backup_exists', `Backup already exists for this timestamp: ${finalPath}`);
  }
  if (fs.existsSync(stagingPath)) {
    fs.rmSync(stagingPath, { recursive: true, force: true });
  }

  try {
    fs.cpSync(storePath, stagingPath, { recursive: true, errorOnExist: false, force: true });
  } catch (error: unknown) {
    try { fs.rmSync(stagingPath, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new BackupError('copy_failed', `Backup copy failed: ${(error as Error).message}`);
  }

  const manifest: BackupManifest = {
    schema_version: 1,
    created_at: now.toISOString(),
    source_path: path.resolve(storePath),
    brainclaw_version: getInstalledBrainclawVersion(),
    store_schema_version: options.storeSchemaVersion ?? null,
    note: options.note,
  };
  fs.writeFileSync(
    path.join(stagingPath, BACKUP_MANIFEST_FILENAME),
    JSON.stringify(manifest, null, 2),
    'utf-8',
  );

  try {
    fs.renameSync(stagingPath, finalPath);
  } catch (error: unknown) {
    try { fs.rmSync(stagingPath, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new BackupError('rename_failed', `Could not finalise backup: ${(error as Error).message}`);
  }

  return { backupPath: finalPath, manifest };
}

/**
 * List sibling backups for a given `.brainclaw/` path, newest first.
 * Backups without a parseable manifest are skipped silently — callers
 * that care can re-read the raw directory listing.
 */
export function listBackups(storePath: string): BackupHandle[] {
  const parent = parentOf(storePath);
  if (!fs.existsSync(parent)) return [];

  const entries = fs.readdirSync(parent, { withFileTypes: true });
  const backups: BackupHandle[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(BACKUP_DIR_PREFIX)) continue;
    if (entry.name.includes('.partial-')) continue;
    const dir = path.join(parent, entry.name);
    const manifest = readManifest(dir);
    if (!manifest) continue;
    backups.push({ backupPath: dir, manifest });
  }

  backups.sort((a, b) => b.manifest.created_at.localeCompare(a.manifest.created_at));
  return backups;
}

export function readManifest(backupPath: string): BackupManifest | null {
  const manifestPath = path.join(backupPath, BACKUP_MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    return BackupManifestSchema.parse(raw);
  } catch {
    return null;
  }
}

export interface RestoreBackupOptions {
  storePath: string;
  backupPath: string;
  now?: () => Date;
  /**
   * If provided, rollback refuses when the backup's stored schema
   * version is not in this set. Lets callers pin the pre-migration
   * schema states they will accept a rollback from.
   */
  acceptSchemaVersions?: readonly string[];
}

export interface RestoreResult {
  parkedPath: string;
  restoredFrom: string;
  manifest: BackupManifest;
}

/**
 * Restore a backup by atomically swapping the live store with the
 * backup contents. The current live store is renamed (parked) instead
 * of deleted — inspectable after rollback, reclaim space manually.
 */
export function restoreBackup(options: RestoreBackupOptions): RestoreResult {
  const { storePath, backupPath } = options;

  if (!fs.existsSync(backupPath)) {
    throw new BackupError('backup_missing', `Backup not found: ${backupPath}`);
  }
  const manifest = readManifest(backupPath);
  if (!manifest) {
    throw new BackupError('manifest_invalid', `Backup has no readable manifest: ${backupPath}`);
  }
  if (options.acceptSchemaVersions && options.acceptSchemaVersions.length > 0) {
    const stored = manifest.store_schema_version;
    if (!stored || !options.acceptSchemaVersions.includes(stored)) {
      throw new BackupError(
        'schema_mismatch',
        `Backup schema ${stored ?? 'unknown'} is not in the accepted set [${options.acceptSchemaVersions.join(', ')}]`,
      );
    }
  }

  const now = (options.now ?? (() => new Date()))();
  const parent = parentOf(storePath);
  const parkedPath = path.join(parent, `${ROLLBACK_PARKED_PREFIX}${isoTimestamp(now)}`);

  // Park the current live store if present.
  if (fs.existsSync(storePath)) {
    fs.renameSync(storePath, parkedPath);
  }

  // Copy backup into the live path. Copy rather than rename so the
  // backup itself remains available for a second rollback if needed.
  try {
    fs.cpSync(backupPath, storePath, { recursive: true, errorOnExist: true });
  } catch (error: unknown) {
    // Try to un-park on failure so the store is not left missing.
    try {
      if (!fs.existsSync(storePath) && fs.existsSync(parkedPath)) {
        fs.renameSync(parkedPath, storePath);
      }
    } catch { /* best effort */ }
    throw new BackupError('restore_copy_failed', `Could not restore backup: ${(error as Error).message}`);
  }

  // Remove the manifest from the restored live store so it does not
  // masquerade as a backup itself.
  const restoredManifest = path.join(storePath, BACKUP_MANIFEST_FILENAME);
  if (fs.existsSync(restoredManifest)) {
    fs.unlinkSync(restoredManifest);
  }

  return { parkedPath, restoredFrom: backupPath, manifest };
}
