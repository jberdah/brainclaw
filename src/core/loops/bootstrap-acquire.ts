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
 *   2. Atomically acquire the coordination-lock claim. If another caller won,
 *      re-find once; join if now visible, else throw
 *      `BootstrapCoordinationInProgressError`.
 *   3. Call `openLoop`, release the lock (success or fail).
 */
import { acquireClaimScope, releaseClaim } from '../claims.js';
import { BOOTSTRAP_PRESET } from './presets/bootstrap.js';
import { listLoops, openLoop } from './store.js';
import type { LoopThread } from './types.js';

// ---- public types -----------------------------------------------------------

export interface AcquireBootstrapOptions {
  /** Agent name (CLI: resolveCurrentAgentName(); MCP: senderAgent). */
  actor: string;
  /** Optional agent_id for the claim + slot. */
  agent_id?: string;
  /** Optional actor id/name to preserve the caller's existing openLoop creator. */
  created_by?: string;
  /** Optional loop title; CLI callers use the bootstrap default. */
  title?: string;
  /** Optional loop goal/scope; MCP callers pass the coordinate scope. */
  goal?: string;
  /** Optional session_id written into the coordination-lock claim. */
  session_id?: string;
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

  // Step 2 — atomically acquire the coordination-lock claim.
  const lockScope = `bootstrap-coordination-lock:${cwd ?? process.cwd()}`;
  const acquireResult = acquireClaimScope({
    scope: lockScope,
    agent: opts.actor,
    agent_id: opts.agent_id,
    description: `bootstrap coordination lock (open by ${opts.actor})`,
    user: process.env.USER || process.env.USERNAME || undefined,
    session_id: opts.session_id,
    model: opts.model,
  }, cwd);

  if (!acquireResult.acquired) {
    // Lost race — re-check once: the holder may have just finished opening the loop.
    const reFound = findExistingBootstrapLoop(cwd);
    if (reFound) {
      warnings.push(`bootstrap loop opened by a parallel coordinator (${reFound.id}); joined existing.`);
      return { action: 'joined', loop: reFound, warnings };
    }
    throw new BootstrapCoordinationInProgressError(acquireResult.conflicting_claim!.id);
  }

  // Step 3 — open the loop, release the lock.
  const lockClaimId = acquireResult.claim!.id;

  try {
    const loop = openLoop(
      {
        kind: 'ideation',
        title: opts.title ?? 'Bootstrap PROJECT.md',
        goal: opts.goal,
        created_by: opts.created_by ?? opts.agent_id ?? opts.actor,
        slots: [
          {
            role: 'champion',
            agent: opts.actor,
            ...(opts.agent_id ? { agent_id: opts.agent_id } : {}),
          },
        ],
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
