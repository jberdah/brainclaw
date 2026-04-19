import fs from 'node:fs';
import path from 'node:path';
import { PROVENANCE_ENTITY_LAYOUTS } from './patches/provenance-rollout.js';
import { PENDING_INBOX_SUBPATH } from './patches/candidate-archive.js';
import { HANDOFFS_SUBPATH } from './patches/handoff-review-strip.js';
import {
  V1_TARGET_SCHEMA_VERSION,
  readSchemaVersion,
} from './schema-version.js';

/**
 * Post-migration health check — invoked via `brainclaw doctor --after-migration`.
 * Verifies the four invariants that `brainclaw upgrade --to=1.0` is meant to
 * leave behind:
 *
 *   1. Every memory record carries a `provenance` field (legacy or v1 kind).
 *   2. No handoff still carries a `review` sub-object.
 *   3. No stray candidate JSON files at the `coordination/inbox/` root
 *      (pending candidates must have been archived).
 *   4. `.brainclaw/schema-version.json` exists and `current == V1_TARGET_SCHEMA_VERSION`.
 *
 * Designed to be pure: no mutation, no side effects. Returns a structured
 * report; the CLI decides exit code.
 */

const V1_PROVENANCE_KINDS = new Set([
  'agent', 'auto_reflect', 'user', 'loop_artifact', 'federation', 'correction', 'legacy',
]);

export type HealthCheckStatus = 'ok' | 'warn' | 'error';

export interface HealthCheckFinding {
  check: 'provenance' | 'handoff_review' | 'candidate_archive' | 'schema_version';
  status: HealthCheckStatus;
  message: string;
  details?: unknown;
}

export interface PostMigrationHealthReport {
  ok: boolean;
  store_path: string;
  findings: HealthCheckFinding[];
  stats: {
    records_scanned: number;
    records_missing_provenance: number;
    handoffs_with_review: number;
    pending_candidates_in_root: number;
    current_schema_version: string | null;
    target_schema_version: string;
  };
}

export interface RunHealthCheckOptions {
  storePath: string;
}

export function runPostMigrationHealthCheck(options: RunHealthCheckOptions): PostMigrationHealthReport {
  const { storePath } = options;
  const findings: HealthCheckFinding[] = [];

  // ---- 1. provenance coverage ----
  let recordsScanned = 0;
  const missingProvenance: string[] = [];
  for (const layout of PROVENANCE_ENTITY_LAYOUTS) {
    const dir = path.join(storePath, layout.dir);
    for (const file of listJsonFiles(dir, layout.recursive)) {
      recordsScanned += 1;
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      } catch {
        missingProvenance.push(relFromStore(storePath, file));
        continue;
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        missingProvenance.push(relFromStore(storePath, file));
        continue;
      }
      const provenance = (raw as Record<string, unknown>).provenance;
      if (!isValidProvenance(provenance)) {
        missingProvenance.push(relFromStore(storePath, file));
      }
    }
  }
  findings.push(
    missingProvenance.length === 0
      ? { check: 'provenance', status: 'ok', message: `All ${recordsScanned} memory record(s) carry a valid provenance field.` }
      : {
          check: 'provenance',
          status: 'error',
          message: `${missingProvenance.length} of ${recordsScanned} memory record(s) are missing a valid provenance field.`,
          details: { sample: missingProvenance.slice(0, 10), total: missingProvenance.length },
        },
  );

  // ---- 2. handoff review sub-object ----
  const handoffsDir = path.join(storePath, HANDOFFS_SUBPATH);
  const handoffFiles = listJsonFiles(handoffsDir, false);
  const handoffsWithReview: string[] = [];
  for (const file of handoffFiles) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      continue; // malformed; handled by provenance check or migration test
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    if ((raw as Record<string, unknown>).review !== undefined) {
      handoffsWithReview.push(relFromStore(storePath, file));
    }
  }
  findings.push(
    handoffsWithReview.length === 0
      ? { check: 'handoff_review', status: 'ok', message: `No handoff carries a \`review\` sub-object (${handoffFiles.length} scanned).` }
      : {
          check: 'handoff_review',
          status: 'error',
          message: `${handoffsWithReview.length} handoff(s) still carry a \`review\` sub-object.`,
          details: { sample: handoffsWithReview.slice(0, 10), total: handoffsWithReview.length },
        },
  );

  // ---- 3. candidate archive — inbox/ root must be empty of JSON files ----
  const inboxRoot = path.join(storePath, PENDING_INBOX_SUBPATH);
  const pendingCandidates: string[] = [];
  if (fs.existsSync(inboxRoot)) {
    for (const entry of fs.readdirSync(inboxRoot, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.json')) continue;
      pendingCandidates.push(entry.name);
    }
  }
  findings.push(
    pendingCandidates.length === 0
      ? { check: 'candidate_archive', status: 'ok', message: 'No pending candidates remain at coordination/inbox/ root.' }
      : {
          check: 'candidate_archive',
          status: 'error',
          message: `${pendingCandidates.length} pending candidate file(s) remain at the inbox root — candidate-archive patch did not complete.`,
          details: { sample: pendingCandidates.slice(0, 10), total: pendingCandidates.length },
        },
  );

  // ---- 4. schema version marker ----
  const schemaState = readSchemaVersion(storePath);
  if (!schemaState.present) {
    findings.push({
      check: 'schema_version',
      status: 'error',
      message: `schema-version.json is missing — upgrade did not reach the version-bump step.`,
    });
  } else if (schemaState.current !== V1_TARGET_SCHEMA_VERSION) {
    findings.push({
      check: 'schema_version',
      status: 'error',
      message: `Store is at schema ${schemaState.current}, expected ${V1_TARGET_SCHEMA_VERSION}.`,
    });
  } else {
    findings.push({
      check: 'schema_version',
      status: 'ok',
      message: `Store is at schema ${schemaState.current} (history: ${schemaState.history.length} transition(s)).`,
    });
  }

  const ok = findings.every((f) => f.status === 'ok');
  return {
    ok,
    store_path: storePath,
    findings,
    stats: {
      records_scanned: recordsScanned,
      records_missing_provenance: missingProvenance.length,
      handoffs_with_review: handoffsWithReview.length,
      pending_candidates_in_root: pendingCandidates.length,
      current_schema_version: schemaState.present ? schemaState.current : null,
      target_schema_version: V1_TARGET_SCHEMA_VERSION,
    },
  };
}

function isValidProvenance(value: unknown): boolean {
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

function relFromStore(storePath: string, file: string): string {
  return path.relative(storePath, file).split(path.sep).join('/');
}
