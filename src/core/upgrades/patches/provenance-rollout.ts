import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Provenance rollout (P6.3) — v1.0 schema migration patch.
 *
 * Stamps every pre-existing memory record with a `provenance` field
 * of kind `legacy`. From v1.0 onward, write paths populate the
 * typed discriminated-union provenance (agent / auto_reflect / user /
 * loop_artifact / federation / correction / legacy); legacy records
 * keep the `legacy` tag so default read filters can exclude them
 * until an operator promotes them.
 *
 * Scope: decisions, constraints, traps, handoffs, runtime_notes.
 *
 * Auto-reflect retroactive detection: not attempted. Pre-v1.0 records
 * do not carry a reliable marker distinguishing auto-reflect writes
 * from human-authored writes at the entity level. Stamping every
 * pre-existing record as `legacy` is the safe default — new
 * auto-reflect writes from v1.0 onward carry the correct provenance
 * from birth.
 *
 * Like the other patches, implementation uses raw JSON read/write
 * (no Zod round-trip) so unknown fields survive the rewrite.
 */

export const MIGRATIONS_ARCHIVE_SUBPATH = path.join('archive', 'migrations');
export const PROVENANCE_ROLLOUT_LOG = 'provenance-rollout.json';

export interface EntityKindLayout {
  kind: 'decision' | 'constraint' | 'trap' | 'handoff' | 'runtime_note';
  dir: string;
  recursive: boolean;
}

export const PROVENANCE_ENTITY_LAYOUTS: readonly EntityKindLayout[] = [
  { kind: 'decision',     dir: path.join('memory', 'decisions'),        recursive: false },
  { kind: 'constraint',   dir: path.join('memory', 'constraints'),      recursive: false },
  { kind: 'trap',         dir: path.join('memory', 'traps'),            recursive: false },
  { kind: 'handoff',      dir: path.join('coordination', 'handoffs'),   recursive: false },
  { kind: 'runtime_note', dir: path.join('coordination', 'runtime'),    recursive: true  },
];

export const ProvenanceRolloutEntrySchema = z.object({
  kind: z.enum(['decision', 'constraint', 'trap', 'handoff', 'runtime_note']),
  id: z.string(),
  short_label: z.string().nullable(),
  record_path: z.string(),
  stamped_kind: z.literal('legacy'),
  stamped_at: z.string().datetime(),
});
export type ProvenanceRolloutEntry = z.infer<typeof ProvenanceRolloutEntrySchema>;

export const ProvenanceRolloutLogSchema = z.object({
  schema_version: z.literal(1),
  stamped_at: z.string().datetime(),
  reason: z.string(),
  count: z.number().int().nonnegative(),
  counts_by_kind: z.record(z.number().int().nonnegative()),
  entries: z.array(ProvenanceRolloutEntrySchema),
});
export type ProvenanceRolloutLog = z.infer<typeof ProvenanceRolloutLogSchema>;

export interface ProvenanceRolloutOptions {
  storePath: string;
  now?: () => Date;
  dryRun?: boolean;
  reason?: string;
}

export interface ProvenanceRolloutResult {
  status: 'noop' | 'stamped' | 'planned';
  scanned: number;
  stamped: ProvenanceRolloutEntry[];
  countsByKind: Record<string, number>;
  logPath: string | null;
}

export function rolloutProvenance(options: ProvenanceRolloutOptions): ProvenanceRolloutResult {
  const { storePath } = options;
  const now = (options.now ?? (() => new Date()))();
  const dateStamp = now.toISOString().slice(0, 10);
  const logDir = path.join(storePath, MIGRATIONS_ARCHIVE_SUBPATH, dateStamp);
  const logPath = path.join(logDir, PROVENANCE_ROLLOUT_LOG);
  const reason = options.reason ?? 'v1.0 schema migration (P6.3): stamp legacy provenance on pre-existing memory records';

  let scanned = 0;
  const entries: ProvenanceRolloutEntry[] = [];
  const countsByKind: Record<string, number> = {};

  for (const layout of PROVENANCE_ENTITY_LAYOUTS) {
    const fullDir = path.join(storePath, layout.dir);
    const files = listJsonFiles(fullDir, layout.recursive);
    scanned += files.length;
    for (const file of files) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`provenance-rollout: ${file} is not a JSON object`);
      }
      const obj = raw as Record<string, unknown>;
      if (obj.provenance !== undefined) {
        if (isValidV1Provenance(obj.provenance)) continue;
        throw new Error(
          `provenance-rollout: ${file} has a malformed \`provenance\` field; ` +
          `expected an object with a known kind, got ${JSON.stringify(obj.provenance)}`,
        );
      }

      const entry: ProvenanceRolloutEntry = {
        kind: layout.kind,
        id: typeof obj.id === 'string' ? obj.id : path.basename(file, '.json'),
        short_label: typeof obj.short_label === 'string' ? obj.short_label : null,
        record_path: path.relative(storePath, file).split(path.sep).join('/'),
        stamped_kind: 'legacy',
        stamped_at: now.toISOString(),
      };
      entries.push(entry);
      countsByKind[layout.kind] = (countsByKind[layout.kind] ?? 0) + 1;

      if (!options.dryRun) {
        const next = { ...obj, provenance: { kind: 'legacy' as const } };
        fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf-8');
      }
    }
  }

  if (entries.length === 0) {
    return { status: 'noop', scanned, stamped: [], countsByKind, logPath: null };
  }

  if (options.dryRun) {
    return { status: 'planned', scanned, stamped: entries, countsByKind, logPath };
  }

  fs.mkdirSync(logDir, { recursive: true });
  const log: ProvenanceRolloutLog = {
    schema_version: 1,
    stamped_at: now.toISOString(),
    reason,
    count: entries.length,
    counts_by_kind: countsByKind,
    entries,
  };
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2), 'utf-8');

  return { status: 'stamped', scanned, stamped: entries, countsByKind, logPath };
}

const V1_PROVENANCE_KINDS = new Set([
  'agent', 'auto_reflect', 'user', 'loop_artifact', 'federation', 'correction', 'legacy',
]);

function isValidV1Provenance(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = (value as Record<string, unknown>).kind;
  return typeof kind === 'string' && V1_PROVENANCE_KINDS.has(kind);
}

function listJsonFiles(dir: string, recursive: boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith('.json')) {
      out.push(full);
      continue;
    }
    if (recursive && entry.isDirectory()) {
      out.push(...listJsonFiles(full, true));
    }
  }
  return out;
}
