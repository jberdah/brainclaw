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
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CandidateSchema, type Candidate, LaneResultSchema, type LaneResult, type AssignmentArtifact, type AssignmentStatus } from '../core/schema.js';
import { gitEvidence } from '../core/dispatch-status.js';
import { listCandidates, listArchivedCandidates, saveCandidate } from '../core/candidates.js';
import { createRuntimeEvent } from '../core/events.js';
import { memoryExists } from '../core/io.js';
import { loadAssignment, transitionAssignment } from '../core/assignments.js';
import { releaseClaimWithCascade, loadClaim } from '../core/claims.js';
import { getCapabilityProfile, dispatchCanCommit } from '../core/agent-capability.js';
import { commitWorktreeOnBehalf, worktreesBaseDir } from '../core/worktree.js';

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
 * sprint 1.5 — deterministic worktree resolution for one assignment. The
 * auto-detect scan depends on the project-hash directory layout and missed a
 * LANE-RESULT.json that demonstrably existed (asgn_ab11b801): the assignment's
 * own worktree_path (and its claim's) are authoritative — scan them FIRST.
 * Works regardless of assignment status (incl. expired — evidence arriving
 * late must still be harvestable).
 */
function resolveAssignmentWorktreePaths(assignmentId: string, cwd: string): string[] {
  const paths: string[] = [];
  const assignment = loadAssignment(assignmentId, cwd);
  if (assignment?.worktree_path) paths.push(assignment.worktree_path);
  if (assignment?.claim_id) {
    try {
      const claim = loadClaim(assignment.claim_id, cwd);
      if (claim.worktree_path) paths.push(claim.worktree_path);
    } catch { /* claim gone — assignment path may still resolve */ }
  }
  return [...new Set(paths)].filter((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });
}

/** Scan list for a lane harvest: explicit paths win; otherwise the assignment's
 * own worktrees first, then the auto-detected pool (deduped). */
function resolveLaneScanPaths(options: { assignmentId?: string; worktreePaths?: string[] }, cwd: string): string[] {
  if (options.worktreePaths && options.worktreePaths.length > 0) return options.worktreePaths;
  const assignmentPaths = options.assignmentId ? resolveAssignmentWorktreePaths(options.assignmentId, cwd) : [];
  return [...new Set([...assignmentPaths, ...autoDetectWorktreePaths(cwd)])];
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

  const worktreePaths = resolveLaneScanPaths(options, cwd);

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
        fs.writeFileSync(marker, new Date().toISOString(), 'utf-8');
      } catch (err) {
        result.errors.push(`Failed to ingest lane result for ${lane.assignment_id}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }

    result.harvested.push(lane);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// pln#534 — worktree-as-contract: integrate a worker's lane on its behalf.
//
// LEVER #1 from the LeaseUp frontier (can_100f1e8c). The worker's contract is
// reduced to "edit files in this worktree + drop LANE-RESULT.json". brainclaw
// carries the rest for a worker that cannot (a sandboxed agent whose root
// excludes `.git`, i.e. dispatchCanCommit=false): it COMMITS the worktree diff
// on the worker's behalf so the code lands on the lane branch, then lifecycles
// the assignment and releases the claim (with plan cascade). Self-commit / MCP /
// self-lifecycle become PROGRESSIVE enrichments, not prerequisites.
//
// Strictly ADDITIVE + opt-in: nothing here runs unless a caller invokes
// integrateLaneResults / `brainclaw harvest --integrate`. Existing harvest stays
// report-only.
// ─────────────────────────────────────────────────────────────────────────────

/** Happy-path assignment FSM chain walked when force-completing on behalf. */
const ASSIGNMENT_COMPLETE_CHAIN: AssignmentStatus[] = ['created', 'offered', 'accepted', 'started', 'completed'];

/**
 * Walk a still-open assignment forward to `completed` through the valid FSM
 * chain (offered→accepted→started→completed), attaching artifacts on the final
 * step. Idempotent (already-completed → true; transitions no-op). Returns false
 * for assignments parked off the happy path (failed/blocked/timed_out) — those
 * are not silently force-completed.
 */
function forceCompleteAssignment(
  assignmentId: string,
  artifacts: AssignmentArtifact[],
  statusReason: string,
  actor: string,
  cwd: string,
): boolean {
  const current = loadAssignment(assignmentId, cwd);
  if (!current) return false;
  if (current.status === 'completed') return true;
  // can_948acfd6 — expired→completed: a LANE-RESULT arriving after an
  // administrative expiry is the truth; converge instead of FSM-blocking.
  if (current.status === 'expired') {
    try {
      transitionAssignment(assignmentId, 'completed', {
        actor, artifacts, status_reason: `${statusReason} (late evidence after administrative expiry)`,
      }, cwd);
    } catch { /* concurrent transition */ }
    return loadAssignment(assignmentId, cwd)?.status === 'completed';
  }
  const startIdx = ASSIGNMENT_COMPLETE_CHAIN.indexOf(current.status as AssignmentStatus);
  if (startIdx === -1) return false; // off the happy path (failed/blocked/…): leave it.

  for (let i = startIdx + 1; i < ASSIGNMENT_COMPLETE_CHAIN.length; i++) {
    const next = ASSIGNMENT_COMPLETE_CHAIN[i]!;
    try {
      transitionAssignment(
        assignmentId,
        next,
        next === 'completed' ? { actor, artifacts, status_reason: statusReason } : { actor },
        cwd,
      );
    } catch {
      // A concurrent explicit transition may have moved it; stop walking.
      break;
    }
  }
  return loadAssignment(assignmentId, cwd)?.status === 'completed';
}

export interface LaneIntegrateOptions {
  /** Only integrate this assignment id. Omit to integrate every lane result. */
  assignmentId?: string;
  /** Explicit worktree paths to scan. Defaults to all managed worktrees. */
  worktreePaths?: string[];
  /** When true, nothing is committed/lifecycled — the plan is reported only. */
  dryRun?: boolean;
  cwd?: string;
  /** Actor name for events/lifecycle. Defaults to 'coordinator'. */
  agent?: string;
}

export interface LaneIntegrateEntry {
  assignment_id: string;
  worker_agent?: string;
  lane_status: string;
  /** The worker's OWN commit capability — false ⇒ brainclaw commits for it. */
  worker_can_commit: boolean;
  /** brainclaw committed the worktree diff on the worker's behalf. */
  committed_on_behalf: boolean;
  commit_sha?: string;
  files_changed: string[];
  assignment_completed: boolean;
  claim_released: boolean;
  reason: string;
}

export interface LaneIntegrateResult {
  integrated: LaneIntegrateEntry[];
  /** assignment_ids skipped (no assignment record, or unmapped). */
  skipped: string[];
  errors: string[];
}

/**
 * Integrate completed lanes on behalf of workers that cannot self-commit.
 *
 * For each LANE-RESULT.json found (optionally filtered to one assignment):
 *  1. resolve the assignment + the worker agent's commit capability;
 *  2. when the worker CANNOT commit (sandboxed) and the worktree is dirty,
 *     commit the diff on its behalf onto the lane branch (guarded to the linked
 *     worktree only — never the main repo);
 *  3. lifecycle the assignment (status=completed → walk to completed with the
 *     commit + files as artifacts; status=blocked/failed → best-effort
 *     transition) and release the claim with plan cascade.
 *
 * A worker that CAN commit is left to its self-commit handoff — brainclaw only
 * lifecycles/releases, it does not author commits for it.
 */
export function integrateLaneResults(options: LaneIntegrateOptions = {}): LaneIntegrateResult {
  const cwd = options.cwd ?? process.cwd();
  const actor = options.agent ?? 'coordinator';
  const result: LaneIntegrateResult = { integrated: [], skipped: [], errors: [] };

  const worktreePaths = resolveLaneScanPaths(options, cwd);

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

    if (options.assignmentId && lane.assignment_id !== options.assignmentId) continue;

    const assignment = loadAssignment(lane.assignment_id, cwd);
    if (!assignment) {
      result.skipped.push(lane.assignment_id);
      result.errors.push(`No assignment record for lane ${lane.assignment_id} — cannot integrate`);
      continue;
    }

    const profile = getCapabilityProfile(assignment.agent);
    // No profile ⇒ assume it can commit (conservative: don't author for an
    // unknown agent), so brainclaw only lifecycles.
    const workerCanCommit = profile ? dispatchCanCommit(profile) : true;

    const entry: LaneIntegrateEntry = {
      assignment_id: lane.assignment_id,
      worker_agent: assignment.agent,
      lane_status: lane.status,
      worker_can_commit: workerCanCommit,
      committed_on_behalf: false,
      files_changed: lane.files_changed ?? [],
      assignment_completed: false,
      claim_released: false,
      reason: '',
    };
    const reasons: string[] = [];

    // 1. Commit on behalf (only when the worker cannot, and there is a diff).
    if (!workerCanCommit) {
      if (options.dryRun) {
        reasons.push('(dry-run) would commit worktree diff on behalf');
      } else {
        const message = `chore(lane): integrate ${assignment.agent} work for ${lane.assignment_id}\n\n`
          + `${lane.summary}\n\n[brainclaw committed on behalf — worker sandbox cannot self-commit (pln#534)]`;
        const commit = commitWorktreeOnBehalf(worktreePath, message, {
          authorName: `${assignment.agent} (via brainclaw)`,
          authorEmail: 'brainclaw@on-behalf.local',
        });
        entry.committed_on_behalf = commit.committed;
        entry.commit_sha = commit.sha;
        if (commit.committed) entry.files_changed = commit.files_changed;
        reasons.push(commit.reason);
      }
    } else {
      reasons.push('worker can self-commit — no on-behalf commit');
    }

    // 2. Lifecycle + release.
    if (!options.dryRun) {
      if (lane.status === 'completed') {
        const artifacts: AssignmentArtifact[] = [
          ...(entry.commit_sha ? [{ type: 'commit', ref: entry.commit_sha, description: 'on-behalf integration commit' }] : []),
          ...entry.files_changed.slice(0, 50).map((f) => ({ type: 'file', ref: f })),
        ];
        entry.assignment_completed = forceCompleteAssignment(
          lane.assignment_id, artifacts, `pln#534 on-behalf integration: ${lane.summary.slice(0, 120)}`, actor, cwd,
        );
        try {
          const rel = releaseClaimWithCascade(assignment.claim_id, { planStatus: 'done', cwd });
          entry.claim_released = rel.claim.status === 'released';
        } catch (err) {
          reasons.push(`claim release failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        // blocked / failed: best-effort lifecycle (FSM may reject from offered).
        const target: AssignmentStatus = lane.status === 'blocked' ? 'blocked' : 'failed';
        try {
          transitionAssignment(lane.assignment_id, target, { actor, status_reason: lane.summary.slice(0, 200) }, cwd);
        } catch (err) {
          reasons.push(`assignment ${target} transition rejected: ${err instanceof Error ? err.message : String(err)}`);
        }
        try {
          const rel = releaseClaimWithCascade(assignment.claim_id, {
            planStatus: lane.status === 'blocked' ? 'blocked' : undefined,
            cwd,
          });
          entry.claim_released = rel.claim.status === 'released';
        } catch (err) {
          reasons.push(`claim release failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Durable trace of the integration.
      try {
        createRuntimeEvent({
          agent: actor,
          event_type: 'lane_integrated',
          text: `Integrated lane ${lane.assignment_id} (${lane.status}) on behalf of ${assignment.agent}`,
          tags: ['harvest', 'integrate', 'worktree-as-contract', lane.status],
          assignment_id: lane.assignment_id,
          metadata: {
            assignment_id: lane.assignment_id,
            worker_agent: assignment.agent,
            committed_on_behalf: entry.committed_on_behalf,
            commit_sha: entry.commit_sha ?? null,
            files_changed: entry.files_changed,
            assignment_completed: entry.assignment_completed,
            claim_released: entry.claim_released,
          },
        }, cwd);
      } catch { /* event is best-effort */ }
    }

    entry.reason = reasons.join('; ');
    result.integrated.push(entry);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// pln#554 step 3 — `harvest --orphaned`: recover a dead worker that left NO
// LANE-RESULT. Codifies the manual recovery executed twice on 2026-06-10
// (42 and 41 files, zero loss): inspect the worktree, typecheck if possible,
// commit on-behalf with the standard marker, lifecycle when the FSM allows,
// release the claim. NEVER deletes or resets anything.
// ─────────────────────────────────────────────────────────────────────────────

export const ORPHANED_COMMIT_MARKER =
  '[brainclaw committed on behalf — worker died before delivering; coordinator harvest --orphaned]';

export type OrphanedTypecheckStatus = 'passed' | 'failed' | 'skipped_no_node_modules' | 'not_run';

export interface OrphanedHarvestOptions {
  /** Assignment whose worktree should be recovered (resolves worktree via assignment/claim). */
  assignmentId?: string;
  /** Explicit worktree path (wins over assignment resolution). */
  worktreePath?: string;
  /** Base ref for the commits-ahead comparison. Default 'master'. */
  baseRef?: string;
  /** When true, inspect + report only — no typecheck, commit, or lifecycle. */
  dryRun?: boolean;
  cwd?: string;
  /** Actor name for events/lifecycle. Defaults to 'coordinator'. */
  agent?: string;
}

export interface OrphanedHarvestReport {
  assignment_id?: string;
  worktree_path?: string;
  commits_ahead: number;
  dirty_tracked: number;
  untracked: number;
  /** Worktree clean + no commits ahead — state left untouched. */
  nothing_to_recover: boolean;
  typecheck: OrphanedTypecheckStatus;
  typecheck_output?: string;
  committed_on_behalf: boolean;
  commit_sha?: string;
  files_changed: string[];
  assignment_completed: boolean;
  claim_released: boolean;
  errors: string[];
  recommended_next_action: string;
}

function countUntracked(worktreePath: string): number {
  const r = spawnSync('git', ['-C', worktreePath, 'status', '--short'], { encoding: 'utf-8', timeout: 15000 });
  if (r.status !== 0) return 0;
  return (r.stdout ?? '').split('\n').filter((l) => l.startsWith('??')).length;
}

/** `npx tsc --noEmit` in the worktree; skips gracefully when node_modules is absent. */
function typecheckWorktree(worktreePath: string): { status: OrphanedTypecheckStatus; output?: string } {
  if (!fs.existsSync(path.join(worktreePath, 'node_modules'))) {
    return {
      status: 'skipped_no_node_modules',
      output: 'node_modules absent in worktree — link it from the main repo (Windows junction / symlink) to typecheck locally; the coordinator validates centrally after harvest.',
    };
  }
  // Fixed command string (no user input) — shell needed for npx on Windows.
  const r = spawnSync('npx tsc --noEmit', { cwd: worktreePath, shell: true, encoding: 'utf-8', timeout: 300_000 });
  if (r.status === 0) return { status: 'passed' };
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  return { status: 'failed', output: out.slice(0, 2000) };
}

/**
 * Recover an orphaned lane: a worker died without writing LANE-RESULT.json.
 *
 * Evidence-first and strictly non-destructive:
 *  - LANE-RESULT present → not orphaned; refuse and point at the normal harvest;
 *  - tracked changes → typecheck (best effort), then commit on-behalf with
 *    ORPHANED_COMMIT_MARKER;
 *  - clean tree + no commits ahead → 'nothing to recover', state untouched;
 *  - then lifecycle the assignment when the FSM allows and release the claim.
 */
export function harvestOrphaned(options: OrphanedHarvestOptions): OrphanedHarvestReport {
  const cwd = options.cwd ?? process.cwd();
  const actor = options.agent ?? 'coordinator';
  const baseRef = options.baseRef ?? 'master';
  const report: OrphanedHarvestReport = {
    assignment_id: options.assignmentId,
    worktree_path: undefined,
    commits_ahead: 0,
    dirty_tracked: 0,
    untracked: 0,
    nothing_to_recover: false,
    typecheck: 'not_run',
    committed_on_behalf: false,
    files_changed: [],
    assignment_completed: false,
    claim_released: false,
    errors: [],
    recommended_next_action: '',
  };

  let worktree = options.worktreePath;
  if (!worktree && options.assignmentId) {
    worktree = resolveAssignmentWorktreePaths(options.assignmentId, cwd)[0];
  }
  if (!worktree || !fs.existsSync(worktree)) {
    report.errors.push('No worktree resolved — pass --worktree <path> explicitly, or patch claim.worktree_path.');
    report.recommended_next_action = 'Resolve the worktree path first; nothing was touched.';
    return report;
  }
  report.worktree_path = worktree;

  if (fs.existsSync(getLaneResultPath(worktree))) {
    report.errors.push('LANE-RESULT.json present — this lane is NOT orphaned. Use `brainclaw harvest <assignment_id> [--integrate]` instead.');
    report.recommended_next_action = 'Run the normal lane harvest; nothing was touched.';
    return report;
  }

  const evidence = gitEvidence(worktree, baseRef);
  if (!evidence) {
    report.errors.push(`Could not read git evidence from ${worktree} (base ref '${baseRef}') — is it a git worktree and does the base ref exist?`);
    report.recommended_next_action = 'Fix the base ref (--base) or inspect the worktree manually; nothing was touched.';
    return report;
  }
  report.commits_ahead = evidence.commitsAhead;
  report.dirty_tracked = evidence.dirtyTracked;
  report.untracked = countUntracked(worktree);

  if (evidence.dirtyTracked === 0 && evidence.commitsAhead === 0) {
    report.nothing_to_recover = true;
    report.recommended_next_action = report.untracked > 0
      ? `Nothing to recover (no tracked changes, no commits ahead). ${report.untracked} untracked file(s) present — inspect them manually before any cleanup. State left untouched.`
      : 'Nothing to recover — worktree clean with no commits ahead. State left untouched.';
    return report;
  }

  // Tracked changes → typecheck (best effort), then commit on-behalf.
  if (evidence.dirtyTracked > 0) {
    if (options.dryRun) {
      report.recommended_next_action = `(dry-run) would typecheck + commit ${evidence.dirtyTracked} tracked change(s) on behalf.`;
    } else {
      const tc = typecheckWorktree(worktree);
      report.typecheck = tc.status;
      report.typecheck_output = tc.output;

      const message = `chore(lane): recover orphaned worker output${options.assignmentId ? ` for ${options.assignmentId}` : ''}\n\n${ORPHANED_COMMIT_MARKER}`;
      const commit = commitWorktreeOnBehalf(worktree, message, {
        authorName: 'brainclaw (orphaned recovery)',
        authorEmail: 'brainclaw@on-behalf.local',
      });
      report.committed_on_behalf = commit.committed;
      report.commit_sha = commit.sha;
      report.files_changed = commit.files_changed;
      if (!commit.committed) report.errors.push(`commit on behalf failed: ${commit.reason}`);
    }
  } else if (options.dryRun) {
    // commits ahead with a clean tree — the worker delivered before dying.
    report.recommended_next_action = `(dry-run) nothing to commit (${evidence.commitsAhead} commit(s) already on the branch); would lifecycle the assignment + release the claim.`;
  }

  // Lifecycle + claim release (only with an assignment to converge, never dry-run).
  if (!options.dryRun && options.assignmentId) {
    const assignment = loadAssignment(options.assignmentId, cwd);
    if (assignment) {
      const artifacts: AssignmentArtifact[] = [
        ...(report.commit_sha ? [{ type: 'commit', ref: report.commit_sha, description: 'orphaned-recovery commit (on behalf)' }] : []),
        ...report.files_changed.slice(0, 50).map((f) => ({ type: 'file', ref: f })),
      ];
      report.assignment_completed = forceCompleteAssignment(
        options.assignmentId, artifacts,
        'pln#554 harvest --orphaned: worker died before delivering; work recovered from worktree',
        actor, cwd,
      );
      try {
        const rel = releaseClaimWithCascade(assignment.claim_id, { planStatus: 'done', cwd });
        report.claim_released = rel.claim.status === 'released';
      } catch (err) {
        report.errors.push(`claim release failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      report.errors.push(`No assignment record for ${options.assignmentId} — recovered the worktree but skipped lifecycle/claim release.`);
    }
  }

  if (!options.dryRun) {
    try {
      createRuntimeEvent({
        agent: actor,
        event_type: 'lane_integrated',
        text: `Orphaned lane recovered${options.assignmentId ? ` for ${options.assignmentId}` : ''}: ${report.files_changed.length} file(s) committed on behalf (typecheck=${report.typecheck})`,
        tags: ['harvest', 'orphaned', 'recovery'],
        assignment_id: options.assignmentId,
        metadata: {
          assignment_id: options.assignmentId ?? null,
          worktree_path: worktree,
          commit_sha: report.commit_sha ?? null,
          files_changed: report.files_changed,
          typecheck: report.typecheck,
          commits_ahead: report.commits_ahead,
          assignment_completed: report.assignment_completed,
          claim_released: report.claim_released,
        },
      }, cwd);
    } catch { /* event is best-effort */ }

    const tcWarn = report.typecheck === 'failed'
      ? ' WARNING: typecheck FAILED — fix the branch before merging (output captured in the report).'
      : report.typecheck === 'skipped_no_node_modules'
        ? ' Typecheck was skipped (no node_modules) — validate centrally.'
        : '';
    report.recommended_next_action =
      `Run targeted tests for the recovered files, then merge the lane branch.${tcWarn}`;
  }

  return report;
}

// --- CLI entry point: `brainclaw harvest <assignment_id>` ---

export interface RunHarvestLaneOptions {
  /** Harvest every lane-result instead of one assignment. */
  all?: boolean;
  dryRun?: boolean;
  worktree?: string[];
  json?: boolean;
  cwd?: string;
  /** pln#534: also commit-on-behalf + lifecycle + release (worktree-as-contract). */
  integrate?: boolean;
  /** pln#554: recover a dead worker that left NO lane-result. */
  orphaned?: boolean;
  /** Base ref for --orphaned commits-ahead comparison. Default 'master'. */
  base?: string;
}

export function runHarvestLane(assignmentId: string | undefined, options: RunHarvestLaneOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();

  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }
  if (!assignmentId && !options.all && !(options.orphaned && options.worktree?.length)) {
    console.error('Error: provide an <assignment_id>, or pass --all to harvest every lane result.');
    process.exit(1);
  }

  // pln#554 — `--orphaned`: the worker died WITHOUT a lane-result. Recover its
  // worktree (typecheck + commit on behalf), lifecycle, and release. Never
  // deletes or resets anything.
  if (options.orphaned) {
    const report = harvestOrphaned({
      assignmentId,
      worktreePath: options.worktree?.[0],
      baseRef: options.base,
      dryRun: options.dryRun,
      cwd,
    });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.errors.length > 0 ? 1 : 0;
      return;
    }
    const dry = options.dryRun ? ' (dry-run)' : '';
    console.log(`Orphaned-lane recovery${dry} for ${assignmentId ?? report.worktree_path ?? '(unresolved)'}:`);
    if (report.worktree_path) console.log(`  worktree: ${report.worktree_path}`);
    console.log(`  evidence: commits_ahead=${report.commits_ahead} dirty_tracked=${report.dirty_tracked} untracked=${report.untracked}`);
    if (report.nothing_to_recover) {
      console.log('  → nothing to recover; state left untouched.');
    } else {
      if (report.typecheck !== 'not_run') {
        console.log(`  typecheck: ${report.typecheck}`);
        if (report.typecheck_output) console.log(`    ${report.typecheck_output.split('\n').slice(0, 12).join('\n    ')}`);
      }
      if (report.committed_on_behalf) {
        console.log(`  ✔ committed on behalf: ${report.commit_sha?.slice(0, 10)} (${report.files_changed.length} file(s))`);
      }
      console.log(`  assignment_completed=${report.assignment_completed} claim_released=${report.claim_released}`);
    }
    for (const err of report.errors) console.error(`  ✗ ${err}`);
    if (report.recommended_next_action) console.log(`  → ${report.recommended_next_action}`);
    process.exitCode = report.errors.length > 0 ? 1 : 0;
    return;
  }

  // pln#534 — `--integrate` upgrades harvest from report-only to converge-the-
  // lane: commit the worktree diff on behalf of a sandboxed worker, lifecycle
  // the assignment, and release the claim. Runs alongside the normal ingest.
  if (options.integrate) {
    const integ = integrateLaneResults({
      assignmentId: options.all ? undefined : assignmentId,
      worktreePaths: options.worktree,
      dryRun: options.dryRun,
      cwd,
    });
    if (options.json) {
      console.log(JSON.stringify(integ, null, 2));
      return;
    }
    const dry = options.dryRun ? ' (dry-run)' : '';
    if (integ.integrated.length === 0 && integ.errors.length === 0) {
      if (assignmentId) {
        const checked = resolveLaneScanPaths({ assignmentId, worktreePaths: options.worktree }, cwd);
        console.log(`No LANE-RESULT.json to integrate for ${assignmentId}.`);
        console.log(checked.length > 0
          ? `  Checked worktree(s): ${checked.slice(0, 5).join(', ')}${checked.length > 5 ? ` (+${checked.length - 5} more)` : ''}`
          : '  No worktree resolved for this assignment — pass --worktree <path> explicitly, or patch claim.worktree_path.');
      } else {
        console.log('No lane results to integrate.');
      }
      return;
    }
    for (const e of integ.integrated) {
      console.log(`  ✔ Integrated [${e.assignment_id}] ${e.lane_status} (worker=${e.worker_agent}, can_commit=${e.worker_can_commit})`);
      if (e.committed_on_behalf) console.log(`      committed on behalf: ${e.commit_sha?.slice(0, 10)} (${e.files_changed.length} file(s))`);
      console.log(`      assignment_completed=${e.assignment_completed} claim_released=${e.claim_released}`);
      if (e.reason) console.log(`      ${e.reason}`);
    }
    for (const err of integ.errors) console.error(`  ✗ ${err}`);
    console.log(`\n✔ Lane integrate complete${dry}: ${integ.integrated.length} integrated, ${integ.errors.length} error(s).`);
    return;
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
    if (assignmentId) {
      const checked = resolveLaneScanPaths({ assignmentId, worktreePaths: options.worktree }, cwd);
      console.log(`No LANE-RESULT.json found for ${assignmentId}.`);
      console.log(checked.length > 0
        ? `  Checked worktree(s): ${checked.slice(0, 5).join(', ')}${checked.length > 5 ? ` (+${checked.length - 5} more)` : ''}`
        : '  No worktree resolved for this assignment — pass --worktree <path> explicitly, or patch claim.worktree_path.');
    } else {
      console.log('No lane results found in any worktree.');
    }
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
