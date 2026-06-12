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
  checkpoints/
    ckpt-<seq>.json        # self-contained state manifest at head <seq>
```

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

**Cold start (no cursor, or cursor below the oldest live segment):**

1. Load the newest verified checkpoint `ckpt-<S>.json` → seed the in-memory
   projection (full post-image set at head `S`). Set `cursor.checkpoint_seq = S`.
2. Tail every record with `seq > S` across segments in (segment, file-line)
   order; apply by class (§2).
3. Set `cursor.seq` to the last applied seq. Render.

If no checkpoint exists, seed from the empty projection and tail from seq 1
(small/young stores). If the cursor's `seq` is **below the oldest non-archived
segment's first seq** (gap — segments archived past the watermark), discard the
cursor and cold-start from the checkpoint: notifications degrade, state never
does.

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
