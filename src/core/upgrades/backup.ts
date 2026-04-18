import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getInstalledBrainclawVersion } from '../brainclaw-version.js';

export const BACKUP_DIR_PREFIX = '.brainclaw.bak-';
export const BACKUP_MANIFEST_FILENAME = 'backup.json';
export const ROLLBACK_PARKED_PREFIX = '.brainclaw.rollback-';
export const ROLLBACK_STAGING_PREFIX = '.brainclaw.restoring-';

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
 * Restore a backup by staging the new live contents into a sibling
 * directory, then doing a single rename swap. Failure-atomic:
 *
 *   1. Copy backup → staging (slow phase, can be interrupted safely —
 *      the live store is still untouched).
 *   2. Strip the manifest from the staging dir (so the restored store
 *      does not masquerade as a backup).
 *   3. Park live → parked (atomic rename).
 *   4. Swap staging → live (atomic rename).
 *
 * If step 4 fails after step 3, we un-park so the store is never left
 * missing, and we wipe the staging dir to avoid orphans. If any step
 * before 3 fails, the live store is unchanged.
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
  const stamp = isoTimestamp(now);
  const parent = parentOf(storePath);
  const stagingPath = path.join(parent, `${ROLLBACK_STAGING_PREFIX}${stamp}.pid-${process.pid}`);
  const parkedPath = path.join(parent, `${ROLLBACK_PARKED_PREFIX}${stamp}`);

  if (fs.existsSync(stagingPath)) {
    fs.rmSync(stagingPath, { recursive: true, force: true });
  }

  // Step 1: populate staging. Live store untouched on failure.
  try {
    fs.cpSync(backupPath, stagingPath, { recursive: true, errorOnExist: true });
  } catch (error: unknown) {
    try { fs.rmSync(stagingPath, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new BackupError('restore_copy_failed', `Could not stage backup for restore: ${(error as Error).message}`);
  }

  // Step 2: remove manifest from the staged copy so the restored live
  // store does not look like a backup.
  const stagedManifest = path.join(stagingPath, BACKUP_MANIFEST_FILENAME);
  if (fs.existsSync(stagedManifest)) {
    fs.unlinkSync(stagedManifest);
  }

  // Step 3: park the current live store (if any). From here on we
  // MUST end with a live store in place, either via swap or un-park.
  let parked = false;
  if (fs.existsSync(storePath)) {
    try {
      fs.renameSync(storePath, parkedPath);
      parked = true;
    } catch (error: unknown) {
      try { fs.rmSync(stagingPath, { recursive: true, force: true }); } catch { /* best effort */ }
      throw new BackupError('park_failed', `Could not park live store: ${(error as Error).message}`);
    }
  }

  // Step 4: swap staging → live. On failure, un-park so the store
  // is never left missing; staging dir is cleaned.
  try {
    fs.renameSync(stagingPath, storePath);
  } catch (error: unknown) {
    try { fs.rmSync(stagingPath, { recursive: true, force: true }); } catch { /* best effort */ }
    if (parked) {
      try {
        fs.renameSync(parkedPath, storePath);
      } catch { /* Catastrophic — both swaps failed. Leave parked for manual recovery. */ }
    }
    throw new BackupError('restore_swap_failed', `Could not swap staging into live path: ${(error as Error).message}`);
  }

  return { parkedPath: parked ? parkedPath : '', restoredFrom: backupPath, manifest };
}
