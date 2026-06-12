/**
 * Lazy reconciler for orphaned review-loop assignments (pln#563, layer B).
 *
 * A review-loop assignment whose loop already reached a terminal status but
 * which is itself still stuck in `offered`/`accepted`/`started` (the file-based
 * worker never reported terminal; the coordinator couldn't cross-update it —
 * trp#547) is converged on read. This is the house lazy-reconcile-at-read
 * pattern (feedback_lazy_reconcile_pattern / pln#496): no daemon, convergence
 * happens the next time open_work is computed.
 *
 * Layer A (the closeLoop cascade) handles the common path going forward; this
 * backstop cleans the existing backlog and any future close that didn't cascade
 * (e.g. a loop force-closed out of band). Kept in its own module to avoid an
 * import cycle (loops/store → assignments for the cascade; this → both).
 */
import { listAssignments, convergeAssignmentToTerminal } from './assignments.js';
import { getLoop } from './loops/store.js';

/** review-loop:lop_xxx → the loop id. */
const LOOP_SCOPE_RE = /^review-loop:(lop_[0-9a-z]+)/;
const LOOP_TERMINAL = new Set(['completed', 'cancelled', 'blocked']);

/**
 * Converge any review-loop assignment whose loop is terminal. Returns the
 * count converged. Pure best-effort and cheap: it only does a loop lookup for
 * assignments whose scope is a review-loop, and only writes when a stuck one is
 * found (the steady state is zero writes).
 */
export function reconcileOrphanedLoopAssignments(cwd?: string): number {
  let converged = 0;
  for (const a of listAssignments(cwd)) {
    const match = a.scope?.match(LOOP_SCOPE_RE);
    if (!match) continue;
    const loop = getLoop(match[1], cwd);
    if (!loop || !LOOP_TERMINAL.has(loop.status)) continue;
    const terminal = loop.status === 'completed' ? 'completed' : 'cancelled';
    if (convergeAssignmentToTerminal(a.id, terminal, `loop ${match[1]} ${loop.status} (lazy reconcile)`, cwd)) {
      converged += 1;
    }
  }
  return converged;
}
