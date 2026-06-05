/**
 * CLI command: brainclaw harvest-candidates
 *
 * Scans worktree inboxes for candidates written by agents operating in
 * --sandbox workspace-write mode (e.g. Codex), and copies them into the
 * main project store. This is the coordinator-side of the codex-sandbox
 * bridge: agents write candidates to their worktree's
 * `.brainclaw/coordination/inbox/cnd_*.json` and the coordinator harvests
 * them via this command.
 *
 * @module
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { CandidateSchema, type Candidate, LaneResultSchema, type LaneResult } from '../core/schema.js';
import { listCandidates, listArchivedCandidates, saveCandidate } from '../core/candidates.js';
import { createRuntimeEvent } from '../core/events.js';
import { memoryExists } from '../core/io.js';

export interface HarvestOptions {
  /**
   * Explicit worktree paths to scan. When omitted, all active worktrees
   * under `~/.brainclaw/worktrees/<project-hash>/` are scanned.
   */
  worktreePaths?: string[];
  /** When true, no candidates are written to the main store. */
  dryRun?: boolean;
  /** Main project root. Defaults to process.cwd(). */
  cwd?: string;
  /** Agent name emitting harvest runtime events. Defaults to 'coordinator'. */
  agent?: string;
}

export interface HarvestResult {
  /** Candidates successfully copied to the main store. */
  harvested: Candidate[];
  /** IDs of candidates that already existed in the main store (skipped). */
  skipped: string[];
  /** Error messages for files that could not be read/parsed. */
  errors: string[];
}

/**
 * Returns the base directory where brainclaw-managed worktrees are stored
 * for the given project root: `~/.brainclaw/worktrees/<sha1-hash>/`.
 */
function worktreesBaseDir(projectRoot: string): string {
  const hash = crypto.createHash('sha1').update(projectRoot).digest('hex').slice(0, 12);
  return path.join(os.homedir(), '.brainclaw', 'worktrees', hash);
}

/**
 * Auto-detect all worktree directories under the brainclaw-managed base dir.
 * Returns subdirectories that exist on disk (may or may not have an inbox).
 */
function autoDetectWorktreePaths(cwd: string): string[] {
  const base = worktreesBaseDir(cwd);
  if (!fs.existsSync(base)) return [];

  return fs.readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(base, entry.name));
}

/**
 * Collect all `cnd_*.json` files from a worktree's candidate inbox.
 *
 * Checks both the entity-model path (`.brainclaw/coordination/inbox/`) and
 * the legacy flat path (`.brainclaw/inbox/`) for backward compatibility.
 */
function collectWorktreeCandidateFiles(worktreePath: string): string[] {
  const dirs = [
    path.join(worktreePath, '.brainclaw', 'coordination', 'inbox'),
    path.join(worktreePath, '.brainclaw', 'inbox'),
  ];

  const files: string[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.startsWith('cnd_') && entry.name.endsWith('.json')) {
        files.push(path.join(dir, entry.name));
      }
    }
  }

  // Dedupe: same filename may appear in both paths (entity + legacy)
  const seen = new Set<string>();
  return files.filter((f) => {
    const key = path.basename(f);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Harvest candidates from worktree inboxes into the main project store.
 *
 * This is the coordinator-side fix for gap 5 of E2E test n°1: agents
 * running under `--sandbox workspace-write` cannot reach the main store
 * via MCP. They write candidates directly to their worktree inbox; the
 * coordinator calls `harvestCandidates` to sync them.
 *
 * @returns HarvestResult with counts of harvested, skipped, and errors.
 */
export function harvestCandidates(options: HarvestOptions = {}): HarvestResult {
  const cwd = options.cwd ?? process.cwd();
  const agent = options.agent ?? 'coordinator';
  const result: HarvestResult = { harvested: [], skipped: [], errors: [] };

  // Resolve which worktrees to scan
  const worktreePaths = (options.worktreePaths && options.worktreePaths.length > 0)
    ? options.worktreePaths
    : autoDetectWorktreePaths(cwd);

  if (worktreePaths.length === 0) {
    return result;
  }

  // Build a set of IDs already present in the main store across ALL archives
  // (pending + accepted + rejected) to prevent re-importing archived items.
  // (Codex review cnd#564: dedup was only checking pending inbox)
  const existingIds = new Set<string>([
    ...listCandidates(undefined, cwd).map((c) => c.id),
    ...listArchivedCandidates('accepted', cwd).map((c) => c.id),
    ...listArchivedCandidates('rejected', cwd).map((c) => c.id),
  ]);

  for (const worktreePath of worktreePaths) {
    // Wrap per-worktree scan so a disappeared worktree records an error
    // instead of aborting the full harvest. (Codex review cnd#564)
    let files: string[];
    try {
      files = collectWorktreeCandidateFiles(worktreePath);
    } catch (err) {
      result.errors.push(
        `Failed to scan worktree ${worktreePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    for (const filePath of files) {
      let candidate: Candidate;
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        candidate = CandidateSchema.parse(raw);
      } catch (err) {
        result.errors.push(
          `Failed to parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      if (existingIds.has(candidate.id)) {
        result.skipped.push(candidate.id);
        continue;
      }

      if (!options.dryRun) {
        try {
          saveCandidate(candidate, cwd);
          createRuntimeEvent({
            agent,
            event_type: 'candidate_harvested',
            text: `Harvested candidate [${candidate.id}] from worktree ${path.basename(worktreePath)}`,
            tags: ['harvest', 'bridge', 'codex-sandbox'],
            metadata: {
              candidate_id: candidate.id,
              source_worktree: worktreePath,
              source_file: filePath,
            },
          }, cwd);
        } catch (err) {
          result.errors.push(
            `Failed to save candidate ${candidate.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
      }

      existingIds.add(candidate.id);
      result.harvested.push(candidate);
    }
  }

  return result;
}

// --- CLI entry point ---

export interface RunHarvestOptions {
  dryRun?: boolean;
  worktree?: string[];
  json?: boolean;
  cwd?: string;
}

export function runHarvestCandidates(options: RunHarvestOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();

  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const result = harvestCandidates({
    worktreePaths: options.worktree,
    dryRun: options.dryRun,
    cwd,
  });

  if (options.json) {
    console.log(JSON.stringify({
      harvested: result.harvested.length,
      skipped: result.skipped.length,
      errors: result.errors,
      candidates: result.harvested.map((c) => ({ id: c.id, type: c.type, text: c.text.slice(0, 80) })),
    }, null, 2));
    return;
  }

  const dryTag = options.dryRun ? ' (dry-run)' : '';

  if (result.harvested.length === 0 && result.skipped.length === 0 && result.errors.length === 0) {
    console.log('No worktree candidates found.');
    return;
  }

  for (const c of result.harvested) {
    const verb = options.dryRun ? '  (dry-run) Would harvest' : '  ✔ Harvested';
    console.log(`${verb} [${c.id}] ${c.type}: ${c.text.slice(0, 80)}`);
  }

  for (const id of result.skipped) {
    console.log(`  ⟳ Skipped (already exists): ${id}`);
  }

  for (const err of result.errors) {
    console.error(`  ✗ ${err}`);
  }

  console.log(`\n✔ Harvest complete${dryTag}: ${result.harvested.length} imported, ${result.skipped.length} skipped, ${result.errors.length} error(s).`);
}

// ─────────────────────────────────────────────────────────────────────────────
// pln#526 — LANE-RESULT convention
//
// A dispatched worker writes a single `LANE-RESULT.json` at its worktree root
// as its final step. This is the standard, brief-boilerplate-free channel for a
// worker (especially a sandboxed one that cannot reach MCP) to report its
// outcome. The coordinator ingests it with `brainclaw harvest <assignment_id>`.
// ─────────────────────────────────────────────────────────────────────────────

/** Conventional path of a worker's lane-result file at the worktree root. */
export function getLaneResultPath(worktreePath: string): string {
  return path.join(worktreePath, 'LANE-RESULT.json');
}

/** Idempotency marker so a lane-result is harvested once. */
function laneHarvestedMarkerPath(cwd: string, assignmentId: string): string {
  return path.join(cwd, '.brainclaw', 'coordination', 'runtime', 'result', `${assignmentId}.harvested`);
}

export interface LaneHarvestOptions {
  /** Only harvest the lane-result for this assignment id. Omit to harvest all. */
  assignmentId?: string;
  /** Explicit worktree paths to scan. Defaults to all managed worktrees. */
  worktreePaths?: string[];
  /** When true, nothing is written (no event, no marker). */
  dryRun?: boolean;
  cwd?: string;
  agent?: string;
}

export interface LaneHarvestResult {
  harvested: LaneResult[];
  /** assignment_ids skipped because already harvested. */
  skipped: string[];
  errors: string[];
}

/**
 * Scan worktrees for `LANE-RESULT.json`, validate, and ingest each: emit a
 * `lane_result_harvested` runtime event (durable + queryable) and drop an
 * idempotency marker so re-runs skip it. The worker's actual code lives in the
 * worktree/branch; this surfaces the structured outcome (status + summary) the
 * coordinator needs to converge the lane.
 */
export function harvestLaneResults(options: LaneHarvestOptions = {}): LaneHarvestResult {
  const cwd = options.cwd ?? process.cwd();
  const agent = options.agent ?? 'coordinator';
  const result: LaneHarvestResult = { harvested: [], skipped: [], errors: [] };

  const worktreePaths = (options.worktreePaths && options.worktreePaths.length > 0)
    ? options.worktreePaths
    : autoDetectWorktreePaths(cwd);

  for (const worktreePath of worktreePaths) {
    const file = getLaneResultPath(worktreePath);
    if (!fs.existsSync(file)) continue;

    let lane: LaneResult;
    try {
      lane = LaneResultSchema.parse(JSON.parse(fs.readFileSync(file, 'utf-8')));
    } catch (err) {
      result.errors.push(`Failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // Assignment filter (when harvesting a specific lane).
    if (options.assignmentId && lane.assignment_id !== options.assignmentId) continue;

    const marker = laneHarvestedMarkerPath(cwd, lane.assignment_id);
    if (fs.existsSync(marker)) {
      result.skipped.push(lane.assignment_id);
      continue;
    }

    if (!options.dryRun) {
      try {
        createRuntimeEvent({
          agent,
          event_type: 'lane_result_harvested',
          text: `Lane result for ${lane.assignment_id}: ${lane.status} — ${lane.summary.slice(0, 120)}`,
          tags: ['harvest', 'lane-result', lane.status],
          assignment_id: lane.assignment_id,
          metadata: {
            assignment_id: lane.assignment_id,
            status: lane.status,
            artifacts: lane.artifacts ?? [],
            files_changed: lane.files_changed ?? [],
            source_worktree: worktreePath,
          },
        }, cwd);
        fs.mkdirSync(path.dirname(marker), { recursive: true });
        fs.writeFileSync(marker, new Date(0).toISOString(), 'utf-8');
      } catch (err) {
        result.errors.push(`Failed to ingest lane result for ${lane.assignment_id}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }

    result.harvested.push(lane);
  }

  return result;
}

// --- CLI entry point: `brainclaw harvest <assignment_id>` ---

export interface RunHarvestLaneOptions {
  /** Harvest every lane-result instead of one assignment. */
  all?: boolean;
  dryRun?: boolean;
  worktree?: string[];
  json?: boolean;
  cwd?: string;
}

export function runHarvestLane(assignmentId: string | undefined, options: RunHarvestLaneOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();

  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }
  if (!assignmentId && !options.all) {
    console.error('Error: provide an <assignment_id>, or pass --all to harvest every lane result.');
    process.exit(1);
  }

  const result = harvestLaneResults({
    assignmentId: options.all ? undefined : assignmentId,
    worktreePaths: options.worktree,
    dryRun: options.dryRun,
    cwd,
  });

  if (options.json) {
    console.log(JSON.stringify({
      harvested: result.harvested,
      skipped: result.skipped,
      errors: result.errors,
    }, null, 2));
    return;
  }

  const dryTag = options.dryRun ? ' (dry-run)' : '';
  if (result.harvested.length === 0 && result.skipped.length === 0 && result.errors.length === 0) {
    console.log(assignmentId ? `No LANE-RESULT.json found for ${assignmentId}.` : 'No lane results found in any worktree.');
    return;
  }

  for (const lane of result.harvested) {
    const verb = options.dryRun ? '  (dry-run) Would harvest' : '  ✔ Harvested';
    console.log(`${verb} [${lane.assignment_id}] ${lane.status}: ${lane.summary.slice(0, 100)}`);
    if (lane.files_changed?.length) console.log(`      files: ${lane.files_changed.slice(0, 8).join(', ')}`);
    if (lane.notes) console.log(`      notes: ${lane.notes.slice(0, 120)}`);
  }
  for (const id of result.skipped) {
    console.log(`  ⟳ Skipped (already harvested): ${id}`);
  }
  for (const err of result.errors) {
    console.error(`  ✗ ${err}`);
  }
  console.log(`\n✔ Lane harvest complete${dryTag}: ${result.harvested.length} harvested, ${result.skipped.length} skipped, ${result.errors.length} error(s).`);
}
