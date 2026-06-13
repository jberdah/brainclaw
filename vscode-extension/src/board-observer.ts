/**
 * Board observer (pln#560 step 2, slice 2 — wiring core).
 *
 * Owns one project's in-memory journal {@link Projection} and its seq cursor,
 * and exposes the journal-derived board/counts to the tree provider. This is
 * the orchestration seam between the pure slice-1/early-slice-2 modules
 * (`journal-consumer`, `board-projection`) and the VS Code glue in
 * `board-tree.ts`.
 *
 * It is deliberately thin and dependency-injected so the orchestration logic
 * unit-tests without vscode: the cursor lives behind a {@link CursorMemento}
 * (VS Code's `workspaceState` in production, a plain object in tests) and the
 * journal is read from a directory path (a tmp dir in tests, exactly like the
 * slice-1 consumer tests).
 *
 * COVERAGE CONTRACT (see board-projection.ts module header + trp_2a89ae97):
 * only plan/constraint/decision/trap/handoff reach the journal with a payload
 * today, so the journal-derived counts are reliable ONLY for `plans`. The
 * attention badge and the claims/actions/assignments/runs counts must come
 * from a single lock-free `board_summary` MCP seed until the writer journals
 * those families. {@link mergeCounts} encodes exactly that split, so the
 * caller can hand it (journalCounts, seed) and get the value the status bar /
 * activity-bar badge should display without re-deriving the rule.
 *
 * @module
 */
import { applyTail, cursorKey, type Projection, type ObserverCursor } from './journal-consumer.js';
import { projectBoard, projectCounts, type ProjectedBoard, type ProjectedCounts } from './board-projection.js';

/**
 * The slice of VS Code's `ExtensionContext.workspaceState` (a `Memento`) the
 * observer needs. Declared locally so this module never imports `vscode` and
 * stays unit-testable (observer-protocol §3: the cursor is client-private
 * storage, keyed by project_id).
 */
export interface CursorMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | void;
}

/**
 * The degraded-family counts the journal cannot supply today — sourced from a
 * lock-free `board_summary` MCP read (mcp-read-handlers attention composite).
 * Field names mirror board-tree's `BoardSummaryCounts`.
 */
export interface SeedCounts {
  claims: number;
  assignments: number;
  runs: number;
  actions: number;
  agents: number;
  sessions: number;
  failedRuns?: number;
}

/** The merged counts the surface displays. Mirrors `BoardSummaryCounts`. */
export interface MergedCounts {
  plans: number;
  claims: number;
  assignments: number;
  runs: number;
  actions: number;
  agents: number;
  sessions: number;
  failedRuns: number;
}

/**
 * Merge the journal-derived counts with the MCP `board_summary` seed.
 *
 * `plans` is taken from the JOURNAL (live, watch-driven — `plan` is journaled
 * with payloads). Every other family is taken from the SEED, because it is not
 * journaled with a payload today and the journal therefore reports 0
 * (trp_2a89ae97). This split is the whole reason the badge does not regress to
 * 0 in observer mode. When the writer starts journaling a family, flip its
 * line here from `seed` to `journal` — no other code changes.
 */
export function mergeCounts(journal: ProjectedCounts, seed: SeedCounts): MergedCounts {
  return {
    plans: journal.plans,            // journal-driven (reliable today)
    claims: seed.claims,             // envelope-only in journal → seed
    assignments: seed.assignments,   // payload-less in journal → seed
    runs: seed.runs,                 // payload-less in journal → seed
    actions: seed.actions,           // not journaled → seed (the attention badge)
    agents: seed.agents,             // identity registry, never journaled → seed
    sessions: seed.sessions,         // session files, never journaled → seed
    failedRuns: seed.failedRuns ?? 0,
  };
}

/**
 * Per-project journal observer. Holds the projection + cursor; `ingest()`
 * advances both from the journal tail. Pure data in, pure data out — no
 * timers, no MCP, no fs.watch (the caller owns the watch and calls `ingest`
 * on a growth signal, per observer-protocol §4).
 */
export class BoardObserver {
  /** In-memory board projection, grown by successive {@link ingest} calls. */
  readonly projection: Projection = new Map();
  private readonly _cursorKey: string;

  /**
   * @param eventsDir absolute path to `<project>/.brainclaw/events`.
   * @param projectId project_id for the cursor key (observer-protocol §3). A
   *   stable client-private id (the board_summary `project_id`, or the project
   *   path when that is all the caller has).
   * @param memento client-private kv (VS Code `workspaceState`).
   */
  constructor(
    private readonly eventsDir: string,
    projectId: string,
    private readonly memento: CursorMemento,
  ) {
    this._cursorKey = cursorKey(projectId);
  }

  private loadCursor(): ObserverCursor {
    const stored = this.memento.get<ObserverCursor>(this._cursorKey);
    if (stored && Number.isSafeInteger(stored.seq) && stored.seq >= 0) {
      return { seq: stored.seq, checkpoint_seq: stored.checkpoint_seq ?? 0 };
    }
    return { seq: 0, checkpoint_seq: 0 };
  }

  /**
   * Tail the journal from the persisted cursor, applying new records to the
   * projection in place, then persist the advanced cursor. Returns the set of
   * affected item_types so the caller can refresh only those sections
   * (observer-protocol §4/§6). Never throws on a torn/absent journal — the
   * consumer skips bad lines and an absent dir yields zero records.
   */
  ingest(): Set<string> {
    const cursor = this.loadCursor();
    const result = applyTail(this.projection, this.eventsDir, cursor);
    if (result.cursor.seq !== cursor.seq) {
      void this.memento.update(this._cursorKey, result.cursor);
    }
    return result.affectedTypes;
  }

  /** The journal-projected board (plan/trap/handoff populated; see contract). */
  board(): ProjectedBoard {
    return projectBoard(this.projection);
  }

  /** The journal-derived counts (only `plans` reliable today — see {@link mergeCounts}). */
  counts(): ProjectedCounts {
    return projectCounts(this.projection);
  }
}
