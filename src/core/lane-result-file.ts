import fs from 'node:fs';
import path from 'node:path';
import {
  LANE_RESULT_BODY_MAX_BYTES,
  LaneResultSchema,
  type LaneResult,
} from './schema.js';

export const LANE_RESULT_FILENAME = 'LANE-RESULT.json';

export type LaneResultFileResolution =
  | { kind: 'found'; path: string; lane: LaneResult; canonical: boolean }
  | { kind: 'absent' }
  | { kind: 'invalid'; path: string; error: string }
  | { kind: 'ambiguous'; paths: string[] };

const MAX_RESULT_FILE_BYTES = LANE_RESULT_BODY_MAX_BYTES + 16 * 1024;

function parseLaneResultFile(file: string): LaneResult | undefined {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_RESULT_FILE_BYTES) return undefined;
  return LaneResultSchema.parse(JSON.parse(fs.readFileSync(file, 'utf-8')));
}

/**
 * Resolve a worker's terminal result without trusting arbitrary paths.
 *
 * The protocol filename is exact and remains authoritative. When an agent
 * nevertheless renames it, recover only a UNIQUE schema-valid JSON file at the
 * worktree root (never recursively, never through a symlink), optionally bound
 * to the requested assignment id. Ambiguity is surfaced instead of guessed.
 */
export function resolveLaneResultFile(
  worktreePath: string,
  assignmentId?: string,
): LaneResultFileResolution {
  const canonicalPath = path.join(worktreePath, LANE_RESULT_FILENAME);
  let foreignCanonical: Extract<LaneResultFileResolution, { kind: 'found' }> | undefined;

  if (fs.existsSync(canonicalPath)) {
    try {
      const lane = parseLaneResultFile(canonicalPath);
      if (!lane) {
        return { kind: 'invalid', path: canonicalPath, error: 'file is not a regular bounded lane-result file' };
      }
      const found = { kind: 'found' as const, path: canonicalPath, lane, canonical: true };
      if (!assignmentId || lane.assignment_id === assignmentId) return found;
      foreignCanonical = found;
    } catch (err) {
      return {
        kind: 'invalid',
        path: canonicalPath,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(worktreePath, { withFileTypes: true });
  } catch {
    return foreignCanonical ?? { kind: 'absent' };
  }

  const recovered: Array<{ path: string; lane: LaneResult }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json') || entry.name === LANE_RESULT_FILENAME) continue;
    const candidatePath = path.join(worktreePath, entry.name);
    try {
      const lane = parseLaneResultFile(candidatePath);
      if (lane && (!assignmentId || lane.assignment_id === assignmentId)) {
        recovered.push({ path: candidatePath, lane });
      }
    } catch {
      // Ordinary project JSON and malformed non-canonical files are not lane results.
    }
  }

  if (recovered.length === 1) {
    return { kind: 'found', ...recovered[0], canonical: false };
  }
  if (recovered.length > 1) {
    return { kind: 'ambiguous', paths: recovered.map((item) => item.path).sort() };
  }
  return foreignCanonical ?? { kind: 'absent' };
}
