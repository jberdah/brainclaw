/**
 * Board adapters (pln#560 step 2, slice 2 — pure modules).
 *
 * Turn the in-memory journal {@link Projection} (from `journal-consumer.ts`)
 * into the two shapes the VS Code tree already consumes:
 *
 *   1. {@link projectBoard}  — a `BoardData`-shaped object of entity arrays,
 *      the journal-driven replacement for the N lazy `bclaw_*` fetches the
 *      tree does on section expand (board-tree.ts `_buildSectionChildren`).
 *   2. {@link projectCounts} — the summary counts, the journal-driven
 *      replacement for `bclaw_context(board_summary)` (board-tree.ts
 *      `_runAgentBoard`).
 *
 * Both are PURE (no vscode, no fs, no MCP) so they unit-test directly like
 * slice 1, and so the slice-2 wiring can drop them behind an OFF-by-default
 * flag. They are also **forward-compatible**: an `item_type` that carries no
 * payload in the journal simply has zero rows in the projection, so its slot
 * comes out empty; when the writer starts journaling it with payloads these
 * adapters light it up with no code change.
 *
 * ── COVERAGE (updated pln#568, phase 1.5) ─────────────────────────────────
 * Originally (verified against a live store 2026-06-13) only FIVE item_types
 * reached the journal with a payload — plan, constraint, decision, trap,
 * handoff (the families src/core/state.ts `planStateDirectories` diffs). The
 * registry / coordination families were envelope-only or absent (trp#559).
 *
 * pln#568 closed that gap on the WRITER side: claim, assignment, agent_run,
 * candidate, sequence, and action_required (journaled under item_type `state`)
 * now emit full entity-state post-images on their persist chokepoint
 * (src/core/events/registry-post-image.ts), and runtime_note for SHARED notes.
 * So these slots now light up for real when this module is fed a journal that
 * carries them — exactly the forward-compatibility this module was built for.
 *
 * CUTOVER (pln#568 slice 3 — wired): the caller (board-tree.ts) now switches
 * `claims`/`assignments`/`runs`/`actions` from the `board_summary` MCP seed to
 * THESE journal-derived counts once the journal carries the `registry_genesis`
 * marker — `BoardObserver.registryAuthoritative()` gates it, and a registry
 * genesis backfill (`brainclaw migrate --enable-journal`) guarantees every
 * pre-existing entity has a post-image first, so the badge cannot undercount
 * (trp#559). Until a store runs the supplement, the seed stays the floor. This
 * module is unchanged either way — it always projected these slots faithfully.
 *
 * @module
 */
import type { Projection } from './journal-consumer.js';

/**
 * The journal-driven subset of board-tree.ts's private `BoardData`. Only the
 * fields the section renderers actually read are populated; agent/session
 * rosters and server-computed hints are NOT journal entities and stay the
 * caller's concern (observer-protocol §6.1, §6.2).
 */
export interface ProjectedBoard {
  active_plans: Record<string, unknown>[];
  active_claims: Record<string, unknown>[];
  active_assignments: Record<string, unknown>[];
  active_runs: Record<string, unknown>[];
  active_actions: Record<string, unknown>[];
  open_handoffs: Record<string, unknown>[];
  runtime_notes: Record<string, unknown>[];
  known_traps: Record<string, unknown>[];
  pending_candidates: Record<string, unknown>[];
  active_sequence?: Record<string, unknown>;
}

/**
 * Mirror of board-tree.ts's `BoardSummaryCounts`. `agents`/`sessions` are not
 * derivable from the journal (identity registry + session files, not entity
 * state) — they default to 0 here and the caller overlays the MCP-seeded
 * values. `actions` is the FULL attention composite (matching the server's
 * `attention_required`, pln#559) — BUT see the module-header coverage note:
 * actions/candidates/claims are not journaled today, so `actions` and `claims`
 * read 0 in pure-journal mode and the caller must overlay them from the MCP
 * seed or the badge undercounts. `plans` is reliable (plan IS journaled).
 */
export interface ProjectedCounts {
  plans: number;
  claims: number;
  assignments: number;
  runs: number;
  actions: number;
  agents: number;
  sessions: number;
  failedRuns: number;
}

/** Composite attention count + its breakdown, mirroring the server. */
export interface AttentionBreakdown {
  total: number;
  pending_actions: number;
  pending_human_candidates: number;
  blocked_assignments: number;
  stale_runs: number;
}

/**
 * `item_type` → the `ProjectedBoard` array slot it feeds. `state` is the
 * journal item_type action_required entities WOULD use (src/core/actions.ts) —
 * though they are not journaled yet (see the module-header coverage note), the
 * mapping is here so the slot lights up automatically when they are.
 * `sequence` is handled separately (it collapses to the single active one).
 * `decision`/`constraint`/`session`/`instruction` have no board array today —
 * they drive SYSTEM counts, not entity rows, exactly as `BoardData` omits them.
 */
const ARRAY_SLOT: Readonly<Record<string, keyof ProjectedBoard>> = {
  plan: 'active_plans',
  claim: 'active_claims',
  assignment: 'active_assignments',
  agent_run: 'active_runs',
  state: 'active_actions',
  handoff: 'open_handoffs',
  runtime_note: 'runtime_notes',
  trap: 'known_traps',
  candidate: 'pending_candidates',
};

function emptyBoard(): ProjectedBoard {
  return {
    active_plans: [], active_claims: [], active_assignments: [], active_runs: [],
    active_actions: [], open_handoffs: [], runtime_notes: [], known_traps: [],
    pending_candidates: [],
  };
}

function statusOf(payload: Record<string, unknown>, fallback: string): string {
  const s = payload['status'];
  return typeof s === 'string' && s ? s : fallback;
}

function asPayload(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Local mirror of src/core/candidates.ts:resolvedSource. `board_summary`
 * excludes only candidates whose resolved source is exactly `auto`, so the
 * projection must use the same inference rather than the tree's broader
 * section filter (`origin` starting with any `session-end` string).
 */
function resolvedCandidateSource(candidate: Record<string, unknown>): 'auto' | 'agent' | 'human' {
  const source = candidate['source'];
  if (source === 'auto' || source === 'agent' || source === 'human') {
    return source;
  }
  const origin = candidate['origin'];
  if (typeof origin !== 'string' || !origin) { return 'human'; }
  if (origin.startsWith('session-end:')) { return 'auto'; }
  if (origin.startsWith('runtime-note:')) { return 'agent'; }
  if (origin.startsWith('mcp:')) { return 'agent'; }
  if (origin.startsWith('cross-project:')) { return 'agent'; }
  return 'agent';
}

/**
 * Project the journal map into a `BoardData`-shaped object. Each entry's full
 * post-image `payload` is placed in its `item_type`'s slot UNFILTERED — the
 * tree's existing `active*` helpers apply the status filters at render time,
 * matching the contract of the full board fetch this replaces (a section that
 * filtered here would double-filter and is harder to reason about).
 *
 * `sequence` collapses to a single `active_sequence`: the one whose status is
 * `active`, else the first seen (board-tree renders only the active sequence).
 */
export function projectBoard(projection: Projection): ProjectedBoard {
  const board = emptyBoard();
  for (const entry of projection.values()) {
    const payload = asPayload(entry.payload);
    if (!payload) { continue; }
    if (entry.item_type === 'sequence') {
      if (!board.active_sequence || statusOf(payload, '') === 'active') {
        board.active_sequence = payload;
      }
      continue;
    }
    const slot = ARRAY_SLOT[entry.item_type];
    if (slot) { (board[slot] as Record<string, unknown>[]).push(payload); }
  }
  return board;
}

/**
 * The attention composite, byte-for-byte the server's definition
 * (src/commands/mcp-read-handlers.ts: pending actions + non-auto pending
 * candidates + blocked assignments + stale runs). Computed from the journal
 * projection so the surface no longer reads it from `board_summary`.
 *
 * Note: today EVERY input to this composite is absent from the journal —
 * actions and candidates are not journaled at all, assignments/runs are
 * envelope-only (see the module-header coverage note). So this returns 0 in
 * pure-journal mode; the caller MUST overlay the composite from the MCP seed
 * until the writer journals those families with payloads. The computation is
 * correct and stays unchanged — it simply has nothing to count yet.
 */
export function attentionRequired(board: ProjectedBoard): AttentionBreakdown {
  const pending_actions = board.active_actions.filter((a) => statusOf(a, 'pending') === 'pending').length;
  const pending_human_candidates = board.pending_candidates.filter(
    (c) => statusOf(c, 'pending') === 'pending' && resolvedCandidateSource(c) !== 'auto',
  ).length;
  const blocked_assignments = board.active_assignments.filter((a) => statusOf(a, 'active') === 'blocked').length;
  const stale_runs = board.active_runs.filter((r) => {
    const s = statusOf(r, 'active');
    return s === 'blocked' || s === 'waiting_input' || s === 'failed';
  }).length;
  return {
    total: pending_actions + pending_human_candidates + blocked_assignments + stale_runs,
    pending_actions, pending_human_candidates, blocked_assignments, stale_runs,
  };
}

/**
 * The summary counts (`board_summary` equivalent). `plans` counts in_progress +
 * todo (matching the server summary, NOT the broader `active` filter);
 * `claims` counts status `active`; `actions` is the attention composite.
 * `agents`/`sessions` are 0 here — not journal entities — and are overlaid by
 * the caller's MCP seed (§6.1). Pass `projectBoard(projection)` or let this
 * build it.
 */
export function projectCounts(projection: Projection): ProjectedCounts {
  const board = projectBoard(projection);
  const attention = attentionRequired(board);
  const planStatus = (p: Record<string, unknown>) => statusOf(p, 'todo');
  return {
    plans: board.active_plans.filter((p) => { const s = planStatus(p); return s === 'in_progress' || s === 'todo'; }).length,
    claims: board.active_claims.filter((c) => statusOf(c, 'active') === 'active').length,
    assignments: board.active_assignments.filter((a) => {
      const s = statusOf(a, 'active');
      return s !== 'completed' && s !== 'expired' && s !== 'rerouted' && s !== 'cancelled';
    }).length,
    runs: board.active_runs.filter((r) => {
      const s = statusOf(r, 'active');
      return s !== 'completed' && s !== 'cancelled';
    }).length,
    actions: attention.total,
    agents: 0,
    sessions: 0,
    failedRuns: attention.stale_runs,
  };
}
