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
 * COVERAGE CONTRACT (updated pln#568 — see board-projection.ts header):
 * the memory families (plan/constraint/decision/trap/handoff) are journal-driven.
 * The registry / coordination families (claims/assignments/runs/actions) are
 * journaled with post-images since pln#568, but the observer trusts the journal
 * for them ONLY once {@link BoardObserver.registryAuthoritative} is set (the
 * `registry_genesis` cutover marker is present); until then they come from the
 * lock-free `board_summary` MCP seed so a partial journal cannot undercount the
 * attention badge (trp#559). {@link mergeCounts} encodes exactly that split, so
 * the caller hands it (journalCounts, seed, journalActive, registryAuthoritative)
 * and gets the value the status bar / activity-bar badge should display.
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
  /** board_summary plan count (in_progress + todo) — the fallback when the
   *  journal is off/absent (observer-protocol §9), see {@link mergeCounts}. */
  plans: number;
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
 * `plans` is taken from the JOURNAL when the journal is active (`journalActive`,
 * the default) — `plan` is journaled with payloads, so the projection is the
 * live source. When the journal is off/absent (observer-protocol §9), the
 * projection is empty and would report 0 plans even though the store has them,
 * so we fall back to the seed's board_summary plan count.
 *
 * The registry / coordination families (claims, assignments, runs, actions)
 * are journaled with full post-images since pln#568, but the observer only
 * trusts the journal for them once `registryAuthoritative` is set — i.e. the
 * journal carries the `registry_genesis` cutover marker, which guarantees EVERY
 * pre-existing registry entity has a post-image. Until then they come from the
 * SEED, so a partially-journaled store cannot undercount the attention badge
 * (the trp#559 regression). `agents`/`sessions` are never journaled (identity
 * registry + session files) → always seed.
 */
export function mergeCounts(
  journal: ProjectedCounts,
  seed: SeedCounts,
  journalActive = true,
  registryAuthoritative = false,
): MergedCounts {
  const registry = journalActive && registryAuthoritative;
  return {
    plans: journalActive ? journal.plans : seed.plans,  // journal-driven, seed fallback when journal off (§9)
    claims: registry ? journal.claims : seed.claims,
    assignments: registry ? journal.assignments : seed.assignments,
    runs: registry ? journal.runs : seed.runs,
    actions: registry ? journal.actions : seed.actions,       // the attention badge
    agents: seed.agents,             // identity registry, never journaled → seed
    sessions: seed.sessions,         // session files, never journaled → seed
    failedRuns: registry ? journal.failedRuns : (seed.failedRuns ?? 0),
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
  private _bootstrapped = false;
  /** Sticky: set once the registry_genesis cutover marker is observed (pln#568
   *  slice 3). Re-derived on every cold start because ingest replays from the
   *  checkpoint floor (0 today), so the marker is always re-seen. */
  private _registryAuthoritative = false;

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
      const checkpointSeq = Number.isSafeInteger(stored.checkpoint_seq)
        && stored.checkpoint_seq >= 0
        && stored.checkpoint_seq <= stored.seq
        ? stored.checkpoint_seq
        : 0;
      return { seq: stored.seq, checkpoint_seq: checkpointSeq };
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
    const storedCursor = this.loadCursor();
    // The seq watermark is valid only together with the in-memory projection it
    // advanced. On a fresh extension process the projection is empty, so replay
    // from the checkpoint floor (0 today; checkpoints are not emitted yet) and
    // then use the persisted seq for warm tails in this process.
    const cursor = this._bootstrapped
      ? storedCursor
      : { seq: storedCursor.checkpoint_seq, checkpoint_seq: storedCursor.checkpoint_seq };
    const result = applyTail(this.projection, this.eventsDir, cursor);
    this._bootstrapped = true;
    if (result.registryGenesisSeen) { this._registryAuthoritative = true; }
    if (result.cursor.seq !== storedCursor.seq || result.cursor.checkpoint_seq !== storedCursor.checkpoint_seq) {
      void this.memento.update(this._cursorKey, result.cursor);
    }
    return result.affectedTypes;
  }

  /** The journal-projected board (plan/trap/handoff populated; see contract). */
  board(): ProjectedBoard {
    return projectBoard(this.projection);
  }

  /** The journal-derived counts (see {@link mergeCounts}). */
  counts(): ProjectedCounts {
    return projectCounts(this.projection);
  }

  /**
   * Whether the journal carries the registry_genesis cutover marker (pln#568
   * slice 3) — i.e. the observer may trust the journal as authoritative for the
   * registry/coordination counts. Pass to {@link mergeCounts}. False until the
   * marker is ingested (a store that ran `brainclaw migrate --enable-journal`).
   */
  registryAuthoritative(): boolean {
    return this._registryAuthoritative;
  }
}
