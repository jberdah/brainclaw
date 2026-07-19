# Observer Protocol — language-agnostic read-only surfaces

Status: spec (pln#560 step 1). Pivot deliverable: it serves the VS Code
extension, the JetBrains plugin, and any future surface identically. Companion
to `event-log-store.md` (the journal this protocol consumes) and the VS Code
vision §5 (the UX it powers).

## 1. The one rule

**An observability surface is a pure consumer of the event journal. It never
acquires a store lock, never writes inside `.brainclaw/`, never runs a polling
timer against the MCP server for display.** It tails the append-only journal,
projects board state in memory, and refreshes the affected section when a new
record arrives. The MCP server is reserved for *actions* (accept / release /
dispatch / transition) through a separate, lazily-created client.

Why this exists (2026-06-10 calibration): the prior extension "read" the board
by calling a path that mutated and git-committed the entire store under the
lock (`autoAcknowledge → persistState`, held >5s), ran the agent-run reconciler
twice per poll with locked writes, created ~120 locked "unverified" event files
per hour per run, and impersonated the parent shell's agent identity —
consuming that agent's cursor. A dashboard is not an agent. This protocol makes
that class of bug unrepresentable: a conforming observer *cannot* write.

## 2. What the observer reads

The journal defined in `event-log-store.md`:

```
.brainclaw/events/
  meta.json                # { next_seq, active_segment, entity_revs } — a cache
  seg-<firstSeq>.jsonl     # immutable once rolled; named by first seq it holds
  seg-<firstSeq>.jsonl     # active = lexicographically-last segment
  checkpoints/             # NOT YET EMITTED by the writer (see §5) — directory
    ckpt-<seq>.json        # may be absent today; self-contained state manifest
```

**Segment naming is normative.** `firstSeq` is encoded as a **decimal,
zero-padded to 8 digits** (e.g. `seg-00018342.jsonl`) so directory-listing
lex-sort matches numeric seq order with no parsing. Implementations MUST emit
and accept exactly this format; any other padding (or none) breaks the
binary-search-by-filename in §5. The 8-digit field overflows at `seq > 1e8`;
at the historical write rate (~17k events to date) this is decades away, but
a journal that crosses the boundary requires a coordinated widen-and-pad
migration in writer + every observer (deferred until needed; flagged here so
no implementer assumes the pad width is incidental).

`meta.json` is advisory only (§4): the observer reads it to cheaply detect
"did anything change" but never trusts its `entity_revs` or `next_seq` for
correctness — those are derived from the journal tail itself.

Record envelope (v2), one JSON object per line:

```jsonc
{ "v": 2, "seq": 18342, "ts": "…", "writer": "w_…", "agent": "claude-code",
  "action": "update", "item_type": "plan", "item_id": "pln_…",
  "entity_rev": 7, "summary": "…", "payload": { /* full post-image */ } }
```

Action → class mapping (the observer needs the class, not a hardcoded verb
list — it is `ACTION_CLASS_BY_ACTION` in `event-log.ts`, and MUST be mirrored
in every implementation or fetched from a shared manifest):

| Class | Effect on the projection |
|---|---|
| `entity-state` (`create`,`update`,`accept`,`reject`,`claim`,`release_claim`,`rollback`,`upgrade`,`backfill`) | upsert `payload` at `(item_type,item_id)` |
| `tombstone` (`delete`) | remove `(item_type,item_id)` |
| `journal-meta` (`checkpoint_ref`,`journal_note`,`seq_repair`,`federation_apply`) | ignore for state; `checkpoint_ref` is a bootstrap hint (§5) |
| `observability` (`session_start`,`session_end`,`assignment_offered`,`assignment_progress`,`run_progress`) | activity feed only — never a state upsert |
| `registry-lifecycle` (`assignment_*`,`run_*`) | upsert when `payload` present (phase 1.5+), else a status/activity signal |

The observer is **forward-compatible**: an unknown `action` whose class it
cannot resolve is applied as `entity-state` iff it carries a `payload` and an
`item_id`, else treated as an activity signal. Never crash on an unknown verb.

## 3. The cursor lives OUTSIDE the store

The observer's read position is a **seq watermark** persisted in *client*
storage, never in `.brainclaw/`:

- VS Code: `ExtensionContext.workspaceState`, key `bclaw.observer.cursor.<project_id>`.
- JetBrains: `PropertiesComponent` / project-scoped state, same key shape.
- Generic: any client-private kv keyed by `project_id`.

Shape: `{ seq: number, checkpoint_seq: number }`. `seq` = highest record seq
applied; `checkpoint_seq` = the checkpoint the in-memory projection was last
seeded from (for fast re-bootstrap). The store's own `.cursors/` directory is
the AGENTS' read position and is **off-limits** to observers — touching it is
the identity-leak bug this protocol forbids.

Rationale: a watermark survives segment rotation, compaction, and archival
(byte offsets do not). It is private to the surface, so N observers never
interfere with each other or with agents.

## 4. Change detection — a file watch, not a poll, not a lock

The observer watches the journal directory for growth and reacts:

1. Watch `.brainclaw/events/` (the active segment's size/mtime, and creation of
   new `seg-*.jsonl`). VS Code: `FileSystemWatcher` on `events/seg-*.jsonl` +
   `meta.json`. JetBrains: `VirtualFileListener` / NIO `WatchService`. Generic
   fallback: stat the active segment on a *long* interval (≥10 s) — this is a
   stat, not an MCP call, and acquires no lock.
2. On a growth signal, **tail forward** from `cursor.seq` (§5) and apply records
   to the in-memory projection.
3. `meta.json` is advisory only; never trust it for correctness — the journal
   tail is the truth (it may be a stale cache mid-write). Use it only to detect
   "did anything change" cheaply.

There is no MCP server process for display. The watcher is OS-level; the read
is a file read. Under the 2026-06-10 load (3 workers + open surface) this yields
zero lock acquisitions by the surface — the validation gate (step 3).

## 5. Bootstrap and tail algorithm

**Status of checkpoint emission (2026-06-12, pln#543 step 4 landed):** the
writer does NOT yet produce `checkpoints/ckpt-*.json` files — checkpoint
emission ships with step 3/5 of pln#543. Until then, the empty-seed + full
tail path below is the **primary** cold-start path in production, not a
degenerate fallback. The checkpoint-first path is the spec the consumer must
implement for forward-compatibility; an observer that hard-requires a
checkpoint at activation is broken against today's store. The perf targets
in §10 assume checkpoint emission; until it ships, "activation → first
summary" is bounded by the full tail length instead (~10 MB of segments in
the typical case, sub-second in practice, but the budget no longer has
slack).

**Cold start (no cursor, or cursor below the oldest live segment):**

1. **If a verified checkpoint exists**, load the newest `ckpt-<S>.json` →
   seed the in-memory projection (full post-image set at head `S`). Set
   `cursor.checkpoint_seq = S`. (Today: this branch is dead until the
   writer ships checkpoint emission.)
2. **Otherwise** (today's primary path), seed from the empty projection
   with `cursor.checkpoint_seq = 0`.
3. Tail every record with `seq > checkpoint_seq` across segments in
   (segment, file-line) order; apply by class (§2). With no checkpoint
   this is a full replay from seq 1, bounded by retention (the
   `events/archive/` floor — segments are park-don't-deleted past the
   second-newest verified checkpoint; with no checkpoint, no segment is
   ever eligible for archive, so "the journal" = "every segment ever
   written" until checkpoint emission ships).
4. Set `cursor.seq` to the last applied seq. Render.

If the cursor's `seq` is **below the oldest non-archived segment's first
seq** (gap — segments archived past the watermark), discard the cursor and
cold-start: notifications degrade, state never does. Today no segment is
ever archived (gc requires a verified checkpoint floor, see §2.3 of the
store spec), so this branch is unreachable in production until checkpoint
emission ships — but the rule is normative regardless: an observer that
crashes on a gap is broken against any future store.

**Warm tail (cursor present, within live segments):**

1. Binary-search the segment whose name (`seg-<firstSeq>`) contains
   `cursor.seq + 1` (filenames sort by first seq).
2. Stream forward from that point across segments; apply by class.
3. A **torn tail** (final line unparseable or missing trailing `\n`) is expected
   crash residue mid-write by an agent — skip it; it reappears complete on the
   next growth signal. Never block on it.
4. A mid-file unparseable line is logged and skipped (do not halt the tail).
5. Advance `cursor.seq` only over records actually applied.

Replay order is always (segment order, then file-line order) — never sorted by
seq (matches the store's own reducer; a dup `seq` from a lock-steal applies
later-line-wins, harmlessly, in a read-only projection).

## 6. Board projection — which records touch which section

The in-memory projection is `Map<item_type, Map<item_id, payload>>` plus a
bounded recent-activity ring (observability + registry signals, last N). The
board sections are derived; a record invalidates only the sections its
`item_type` feeds, and only those re-render (push-by-affected-section, §5.3):

| `item_type` | Invalidates sections |
|---|---|
| `plan` | IN_PROGRESS, SPRINTS, BACKLOG, ATTENTION (badge), SYSTEM (counts) |
| `claim` | IN_PROGRESS, AGENTS (roster freshness) |
| `assignment` | IN_PROGRESS, ATTENTION (blocked/failed), "Recently terminal" |
| `agent_run` | IN_PROGRESS (worker rows), AGENTS, "Recently terminal" |
| `candidate` | ATTENTION (human-review), CANDIDATES |
| `action` | ATTENTION (the dominant attention input) |
| `constraint`/`decision`/`trap` | SYSTEM (counts), TRAPS |
| `handoff` | ACTIVITY, SYSTEM (counts) |
| `sequence` | SPRINTS |
| `session`/`*_progress` (observability) | ACTIVITY feed only — never a section state change |

`attention_required` is computed by the observer from the projection (actions +
human candidates + blocked/failed assignments + failed runs + evidence-
contradicted terminals), matching what the server-side composite returns — the
surface must not under-count by reading "actions only" (the pln#559 fix, now in
the projection rule).

### 6.1 Dual-mode coverage gap (CLOSED by pln#568 phase 1.5)

> **Status (pln#568):** the writer-side gap below is **closed**. The
> registry / coordination families (claim, assignment, agent_run,
> action_required [journaled under item_type `state`], candidate, sequence,
> and SHARED runtime_note) now emit full entity-state **post-images** on their
> persist chokepoint (`src/core/events/registry-post-image.ts`), and the
> observer materializer projects them (`board-projection.ts` ARRAY_SLOT).
>
> **Cutover signal (O2, resolved):** an observer switches a registry family
> from the MCP `board_summary` seed to the journal only once the journal
> carries the `journal_note` kind **`registry_genesis`** marker — emitted by
> `runRegistryGenesisSupplement` (run via `brainclaw migrate --enable-journal`)
> after it backfills every pre-existing registry entity. The marker is the
> safety gate: without a complete backfill a partially-journaled store would
> undercount the attention badge (trp#559). `BoardObserver.registryAuthoritative()`
> tracks the marker (sticky, re-derived on cold start by replaying from the
> checkpoint floor); `mergeCounts(journal, seed, journalActive, registryAuthoritative)`
> takes claims/assignments/runs/actions from the journal when it is set, and
> from the seed otherwise. `agents`/`sessions` are never journaled → always seed.
> A store that has NOT run the supplement keeps the seed (no regression).
>
> **Section CONTENT cutover (pln#560 completion):** once `registryAuthoritative()`
> is set, the registry/coordination sections (ATTENTION, IN_PROGRESS, SPRINTS,
> and the flat claims/assignments/runs/actions/candidates drill-downs) serve
> their entity content from the projection too — zero MCP display fetches on
> expand. The non-journaled extras on the composites (server-computed
> `workflow_hints`, loops via `bclaw_loop(intent='list')`, and the
> `bclaw_dispatch_status` evidence digests of §6/§7) remain best-effort reads
> through the observer-flagged client: when no client resolves, the section
> still renders its entities. SYSTEM keeps its MCP fetch regardless — it mixes
> private/machine runtime_notes (never journaled, visibility boundary) and
> cross-project config, neither derivable from the shared journal.
>
> The historical (pre-pln#568) description below is kept for context.

The journal classifies records into five classes (§2). In phase 1 / `dual`
mode — what runs today after pln#543 step 4 — **registry-lifecycle records
are payload-OPTIONAL** (event-log-store.md §2.1.1, J4); the dual-write path
in `src/core/event-log.ts:152` forwards `assignment_*` and `run_*` events to
the journal with `item_id` only, no `payload`. The §2 rule "upsert when
payload present, else a status/activity signal" means today's journal carries
**no post-images for `assignment` or `agent_run`**: the in-memory projection
has zero rows for those item_types, and the materializer
(`src/core/events/materialize.ts`) only enumerates the 5 memory families
(constraint/decision/trap/handoff/plan).

Consequence for the §6 mapping table: until phase 1.5 ships, the rows that
the table claims `assignment` / `agent_run` / `claim` populate (IN_PROGRESS
worker rows, ATTENTION blocked/failed, Recently terminal under IN_PROGRESS)
cannot be drawn from the journal alone. A conforming observer in dual mode
MUST:

- Seed those sections at activation from a **single observer-flagged
  `bclaw_context(kind: "board_summary")`** call (no timer, no poll) — that
  read is lock-free under the §8 observer contract (validated against
  `getDispatchStatus` and `loadAssignment`/`loadAgentRun`, which are pure
  projection reads — `mcp-read-handlers.ts:1916`, `json-store.ts:47`); and
- Mark those sections "live-view degraded" in the tooltip until phase 1.5,
  so the operator can tell journal-driven sections (memory entities,
  attention badges) from MCP-seeded sections (workers, lifecycle).

Memory-entity sections (plan / constraint / decision / trap / handoff /
sequence / handoff-derived ACTIVITY) ARE journal-driven today via the
per-entity diff in `persistState` (`src/core/state.ts:400`) — the protocol
delivers its full value for them.

### 6.2 Section ID glossary

The §6 table uses display names; the canonical IDs in
`vscode-extension/src/board-tree.ts:321` are `attention | in-progress |
sprints | backlog | system | agents | candidates | activity | plans | claims
| assignments | runs | actions | handoffs | sprint | traps | cross-project`.
"Recently terminal" is **not** a top-level section — it is a sub-node
rendered under `in-progress`. The board also surfaces `cross-project`
(federation incoming signals) and `linked_projects`, neither of which has a
single journal `item_type` today: cross-project signals arrive via the
handoff/candidate streams (already covered), `linked_projects` is derived
from project config and is intentionally NOT a journal concern.

The projection is **state**, not administrative belief: a worker row's health
comes from evidence in the records (commits/fs signals carried on
registry-lifecycle payloads when present), not from a bare status field that the
2026-06-10 log proved lies. Where richer evidence requires it, the surface MAY
call `bclaw_dispatch_status` through the actions client (§7) — that is a
read-only MCP call, used sparingly (per visible terminal row), not a poll.

## 7. Actions go through a separate, lazy MCP client

Mutations (accept candidate, release claim, dispatch, transition, complete step)
are the *only* reason an observer talks to the MCP server. Rules:

- One lazily-created MCP client per project, spun up on first action, idle-timed
  out after inactivity. Never created just to display.
- Distinct from any agent session: the client identifies as an **observer
  principal** (see §8), so its calls never adopt an agent's claim/cursor.
- After an action, the observer does NOT optimistically mutate its projection;
  it waits for the resulting journal record(s) to arrive via the tail (§5) and
  re-projects. Single source of truth, no split-brain. (A short-lived "pending"
  affordance on the clicked item is a UI concern, not projection state.)
- `bclaw_dispatch_status` and other read-only facades are permitted through this
  client for on-demand evidence enrichment, but are never on a timer.

## 8. Observer identity (no impersonation, no side effects)

The surface declares itself an observer so the server suppresses every write a
read would otherwise trigger:

- Transport signal: `BRAINCLAW_OBSERVER=1` in the action client's env, and/or
  MCP `clientInfo.name = "brainclaw-observer/<surface>"`.
- Server contract (already implemented, pln#558): observer reads do not
  `autoAcknowledge`, do not run agent-run reconciliation, do not advance
  `readUnseenEvents` cursors, do not implicit-heartbeat or auto-register an
  identity. This protocol is the client half of that contract: even the read-
  only facade calls in §7 carry the observer flag.
- The observer never presents an agent name as the actor of anything. Actions
  the human triggers are attributed to the human operator principal, not to a
  spawned agent.

## 9. Failure modes and degradation

| Condition | Behavior |
|---|---|
| `events/` absent (journal off / not migrated) | Fall back to a single MCP `board_summary` read at activation (no timer); show a "journal off — limited live view" hint. The surface still works, just not push-driven. |
| Cursor gap (archived past watermark) | Cold-start from newest checkpoint (§5); silent — state is correct, only missed-activity history is lost. |
| Checkpoint missing/corrupt | Fall back to the previous checkpoint, replay more segments (the two-checkpoint floor guarantees one exists); if none, seed empty + full tail. |
| Torn / unparseable line | Skip, keep tailing (§5). |
| Active segment shrinks / meta regresses | Trust the journal tail, re-derive; never write a "repair" (that is an agent/doctor job). |
| Watch unavailable (network FS, sandbox) | Degrade to a long-interval stat of the active segment; still zero locks. |

## 10. Performance budget (vision §5.3, restated as observer obligations)

| Operation | Target | Hard limit | How the protocol meets it |
|---|---|---|---|
| Activation → first summary | 500 ms | 2 s | seed from newest checkpoint, no full replay |
| Summary refresh | 300 ms | 1 s | apply only the new tail records |
| Section expand (warm) | 50 ms | 200 ms | projection is in memory; expand reads the map |
| Section expand (cold) | 500 ms | 2 s | first projection build from checkpoint+tail |
| Action round-trip | 500 ms | 2 s | lazy MCP client; result observed via tail |

Out of budget → surface in tooltip + a "performance degraded" status-bar
indicator (never escalate by calling a heavier path — that is the contention-
breeds-contention bug this protocol exists to kill).

## 11. Language-agnostic conformance checklist

A surface in any language conforms iff:

1. It reads only files under `.brainclaw/events/` (+ checkpoints) and writes
   nothing under `.brainclaw/`.
2. Its cursor is a seq watermark in client-private storage, keyed by
   `project_id`, never in the store's `.cursors/`.
3. It seeds from the newest verified checkpoint and tails by (segment, line)
   order, applying records by action *class*, tolerant of unknown verbs and torn
   tails.
4. Change detection is an OS file watch (or long-interval stat) — never an MCP
   poll, never a lock.
5. Mutations go through a separate lazy MCP client flagged as an observer
   principal; the projection updates only from the resulting journal records.
6. `attention_required` and worker health are computed from journal evidence,
   not from administrative status fields alone.

Reference implementation: the VS Code extension (pln#560 step 2). The JetBrains
plugin (next plan) implements this same checklist in Kotlin — its existence is
the cross-language validation that this protocol, not the TypeScript code, is
the contract.

## 12. OPEN QUESTIONS

Carried from the 2026-06-12 symmetric review (pln#560 step 1, this branch).
Each is something the spec text cannot close on its own; one or more must
be answered before the JetBrains plugin (Kotlin) ships.

| # | Sev | Question |
|---|---|---|
| O1 | MED | **Shared `ACTION_CLASS_BY_ACTION` manifest.** §2 says implementations MUST mirror the table "or fetch it from a shared manifest." Today only the TS version exists (`src/core/events/journal.ts:66`); a Kotlin implementer would re-type 42 entries by hand and silently drift on the 43rd. Should this ship as a generated JSON next to `event-log-store.md` (single source of truth, both runtimes load it) or as part of a versioned schema bundle? Recommend the generated JSON — the table is small and changes per spec revision, not per release. |
| O2 | RESOLVED (pln#568) | **Phase-1.5 cutover signal for §6.1.** Resolved with a `journal_note` kind **`registry_genesis`** marker emitted by `runRegistryGenesisSupplement` after it backfills every pre-existing registry entity (`brainclaw migrate --enable-journal`). Observers detect it (`BoardObserver.registryAuthoritative()`, sticky + re-derived on cold start) and switch the registry counts from the MCP seed to the journal via `mergeCounts(..., registryAuthoritative)`. Chosen over a `meta.json` version bump because meta is a rebuildable cache (§2.3) — the marker is a durable journal record, the source of truth, and survives a meta rebuild. Open follow-up: when checkpoints start emitting (today `checkpoint_seq=0`), the checkpoint must encode the capability so a cold start past the marker's segment still re-derives authority. |
| O3 | LOW | **`bclaw_dispatch_status` enrichment scope.** §6 + §7 allow it "per visible terminal row" but the wording is ambiguous between "terminal-state row" (Recently terminal) and "row currently visible in the terminal UI" (every IN_PROGRESS row). Settle: probably the first (only failed/silent_death rows want the evidence digest) — but the contract must say so, otherwise an implementor renders an O(workers) burst on every refresh. |
| O4 | LOW | **Segment pad-width upgrade path.** §2 pins 8-digit decimal padding; the writer is 8-digit too (`src/core/events/journal.ts:214 SEGMENT_PAD=8`). At ~17k events historical, the 1e8 ceiling is decades out — but a future widen would require coordinated writer + every observer roll-out. Carry the migration recipe (pad-width in `meta.json`?) here so a future maintainer doesn't have to rediscover it. |
| O5 | LOW | **File watch semantics on Windows network mounts.** §4 falls back to a "long-interval stat" when the watcher is unavailable. VS Code's `FileSystemWatcher` on a junction-linked worktree (the brainclaw dispatch substrate) may fire on the link target's mtime but not the source-of-truth segment writes from another process; verify against the dispatch worktree machinery (`pln#498` junctions) before declaring the watch path universal. |
