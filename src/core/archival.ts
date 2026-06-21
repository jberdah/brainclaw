import fs from 'node:fs';
import path from 'node:path';
import { resolveEntityDir } from './io.js';
import { logger } from './logger.js';
import { mutate } from './mutation-pipeline.js';

/** Default age threshold: items older than 30 days are eligible for archival. */
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface ArchivalResult {
  archived: number;
  entity: string;
  archivePath: string;
}

/**
 * Archive done plans and closed handoffs older than maxAgeMs to JSONL cold storage.
 * Each entity type gets its own archive file (e.g. coordination/plans/archive.jsonl).
 * Archived items are appended as one JSON line per item, then the source file is deleted.
 * This is lossless — all data is preserved in the archive.
 */
export function archiveStalePlansAndHandoffs(
  cwd?: string,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS,
): ArchivalResult[] {
  // Review follow-up O4 (lop_e2d566765b8b4ce3): the append+unlink pairs must
  // run inside the store mutation lock — outside it, a concurrent stale-snapshot
  // persistState could RECREATE the just-archived files (resurrection).
  return mutate({ cwd }, () => {
    const results: ArchivalResult[] = [];
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

    results.push(archiveEntity('plans', cutoff, (item) => {
      return item.status === 'done' || item.status === 'dropped';
    }, cwd));

    results.push(archiveEntity('handoffs', cutoff, (item) => {
      return item.status === 'closed';
    }, cwd));

    return results.filter(r => r.archived > 0);
  });
}

function archiveEntity(
  entity: string,
  cutoffDate: string,
  isEligible: (item: Record<string, unknown>) => boolean,
  cwd?: string,
): ArchivalResult {
  const dir = resolveEntityDir(entity, cwd ?? process.cwd(), 'read');
  const archivePath = path.join(dir, 'archive.jsonl');

  if (!fs.existsSync(dir)) {
    return { archived: 0, entity, archivePath };
  }

  let archived = 0;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'archive.json');

  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const item = JSON.parse(content) as Record<string, unknown>;

      // Check eligibility: correct status AND older than cutoff
      const createdAt = (item.completed_at ?? item.updated_at ?? item.created_at) as string | undefined;
      if (!isEligible(item)) continue;
      if (createdAt && createdAt > cutoffDate) continue;

      // Append to archive JSONL
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      fs.appendFileSync(archivePath, JSON.stringify(item) + '\n', 'utf-8');

      // Delete source file
      fs.unlinkSync(filePath);
      archived++;
    } catch (err) {
      logger.debug(`Failed to archive ${entity}/${file}:`, err);
    }
  }

  return { archived, entity, archivePath };
}

/**
 * Read archived items from a JSONL archive file.
 * Useful for search/audit across archived entities.
 */
export function readArchive(entity: string, cwd?: string): Record<string, unknown>[] {
  const dir = resolveEntityDir(entity, cwd ?? process.cwd(), 'read');
  const archivePath = path.join(dir, 'archive.jsonl');

  if (!fs.existsSync(archivePath)) return [];

  const lines = fs.readFileSync(archivePath, 'utf-8').split('\n').filter(Boolean);
  const items: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      items.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // skip malformed lines
    }
  }
  return items;
}
