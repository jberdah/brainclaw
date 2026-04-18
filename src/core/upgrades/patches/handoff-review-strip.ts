import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Handoff review-strip (P6.1 groundwork) — v1.0 schema migration patch.
 *
 * Existing handoffs may carry a `review` sub-object (requester,
 * reviewer, verdict, blocking_issues, …). The v1.0 model drops the
 * review sub-flow entirely: handoffs become immutable session-end
 * artefacts and corrections use the tombstone pattern (P6.1) via
 * `bclaw_correct_handoff` (to land in Phase 3, slice 3e).
 *
 * This patch removes the `review` field from every handoff file that
 * still carries one, writes a log listing what was stripped, and is
 * idempotent.
 *
 * Implementation note: handoffs are read/written as raw JSON instead
 * of parsed through Zod. Round-tripping Zod would drop any field not
 * declared in the schema (e.g., fields added by a future branch).
 * The patch's contract is "strip `review`, touch nothing else".
 */

export const HANDOFFS_SUBPATH = path.join('coordination', 'handoffs');
export const MIGRATIONS_ARCHIVE_SUBPATH = path.join('archive', 'migrations');
export const HANDOFF_REVIEW_STRIP_LOG = 'handoff-review-strip.json';

export const HandoffReviewStripEntrySchema = z.object({
  handoff_id: z.string(),
  short_label: z.string().nullable(),
  handoff_path: z.string(),
  review_fields: z.array(z.string()),
  stripped_at: z.string().datetime(),
});
export type HandoffReviewStripEntry = z.infer<typeof HandoffReviewStripEntrySchema>;

export const HandoffReviewStripLogSchema = z.object({
  schema_version: z.literal(1),
  stripped_at: z.string().datetime(),
  reason: z.string(),
  count: z.number().int().nonnegative(),
  entries: z.array(HandoffReviewStripEntrySchema),
});
export type HandoffReviewStripLog = z.infer<typeof HandoffReviewStripLogSchema>;

export interface HandoffReviewStripOptions {
  storePath: string;
  now?: () => Date;
  dryRun?: boolean;
  reason?: string;
}

export interface HandoffReviewStripResult {
  status: 'noop' | 'stripped' | 'planned';
  handoffsDir: string;
  logPath: string | null;
  stripped: HandoffReviewStripEntry[];
  scanned: number;
}

/**
 * Strip the `review` sub-object from every handoff file that still
 * carries one. Handoffs without `review` are scanned but not
 * rewritten. Idempotent.
 */
export function stripHandoffReview(options: HandoffReviewStripOptions): HandoffReviewStripResult {
  const { storePath } = options;
  const handoffsDir = path.join(storePath, HANDOFFS_SUBPATH);
  const now = (options.now ?? (() => new Date()))();
  const dateStamp = now.toISOString().slice(0, 10);
  const logDir = path.join(storePath, MIGRATIONS_ARCHIVE_SUBPATH, dateStamp);
  const logPath = path.join(logDir, HANDOFF_REVIEW_STRIP_LOG);
  const reason = options.reason ?? 'v1.0 schema migration (P6.1 groundwork): handoffs become immutable, corrections use tombstones';

  const files = listHandoffFiles(handoffsDir);
  const stripped: HandoffReviewStripEntry[] = [];

  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`handoff-review-strip: ${file} is not a JSON object`);
    }
    const obj = raw as Record<string, unknown>;
    const review = obj.review;
    if (review === undefined) continue;

    const reviewFields = review && typeof review === 'object' && !Array.isArray(review)
      ? Object.keys(review as Record<string, unknown>)
      : [];

    const entry: HandoffReviewStripEntry = {
      handoff_id: typeof obj.id === 'string' ? obj.id : path.basename(file, '.json'),
      short_label: typeof obj.short_label === 'string' ? obj.short_label : null,
      handoff_path: path.relative(storePath, file).split(path.sep).join('/'),
      review_fields: reviewFields,
      stripped_at: now.toISOString(),
    };
    stripped.push(entry);

    if (!options.dryRun) {
      const next = { ...obj };
      delete next.review;
      fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf-8');
    }
  }

  if (stripped.length === 0) {
    return {
      status: 'noop',
      handoffsDir,
      logPath: null,
      stripped: [],
      scanned: files.length,
    };
  }

  if (options.dryRun) {
    return {
      status: 'planned',
      handoffsDir,
      logPath,
      stripped,
      scanned: files.length,
    };
  }

  fs.mkdirSync(logDir, { recursive: true });
  const log: HandoffReviewStripLog = {
    schema_version: 1,
    stripped_at: now.toISOString(),
    reason,
    count: stripped.length,
    entries: stripped,
  };
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2), 'utf-8');

  return {
    status: 'stripped',
    handoffsDir,
    logPath,
    stripped,
    scanned: files.length,
  };
}

function listHandoffFiles(handoffsDir: string): string[] {
  if (!fs.existsSync(handoffsDir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(handoffsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.json')) continue;
    out.push(path.join(handoffsDir, entry.name));
  }
  return out;
}
