/**
 * Assignment timeout sweeper — detects stuck/expired assignments.
 *
 * Runs opportunistically (no daemon): integrated into dispatch().
 * Future: integrate into session_start() and expose as CLI `brainclaw sweep`.
 *
 * @module
 */
import { listAssignments, transitionAssignment } from './assignments.js';
import type { Assignment } from './schema.js';

// ── Types ────────────────────────────────────────────────────

export interface SweeperResult {
  timed_out: Array<{ assignment_id: string; agent: string; age_ms: number }>;
  expired: Array<{ assignment_id: string; agent: string; age_ms: number }>;
}

// ── Sweeper ──────────────────────────────────────────────────

/**
 * Scan all active assignments and timeout those past their TTL.
 *
 * - `started` assignments with no heartbeat within `heartbeat_ttl_ms` → `timed_out`
 * - `offered` assignments not accepted within `acceptance_ttl_ms` → `expired`
 *
 * @param cwd - Project root
 * @param options.nowMs - Override current time for testing
 * @param options.actor - Actor name for audit trail (default: 'sweeper')
 */
export function sweepAssignments(
  cwd?: string,
  options?: { nowMs?: number; actor?: string },
): SweeperResult {
  const now = options?.nowMs ?? Date.now();
  const actor = options?.actor ?? 'sweeper';
  const result: SweeperResult = { timed_out: [], expired: [] };

  const all = listAssignments(cwd);

  for (const assignment of all) {
    // Check started assignments for heartbeat timeout
    if (assignment.status === 'started') {
      const lastBeat = assignment.last_heartbeat_at ?? assignment.started_at;
      if (!lastBeat) continue;
      const ageMs = now - new Date(lastBeat).getTime();
      if (ageMs > assignment.heartbeat_ttl_ms) {
        try {
          transitionAssignment(assignment.id, 'timed_out', {
            status_reason: `No heartbeat for ${Math.round(ageMs / 60_000)} minutes (TTL: ${Math.round(assignment.heartbeat_ttl_ms / 60_000)}min)`,
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
      // Use acceptance_ttl for accepted→timed_out (same window: agent should start quickly after accepting)
      if (ageMs > assignment.acceptance_ttl_ms) {
        try {
          transitionAssignment(assignment.id, 'timed_out', {
            status_reason: `Accepted but not started within ${Math.round(ageMs / 60_000)} minutes`,
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
      if (ageMs > assignment.acceptance_ttl_ms) {
        try {
          transitionAssignment(assignment.id, 'expired', {
            status_reason: `Not accepted within ${Math.round(ageMs / 60_000)} minutes (TTL: ${Math.round(assignment.acceptance_ttl_ms / 60_000)}min)`,
            actor,
          }, cwd);
          result.expired.push({ assignment_id: assignment.id, agent: assignment.agent, age_ms: ageMs });
        } catch { /* skip */ }
      }
    }
  }

  return result;
}
