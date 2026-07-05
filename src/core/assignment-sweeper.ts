/**
 * Assignment timeout sweeper — detects stuck/expired assignments.
 *
 * Runs opportunistically (no daemon): integrated into dispatch().
 * Future: integrate into session_start() and expose as CLI `brainclaw sweep`.
 *
 * can_948acfd6 (sprint 1.5): the sweep consults IMPLICIT worker evidence
 * before declaring an administrative death. Three live workers were expired
 * by the acceptance-TTL in a single sprint because they could not call
 * bclaw_assignment_update (sandboxed / no MCP) — yet their ack sentinel,
 * heartbeat, filesystem activity and commits were all observable. This is the
 * acceptance-sweep counterpart of the pln#527 no-heartbeat veto.
 *
 * @module
 */
import { spawnSync } from 'node:child_process';
import { listAssignments, transitionAssignment } from './assignments.js';
import { signalExists, readHeartbeat, latestActivityMs } from './runtime-signals.js';
import { DEFAULT_HYGIENE_POLICY, type HygienePolicy } from './hygiene-policy.js';
import type { Assignment } from './schema.js';

// ── Types ────────────────────────────────────────────────────

export interface SweeperResult {
  timed_out: Array<{ assignment_id: string; agent: string; age_ms: number }>;
  expired: Array<{ assignment_id: string; agent: string; age_ms: number }>;
  /** Assignments advanced (offered→accepted / accepted→started) on implicit evidence instead of being expired. */
  implicitly_advanced: Array<{ assignment_id: string; agent: string; to: 'accepted' | 'started'; evidence: string }>;
}

// ── Implicit worker evidence ─────────────────────────────────

interface ImplicitEvidence {
  /** Any life-sign at all (ack counts — proves the spawn shell ran). */
  any: boolean;
  /** Evidence fresh enough to count as current activity (age <= ttl). */
  fresh: boolean;
  description: string;
}

function lastCommitAgeMs(worktreePath: string | undefined, nowMs: number): number | undefined {
  if (!worktreePath) return undefined;
  try {
    const res = spawnSync('git', ['log', '-1', '--format=%ct'], {
      cwd: worktreePath, encoding: 'utf-8', windowsHide: true, timeout: 10_000,
    });
    if (res.status !== 0) return undefined;
    const epochSec = parseInt((res.stdout ?? '').trim(), 10);
    if (!Number.isFinite(epochSec)) return undefined;
    return nowMs - epochSec * 1000;
  } catch {
    return undefined;
  }
}

/**
 * Collect implicit life-signs for an assignment: ack sentinel, heartbeat
 * (project-root OR worktree-local), filesystem activity (logs + worktree),
 * and a post-dispatch commit on the worktree branch.
 *
 * `sinceMs` anchors the commit check (a commit older than the offer is not
 * evidence of THIS assignment's worker). `freshTtlMs` bounds what counts as
 * "currently active" for the accepted/started branches.
 */
function collectImplicitEvidence(
  assignment: Assignment,
  cwd: string | undefined,
  nowMs: number,
  sinceMs: number,
  freshTtlMs: number,
): ImplicitEvidence {
  const root = cwd ?? process.cwd();
  const parts: string[] = [];
  let freshest: number | undefined;
  const bump = (ageMs: number | undefined): void => {
    if (ageMs === undefined) return;
    if (freshest === undefined || ageMs < freshest) freshest = ageMs;
  };

  try {
    if (signalExists(root, assignment.id, 'ack')) parts.push('ack sentinel');
  } catch { /* defensive */ }

  try {
    const hb = readHeartbeat(root, assignment.id, assignment.worktree_path);
    if (hb.exists && hb.mtimeMs !== undefined) {
      const age = nowMs - hb.mtimeMs;
      parts.push(`heartbeat ${Math.round(age / 1000)}s old`);
      bump(age);
    }
  } catch { /* defensive */ }

  try {
    const lastFs = latestActivityMs(root, assignment.id, assignment.worktree_path);
    if (lastFs !== undefined) {
      const age = nowMs - lastFs;
      parts.push(`fs activity ${Math.round(age / 1000)}s old`);
      bump(age);
    }
  } catch { /* defensive */ }

  const commitAge = lastCommitAgeMs(assignment.worktree_path, nowMs);
  if (commitAge !== undefined && nowMs - commitAge >= sinceMs) {
    parts.push(`post-dispatch commit ${Math.round(commitAge / 1000)}s old`);
    bump(commitAge);
  }

  return {
    any: parts.length > 0,
    fresh: freshest !== undefined && freshest <= freshTtlMs,
    description: parts.join(' + ') || 'none',
  };
}

// ── Sweeper ──────────────────────────────────────────────────

/**
 * Scan all active assignments and timeout those past their TTL.
 *
 * - `started` assignments with no heartbeat within `heartbeat_ttl_ms` → `timed_out`
 *   UNLESS file evidence (heartbeat sentinel / fs activity / commit) is fresh.
 * - `accepted` assignments not started within `acceptance_ttl_ms` → `timed_out`
 *   UNLESS fresh evidence ⇒ implicit `started`.
 * - `offered` assignments not accepted within `acceptance_ttl_ms` → `expired`
 *   UNLESS any evidence ⇒ implicit `accepted` (ack/heartbeat/fs/commit are
 *   acceptance, just delivered by a worker that cannot reach MCP).
 *
 * @param cwd - Project root
 * @param options.nowMs - Override current time for testing
 * @param options.actor - Actor name for audit trail (default: 'sweeper')
 */
export function sweepAssignments(
  cwd?: string,
  options?: { nowMs?: number; actor?: string; policy?: HygienePolicy },
): SweeperResult {
  return sweepAssignmentsFromList(listAssignments(cwd), cwd, options);
}

/**
 * Read-path variant: sweep only the assignments the caller ALREADY loaded
 * (typically open_work.active_assignments). No `listAssignments` call, so no
 * additional store scan on the hot bclaw_work path (pln#602 perf guardrail
 * per the pln#578 read-path optimisation). Use `sweepAssignmentsFromList`
 * with a bounded slice when a full pass would violate the budget.
 *
 * @param assignments - pre-loaded assignments to consider (only non-terminal ones matter)
 * @param cwd - project root
 * @param options.nowMs - Override current time for testing
 * @param options.actor - Actor for the audit trail (default: 'sweeper-readpath')
 * @param options.policy - Family-level TTL/policy overrides
 */
export function sweepAssignmentsFromList(
  assignments: Assignment[],
  cwd?: string,
  options?: { nowMs?: number; actor?: string; policy?: HygienePolicy },
): SweeperResult {
  const policy = options?.policy;
  if (policy?.disabled) {
    return { timed_out: [], expired: [], implicitly_advanced: [] };
  }
  const now = options?.nowMs ?? Date.now();
  const actor = options?.actor ?? 'sweeper';
  const result: SweeperResult = { timed_out: [], expired: [], implicitly_advanced: [] };

  for (const assignment of assignments) {
    // pln#602 / Codex PR#48 finding 2: when a hygiene `policy` is supplied
    // (session-start full sweep, bclaw_work read-path), the age comparison,
    // the implicit-evidence freshness window, AND the status_reason MUST use
    // the family TTLs (offered 3d / accepted 1d / started 1d by default), NOT
    // the assignment's embedded heartbeat_ttl_ms/acceptance_ttl_ms (~30/15min).
    // Otherwise a 20-min offered assignment that `doctor --hygiene` does not
    // list as a candidate could still be expired here — the exact incoherence
    // Codex flagged. Without a policy (the dispatcher convergence sweep,
    // dispatcher.ts), fall back to the embedded TTLs so short-window dispatch
    // convergence is unchanged.
    const startedTtl = policy?.assignment_started_ttl_ms ?? assignment.heartbeat_ttl_ms;
    const acceptedTtl = policy?.assignment_accepted_ttl_ms ?? assignment.acceptance_ttl_ms;
    const offeredTtl = policy?.assignment_offered_ttl_ms ?? assignment.acceptance_ttl_ms;

    // Check started assignments for heartbeat timeout
    if (assignment.status === 'started') {
      const lastBeat = assignment.last_heartbeat_at ?? assignment.started_at;
      if (!lastBeat) continue;
      const ageMs = now - new Date(lastBeat).getTime();
      if (ageMs > startedTtl) {
        // can_948acfd6: a worker without MCP cannot bump last_heartbeat_at —
        // its file evidence is the heartbeat. Fresh file activity vetoes the
        // administrative timeout.
        const sinceMs = new Date(assignment.started_at ?? assignment.created_at).getTime();
        const evidence = collectImplicitEvidence(assignment, cwd, now, sinceMs, startedTtl);
        if (evidence.fresh) continue;
        try {
          transitionAssignment(assignment.id, 'timed_out', {
            status_reason: `No heartbeat for ${Math.round(ageMs / 60_000)} minutes (TTL: ${Math.round(startedTtl / 60_000)}min); implicit evidence: ${evidence.description}`,
            actor,
          }, cwd);
          result.timed_out.push({ assignment_id: assignment.id, agent: assignment.agent, age_ms: ageMs });
        } catch { /* skip: transition may fail if status changed concurrently */ }
      }
    }

    // Check accepted assignments that never started (accepted but worker died before starting)
    if (assignment.status === 'accepted') {
      const acceptedAt = assignment.accepted_at ?? assignment.last_heartbeat_at;
      if (!acceptedAt) continue;
      const ageMs = now - new Date(acceptedAt).getTime();
      // Use the accepted-family TTL for accepted→timed_out (agent should start
      // soon after accepting; family default 1d, or embedded acceptance_ttl_ms
      // for the policy-less convergence sweep).
      if (ageMs > acceptedTtl) {
        const sinceMs = new Date(acceptedAt).getTime();
        const evidence = collectImplicitEvidence(assignment, cwd, now, sinceMs, acceptedTtl);
        if (evidence.fresh) {
          // Working without MCP — record the implicit start so the FSM matches reality.
          try {
            transitionAssignment(assignment.id, 'started', {
              status_reason: `Implicit start inferred by sweeper: ${evidence.description}`,
              actor,
            }, cwd);
            result.implicitly_advanced.push({ assignment_id: assignment.id, agent: assignment.agent, to: 'started', evidence: evidence.description });
          } catch { /* skip */ }
          continue;
        }
        try {
          transitionAssignment(assignment.id, 'timed_out', {
            status_reason: `Accepted but not started within ${Math.round(ageMs / 60_000)} minutes; implicit evidence: ${evidence.description}`,
            actor,
          }, cwd);
          result.timed_out.push({ assignment_id: assignment.id, agent: assignment.agent, age_ms: ageMs });
        } catch { /* skip */ }
      }
    }

    // Check offered assignments for acceptance timeout
    if (assignment.status === 'offered') {
      const offeredAt = assignment.offered_at;
      if (!offeredAt) continue;
      const ageMs = now - new Date(offeredAt).getTime();
      if (ageMs > offeredTtl) {
        // can_948acfd6: ANY worker evidence (ack sentinel touched pre-exec,
        // heartbeat written, files edited, commit landed) is an implicit
        // acceptance — the worker just couldn't say so via MCP. Expiring it
        // is the false-administrative-death observed three times in sprint 1.
        const sinceMs = new Date(offeredAt).getTime();
        const evidence = collectImplicitEvidence(assignment, cwd, now, sinceMs, offeredTtl);
        if (evidence.any) {
          try {
            transitionAssignment(assignment.id, 'accepted', {
              status_reason: `Implicit acceptance inferred by sweeper: ${evidence.description}`,
              actor,
            }, cwd);
            result.implicitly_advanced.push({ assignment_id: assignment.id, agent: assignment.agent, to: 'accepted', evidence: evidence.description });
          } catch { /* skip */ }
          continue;
        }
        try {
          transitionAssignment(assignment.id, 'expired', {
            status_reason: `Not accepted within ${Math.round(ageMs / 60_000)} minutes (TTL: ${Math.round(offeredTtl / 60_000)}min); no implicit evidence`,
            actor,
          }, cwd);
          result.expired.push({ assignment_id: assignment.id, agent: assignment.agent, age_ms: ageMs });
        } catch { /* skip */ }
      }
    }
  }

  return result;
}

/**
 * Bounded read-path sweep. Called from `bclaw_work` after buildContext has
 * populated open_work; operates ONLY on the caller's list, capped by the
 * hygiene policy's read_path_sweep_budget so a burst of stale assignments
 * cannot inflate the hot path.
 *
 * Selection prioritises the offered/accepted branches: those are the ones
 * that empirically go stale AFTER a worktree GC without a self-report
 * (fable-audit-2026-07 witnesses asgn_f835612c and the 2026-07-04 morning
 * trio). `started` items keep converging via the reconciler on the same
 * pass elsewhere.
 */
/** Minimal projection the read-path candidate selector needs (matches the
 * fields context.ts surfaces on open_work.active_assignments). */
export interface ReadPathAssignmentProjection {
  id: string;
  status: string;
  last_heartbeat_at?: string;
}

/**
 * Pure candidate selection for the bclaw_work read-path sweep (Codex PR#48
 * finding 3, pln#578 guardrail). Given ONLY the in-memory projections that
 * buildContext already surfaced, return the ids worth a full loadAssignment:
 *   - status must be sweepable (offered/accepted/started) — created/terminal
 *     rows can never transition and are dropped BEFORE any file read, so a
 *     healthy store full of `created` assignments costs zero extra I/O;
 *   - among those, only rows whose surfaced heartbeat is older than the
 *     smallest family TTL (or that carry no heartbeat) are suspicious;
 *   - capped at read_path_sweep_budget.
 * Extracted so the hot-path zero-read guarantee is unit-testable without the
 * MCP handler.
 */
export function selectReadPathSweepCandidates(
  projections: ReadPathAssignmentProjection[],
  policy: HygienePolicy,
  nowMs: number,
): string[] {
  if (policy.disabled) return [];
  const minTtl = Math.min(
    policy.assignment_offered_ttl_ms,
    policy.assignment_accepted_ttl_ms,
    policy.assignment_started_ttl_ms,
  );
  return projections
    .filter((a) => {
      if (a.status !== 'offered' && a.status !== 'accepted' && a.status !== 'started') return false;
      const beat = a.last_heartbeat_at;
      if (!beat) return true;
      return nowMs - new Date(beat).getTime() > minTtl;
    })
    .slice(0, policy.read_path_sweep_budget)
    .map((a) => a.id);
}

export function sweepAssignmentsAtReadPath(
  assignments: Assignment[],
  cwd?: string,
  options?: { nowMs?: number; actor?: string; policy?: HygienePolicy },
): SweeperResult {
  const policy = options?.policy ?? DEFAULT_HYGIENE_POLICY;
  if (policy.disabled) {
    return { timed_out: [], expired: [], implicitly_advanced: [] };
  }
  const budget = policy.read_path_sweep_budget;
  // Prefer offered/accepted (the empirical debris class); the sweep is a no-op
  // for terminal statuses so filtering is a perf hygiene, not correctness.
  const eligible = assignments
    .filter((a) => a.status === 'offered' || a.status === 'accepted' || a.status === 'started')
    .slice(0, budget);
  return sweepAssignmentsFromList(eligible, cwd, {
    ...options,
    actor: options?.actor ?? 'sweeper-readpath',
    policy,
  });
}
