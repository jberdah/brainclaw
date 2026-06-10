# Event-Log Store — Proposal B (slot B, round 1)

Status: ideation draft — loop lop_3bf55b9492e0d96c, pln_2290bc70 / pln#543 step 1.
Author: claude-code (slot B), independent round-1 proposal.

## Thesis

Evolve `src/core/event-log.ts` from a best-effort notification stream into the
**source of truth**, and re-cast the existing per-entity JSON files as a
**materialized projection** of that journal. The JSON files do not disappear —
they become a derived cache that is *also* the git-diffable, human-readable,
MCP-cheap representation. This single move satisfies the three hard constraints
that look contradictory at first glance (journal as truth / git-diffable store /
cheap worker-per-call reads), because the projection on disk *is* what today's
readers already consume.

Core design choices, argued below:

| Question | Choice | One-line rationale |
|---|---|---|
| Payload format | **Full entity snapshot per event** | Self-contained, gap-tolerant, zero-dep, trivial compaction |
| Ordering authority | **Global monotonic `seq`, assigned under the store lock** | Clock skew neutralized; journal order = mutation order |
| Append safety | O_APPEND single-write + newline framing + torn-tail tolerance | Atomic enough on NTFS+POSIX local FS; reader heals |
| Durability | One `fsync` per `mutate()` (not per event), configurable | Journal-first means tail loss is bounded and healable |
| Rotation | **Immutable segments + checkpoint records**, never rename-away | Rebuildability preserved; cursors survive rotation |
| Projections | Lazy reconciliation at read paths, `seq`-watermark dirty check | House pattern (pln#496); no daemon |
| Migration | Flag-gated dual-write, genesis-snapshot backfill, park-don't-delete | Rollback = flip the flag; JSON files are always valid |

---

## 1. Event payload format

### 1.1 Decision: full entity snapshot per event

Each state-changing event carries the **complete post-mutation entity**, not a
diff. Record shape (v2; existing events are retroactively "v1"):

```jsonc
{
  "v": 2,
  "seq": 18342,                 // global monotonic, assigned under store lock
  "ts": "2026-06-10T14:03:22.114Z",   // informational only — never an ordering key
  "writer": "claude-code",      // agent name
  "writer_id": "agt_...",       // optional stable agent id
  "pid": 31416,                 // diagnostic
  "action": "update",           // existing EventAction union
  "item_type": "plan",
  "item_id": "pln_2290bc70",
  "summary": "step 1 started",  // human-facing, optional
  "payload": { /* full entity object, schema-valid */ },
  "deleted": false              // true => payload omitted, tombstone
}
```

Deletes are tombstones (`deleted: true`, no payload). Non-entity events
(`session_start`, `run_*` notifications without state change) keep
`payload`-less form — they are observability, not state.

### 1.2 Why snapshots beat diffs here

Considered alternatives:

- **JSON-Patch (RFC 6902)** — smallest payloads, but: (a) zero-runtime-deps
  constraint means hand-rolling a patch engine with its own bug surface;
  (b) every event becomes **load-bearing**: one corrupt/torn/skipped line
  poisons all subsequent state for that entity. Replay must be perfect or
  fail loudly. That is the wrong failure mode for a file-based store that
  agents, tests, and humans touch directly.
- **Field-delta (shallow `{changed_fields}`)** — cheaper than full snapshot,
  no library needed, but same load-bearing problem for any field ever touched,
  plus ambiguity between "field absent = unchanged" and "field removed".
- **Full snapshot** — every event is **idempotent and self-contained**.
  Rebuilding an entity = take the latest event for that `item_id`. Rebuilding
  the store = one backward scan keeping first-seen per id. A lost or corrupt
  line costs *at most the window until the next write of that entity*, never
  the entity's integrity. Compaction is trivial (§3). Federation merge is
  trivial (§5).

### 1.3 Size math (is snapshot affordable?)

Entities today are ~1–4 KB pretty-printed; compact JSON in the journal ≈
0.5–2 KB. Current observed rate: ~17k events / ~2 months. Even if v2 events
average 2 KB, that is ~34 MB/2 months ≈ a 10 MB segment roll every ~2–3 weeks.
With checkpoint-based compaction (§3) the *live* journal stays bounded by
(entities × snapshot size) + recent tail. Verdict: snapshot cost is noise at
brainclaw's write rates; we are not building Kafka.

**Mitigation if an entity type grows large** (e.g. long plan bodies): per-type
opt-in to `payload_ref` pointing at the projection file + content hash — but
this is explicitly **deferred**; do not build it until a real entity exceeds
~64 KB. (OPEN QUESTION Q1.)

---

## 2. Append atomicity & durability

### 2.1 What we get from the OS

`fs.appendFileSync` opens `O_APPEND` (POSIX) / `FILE_APPEND_DATA` (Windows).
For **local** filesystems (NTFS, ext4, APFS), a single `write()` of one buffer
to an O_APPEND fd positions atomically; interleaving between processes
produces *concatenated* records, not *interleaved bytes*, for the record sizes
we write. Caveats we must encode in the spec, not just assume:

- Network filesystems (SMB shares, NFS) do **not** guarantee O_APPEND
  atomicity. Spec stance: journal correctness is guaranteed on local FS only;
  `bclaw doctor` warns when the store sits on a network mount.
- A crash mid-`write()` can leave a **torn tail** (partial line, no `\n`).

### 2.2 Framing: leading + trailing newline

Each record is written as **one buffer**: `"\n" + JSON + "\n"`.

The leading `\n` is the cheap, high-value trick: if the previous append tore
(no trailing newline), our leading newline *terminates the torn fragment as
its own malformed line* instead of letting our valid record be absorbed into
it. Damage from a torn write is thereby capped at **exactly one event** — the
torn one — never two. Readers already `split('\n').filter(Boolean)`, so empty
lines from double-`\n` are free.

Reader rules (normative):
1. Split on `\n`; skip empty lines.
2. A line that fails `JSON.parse` or schema validation: skip, count, surface
   via `bclaw doctor` (never silently — extend the current swallow).
3. A torn **tail** (last line, no trailing newline in file) is *expected* after
   a crash: skip without warning, but record `torn_tail: true` in doctor output.

### 2.3 Write path and the journal-first invariant

All state-mutating appends happen **inside `mutate()`** (they already do —
`appendEvent` is called from `persistStateUnlocked`). The store lock therefore
serializes mutating appenders; O_APPEND atomicity is the backstop for the
non-mutating observability events (session/run notifications) that may append
without the lock.

**Order inversion required.** Today `persistStateUnlocked` writes entity JSON
files first, then appends the event (state.ts:196→200). As source of truth the
journal must be written **first**:

```
mutate(): append v2 event(s) [+ fsync] → update projection files → bump watermark
```

Crash between append and projection write → projection is *stale*, lazy
reconcile heals forward. The reverse order would allow a projection *from the
future* — an event-less state the journal can never explain, and which a
reconciler would wrongly **regress**. Journal-first is the single most
important invariant in this spec.

### 2.4 fsync policy

- Default: **one `fs.fsyncSync(fd)` per `mutate()` call**, after the last
  append, before projection writes. Mutations are user-action-frequency, not
  hot-loop; one fsync per mutation is affordable on NTFS.
- `appendEvent` outside a mutation (observability events): no fsync.
- Config escape hatch `store.journal.fsync: "mutation" | "never"` for
  pathological filesystems. No `"always"` tier until someone demonstrates a
  need. (OPEN QUESTION Q2: default for CI/test envs.)
- The current `try/catch` that **swallows append errors must go** for v2
  state events: if the journal append fails inside a mutation, the mutation
  fails. A source of truth that silently drops writes is not a source of truth.
  Observability-only events may keep best-effort semantics.

---

## 3. Non-lossy rotation: segments + checkpoints

### 3.1 Layout

```
.brainclaw/events/
  HEAD.json                  # { next_seq, active_segment } — written under store lock
  seg-00000001.jsonl         # immutable once rolled; name = first seq it contains
  seg-00018000.jsonl         # active segment (append target)
  archive/
    events.v1.jsonl          # the parked legacy notification log (never deleted)
```

- Segment file name encodes the **first seq** in it → locating seq N is a
  directory listing + binary search by name, no index file needed.
- Roll when active segment ≥ 10 MB: under the store lock, write a fresh
  segment, update `HEAD.json`. **Never rename the active file** — readers
  holding it open (Windows!) are unaffected; rolled segments are immutable.
- `HEAD.json` is small and rewritten atomically (temp+rename, as
  `writeFileAtomic` already does). It is a cache: if missing/corrupt it is
  rebuilt by listing segments and tail-reading the last one.

### 3.2 Checkpoints make old segments prunable

A **checkpoint** is a special record (or run of records) appended like any
event: `{v:2, seq, action:"checkpoint", item_type:"state", payload:{...full
snapshot refs...}}` — concretely, a checkpoint emits one snapshot event per
live entity plus a terminator record. After a checkpoint at seq C, every
segment whose *last* seq < first-snapshot-of-C is **redundant for state
rebuild** and moves to `archive/` (park, never delete — house rule).

Checkpoint triggers (lazy, no daemon): on segment roll, and on
`bclaw doctor --compact`. Cost: O(live entities), bounded, runs under the
store lock.

### 3.3 Cursors become seq watermarks

Replace `{offset, last_read}` byte cursors with `{last_seq, last_read}`.
This fixes the existing rotation bug class outright: rotation/compaction
**cannot invalidate a seq watermark**. `readUnseenEvents(agent)` = find
segment containing `last_seq+1` (filename binary search), stream forward.
If the watermark predates the oldest non-archived segment, the reader gets
`{gap: true}` and a summary built from the checkpoint instead of replaying
archaeology — notifications degrade gracefully, state rebuild does not need
them.

---

## 4. Projections: lazy materialization

### 4.1 What is a projection

Exactly the files we have today: `constraints/*.json`, `plans/*.json`, etc.,
written by `saveVersionedJsonFile` (atomic, pretty-printed, git-diffable).
Plus one new manifest:

```
.brainclaw/projections.json    # { applied_seq: 18342 }
```

### 4.2 Dirty detection = watermark comparison (no dirty flags, no daemon)

Read path (`loadState`, single-entity gets):

1. Read `projections.json.applied_seq` and `HEAD.json.next_seq` — two tiny
   file reads, this is the staleness check and it is O(1).
2. Equal (the overwhelmingly common case: same-process read-after-write, or
   MCP worker spawned after a clean mutation) → serve projection files
   directly. **This is why worker-per-call stays cheap**: the fresh-path adds
   two small reads to today's behavior, nothing else.
3. Behind → acquire store lock, replay events `(applied_seq, head)` onto the
   projection (apply snapshot / tombstone per record), bump `applied_seq`,
   release. Replay cost is proportional to the *gap*, not the store.
4. Lock unavailable (reader racing a writer) → serve the stale projection
   with a `stale: true` annotation rather than block reads. (OPEN QUESTION
   Q3: is stale-read acceptable for claims? Probably not — claims may need
   read-through-journal.)

This is precisely the pln#496 lazy-reconcile pattern: convergence at read
paths, no background process.

### 4.3 How `mutateState` / `persistState` migrate

End-state shape (phase 3, §6):

```ts
mutateState(fn):
  mutate(lock):
    state = loadState()             // projection, reconciled if behind
    result = fn(state)
    events = diffToEvents(prev, state)   // snapshot events for changed entities
    appendEvents(events) + fsync
    applyToProjection(events)            // same writes syncDirectory does today
    writeWatermark(applied_seq = last seq)
  return result
```

`diffToEvents` compares by entity identity + shallow equality — note this
replaces today's "rewrite every file on every mutation" with **write only what
changed**, which is where the "single-entity ops not O(store)" perf target is
actually won. `syncDirectory`'s deleteMissing semantics map to tombstone
events; the trp_d5595086 guard (never unlink unparseable files) carries over
unchanged on the projection side.

The full-state-load in `mutateState` stays in phase 1–2 (it's correct, just
not optimal); per-entity loads land in phase 3 once registries
(assignments/runs/loops, which already do per-entity files) and State entities
share the journal apply path.

---

## 5. Causal ordering & multi-writer

### 5.1 Inside one store

- **`seq` is the only ordering authority.** Assigned under the store lock from
  `HEAD.json.next_seq`. Since every state mutation already runs under that
  lock (mutation-pipeline invariant), seq assignment adds zero new
  coordination.
- `ts` is diagnostic. Clock skew, DST, multi-machine clones — none of it can
  reorder state, because nothing orders by `ts`.
- Observability events appended outside the lock get `seq: null` and are
  excluded from state rebuild; they order best-effort by file position. If
  this proves annoying, they can cheaply take the lock — but do not let
  notification traffic contend with mutations by default.
- Per-writer `(writer_id, writer_seq)` is **also** recorded (a tiny counter in
  the agent's cursor file) — unused locally, load-bearing for federation.

### 5.2 Federation (Pull-and-Materialize consumes the journal)

The journal is the sync substrate the federation decisions assumed:

- A remote pulls segments (append-only files = rsync/git/dumb-bus friendly,
  no daemon).
- Materialization replays *foreign* snapshot events into the local store as
  **signaling entities** (candidates/handoffs) per the
  cross-project-signaling decision — foreign events do not directly mutate
  local execution entities.
- Idempotency key for merge = `(origin_store_id, seq)`; duplicate pulls are
  no-ops. `origin_store_id` is stamped once per segment header record, not
  per event, to save bytes.
- Conflict semantics (same entity edited in two stores): **out of scope
  here**; the journal guarantees each side's history is complete and
  replayable, which is the precondition. (OPEN QUESTION Q4 — Codex schema
  review territory.)

### 5.3 Adversarial scenarios (pre-answered for the critique round)

| Attack | Outcome under this design |
|---|---|
| Crash mid-append | Torn tail; leading-`\n` framing caps loss at 1 event; reader skips; doctor reports. Mutation that crashed never confirmed → caller retries; projection never ahead of journal (journal-first). |
| Two mutating writers | Impossible by construction — store lock (hardened today, token-owned, refresh-padded) serializes them; seq assignment is inside the lock. |
| Stray appender without lock | O_APPEND keeps records intact; record has `seq:null` → cannot corrupt state order. |
| Rotation during read | Rolled segments are immutable; active segment never renamed; seq watermarks survive. The v1 bug (rename + cursor reset) is structurally removed. |
| Clock skew / ts collision | Irrelevant to state: seq orders. |
| 100k-event store | Reads never replay history: fresh-path is O(1) check + projection read; stale-path replays only the gap; rebuild-from-zero bounded by last checkpoint. |
| Corrupt line mid-segment | Snapshot self-containment: only that event lost; later snapshot of same entity supersedes. Doctor flags the segment. |
| `HEAD.json` corrupt/lost | Rebuilt from segment listing + tail read; it is a cache, not truth. |
| `projections.json` lost | Worst case: full replay from last checkpoint. Truth intact. |

---

## 6. Migration plan

Flag: `store.journal_v2: off | dual | primary` (config.yaml), default `off`.

**Phase 0 — ship the format, change nothing.** Land record schema (zod),
segment reader/writer, doctor checks. v1 `events.jsonl` untouched.

**Phase 1 — `dual`: journal-first dual-write.**
- `bclaw migrate journal` (one-shot, upgrade-style): backup store; emit
  **genesis checkpoint** = one snapshot event per current entity built from
  the projection files (the only truth we have — the 17k v1 events are not
  reconstructible and are not translated, just parked to
  `events/archive/events.v1.jsonl`, still readable for history/forensics);
  initialize `HEAD.json`, `projections.json`.
- `persistStateUnlocked` reordered: append v2 events → existing
  `writeStateDirectories` → watermark. Notifications switch to seq cursors.
- **Rollback:** set flag `off`, restore nothing — projection files were
  written on every mutation and are exactly today's format. Park the
  `events/` dir. Zero data loss in either direction. This must not regress
  today's lock/mutation hardening: the only change inside the lock is
  ordering + two small file writes.

**Phase 2 — `primary`: reads heal from journal.** Lazy reconcile on read
paths (§4.2). Acceptance gate: kill -9 storms in tests (crash between append
and projection) always converge.

**Phase 3 — per-entity ops.** Single-entity mutations append + patch one
projection file without full-store load/rewrite; registries unify on the same
path. Perf gates: `bclaw_work` cold read < 1 s on a 100k-event store;
single-entity op cost independent of store size.

Each phase ships dark behind the flag, soak-tested by dogfooding (this repo's
own store is the canary, ~17k events of realistic traffic).

---

## 7. Hard-constraint checklist

- **Zero new runtime deps**: snapshots need no diff lib; zod (already present)
  validates records; segments are plain JSONL. ✔
- **Windows + POSIX**: O_APPEND/FILE_APPEND_DATA local-FS semantics; no rename
  of open files; no fsync assumptions beyond Node built-ins; paths via
  existing `memoryDir`. ✔
- **Git-diffable store identity**: projection files unchanged in format and
  location; segments are append-only (clean diffs); archives parked. ✔
- **No daemon**: all convergence at read/write paths under the existing lock. ✔
- **Cheap MCP worker-per-call**: fresh-path = two extra tiny reads. ✔

## 8. Open questions (for Codex review / Juan product call)

- **Q1** Large-payload escape hatch (`payload_ref`): spec now or explicitly
  defer? (I say defer; flagging because it changes the record schema if added.)
- **Q2** fsync default in tests/CI — `"never"` to keep suite fast, or same as
  prod to keep fidelity? (Test-runner env contamination history says: same as
  prod, measure first.)
- **Q3** Are stale projection reads acceptable when the lock is contended, or
  must claims/locks-adjacent entities read through the journal? Product call:
  consistency vs. never-blocking reads.
- **Q4** Federation conflict semantics (LWW per entity vs field merge vs
  always-surface-as-candidate). Needs Codex's schema-review pass; journal
  design above is agnostic.
- **Q5** Should journal segments be committed by `commitMemoryChange`
  (memory-git) or gitignored within the store's internal repo? Append-only
  files diff well, but double-storing 10 MB segments in git history may bloat;
  checkpoint-only commits are a middle ground.
- **Q6** Observability events: keep them in the same journal (current
  proposal) or split notification stream from state journal entirely? Same
  file is simpler; split avoids notification traffic inflating segments.

## Memory ids relied upon

- feedback_lazy_reconcile_pattern (pln#496) — projection reconciliation shape (§4).
- trp_d5595086 — never-unlink-unparseable guard carried into projection apply (§4.3); load-swallow lesson behind §2.2 reader rules.
- federation_architecture_decisions / cross_project_signaling_vs_execution — no daemon, Pull-and-Materialize, signaling-only foreign writes (§5.2).
- trp_e85e9fbe — Windows/POSIX divergence discipline (§2.1, §7); CI-on-both-platforms gate for phases.
- trp_09988deb — config/backup hygiene → upgrade-style backup + park-don't-delete in migration (§6).
- feedback_bisect_state_before_code — motivates doctor-visible counters over silent skips (§2.2).
