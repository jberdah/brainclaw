# Event-Log Store — Proposal A (slot A, round 1)

> Ideation artifact for lop_3bf55b9492e0d96c (pln_2290bc70 / pln#543 step 1).
> Independent proposal — not yet cross-critiqued. Status: DRAFT.

## 0. Position summary

Evolve `src/core/event-log.ts` from a best-effort notification stream into a
**write-ahead journal of full-entity snapshots**, organized as **immutable
sealed segments + checkpoint records**, with the existing per-entity JSON
directories demoted to **lazily reconciled projections** (pln#496 pattern).
Ordering comes from a **store-global sequence number assigned under the
existing store lock** — never from timestamps. Migration is a four-phase,
flag-gated dual-write with a backfill genesis and a park-don't-delete rollback.

The three deliberate "boring" choices, argued below:

1. **Full snapshot payloads, not diffs** (§2) — correctness over bytes.
2. **The store lock is the concurrency primitive, O_APPEND is the seatbelt**
   (§3) — no new locking protocol.
3. **One journal per store, not per entity** (§5) — global order for free.

## 1. Seed analysis — what exists and the exact gap

What `src/core/event-log.ts` + call sites give us today:

| Capability | State today | Gap to source-of-truth |
|---|---|---|
| Append on every mutation | `appendEvent` wired into `persistStateUnlocked` (state.ts:200) and ~30 verb sites | Events carry no payload — state NOT reconstructible |
| Envelope | `{ts, agent, agent_id?, user?, action, item_type, item_id?, summary?}` | No seq, no writer identity, no payload, no schema version |
| Durability | `appendFileSync` inside try/catch that **swallows all errors** (event-log.ts:94-96) | A journal that may silently drop writes cannot be authoritative |
| Rotation | At 10MB: rename file away, **delete all cursors** (event-log.ts:211-236) | History unreachable by readers; cursor reset re-notifies nothing (offset semantics gone) |
| Readers | `readAllEvents` (full parse), `readUnseenEvents` (byte-offset cursors), `buildNotificationSummary` | Cursors are bare byte offsets into a file that rotation deletes |
| Concurrency | All mutations serialize via `mutate()` → store-wide lock with token ownership + refresh (lock.ts, hardened sprint 1.5) | appendEvent itself is also called outside any documented invariant; lock-expiry break creates a 2-writer window |

Adjacent precedent worth noting: **loops already run a payload-carrying
per-loop journal** (`src/core/loops/store.ts` `appendEvent` →
`loops/<id>/events.jsonl`, zod-validated `LoopEventSchema`, thread file as
projection). The store journal should converge on the same shape; unifying
the loop journals into it is explicitly a **non-goal** of this spec (future
work, §10).

## 2. Event payload format: full entity snapshot

### Decision

Every state-changing event carries the **complete post-image of the entity**
(`payload` = the same zod-validated document that today lands in
`<entity>/<id>.json`). Deletions are explicit tombstones (`payload: null`,
`action: "delete"`). No JSON-patch, no field-deltas.

```jsonc
{
  "v": 2,                          // envelope schema version
  "seq": 18204,                    // store-global, assigned under lock (§4)
  "ts": "2026-06-10T14:02:11.318Z",// informational ONLY, never ordering
  "writer": "w_1a2b3c",            // writer instance id: pid + start-nonce
  "agent": "claude-code",
  "agent_id": "agt_...",
  "user": "jberdah",
  "action": "update",              // existing EventAction union
  "item_type": "plan",
  "item_id": "pln_2290bc70",
  "entity_rev": 7,                 // per-entity monotonic revision (§6)
  "payload": { /* full post-image, schema-versioned doc */ },
  "summary": "step 1 completed"    // kept for notification consumers
}
```

### Why snapshots win

- **Replay is a trivially correct reducer.** Rebuild = single pass, last
  event per `item_id` wins, tombstones remove. No patch-base tracking, no
  op-ordering semantics, no "patch against missing base" failure class.
- **Zero-dep constraint.** JSON-patch (RFC 6902) means either a new runtime
  dep or a hand-rolled implementation — hand-rolled patch appliers are
  exactly the kind of subtle code that produced trp_d5595086 (silent data
  loss via load-swallow). Snapshots reuse the existing zod schemas as the
  only validation layer.
- **Partial history loss is survivable.** With diffs, one torn/lost event
  poisons every later diff for that entity. With snapshots, the next event
  for that entity self-heals the projection.
- **Size is bounded by compaction, not by the payload format.** Entities are
  1–10KB. The worst case (a plan updated 50× in a session) costs ~500KB of
  journal — and §5's checkpointing makes old fat segments irrelevant to
  replay cost. Optimizing bytes here buys nothing measurable and sells
  correctness.

### Trade-off acknowledged

Snapshot payloads make the journal **chatty in git diffs** (every event line
embeds the whole doc). Mitigation: the journal lives under
`.brainclaw/journal/` and the *projections* stay git-diffable as today —
store identity for human review remains the per-entity JSON files +
PROJECT.md. The journal is diffable too (append-only = pure line additions),
just verbose. OPEN QUESTION Q1 (§11) flags whether `payload` should be
elided for `summary`-only event kinds (session_start, run_* lifecycle) —
proposed: yes, payload is required only for actions that mutate a persisted
entity.

## 3. Atomicity & append guarantees

### Append protocol (replaces the swallow)

1. All journal appends happen **inside the store mutation lock** — the
   journal becomes part of the `mutate()` critical section, ordered
   **journal-first** (write-ahead): append event(s) → apply projections →
   release lock. Crash between append and projection write = projection is
   stale-but-rebuildable; the lazy reconciler (§6) converges it on next read.
2. One event = **one `fs.writeSync` call** on a fd opened with flag `'a'`
   (O_APPEND on POSIX; FILE_APPEND_DATA on Windows). Single-syscall writes
   of a full line ≤ a few KB do not interleave on local filesystems on
   either platform. This is the **seatbelt**, not the primary guarantee —
   the lock is. It matters precisely in the lock-expiry race (lock.ts O2
   residual: a breaker can briefly coexist with a stale-but-alive owner):
   two appenders may both write, but neither corrupts the other's line, and
   `(writer, seq)` lets the reader detect the overlap (§4).
3. **Failures are loud.** If the journal is source of truth, a failed append
   is a failed mutation: `appendEvent` throws inside `mutate()`, the
   mutation reports failure to the caller, projections are not written.
   The current `logger.debug` swallow is removed in journal-mode. (During
   the dual-write phase the legacy stream keeps best-effort semantics; the
   new journal is strict from day one — see §8.)

### fsync policy

Default: **no fsync per event.** Node's `writeSync` hands data to the OS;
on OS crash / power loss we may lose the tail. That is acceptable because
(a) projections exist on disk as a second copy, (b) the store also commits
to git (`commitMemoryChange`), and (c) the recovery rule below makes a torn
tail non-fatal. Config escape hatch: `journal.fsync: always | rotate | off`
(default `rotate` — fsync on segment seal and checkpoint write only).
Per-event fsync on Windows is brutal (~ms each) and would violate the
"MCP worker-per-call stays cheap" constraint.

### Torn-tail recovery (read side)

A reader hitting the active segment applies one rule: **a final line not
terminated by `\n`, or that fails `JSON.parse`, is a torn write — ignore
it and treat the previous line as head.** The next writer, before
appending, checks the last byte of the file; if it is not `\n`, it moves
the torn bytes into `journal/quarantine/<segment>-<ts>.torn` and appends a
`journal_repair` event recording what was quarantined. Torn data is parked,
never deleted (house rule). Mid-file malformed lines (should be impossible
under the lock) are surfaced via `logger.warn` + `brainclaw doctor`, never
silently skipped — that is the trp_d5595086 lesson applied to the journal.

### Windows/POSIX divergence note

All of the above must land with tests run on both families — the sprint-1
release-gate trap (trp_e85e9fbe) showed `shell:true` spawn and path-
normalization behaviors diverge between local Windows, CI Windows, and
Linux. The append-atomicity seatbelt specifically needs a two-process
stress test (spawn N children appending K events; assert no interleaved
bytes, no lost `(writer, seq)` pairs) on both platforms.

## 4. Ordering: store-global seq under the lock; ts is decoration

- `seq` is a **store-global monotonic integer**, persisted in
  `journal/meta.json` (`next_seq`), incremented under the mutation lock.
  Since every legitimate append already holds the lock, this is trivially
  total-ordered. File order and seq order coincide in the normal case.
- `writer` (pid + random start nonce) disambiguates the abnormal case: the
  lock-expiry break window can produce two writers that both read the same
  `next_seq`. Readers treat `(seq, writer)` as the identity; a duplicate
  `seq` from different writers is a **detected anomaly** — the reducer
  applies both in file order and emits a doctor warning. Snapshot payloads
  (§2) make this safe: the later file line wins wholesale, no diff
  corruption.
- **Timestamps never order anything.** Clock skew across agent shells,
  WSL, and containers is real; `ts` is for humans and notification
  summaries only.
- **Federation hook (informative, not normative here):** the journal is the
  Pull-and-Materialize substrate. Remote events are imported preserving
  `origin: {store_id, seq}` and assigned fresh local seqs; per-entity
  conflict detection uses `entity_rev` (§6). Cross-store merge semantics
  (entity-level LWW vs. manual conflict surfacing) is OPEN QUESTION Q2 —
  it needs the federation architecture's owner, not this spec.

## 5. Segments + checkpoints replace lossy rotation

### Layout

```
.brainclaw/journal/
  meta.json                  # next_seq, active segment id, checkpoint ref
  active.jsonl               # current segment, append-only
  segments/
    seg-000001-000812.jsonl  # sealed, IMMUTABLE (seq range in name)
    seg-000813-001650.jsonl
  checkpoints/
    ckpt-001650.json         # full-state snapshot manifest at seq 1650
  quarantine/                # torn tails, unparseable lines (parked)
```

### Seal & checkpoint protocol (under the lock)

When `active.jsonl` crosses the size threshold (keep 10MB):

1. Write `ckpt-<seq>.json`: a manifest containing the full materialized
   state at head seq (entity id → post-image, or — cheaper — entity id →
   `{file hash, entity_rev}` referencing the projection files; OPEN
   QUESTION Q3 picks between self-contained vs. referencing checkpoints).
2. fsync checkpoint, then rename `active.jsonl` →
   `segments/seg-<first>-<last>.jsonl` (sealed segments are immutable
   forever after).
3. Create fresh `active.jsonl` whose first record is a `checkpoint_ref`
   event pointing at the checkpoint.
4. Update `meta.json` last (atomic write via existing `writeFileAtomic`).

**Rebuild cost is bounded:** latest checkpoint + replay of `active.jsonl`
only (≤10MB ⇒ ~5–15k events ⇒ well under the 1s cold-read target on the
hardware we run). A 100k-event store replays the same ≤10MB tail; the other
90k events sit in sealed segments that only `doctor --verify-journal`,
backfill audits, or federation ever read.

### Cursors survive rotation

`AgentCursor` becomes `{segment_id, offset, last_read}`. Sealing does not
touch cursors: a cursor pointing into a now-sealed segment is still valid
(the file still exists, immutable). `readUnseenEvents` walks: remainder of
cursor's segment → subsequent sealed segments → active. The current
"rotation deletes all cursors" behavior — and its silent re-notification
loss — disappears entirely.

### Retention

Sealed segments and checkpoints are **never auto-deleted**. `brainclaw gc`
may archive segments older than the N-th checkpoint into
`.brainclaw/gc-backups/` (existing park location). Rationale: house rule
park-don't-delete, plus federation may need deep history.

## 6. Projections: entity dirs become lazily reconciled caches

### Mechanics

- Each projection family (constraints, decisions, traps, handoffs, plans,
  and later assignments/runs/claims) tracks `last_applied_seq` in
  `journal/meta.json` (single file, one stat to check everything).
- **Read path** (`loadState`, entity getters): stat-compare
  `meta.next_seq - 1` vs `last_applied_seq`. Equal → serve projection files
  as today (zero added cost beyond one small JSON read — keeps the MCP
  worker-per-call re-import model cheap). Behind → acquire lock, replay the
  delta events into the projection files, bump `last_applied_seq`, serve.
  This is exactly the pln#496 lazy-reconcile pattern; **no daemon**.
- **Write path migration** is the key ergonomic question. Today
  `mutateState(fn)` lets callers imperatively poke a full `State`. End
  state: writers emit **events**, and projections are a pure
  `apply(state, event)` reducer. Transition without rewriting ~all call
  sites: `persistStateUnlocked` computes an **id-level diff** (loaded state
  vs. mutated state per entity collection: created / content-changed /
  removed) and synthesizes the corresponding snapshot events automatically.
  Callers keep their API; the journal gets correct per-entity events.
  Verb-level code (assignments.ts, agentruns.ts, loops) migrates to
  explicit event emission opportunistically afterwards.
- `syncDirectory(deleteMissing)` keeps its trp_d5595086 guard during dual-
  write. In journal-primary mode, deletion authority moves to tombstone
  events: a projection file is only unlinked when a tombstone for its id is
  applied — "absent from in-memory state" stops being a deletion signal at
  all, which closes that bug class structurally rather than defensively.

### entity_rev

Each entity carries a monotonic `entity_rev` bumped on every event for that
id. Uses: cheap "did it change" checks for projections, optimistic-
concurrency guard for future API writes, and the conflict-detection
primitive federation needs. Stored in the event envelope, not inside the
document (keeps entity schemas untouched during migration).

## 7. Crash-matrix (invariants self-attack, round-1 honesty)

| Scenario | Outcome under this design |
|---|---|
| Crash mid-append | Torn tail quarantined on next read/write (§3); at most the in-flight mutation lost; projections untouched (journal-first means they were never written) |
| Crash between append and projection write | Journal ahead of projection; lazy reconcile converges on next read |
| Crash during seal (steps 1–4) | Ordered writes + meta-last: worst case is a checkpoint file with no meta ref (orphan, harmless) or active not yet renamed (retry seal next time); each step idempotent-checkable |
| Two writers (lock-expiry break, O2 residual) | O_APPEND prevents byte interleaving; duplicate seq detected via `(seq, writer)`; snapshot payloads make double-apply convergent; doctor warning emitted |
| Rotation during concurrent read | Sealed segments immutable; reader holding an fd on the just-sealed file still reads valid data (POSIX) — **Windows caveat:** rename of an open file can fail (EPERM/EBUSY); seal must retry/defer if the rename fails, never copy-then-delete. Flagged for test coverage |
| Clock skew | Irrelevant — ts never orders (§4) |
| 100k-event store | Replay bounded to active segment by checkpoints (§5); cold read target <1s holds |
| Journal disabled/absent (worktree without .brainclaw, trp_26e9634b) | Same failure mode as today's store access — out of scope here, but the spec must not make CLI hang harder on missing journal; ENOENT → clear error |

## 8. Migration plan (flag: `journal.mode = off | dual | primary`)

- **Phase 0 — substrate (no reader change):** envelope v2, loud appends,
  seq/meta, segments+checkpoints, cursor format migration. Journal still
  consumed only by notifications. Old `events.jsonl` (17k events) and any
  `events.<ts>.jsonl` archives are **parked** under
  `journal/legacy/` — they carry no payloads and cannot be upgraded; they
  remain audit history, not replayable state.
- **Phase 1 — dual-write (`dual`):** genesis backfill emits one
  `backfill`-action snapshot event per existing entity (current state =
  seq 1..N), then `persistStateUnlocked` diff-emission (§6) runs alongside
  the unchanged file writes. State dirs remain authoritative. Rollback =
  set `off`; nothing depended on the journal yet.
- **Phase 2 — verification:** `brainclaw doctor --verify-journal` rebuilds
  state from checkpoint+journal in a temp dir and diffs against the live
  projections; runs in CI on both OS families and in dogfooding for a full
  sprint. Exit criterion: zero divergence across a sprint of real
  multi-agent traffic, including dispatch worktree churn.
- **Phase 3 — primary (`primary`):** reads serve projections via lazy
  reconcile; deletion authority moves to tombstones; `mutateState` callers
  unchanged. **Rollback path:** projections are at all times a full
  materialized state in the exact legacy format — flipping back to `dual`
  or `off` requires no data transformation, only re-arming the legacy
  delete semantics. Backup of `.brainclaw/` taken at each phase flip
  (upgrade-style, park-don't-delete).
- **Perf gates (measured, not asserted):** `bclaw_work` cold read < 1s;
  single-entity op cost independent of store size (O(1) append + O(1)
  projection write + O(delta) reconcile); MCP per-call overhead delta
  < 50ms vs. today.

## 9. Hard-constraint compliance check

- Zero new runtime deps: JSONL + zod + node:fs only. ✓
- Windows + POSIX: O_APPEND/FILE_APPEND_DATA seatbelt, rename-of-open-file
  caveat handled, dual-platform CI mandated (trp_e85e9fbe). ✓
- File-based, git-diffable identity: projections unchanged; journal is
  append-only text. ✓
- No daemon: reconciliation only at read paths under lock. ✓ (dec'd in
  federation architecture)
- MCP worker-per-call cheap: clean-state read path adds one small meta read. ✓
- Does not regress sprint-1 lock hardening: journal lives *inside* the
  existing `mutate()` critical section; no new lock protocol introduced. ✓

## 10. Non-goals (this spec)

- Unifying per-loop journals (`loops/<id>/events.jsonl`) into the store
  journal — convergence candidate after primary mode stabilizes.
- Federation merge semantics (consumes this journal; owned by federation
  spec).
- Audit-log (`audit.ts`) consolidation.
- Query/index layer over the journal (projections are the query surface).

## 11. OPEN QUESTIONS (for cross-critique, Codex schema review, Juan)

- **Q1 (schema):** which `EventAction`s are exempt from carrying `payload`?
  Proposal: payload required iff the action mutates a persisted entity;
  lifecycle/notification actions stay payload-free. Codex: please attack
  the action-union → payload-requirement mapping for holes.
- **Q2 (product/federation):** cross-store conflict policy when two stores
  edited the same entity between pulls — entity-level LWW by pull order,
  or surface a conflict artifact for the operator? Affects whether
  `entity_rev` needs a vector component. **Juan's call.**
- **Q3 (schema/perf):** checkpoints self-contained (full post-images,
  bigger but standalone) vs. referencing (hashes of projection files,
  small but couples checkpoint validity to projection integrity)?
  Proposal leans self-contained; needs a size estimate at 20-agent scale.
- **Q4 (scope):** do assignments/agent_runs/claims (currently written via
  their own stores, not `State`) enter the journal in Phase 1 or in a
  Phase 1.5? They are the highest-churn entities — biggest win, biggest
  blast radius.
- **Q5 (ops):** exact threshold/policy for `gc` archiving of sealed
  segments — count-based, age-based, or never until federation needs
  defining?

## 12. Memory citations (per loop protocol)

Relied on: trp_d5595086 (silent-data-loss via load-swallow — drove §3 loud
failures, §6 tombstone deletion authority), feedback_lazy_reconcile_pattern
/ pln#496 (drove §6 read-path reconciliation, no daemon), trp_e85e9fbe
(dual-platform CI gates in §3/§7), trp_26e9634b (worktree-without-store
failure mode noted in §7), feedback_no_init_force / park-don't-delete house
rule (§5 retention, §8 rollback), architecture decisions: federation
Pull-and-Materialize + no-daemon (§4 federation hook, §9 compliance).
