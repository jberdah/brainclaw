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
 * flag. They are also **forward-compatible across the phase-1.5 cutover**
 * (observer-protocol §6.1): an `item_type` that carries no payload in the
 * journal today (`assignment`/`agent_run`/`claim` in dual mode) simply has
 * zero rows in the projection, so its slot comes out empty — the caller is
 * the one that decides whether to seed those families from a single
 * observer-flagged MCP read. When the writer starts journaling those
 * payloads, these adapters light them up with no code change.
 *
 * @module
 */
import type { Projection } from './journal-consumer.js';
import { isAutoCandidate } from './tree-helpers.js';

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
 * values (observer-protocol §6.1). `actions` is the FULL attention composite,
 * matching the server's `attention_required` so the badge never undercounts
 * the section it represents (pln#559).
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
 * journal item_type for action_required entities (src/core/actions.ts).
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
    if (entry.item_type === 'sequence') {
      const seq = entry.payload;
      if (!board.active_sequence || statusOf(seq, '') === 'active') {
        board.active_sequence = seq;
      }
      continue;
    }
    const slot = ARRAY_SLOT[entry.item_type];
    if (slot) { (board[slot] as Record<string, unknown>[]).push(entry.payload); }
  }
  return board;
}

/**
 * The attention composite, byte-for-byte the server's definition
 * (src/commands/mcp-read-handlers.ts: pending actions + non-auto pending
 * candidates + blocked assignments + stale runs). Computed from the journal
 * projection so the surface no longer reads it from `board_summary`.
 *
 * Note (§6.1): in dual mode `assignment`/`agent_run` rows are absent from the
 * journal, so `blocked_assignments`/`stale_runs` read 0 here — the caller must
 * overlay these from the MCP seed until phase 1.5, or the badge undercounts.
 */
export function attentionRequired(board: ProjectedBoard): AttentionBreakdown {
  const pending_actions = board.active_actions.filter((a) => statusOf(a, 'pending') === 'pending').length;
  const pending_human_candidates = board.pending_candidates.filter(
    (c) => statusOf(c, 'pending') === 'pending' && !isAutoCandidate(c as { source?: string; origin?: string }),
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
    actions: attentionRequired(board).total,
    agents: 0,
    sessions: 0,
    failedRuns: board.active_runs.filter((r) => statusOf(r, 'active') === 'failed').length,
  };
}
