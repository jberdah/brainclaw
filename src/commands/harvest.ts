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
import { loadClaim, releaseClaimsCascade, logCascadeReleaseResult } from '../core/claims.js';
import { getCapabilityProfile, dispatchCanCommit } from '../core/agent-capability.js';
import { commitWorktreeOnBehalf, worktreesBaseDir, resolveGitToplevel } from '../core/worktree.js';
import { closeReviewLoopFromLaneResult, type ReviewLoopCloseResult, type ReviewLoopNextTurn } from '../core/review-loop-close.js';
import { closeIdeationLoopFromLaneResult } from '../core/ideation-loop-close.js';
import { dispatchReviewLoopTurn, turnOwnedLoopEnabled } from '../core/review-loop-turn-dispatch.js';
import { reconcileTurn, type ReconcileTurnResult } from '../core/loops/reconcile-turn.js';
import { findReservationByAssignmentId, type TurnReservation } from '../core/loops/attempt-reservation.js';
import { resolveTurnGenerationChain } from '../core/loops/attempt-generations.js';
import { getLoop } from '../core/loops/store.js';
import { phasePolicy } from '../core/loops/kind-policies.js';
import { readCompletionSignals } from '../core/runtime-signals.js';
import { reconcileClaimConformity } from '../core/claim-conformity.js';
import { toWarningDetail } from '../core/warnings.js';
import type { WarningDetail } from '../core/facade-schema.js';
import { harvestHarnessObservation } from '../core/harness-adapters/index.js';

/**
 * pln#630 PR3a — finalize a TURN-OWNED review lane via the exactly-once `reconcileTurn`
 * instead of the legacy `closeReviewLoopFromLaneResult`. Returns `undefined` for a legacy
 * (non-reserved) lane so the caller runs the unchanged legacy path — this is the
 * exactly-one-finalizer discriminator: a lane is turn-owned iff a reservation OWNS its
 * assignment_id (only the turn-owned dispatch writes a reservation file).
 *
 * Evidence sourcing (the load-bearing subtlety): a real reviewer's LANE-RESULT.json is
 * KEYLESS — the review brief never asks the worker to echo turn_id/run_id/nonce — so
 * read-strict `reconcileTurn` (which matches lane.{turn_id,run_id,nonce} against the
 * attempt) would REJECT it. We source the keys authoritatively: turn_id + run_id are
 * deterministic from the reservation, and the NONCE — the non-derivable proof that THIS
 * launch generation actually ran — comes from the coordinator's completion SENTINEL
 * (written mechanically by the ack-wrapper with the launch-grant token). A caller/test
 * that already supplies keyed lanes is honored (lane.* wins); a stale generation's
 * sentinel carries the old token → still rejected, preserving the anti-stale guarantee.
 */
/**
 * The turn-owned FINALIZATION discriminator (pln#630, review Finding 1). A lane finalizes via
 * the exactly-once reconcileTurn ONLY if a committed reservation OWNS it AND turn-keyed evidence
 * (the nonce) is available — from the lane or the coordinator's completion SENTINEL. Without the
 * nonce, reconcileTurn's read-strict gate can NEVER converge: this is reachable in production
 * when a turn-owned dispatch WON the fence but did not ack-wrap-spawn (inbox_only / IDE-only
 * reviewer, command_ready_manual, capacity cap, BRAINCLAW_NO_SPAWN, worktree-creation failure) —
 * it minted a reservation but no sentinel will ever be written. Returning undefined there routes
 * the lane to the LEGACY presence-based closer so the loop still converges instead of stalling
 * forever. This is SAFE: the exactly-once SPAWN guarantee is enforced at DISPATCH by the launch
 * fence (already run), so using legacy FINALIZATION for a sentinel-less lane reintroduces no
 * double-spawn; and a sentinel that lands after a legacy close makes a later reconcile a
 * terminal-loop idempotent no-op.
 */
interface TurnOwnedLaneEvidence {
  reservation: TurnReservation;
  nonce?: string;
  contract_hash?: string;
  capability_snapshot_hash?: string;
}

function turnOwnedLaneEvidence(lane: LaneResult, cwd: string): TurnOwnedLaneEvidence | undefined {
  const reservation = findReservationByAssignmentId(lane.assignment_id, cwd);
  if (!reservation) return undefined; // legacy lane (no reservation)
  const chain = resolveTurnGenerationChain(cwd, reservation.turn_id);
  const completion = readCompletionSignals(
    cwd,
    reservation.child_ids.assignment_id,
    chain?.latest_generation.run_id,
  ).completed;
  const nonce = lane.nonce ?? completion?.nonce;
  if (!nonce && !reservation.execution_contract_ref) return undefined;
  return {
    reservation,
    nonce,
    contract_hash: lane.execution_contract_hash ?? completion?.contract_hash,
    capability_snapshot_hash: lane.capability_snapshot_hash ?? completion?.capability_snapshot_hash,
  };
}

function reconcileTurnOwnedLane(
  lane: LaneResult,
  cwd: string,
  evidence?: TurnOwnedLaneEvidence,
): { reservation: TurnReservation; result: ReconcileTurnResult } | undefined {
  const ev = evidence ?? turnOwnedLaneEvidence(lane, cwd);
  if (!ev) return undefined; // legacy lane OR no turn-keyed evidence — caller runs the legacy path
  const { reservation, nonce } = ev;
  const enrichedLane: LaneResult = {
    ...lane,
    turn_id: lane.turn_id ?? reservation.turn_id,
    run_id: lane.run_id ?? reservation.child_ids.run_id,
    nonce,
    execution_contract_hash: lane.execution_contract_hash ?? ev.contract_hash,
    capability_snapshot_hash: lane.capability_snapshot_hash ?? ev.capability_snapshot_hash,
  };
  const loop = getLoop(reservation.loop_id, cwd);
  const critiques = loop?.kind === 'ideation'
    && reservation.phase === 'critique'
    && lane.artifact_type === 'critique'
    && (lane.body ?? '').trim().length > 0
    ? [{ body: lane.body!.trim() }]
    : undefined;
  const result = reconcileTurn({ turn_id: reservation.turn_id, lane: enrichedLane, cwd, critiques });
  return { reservation, result };
}

/**
 * Map a `reconcileTurn` result onto the `ReviewLoopCloseResult` shape harvest records for
 * observability (entry.review_loop / CLI). No keep_claim / next_turn: the request_changes
 * turn-owned re-dispatch (fix cycle) is pln#630 PR3b — deferred and non-corrupting (the
 * loop stays open awaiting its next turn, identical to the legacy asymmetric path).
 */
function reconcileToReviewLoopResult(
  reservation: TurnReservation,
  rr: ReconcileTurnResult,
  lane: LaneResult,
): ReviewLoopCloseResult {
  return {
    loop_id: reservation.loop_id,
    verdict: lane.review_verdict === 'request_changes' ? 'request_changes' : 'approve',
    action: rr.auto_closed ? 'closed' : rr.reconciled ? 'advanced' : 'noop',
    reason: rr.reason,
    loop_status: rr.loop_status,
  };
}

/**
 * pln#644 — the warn-only branches must stay QUIET for a lane whose turn is no
 * longer the live one: a prior round's LANE-RESULT re-scanned by `harvest --all`
 * after the loop advanced (superseded) or closed (terminal) is a healthy flow,
 * not a stall. Warning there would train operators to ignore the one warning
 * that matters. Only an OPEN loop whose slot still points at THIS turn is
 * actually awaiting convergence.
 */
function loopTurnAwaitsConvergence(reservation: TurnReservation, cwd: string): boolean {
  const loop = getLoop(reservation.loop_id, cwd);
  if (!loop) return false;
  // Only a live, advancing loop is awaiting convergence (PR #171 review P2-1).
  // 'blocked' (iteration cap) is in reconcileTurn's LOOP_TERMINAL set, and a
  // 'paused' loop refuses advancement until resumed — advising `--integrate`
  // on either would be a false alarm. 'open' is the only non-terminal,
  // advancing status (LoopStatus non-terminal = 'open' | 'paused').
  if (loop.status !== 'open') return false;
  const slot = loop.slots.find((s) => s.slot_id === reservation.slot_id);
  if (!slot) return false;
  // Mirror reconcileTurn's superseded guard exactly: an UNSET current_turn_id is
  // "not superseded" (a dispatch whose turn() never rebound the slot pointer is
  // still this turn's attempt), only a pointer to a DIFFERENT turn means the
  // slot moved on and the stale lane deserves silence, not a warning.
  return slot.current_turn_id === undefined || slot.current_turn_id === reservation.turn_id;
}

/**
 * pln#644 — the loud half of "converge or fail loudly". The message names the
 * exact command that finalizes the turn (`harvest --integrate`) AND the manual
 * loop-drive alternative, because the two lived stalls (2026-08-02/03) were
 * both resolved manually once the coordinator finally noticed the open turn.
 */
function reviewTurnNotConvergedWarning(lane: LaneResult, reservation: TurnReservation, why: string): WarningDetail {
  return toWarningDetail({
    code: 'review_turn_not_converged',
    message:
      `Turn-owned review lane ${lane.assignment_id} harvested report-only: loop ${reservation.loop_id} ` +
      `turn ${reservation.turn_id} is NOT converged — ${why}. ` +
      `Run \`brainclaw harvest --integrate ${lane.assignment_id}\` to finalize it ` +
      `(records the verdict; on request_changes it also drives the fix cycle), ` +
      `or drive the loop manually (bclaw_loop add_artifact + complete_turn).`,
    data: {
      assignment_id: lane.assignment_id,
      loop_id: reservation.loop_id,
      turn_id: reservation.turn_id,
      review_verdict: lane.review_verdict ?? null,
      reason: why,
    },
    next_actions: [{
      tool: 'bclaw_loop',
      args: { intent: 'get', loop_id: reservation.loop_id },
      when: 'inspect the open turn before converging it via --integrate or a manual complete_turn',
    }],
  });
}

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
  // Codex review of PR #49 (MED): createWorktree now writes in-tree worktrees
  // under the git-TOPLEVEL hash (pln#614), so the scan base must resolve the
  // toplevel too — otherwise `harvest --all` / candidates from an in-tree
  // project subdir scan the stale subdir hash and miss every lane result. Only
  // the scan base is toplevel-resolved; .brainclaw store reads/writes elsewhere
  // keep the original project cwd.
  const base = worktreesBaseDir(resolveGitToplevel(cwd));
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
 * This is the coordinator-side fix for gap 5 of E2E test n°1: a worker that
 * cannot write to the main store — a genuinely MCP-less agent, or (post
 * dec#133) a sandboxed codex whose `.git` is read-only so it cannot commit —
 * leaves candidates in its worktree inbox; the coordinator calls
 * `harvestCandidates` to sync them.
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
// worker (a genuinely MCP-less agent, or a sandboxed codex that cannot git
// commit) to report its outcome. The coordinator ingests it with
// `brainclaw harvest <assignment_id>`.
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
  /**
   * pln#636 C2 — scope-conformity advisories raised while ingesting.
   *
   * This is the path that reaches the tier C1's hook cannot: a sandboxed lane
   * that never saw MCP and reported through `LANE-RESULT.json`. Advisory only,
   * and additive — a caller that ignores this field sees unchanged behaviour.
   */
  warnings: WarningDetail[];
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
  const result: LaneHarvestResult = { harvested: [], skipped: [], errors: [], warnings: [] };

  const worktreePaths = resolveLaneScanPaths(options, cwd);

  for (const worktreePath of worktreePaths) {
    const file = getLaneResultPath(worktreePath);
    const fileExists = fs.existsSync(file);
    let nativeObservation: ReturnType<typeof harvestHarnessObservation>;
    if (options.assignmentId) {
      try {
        nativeObservation = harvestHarnessObservation(options.assignmentId, cwd, !options.dryRun);
      } catch (err) {
        result.errors.push(`Failed to harvest native harness output for ${options.assignmentId}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }
    if (!fileExists && !nativeObservation) continue;

    let lane: LaneResult;
    if (fileExists) {
      try {
        lane = LaneResultSchema.parse(JSON.parse(fs.readFileSync(file, 'utf-8')));
      } catch (err) {
        result.errors.push(`Failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    } else {
      lane = nativeObservation!.lane;
    }

    // Assignment filter (when harvesting a specific lane).
    if (options.assignmentId && lane.assignment_id !== options.assignmentId) continue;
    let ideationLoop: ReturnType<typeof closeIdeationLoopFromLaneResult> = undefined;

    // pln#628 Focus 4B (Codex review of #87 BLOCKING 1) — a review lane must
    // close/advance its loop on the plain report-only harvest path too, not only
    // on `--integrate`. closeReviewLoopFromLaneResult is convergent + idempotent
    // (a terminal loop is a no-op; a stuck approve is resumed), so firing it here
    // AND in integrateLaneResults is safe — and it runs BEFORE the harvested
    // marker short-circuits below, so a re-harvest still resumes a stuck loop.
    // PR2: cycleOnRequestChanges=false — the report path only closes on approve;
    // it must NOT advance a request_changes cycle it cannot follow through on
    // (no re-dispatch, no claim retention). `harvest --integrate` owns the cycle.
    // Hoisted for the catch below (PR #171 review P2-2): if turn-owned evidence was
    // found before a throw, the swallowed failure must still surface as a warning.
    let turnEvidenceForCatch: TurnOwnedLaneEvidence | undefined;
    try {
      const laneAssignment = loadAssignment(lane.assignment_id, cwd);
      if (laneAssignment) {
        // pln#644 (supersedes the pln#630 PR3a report-path deferral) — a TURN-OWNED review lane
        // used to be skipped ENTIRELY here (finalization deferred to `--integrate`) with no
        // signal at all: the operator ran `brainclaw harvest <asgn>`, read "1 harvested", and
        // the loop turn silently stayed open. That stalled two live loops on 2026-08-02/03
        // (lop_626271ee10ad09d8, lop_4d869568bd99ddc0), both converged by hand. The report
        // path now converges what it safely CAN and says what it can't:
        //   - APPROVE → reconcileTurn right here — the same exactly-once idempotent finalizer
        //     `--integrate` uses (mirrors the pln#638 1c ideation closer firing on this path).
        //     Read-strict is NOT weakened: evidence still comes from the lane keys or the
        //     wrapper sentinel, and a mismatch still refuses (loudly, below).
        //   - REQUEST_CHANGES / no verdict / refused evidence → the loop is left alone (the
        //     report path still cannot follow through on a fix cycle: no re-dispatch, no
        //     commit-on-behalf — `--integrate` owns that) but a `review_turn_not_converged`
        //     WARNING now names the open turn and the recovery. Never a silent stall.
        // Kill-switch (=0), a legacy lane (no reservation), OR a reservation WITHOUT evidence
        // (review Finding 1: an inbox_only/non-ack-wrapped dispatch that never wrote a
        // sentinel) → the lane takes the unchanged legacy close so it still converges.
        // P0C: the same evidence gate now serves every LoopKind. Review keeps
        // its report-only request_changes deferral because that path cannot
        // re-dispatch a fix cycle; other kinds can safely record their result.
        const candidateEvidence = turnOwnedLaneEvidence(lane, cwd);
        // Set before reading the loop: a corrupt loop store may throw below,
        // and the catch must still know this was a turn-owned lane to warn.
        turnEvidenceForCatch = candidateEvidence;
        const candidateLoop = candidateEvidence ? getLoop(candidateEvidence.reservation.loop_id, cwd) : undefined;
        const laneTurnEvidence = candidateEvidence && candidateLoop && turnOwnedLoopEnabled(candidateLoop.kind)
          ? candidateEvidence
          : undefined;
        turnEvidenceForCatch = laneTurnEvidence ?? candidateEvidence;
        const ownedLoop = laneTurnEvidence ? candidateLoop : undefined;
        const ownedPhasePolicy = ownedLoop
          ? phasePolicy(ownedLoop.kind, laneTurnEvidence!.reservation.phase)
          : undefined;
        if (!laneTurnEvidence) {
          closeReviewLoopFromLaneResult(laneAssignment, lane, agent, cwd, { cycleOnRequestChanges: false });
        } else if (ownedPhasePolicy?.finalization === 'integrate') {
          result.warnings.push(toWarningDetail({
            code: 'loop_turn_not_converged',
            message: `Turn-owned ${ownedLoop?.kind ?? 'loop'} lane ${lane.assignment_id} requires harvest --integrate before convergence; claim retained.`,
            data: {
              assignment_id: lane.assignment_id,
              loop_id: laneTurnEvidence.reservation.loop_id,
              turn_id: laneTurnEvidence.reservation.turn_id,
              phase: laneTurnEvidence.reservation.phase,
            },
          }));
        } else if (ownedLoop?.kind !== 'review') {
          const rr = reconcileTurnOwnedLane(lane, cwd, laneTurnEvidence);
          if (
            ownedLoop?.kind === 'ideation'
            && laneTurnEvidence.reservation.phase === 'critique'
            && (lane.artifact_type !== 'critique' || !(lane.body ?? '').trim())
          ) {
            result.warnings.push(toWarningDetail({
              code: 'loop_turn_not_converged',
              message: `Ideation critique lane ${lane.assignment_id} did not provide artifact_type='critique' with a non-empty body; no critique artifact was accepted.`,
              data: { assignment_id: lane.assignment_id, loop_id: laneTurnEvidence.reservation.loop_id, turn_id: laneTurnEvidence.reservation.turn_id },
            }));
          }
          if (rr && !rr.result.reconciled && !/superseded/.test(rr.result.reason ?? '')) {
            result.warnings.push(toWarningDetail({
              code: 'loop_turn_not_converged',
              message: `Turn-owned ${ownedLoop?.kind ?? 'loop'} lane ${lane.assignment_id} did not converge: ${rr.result.reason}.`,
              data: { assignment_id: lane.assignment_id, loop_id: laneTurnEvidence.reservation.loop_id, turn_id: laneTurnEvidence.reservation.turn_id },
            }));
          }
          if (ownedLoop?.kind === 'ideation' && rr) {
            ideationLoop = {
              loop_id: laneTurnEvidence.reservation.loop_id,
              action: rr.result.auto_closed ? 'closed' : rr.result.reconciled ? 'advanced' : 'noop',
              reason: rr.result.reason,
              loop_status: rr.result.loop_status,
            };
          }
        } else if (lane.review_verdict === 'approve') {
          const rr = reconcileTurnOwnedLane(lane, cwd, laneTurnEvidence);
          // Reason-based quietness (PR #171 review P2-1 refinement): a terminal loop
          // returns reconciled:true (idempotent no-op) and a superseded turn is the one
          // healthy decline (`harvest --all` over a prior round's lane) — everything
          // else (refused evidence, deferred lock, loop/slot not found, contradiction,
          // paused complete_turn refusal) is a live approve that did NOT land and must
          // say so. No getLoop re-read here: the decline reason already discriminates,
          // and the loop store itself may be the failing component.
          if (rr && !rr.result.reconciled && !/superseded/.test(rr.result.reason ?? '')) {
            result.warnings.push(reviewTurnNotConvergedWarning(
              lane, laneTurnEvidence.reservation, `reconcileTurn refused: ${rr.result.reason ?? 'no reason given'}`,
            ));
          }
        } else if (loopTurnAwaitsConvergence(laneTurnEvidence.reservation, cwd)) {
          const why = lane.review_verdict === 'request_changes'
            ? 'a request_changes fix cycle needs re-dispatch + commit-on-behalf, which the report path does not do'
            : 'the lane carries no review_verdict, so nothing proves the reviewer reached a verdict';
          result.warnings.push(reviewTurnNotConvergedWarning(lane, laneTurnEvidence.reservation, why));
        }
        // pln#521 P2-bis — the ideation analog: a critic lane records its critique +
        // advances the ideation loop. Returns undefined for non-ideate scopes (no-op here).
        if (!laneTurnEvidence) {
          ideationLoop = closeIdeationLoopFromLaneResult(laneAssignment, lane, agent, cwd);
        }

        // pln#636 C2 (review F3) — the universal net's most important trigger.
        // A file-fallback worker declares its own footprint in `files_changed`,
        // which is BOTH cheaper and more reliable than a git diff here: by
        // harvest time the lane's worktree may already have been reaped, so
        // trusting the worker's declaration is the only thing that still works.
        if (laneAssignment.claim_id && lane.files_changed?.length) {
          const laneClaim = loadClaim(laneAssignment.claim_id, cwd);
          if (laneClaim) {
            const conformity = reconcileClaimConformity(laneClaim, cwd, {
              touchedPaths: lane.files_changed,
            });
            if (conformity.warning) {
              result.warnings.push(toWarningDetail(conformity.warning));
            }
          }
        }
      }
    } catch (err) {
      // Never block harvest on loop-close — but a swallowed failure must not be
      // SILENT for a turn-owned lane (PR #171 review P2-2): before this warning,
      // an unexpected reconcile/store error left the operator with "1 harvested,
      // 0 error(s)" and an open loop turn — the exact stall pln#644 exists to
      // kill. Deliberately no liveness/superseded re-check here: that would
      // re-read the loop store, which may be the very component that just threw
      // (getLoop propagates parse errors). A rare over-warning on a broken store
      // beats a silent stall on a live turn.
      if (turnEvidenceForCatch) {
        try {
          result.warnings.push(reviewTurnNotConvergedWarning(
            lane, turnEvidenceForCatch.reservation,
            `loop-close failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
          ));
        } catch { /* truly never block harvest */ }
      }
    }

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
            body: lane.body ?? null,
            artifact_type: lane.artifact_type ?? null,
            ideation_loop: ideationLoop ?? null,
            files_changed: lane.files_changed ?? [],
            source_worktree: worktreePath,
            harness_stdout_log: nativeObservation?.stdout_log ?? null,
            harness_stderr_log: nativeObservation?.stderr_log ?? null,
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
// LEVER #1 from a cross-project field session. The worker's contract is
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
  /** pln#628 Focus 4B — set when this lane closed/advanced a review loop. */
  review_loop?: ReviewLoopCloseResult;
  /** pln#638 — set when this lane recorded/reconciled a critic artifact. */
  ideation_loop?: Exclude<ReturnType<typeof closeIdeationLoopFromLaneResult>, undefined>;
}

export interface LaneIntegrateResult {
  integrated: LaneIntegrateEntry[];
  /** assignment_ids skipped (no assignment record, or unmapped). */
  skipped: string[];
  errors: string[];
  /**
   * PR2 (pln#628 Focus 4B) — review-loop fix-cycle turns to re-dispatch. Emitted
   * (not spawned) by the sync integrate pass so the async caller (runHarvestLane)
   * can await the actual spawn. Each entry keeps the loop's claim/worktree alive
   * for the same reviewer to apply fixes + re-review.
   */
  next_turns: Array<ReviewLoopNextTurn & { loop_id: string }>;
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
  const result: LaneIntegrateResult = { integrated: [], skipped: [], errors: [], next_turns: [] };

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

        // pln#628 Focus 4B — map this lane onto its review loop BEFORE deciding
        // teardown: PR1 records the verdict + advances (auto-close on approve);
        // PR2 continues the fix cycle on request_changes (bump round, emit a
        // next_turn) unless the iteration cap is hit. This is the --integrate
        // path, so it MAY cycle (it can re-dispatch AND retain the claim). No-op
        // for non-review lanes / lanes without a verdict; never throws.
        // Legacy ideation lanes still use the historical closer. A turn-owned
        // lane of any kind is finalized exactly once by reconcileTurn below.
        const candidateEvidence = turnOwnedLaneEvidence(lane, cwd);
        const ownedLoop = candidateEvidence ? getLoop(candidateEvidence.reservation.loop_id, cwd) : undefined;
        const turnOwnedEvidence = candidateEvidence && ownedLoop && turnOwnedLoopEnabled(ownedLoop.kind)
          ? candidateEvidence
          : undefined;
        if (!turnOwnedEvidence) {
          const ideationClose = closeIdeationLoopFromLaneResult(assignment, lane, actor, cwd);
          if (ideationClose) {
            reasons.push(`ideate-loop ${ideationClose.loop_id}: ${ideationClose.action} — ${ideationClose.reason}`);
            entry.ideation_loop = ideationClose;
          }
        }

        // pln#630 PR3a — a TURN-OWNED review lane finalizes via the exactly-once
        // reconcileTurn, which REPLACES the legacy closer + teardown gate for this lane
        // (exactly-one finalizer per lane). Kill-switch (=0), a legacy (non-reserved) lane, OR a
        // reservation with NO turn-keyed evidence (review Finding 1) → `turnOwned` is undefined
        // and the unchanged legacy `else` block runs so the loop still converges.
        const turnOwned = turnOwnedEvidence
          ? reconcileTurnOwnedLane(lane, cwd, turnOwnedEvidence)
          : undefined;
        if (turnOwned) {
          const { reservation, result: rr } = turnOwned;
          if (ownedLoop?.kind === 'review') {
            entry.review_loop = reconcileToReviewLoopResult(reservation, rr, lane);
            reasons.push(`turn-owned reconcile ${reservation.loop_id}: ${entry.review_loop.action} — ${rr.reason}${rr.conflict ? ' [CONFLICT — held]' : ''}`);
          } else {
            const action = rr.auto_closed ? 'closed' : rr.reconciled ? 'advanced' : 'noop';
            reasons.push(`turn-owned ${ownedLoop?.kind ?? 'loop'} reconcile ${reservation.loop_id}: ${action} — ${rr.reason}${rr.conflict ? ' [CONFLICT — held]' : ''}`);
            if (ownedLoop?.kind === 'ideation') {
              entry.ideation_loop = {
                loop_id: reservation.loop_id,
                action,
                reason: rr.reason,
                loop_status: rr.loop_status,
              };
            }
          }
          // pln#630 PR3b — a symmetric request_changes bumped the round + retained the claim
          // and handed back the next fix-cycle turn. Push it exactly like the legacy path so
          // the existing async re-dispatch loop spawns round N+1 into the reused worktree. The
          // fresh iteration means deriveTurnId mints a new turn_id → the launch fence admits
          // exactly one spawn (a stale re-emit of the same turn_id is denied).
          if (rr.next_turn) {
            result.next_turns.push({ loop_id: reservation.loop_id, ...rr.next_turn });
          }
          // Claim/run/assignment settling is OWNED by reconcileTurn, so we do NOT run the
          // legacy teardown gate — just reflect the resulting claim state. Settlement
          // semantics (reconcile-turn.ts, review #1): an ACCEPTED lane — approve OR
          // request_changes, both settle the slot 'done' — completes the assignment AND
          // releases the claim; only a REJECTED/superseded lane (evidence mismatch/absent,
          // §13 R4 conflict) leaves the claim intact for a retry. No next_turns push: the
          // request_changes fix-cycle re-dispatch — AND re-establishing the claim/worktree
          // that the release above implies — is pln#630 PR3b (deferred; the loop stays open
          // awaiting its next turn, so nothing is corrupted, only not-yet-autonomous).
          try { entry.claim_released = loadClaim(assignment.claim_id, cwd)?.status === 'released'; }
          catch { entry.claim_released = false; }
          // A turn-owned lane that reached here HAS turn-keyed evidence (turnOwnedLaneEvidence
          // gated on a present nonce — the missing-sentinel/non-spawn case already fell back to
          // legacy, review Finding 1). So a non-convergence here means the evidence MISMATCHED
          // the live attempt (stale/superseded generation) — which must NOT fall back to legacy
          // (that would converge on evidence for a DIFFERENT generation). Emit an observable
          // event so an operator/doctor sees the (correctly) withheld convergence. (An R4
          // conflict already journals its own event, so it is excluded here.)
          if (!rr.reconciled && !rr.conflict && lane.review_verdict) {
            try {
              createRuntimeEvent({
                agent: actor,
                event_type: 'run_blocked',
                text: `harvest: turn-owned review lane ${lane.assignment_id} carried verdict '${lane.review_verdict}' but reconcile did not converge (${rr.reason}); loop ${reservation.loop_id} left OPEN — needs the completion sentinel or a manual turn`,
                tags: ['harvest', 'reconcile', 'turn-owned', 'unconverged'],
                assignment_id: lane.assignment_id,
                run_id: reservation.child_ids.run_id,
                status_reason: 'turn_owned_evidence_unaccepted',
              }, cwd);
            } catch { /* observability best-effort */ }
          }
        } else {
          const loopClose = closeReviewLoopFromLaneResult(assignment, lane, actor, cwd);
          if (loopClose) {
            entry.review_loop = loopClose;
            reasons.push(`review-loop ${loopClose.loop_id}: ${loopClose.action} — ${loopClose.reason}`);
            if (loopClose.next_turn) {
              result.next_turns.push({ loop_id: loopClose.loop_id, ...loopClose.next_turn });
            }
          }

          // PR2 claim-teardown gate. Skip the release when either:
          //  (a) keep_claim — the symmetric fix cycle reuses the claim/worktree for
          //      the re-dispatched turn (commits accumulate on one branch); or
          //  (b) Codex review P0 — an idempotent re-harvest of an OLD lane whose
          //      loop is still OPEN returns a `noop` (the reviewer slot is now bound
          //      to a NEWER assignment under an active cycle). Releasing here would
          //      tear down the reused claim/worktree out from under the live turn
          //      and strand the fix cycle. The loop machinery owns the lifecycle
          //      while it is open; only a terminal close (approve/blocked, action
          //      'closed') or an asymmetric hand-off ('advanced' without keep_claim)
          //      releases here. A `noop` on a TERMINAL loop still releases (safe —
          //      the closing pass already released, so this is a no-op).
          const loopStillOpen =
            loopClose?.loop_status !== undefined &&
            !['completed', 'cancelled', 'blocked'].includes(loopClose.loop_status);
          const keepClaimAlive =
            loopClose?.keep_claim === true || (loopClose?.action === 'noop' && loopStillOpen);
          if (keepClaimAlive) {
            // The next_turn spawn (async) is awaited by runHarvestLane. The
            // assignment for THIS turn is still completed above.
            entry.claim_released = false;
            reasons.push(
              loopClose?.keep_claim
                ? 'claim kept alive for review fix-cycle re-dispatch (PR2)'
                : 'claim left intact — idempotent re-harvest on an active review loop (no strand)',
            );
          } else {
            // trp#928 — use the cascade helper (was releaseClaimWithCascade — same
            // logic for the last-claim rule but the cascade wrapper LOGS per-claim,
            // so a silent ownership failure is observable in the runtime event log
            // rather than only in this in-memory `reasons` string).
            const cascade = releaseClaimsCascade([assignment.claim_id], { cwd, planStatus: 'done' });
            logCascadeReleaseResult({ actor, trigger: 'harvest_integrate', assignment_id: lane.assignment_id, claim_id: assignment.claim_id, cascade, cwd });
            const claimEntry = cascade.entries[0];
            entry.claim_released = claimEntry?.released === true;
            if (claimEntry && !claimEntry.released) {
              reasons.push(`claim release ${claimEntry.reason}${claimEntry.error ? `: ${claimEntry.error}` : ''}`);
            }
          }
        }
      } else {
        // blocked / failed: best-effort lifecycle (FSM may reject from offered).
        const target: AssignmentStatus = lane.status === 'blocked' ? 'blocked' : 'failed';
        try {
          transitionAssignment(lane.assignment_id, target, { actor, status_reason: lane.summary.slice(0, 200) }, cwd);
        } catch (err) {
          reasons.push(`assignment ${target} transition rejected: ${err instanceof Error ? err.message : String(err)}`);
        }
        const cascade = releaseClaimsCascade([assignment.claim_id], {
          cwd,
          planStatus: lane.status === 'blocked' ? 'blocked' : undefined,
        });
        logCascadeReleaseResult({ actor, trigger: 'harvest_integrate', assignment_id: lane.assignment_id, claim_id: assignment.claim_id, cascade, cwd });
        const claimEntry = cascade.entries[0];
        entry.claim_released = claimEntry?.released === true;
        if (claimEntry && !claimEntry.released) {
          reasons.push(`claim release ${claimEntry.reason}${claimEntry.error ? `: ${claimEntry.error}` : ''}`);
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
            body: lane.body ?? null,
            artifact_type: lane.artifact_type ?? null,
            ideation_loop: entry.ideation_loop ?? null,
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
      // trp#928 — log per-claim via releaseClaimsCascade instead of the raw
      // releaseClaimWithCascade so an ownership_denied outcome is visible in the
      // runtime event log (previously trapped into report.errors only, which
      // dies with the CLI invocation).
      const cascade = releaseClaimsCascade([assignment.claim_id], { cwd, planStatus: 'done' });
      logCascadeReleaseResult({ actor, trigger: 'harvest_integrate', assignment_id: options.assignmentId, claim_id: assignment.claim_id, cascade, cwd });
      const claimEntry = cascade.entries[0];
      report.claim_released = claimEntry?.released === true;
      if (claimEntry && !claimEntry.released) {
        report.errors.push(`claim release ${claimEntry.reason}${claimEntry.error ? `: ${claimEntry.error}` : ''}`);
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
  /** Coordinator identity used as the dispatcher for PR2 fix-cycle re-dispatch. */
  agent?: string;
}

export async function runHarvestLane(assignmentId: string | undefined, options: RunHarvestLaneOptions = {}): Promise<void> {
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
    // pln#628 Focus 4B PR2 — spawn the review fix-cycle turns the sync integrate
    // pass emitted. Re-dispatches the SAME reviewer into the SAME (kept) worktree
    // to apply the requested changes + re-review. Dry-run only reports them.
    const dispatchedTurns: Array<{ loop_id: string; agent: string; iteration: number; execution_status?: string; error?: string }> = [];
    if (!options.dryRun) {
      for (const nt of integ.next_turns) {
        const dispatched = await dispatchReviewLoopTurn({
          loopId: nt.loop_id,
          slot: { slot_id: nt.slot_id, role: nt.role, agent: nt.agent, agent_id: nt.agent_id },
          phase: nt.phase,
          task: nt.task,
          dispatcherAgent: options.agent ?? 'coordinator',
          cwd,
          // NO worktreeBaseRef: reuse the kept worktree so the fixes accumulate;
          // pinning a ref would reset the branch and wipe prior-round commits.
        });
        dispatchedTurns.push({
          loop_id: nt.loop_id, agent: nt.agent, iteration: nt.iteration,
          execution_status: dispatched.execution_status, error: dispatched.error,
        });
      }
    }
    if (options.json) {
      console.log(JSON.stringify({ ...integ, dispatched_turns: dispatchedTurns }, null, 2));
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
    for (const dt of dispatchedTurns) {
      const status = dt.error ? `error: ${dt.error}` : (dt.execution_status ?? 'unknown');
      console.log(`  ↻ Fix-cycle re-dispatch [${dt.loop_id}] round ${dt.iteration} → ${dt.agent} (${status})`);
    }
    if (options.dryRun && integ.next_turns.length > 0) {
      console.log(`  (dry-run) ${integ.next_turns.length} fix-cycle turn(s) would be re-dispatched.`);
    }
    console.log(`\n✔ Lane integrate complete${dry}: ${integ.integrated.length} integrated, ${dispatchedTurns.length} re-dispatched, ${integ.errors.length} error(s).`);
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
      // pln#644 — warnings (review_turn_not_converged, claim conformity) were
      // collected but never emitted on ANY channel; the silent half of the
      // 2026-08-02/03 review-loop stalls.
      warnings: result.warnings,
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
  // pln#644 — warnings must reach the operator's eyes: a turn-owned review lane
  // whose loop turn did not converge used to vanish behind "N harvested".
  for (const w of result.warnings) {
    console.log(`  ⚠ ${w.message}`);
  }
  const warnTag = result.warnings.length > 0 ? `, ${result.warnings.length} warning(s)` : '';
  console.log(`\n✔ Lane harvest complete${dryTag}: ${result.harvested.length} harvested, ${result.skipped.length} skipped, ${result.errors.length} error(s)${warnTag}.`);
}
