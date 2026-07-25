/**
 * pln#521 P2-bis — assignment/lane → IDEATION-loop convergence (the missing direction).
 *
 * The ideation loop's critics ARE dispatched by bclaw_coordinate(intent='ideate') with
 * targetAgents — claim + assignment + slot-binding + transport-aware brief + spawn (the
 * dispatch half landed in pln#626 Phase 2). But nothing mapped a critic's LANE-RESULT
 * back into a loop transition: the critic reports via LANE-RESULT.json, and no code
 * turned that into a `critique` artifact + complete_turn, so the critique-phase gate
 * (min_artifacts_by_type critique n:3) never satisfied from spawned critics and the loop
 * couldn't advance autonomously — the plan's "dispatched_critics=N announced, zero
 * convergence" symptom.
 *
 * This is the direct ideation mirror of closeReviewLoopFromLaneResult: fire on an
 * `ideate-loop:<lop>` scope + a completed lane, map the critic's summary/notes into ONE
 * `critique` artifact, complete_turn(done), then attempt advance — a blocked n:3 gate is
 * EXPECTED (more critiques still needed), not an error. Convergent + idempotent under
 * withLoopLock. Uses the LEGACY LANE-harvest path (like the review closer), NOT the
 * turn-owned reconcileTurn (which is unwired for everyone today — a later PR); the
 * ideationReducer stays the forward-compatible seam for when turn-owned lands.
 *
 * Purely additive: a new module + two harvest call sites, reusing complete_turn / advance
 * / withLoopLock unchanged. Touches NO review-dispatch code.
 */
import type { Assignment, LaneResult } from './schema.js';
import { getLoop } from './loops/store.js';
import { complete_turn, advance, evaluatePhaseAdvanceGate } from './loops/verbs.js';
import { withLoopLock } from './loops/lock.js';
import { LOOP_ARTIFACT_BODY_MAX_BYTES, type LoopSlot, type LoopThread } from './loops/types.js';

/** ideate-loop:lop_xxx[:slot] → the loop id (dispatch sets `ideate-loop:${loopId}:${slotId}`). */
const IDEATE_LOOP_SCOPE_RE = /^ideate-loop:(lop_[0-9a-z]+)/;
const LOOP_TERMINAL = new Set(['completed', 'cancelled', 'blocked']);

/** Byte-cap a critique body (keep the head) so complete_turn's 4 KiB artifact-body limit
 *  can't reject a long critique. Leaves envelope headroom for the artifact JSON. */
function capCritique(body: string): string {
  const MAX = LOOP_ARTIFACT_BODY_MAX_BYTES - 512;
  if (Buffer.byteLength(body, 'utf8') <= MAX) return body;
  let end = body.length;
  while (end > 0 && Buffer.byteLength(body.slice(0, end), 'utf8') > MAX) end -= 64;
  return `${body.slice(0, Math.max(0, end))}…[truncated]`;
}

export interface IdeationLoopCloseResult {
  loop_id: string;
  action: 'advanced' | 'closed' | 'critique_recorded' | 'failed' | 'noop';
  reason: string;
  loop_status?: string;
}

/**
 * Resolve the critic slot to complete. STRICT by assignment_id (bound since pln#629), so
 * multi-critic loops complete the right slot; never steal a slot bound to a DIFFERENT
 * assignment. Legacy unbound slots fall back to agent / single-active.
 */
function resolveCriticSlot(loop: LoopThread, assignment: Pick<Assignment, 'id' | 'agent'>): LoopSlot | undefined {
  // role === 'critic' is LOAD-BEARING (review F-A): a coordinate-opened ideation loop
  // also has an unbound `champion` slot that lane-harvest never completes; without this
  // filter the single-active fallback below would select the CHAMPION after the critics
  // finish, corrupting the loop. Mirrors resolveReviewerSlot's role filter.
  const active = loop.slots.filter(
    (s) => s.role === 'critic' && s.status !== 'done' && s.status !== 'cancelled' && s.status !== 'failed',
  );
  if (active.length === 0) return undefined;
  if (assignment.id) {
    const bound = active.find((s) => s.assignment_id === assignment.id);
    if (bound) return bound;
    if (active.some((s) => s.assignment_id !== undefined)) return undefined; // bound elsewhere → don't steal
  }
  if (active.length === 1) return active[0];
  const byAgent = assignment.agent ? active.find((s) => s.agent === assignment.agent) : undefined;
  return byAgent ?? active[0];
}

/**
 * Map a harvested critic lane onto its ideation loop and converge it. Fires ONLY on an
 * `ideate-loop:<lop>` scope + a completed lane; otherwise returns undefined and harvest
 * proceeds unchanged. Idempotent (a terminal/absent slot → noop), defensive (any
 * loop-verb / lock error is swallowed into a noop so a convergence failure never breaks
 * harvest — mirrors closeReviewLoopFromLaneResult).
 */
export function closeIdeationLoopFromLaneResult(
  assignment: Pick<Assignment, 'id' | 'scope' | 'agent'>,
  lane: Pick<LaneResult, 'status' | 'summary' | 'notes'>,
  actor: string,
  cwd?: string,
): IdeationLoopCloseResult | undefined {
  const m = assignment.scope?.match(IDEATE_LOOP_SCOPE_RE);
  if (!m) return undefined;
  if (lane.status !== 'completed') return undefined; // only a completed critic converges
  const loopId = m[1]!;
  const noop = (reason: string, loop_status?: string): IdeationLoopCloseResult => ({
    loop_id: loopId, action: 'noop', reason, loop_status,
  });

  try {
    return withLoopLock<IdeationLoopCloseResult>({
      cwd, intent: 'ideate-harvest-close', agentId: actor, scope: { kind: 'loop', loopId },
      work: () => {
        const loop = getLoop(loopId, cwd);
        if (!loop) return noop('loop not found');
        if (LOOP_TERMINAL.has(loop.status)) return noop(`loop already ${loop.status}`, loop.status);
        // Advance, treating ONLY phase_advance_blocked as the expected gate-not-met case;
        // re-throw any OTHER advance error to the outer catch so a real failure becomes a
        // noop carrying the actual message, NEVER a misreported success (review F-C).
        const tryAdvance = (recorded: boolean): IdeationLoopCloseResult => {
          try {
            const advanced = advance({ id: loopId, actor }, cwd);
            return {
              loop_id: loopId,
              action: advanced.auto_closed ? 'closed' : 'advanced',
              reason: `critique gate met → phase "${advanced.loop.current_phase}"`,
              loop_status: advanced.loop.status,
            };
          } catch (err) {
            if (err instanceof Error && /phase_advance_blocked/.test(err.message)) {
              return recorded
                ? { loop_id: loopId, action: 'critique_recorded', reason: 'critique recorded; gate not yet met (more critics needed)', loop_status: getLoop(loopId, cwd)?.status }
                : noop('no active critic slot; critique gate not yet met (idempotent)', getLoop(loopId, cwd)?.status);
            }
            throw err; // a REAL advance error → outer catch → noop with the message
          }
        };

        const slot = resolveCriticSlot(loop, assignment);
        if (!slot) {
          // No active critic slot: either already processed, OR a prior pass recorded the
          // critique(s) and crashed BEFORE advancing → the loop is stuck at a satisfied
          // critique gate. RESUME only in that precise case (review F-B) — the current
          // phase's gate must be a critique gate that now evaluates MET — so we never
          // over-advance a loop that already moved on to revision/synthesis.
          const gate = loop.phases.find((p) => p.name === loop.current_phase)?.advance_gate;
          const stuckAtCritiqueGate =
            gate?.kind === 'min_artifacts_by_type' && gate.type === 'critique' && evaluatePhaseAdvanceGate(loop, gate).advance;
          return stuckAtCritiqueGate ? tryAdvance(false) : noop('no active critic slot; nothing to resume', loop.status);
        }

        // A critic's LANE-RESULT carries free-form summary/notes (no structured
        // critiques[] field) → ONE critique artifact. A bare lane with no critique
        // content FAILS the slot (mirror ideationReducer: no fake gate progress).
        const critique = [lane.summary, lane.notes]
          .map((s) => (s ?? '').trim())
          .filter(Boolean)
          .join('\n\n')
          .trim();
        if (!critique) {
          complete_turn(
            { id: loopId, slot_id: slot.slot_id, actor, outcome: 'failed', failure_reason: 'critic lane produced no critique content (bare summary)' },
            cwd,
          );
          return { loop_id: loopId, action: 'failed', reason: 'bare critic lane → slot failed; critique gate unchanged', loop_status: getLoop(loopId, cwd)?.status };
        }
        complete_turn(
          { id: loopId, slot_id: slot.slot_id, actor, outcome: 'done', artifact: { phase: loop.current_phase, type: 'critique', body: capCritique(critique) } },
          cwd,
        );
        return tryAdvance(true);
      },
    });
  } catch (err) {
    return noop(`ideation close error (swallowed): ${err instanceof Error ? err.message : String(err)}`);
  }
}
