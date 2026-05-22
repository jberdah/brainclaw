/**
 * pln#518 step 1 — bootstrap-loop singleton acquire path.
 *
 * Extracts the find-existing + coordination-lock + openLoop sequence from the
 * bclaw_coordinate ideate handler so that both the CLI (`brainclaw
 * bootstrap-loop`) and the MCP facade share the same code path. Previously
 * the CLI used a bare `listLoops` scan without acquiring any lock, allowing
 * two concurrent CLI invocations to both pass the scan and call `openLoop`
 * directly — bypassing the singleton acquire and producing duplicate loops.
 *
 * Algorithm (lock is opportunistic, not blocking):
 *   1. Find an existing bootstrap loop in {open, paused} → join it.
 *   2. Check for an active coordination-lock claim (another caller is
 *      mid-open). Re-find once; join if now visible, else throw
 *      `BootstrapCoordinationInProgressError`.
 *   3. Acquire the lock, call `openLoop`, release the lock (success or fail).
 */
import { generateClaimId, listClaims, releaseClaim, saveClaim } from '../claims.js';
import { nowISO } from '../ids.js';
import { BOOTSTRAP_PRESET } from './presets/bootstrap.js';
import { listLoops, openLoop } from './store.js';
import type { LoopThread } from './types.js';

// ---- public types -----------------------------------------------------------

export interface AcquireBootstrapOptions {
  /** Agent name (CLI: resolveCurrentAgentName(); MCP: senderAgent). */
  actor: string;
  /** Optional agent_id for the claim + slot. */
  agent_id?: string;
  /** Optional model tag written into the coordination-lock claim. */
  model?: string;
}

export interface AcquireBootstrapResult {
  /** 'joined' when an existing loop was found; 'opened' after creating one. */
  action: 'joined' | 'opened';
  loop: LoopThread;
  /** Non-fatal informational messages (e.g. "joined existing …"). */
  warnings: string[];
}

export class BootstrapCoordinationInProgressError extends Error {
  readonly blockingClaimId: string;
  constructor(blockingClaimId: string) {
    super(
      `another coordinator is currently opening a bootstrap loop (claim ${blockingClaimId}); retry shortly.`,
    );
    this.name = 'BootstrapCoordinationInProgressError';
    this.blockingClaimId = blockingClaimId;
  }
}

// ---- internal helpers -------------------------------------------------------

/** Returns the first active/paused bootstrap loop, or undefined. */
export function findExistingBootstrapLoop(cwd?: string): LoopThread | undefined {
  const all = listLoops({ kind: 'ideation' }, cwd);
  return all.find(
    (l) => l.protocol?.preset === 'bootstrap' && (l.status === 'open' || l.status === 'paused'),
  );
}

// ---- main export ------------------------------------------------------------

/**
 * Singleton acquire path for the bootstrap loop.
 *
 * Callers must NOT call `openLoop` themselves for bootstrap — this function
 * is the sole entry point. Both the CLI and the MCP bclaw_coordinate ideate
 * handler delegate here.
 *
 * Throws `BootstrapCoordinationInProgressError` when a coordination lock is
 * held by a concurrent caller and no loop has materialised yet; callers
 * should surface this to the operator with a "retry shortly" message.
 *
 * All other errors (e.g. from `openLoop`) propagate as-is.
 */
export function acquireBootstrapLoop(
  opts: AcquireBootstrapOptions,
  cwd?: string,
): AcquireBootstrapResult {
  const warnings: string[] = [];

  // Step 1 — find an already-open loop.
  const existing = findExistingBootstrapLoop(cwd);
  if (existing) {
    warnings.push(
      `bootstrap loop already open on this project (${existing.id}, phase=${existing.current_phase}, status=${existing.status}); joined existing instead of opening a duplicate.`,
    );
    return { action: 'joined', loop: existing, warnings };
  }

  // Step 2 — check for an active coordination-lock held by a concurrent caller.
  const lockScope = `bootstrap-coordination-lock:${cwd ?? process.cwd()}`;
  const heldLocks = listClaims(cwd).filter(
    (c) => c.status === 'active' && c.scope === lockScope,
  );
  if (heldLocks.length > 0) {
    // Re-check once: the holder may have just finished opening the loop.
    const reFound = findExistingBootstrapLoop(cwd);
    if (reFound) {
      warnings.push(`bootstrap loop opened by a parallel coordinator (${reFound.id}); joined existing.`);
      return { action: 'joined', loop: reFound, warnings };
    }
    throw new BootstrapCoordinationInProgressError(heldLocks[0].id);
  }

  // Step 3 — acquire the lock, open the loop, release the lock.
  const lockClaimId = generateClaimId();
  saveClaim(
    {
      id: lockClaimId,
      agent: opts.actor,
      agent_id: opts.agent_id,
      user: process.env.USER || process.env.USERNAME || undefined,
      scope: lockScope,
      description: `bootstrap coordination lock (open by ${opts.actor})`,
      created_at: nowISO(),
      status: 'active',
      model: opts.model,
    },
    cwd,
  );

  try {
    const loop = openLoop(
      {
        kind: 'ideation',
        title: 'Bootstrap PROJECT.md',
        created_by: opts.actor,
        slots: [{ role: 'champion', agent: opts.actor }],
        phases: BOOTSTRAP_PRESET.phases,
        stop_condition: BOOTSTRAP_PRESET.stop_condition,
        protocol: BOOTSTRAP_PRESET.protocol,
      },
      cwd,
    );
    return { action: 'opened', loop, warnings };
  } finally {
    try {
      releaseClaim(lockClaimId, cwd);
    } catch {
      /* best-effort */
    }
  }
}
