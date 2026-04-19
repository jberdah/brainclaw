import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { CandidateSchema, type Candidate } from '../../schema.js';

/**
 * Candidate archive (P6.6) — v1.0 schema migration patch.
 *
 * Pending candidates accumulate because the review queue is rarely
 * used as designed. v1.0 archives them out of the live inbox into
 * `.brainclaw/archive/candidates/<YYYY-MM-DD>/` with a manifest
 * listing what moved and why. Accepted and rejected candidates
 * (already properly triaged) stay put.
 *
 * Live inbox path: `.brainclaw/coordination/inbox/`
 * Archive path:    `.brainclaw/archive/candidates/<YYYY-MM-DD>/`
 */

export const PENDING_INBOX_SUBPATH = path.join('coordination', 'inbox');
export const ARCHIVE_CANDIDATES_SUBPATH = path.join('archive', 'candidates');
export const CANDIDATE_ARCHIVE_MANIFEST = 'manifest.json';

export const CandidateArchiveEntrySchema = z.object({
  id: z.string(),
  short_label: z.string().nullable(),
  type: z.string(),
  status: z.string(),
  created_at: z.string(),
  original_path: z.string(),
  archived_path: z.string(),
  /** Present when the source candidate did not parse cleanly against the
   *  current Zod schema. The file is still archived; the manifest records
   *  the first Zod error so an operator can inspect the archive later. */
  parse_error: z.string().optional(),
});
export type CandidateArchiveEntry = z.infer<typeof CandidateArchiveEntrySchema>;

export const CandidateArchiveManifestSchema = z.object({
  schema_version: z.literal(1),
  archived_at: z.string().datetime(),
  reason: z.string(),
  count: z.number().int().nonnegative(),
  entries: z.array(CandidateArchiveEntrySchema),
});
export type CandidateArchiveManifest = z.infer<typeof CandidateArchiveManifestSchema>;

export interface CandidateArchiveOptions {
  storePath: string;
  now?: () => Date;
  dryRun?: boolean;
  reason?: string;
}

export interface CandidateArchiveResult {
  status: 'noop' | 'archived' | 'planned';
  pendingDir: string;
  archiveDir: string | null;
  moved: CandidateArchiveEntry[];
  manifestPath: string | null;
}

/**
 * Archive pending candidates sitting directly in `coordination/inbox/`.
 * Idempotent — re-running after a successful archive is a no-op.
 */
export function archivePendingCandidates(options: CandidateArchiveOptions): CandidateArchiveResult {
  const pendingDir = path.join(options.storePath, PENDING_INBOX_SUBPATH);
  const now = (options.now ?? (() => new Date()))();
  const dateStamp = now.toISOString().slice(0, 10);
  const archiveDir = path.join(options.storePath, ARCHIVE_CANDIDATES_SUBPATH, dateStamp);

  const files = listPendingCandidateFiles(pendingDir);
  if (files.length === 0) {
    return {
      status: 'noop',
      pendingDir,
      archiveDir: null,
      moved: [],
      manifestPath: null,
    };
  }

  const reason = options.reason ?? 'v1.0 schema migration (P6.6): pending candidate review queue retired';
  const entries: CandidateArchiveEntry[] = [];

  // First pass: parse + plan. Candidates that do not pass the current Zod
  // schema are still archived — they may be legacy shapes (e.g. status
  // "proposed" from an older enum). We capture the parse failure in the
  // manifest so the archive is self-describing.
  const planned: Array<{
    source: string;
    target: string;
    raw: Record<string, unknown>;
    candidate: Candidate | null;
    parseError: string | null;
    baseName: string;
  }> = [];
  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`candidate-archive: ${file} is not a JSON object`);
    }
    const rawObj = raw as Record<string, unknown>;
    const parsed = CandidateSchema.safeParse(rawObj);
    planned.push({
      source: file,
      target: path.join(archiveDir, path.basename(file)),
      raw: rawObj,
      candidate: parsed.success ? parsed.data : null,
      parseError: parsed.success ? null : parsed.error.issues[0]?.message ?? 'zod parse failed',
      baseName: path.basename(file),
    });
  }

  if (options.dryRun) {
    for (const p of planned) {
      entries.push(makeEntry(p.candidate, p.raw, p.source, p.target, options.storePath, p.parseError));
    }
    return {
      status: 'planned',
      pendingDir,
      archiveDir,
      moved: entries,
      manifestPath: path.join(archiveDir, CANDIDATE_ARCHIVE_MANIFEST),
    };
  }

  fs.mkdirSync(archiveDir, { recursive: true });

  for (const p of planned) {
    fs.renameSync(p.source, p.target);
    entries.push(makeEntry(p.candidate, p.raw, p.source, p.target, options.storePath, p.parseError));
  }

  const manifest: CandidateArchiveManifest = {
    schema_version: 1,
    archived_at: now.toISOString(),
    reason,
    count: entries.length,
    entries,
  };
  const manifestPath = path.join(archiveDir, CANDIDATE_ARCHIVE_MANIFEST);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  return {
    status: 'archived',
    pendingDir,
    archiveDir,
    moved: entries,
    manifestPath,
  };
}

function listPendingCandidateFiles(pendingDir: string): string[] {
  if (!fs.existsSync(pendingDir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(pendingDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.json')) continue;
    out.push(path.join(pendingDir, entry.name));
  }
  return out;
}

function makeEntry(
  candidate: Candidate | null,
  raw: Record<string, unknown>,
  sourcePath: string,
  archivedPath: string,
  storePath: string,
  parseError: string | null,
): CandidateArchiveEntry {
  const fallback = (key: string, dflt: string): string => {
    const v = raw[key];
    return typeof v === 'string' ? v : dflt;
  };
  return {
    id: candidate?.id ?? fallback('id', path.basename(sourcePath, '.json')),
    short_label: candidate?.short_label ?? (typeof raw.short_label === 'string' ? raw.short_label : null),
    type: candidate?.type ?? fallback('type', 'unknown'),
    status: candidate?.status ?? fallback('status', 'unknown'),
    created_at: candidate?.created_at ?? fallback('created_at', '1970-01-01T00:00:00.000Z'),
    original_path: path.relative(storePath, sourcePath).split(path.sep).join('/'),
    archived_path: path.relative(storePath, archivedPath).split(path.sep).join('/'),
    ...(parseError ? { parse_error: parseError } : {}),
  };
}
