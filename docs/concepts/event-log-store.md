# Event-Log Store — Converged Design Spec

> Synthesis (round 3) of ideation loop lop_3bf55b9492e0d96c, pln#543 step 1.
> Distills proposal-A, proposal-B, and both cross-critiques. Where the two
> round-2 VERDICT blocks agree, this spec follows them; where they diverge,
> one option is chosen and the loser recorded in Appendix A. Status: SPEC,
> product calls ARBITRATED (Juan, 2026-06-10 — see §6); pending Codex
> schema review (C1-C4).

## 1. Motivation

The 2026-06-10 review (zone 1) found that `src/core/event-log.ts` cannot
serve as the store's source of truth in its current form: appends are
swallowed on error (`appendFileSync` inside a catch-all — a journal that may
silently drop writes is not a journal), events carry no payload (state is not
reconstructible from the log), rotation at 10MB renames the file away and
**deletes all reader cursors** (silent re-notification loss, history
unreachable), and the only ordering key is a wall-clock timestamp (unreliable
across agent shells, WSL, containers). Meanwhile every state mutation already
serializes through the hardened store lock, and loops already run a
payload-carrying journal (`loops/<id>/events.jsonl`) — the substrate and the
precedent both exist. This spec evolves the event log into a write-ahead
journal of full-entity snapshots, organized as immutable segments plus
out-of-band checkpoints, with the existing per-entity JSON directories
demoted to lazily reconciled projections (the pln#496 pattern).

## 2. Design

### 2.1 Event record format

Each record is one JSONL line, zod-validated, envelope version `v: 2`
(existing events are retroactively v1):

```jsonc
{
  "v": 2,
  "seq": 18342,                  // store-global monotonic, assigned under lock
  "ts": "2026-06-10T14:03:22.114Z", // informational ONLY — never an ordering key
  "writer": "w_31416-9f3c2a",    // pid + start-nonce (NOT agent name, NOT bare pid)
  "agent": "claude-code",
  "agent_id": "agt_...",         // optional
  "user": "jberdah",             // optional
  "action": "update",            // EventAction union (see payload rule below)
  "item_type": "plan",
  "item_id": "pln_2290bc70",
  "entity_rev": 7,               // per-entity monotonic revision
  "summary": "step 1 completed", // human-facing, optional
  "payload": { /* full post-image, schema-valid entity doc */ }
}
```

Normative rules:

- **Payload = full entity snapshot** (post-image), never a diff. Required
  iff the action mutates a persisted entity; lifecycle/observability actions
  (`session_start`, `run_*` notifications) are payload-free. The exact
  action-union → payload-requirement mapping goes to Codex review (§6).
- **Tombstones**: `action: "delete"`, payload omitted. No redundant
  `deleted` boolean.
- **`(seq, writer)` is the normative event identity.** Bare `seq` is an
  address, valid only where the lock guarantees held (see §2.2 anomaly
  handling). Federation idempotency keys, dedup, and the dup-seq reducer all
  use the pair.
- **`entity_rev`** is a per-entity monotonic revision bumped on every event
  for that id, carried in the envelope (entity schemas untouched). It powers
  projection dirty-checks, the never-regress guard (§2.7), optimistic
  concurrency for future API writes, and is the local half of federation
  conflict detection.
- **New event kinds** introduced by this spec: `checkpoint_ref` (§2.4),
  `journal_note` (§2.6), `seq_repair` (§2.2), `backfill` (§4). Schemas to
  Codex review.
- **Writer identity** is pid + per-process random start-nonce. Pid reuse
  makes bare pid unreliable over a journal's lifetime; agent name is
  metadata, not identity.
- **Max record size, enforced at write time**: warn at 64 KB, hard-fail at
  256 KB with a pointer to a future `payload_ref` mechanism. The cap is the
  tripwire that tells us when the snapshot-everywhere assumption expires
  (see falsifier, §2.8).

### 2.2 Seq and ordering

- `seq` is store-global, monotonic, persisted as `next_seq` in
  `events/meta.json`, incremented **under the store mutation lock**. Every
  append — including observability events — takes the lock and gets a seq.
  There is no lockless append path and no `seq: null` record class (a
  lockless path races segment roll, and seq-less records are unaddressable
  by seq-watermark cursors).
- **Timestamps never order anything.** `ts` is for humans and notification
  summaries.
- **Tail validation at lock acquisition (normative):** before its first
  append, a writer reads the last record of the active segment and sets
  `next_seq = max(meta.next_seq, tail_seq + 1)`. If meta was behind, it
  appends a `seq_repair` event recording the correction. This re-derives
  truth from the journal (meta is a cache) and caps seq collisions to the
  single in-flight race write.
- **Two writers are NOT impossible.** The lock can be broken on presumed
  owner death, and presumed death is fallible (pid-liveness false negatives
  on Windows, pid reuse). A duplicate `seq` from distinct writers is a
  **detected anomaly**: the reducer applies both records in file order
  (snapshot payloads make double-apply convergent — the later line wins
  wholesale), and doctor emits a warning. Detection via `(seq, writer)`;
  containment via tail validation above. The journal's two-writer story is
  only as rare as lock.ts's steal rate; the spec depends on lock.ts
  identifying owners by token, not pid.
- **Scope boundary (stated so the assumption is visible when it breaks):**
  global-seq-under-lock welds event capture to lock availability. Sandboxed
  or worktree workers that cannot reach the store produce zero journal
  events until a sync point — the journal is the truth of the *store*, not
  of the *system*. The moment any roadmap item requires offline local event
  capture with later merge, this primitive is falsified and per-writer seqs
  + merge (the federation mechanism applied locally) become necessary.
  Until then, global seq costs zero new coordination and stays.

### 2.3 Segments and sealing

Layout:

```
.brainclaw/events/
  meta.json                  # next_seq + per-family last_applied_seq — rebuildable cache
  seg-00000001.jsonl         # immutable once rolled; name = first seq it contains
  seg-00018000.jsonl         # active segment (newest = append target)
  checkpoints/
    ckpt-00018000.json       # self-contained state manifest (out-of-band, §2.4)
  quarantine/                # doctor-parked bytes only (offline repair, §2.6)
  archive/
    events.v1.jsonl          # parked legacy notification log (never deleted)
```

- Segments are **named by their first seq at birth and never renamed**.
  The active segment is simply the newest one. No rename means no Windows
  EPERM/EBUSY hazard, no retry protocol, no cursor invalidation. Locating
  seq N = directory listing + binary search by filename; no index file.
- Roll when the active segment ≥ 10 MB: under the lock, write a checkpoint
  (§2.4), create the next segment, update `meta.json`. Rolled segments are
  immutable — an invariant that holds because **all** appenders take the
  lock and resolve the active segment inside it.
- `meta.json` is a single small file (one read covers staleness checks for
  everything), rewritten atomically (temp+rename), and is a **rebuildable
  cache**: if missing or corrupt it is reconstructed from the segment
  listing plus a tail read of the last segment.
- **Retention**: sealed segments are never auto-deleted. `gc` may move
  segments superseded by a *verified* checkpoint to `archive/`
  (park-don't-delete), but never past the **second-newest verified
  checkpoint** — the previous checkpoint must remain replayable as the
  fallback chain (§2.4).
- **Support boundary**: journal correctness is guaranteed on local
  filesystems only (NTFS, ext4, APFS). O_APPEND atomicity does not hold on
  SMB/NFS. `bclaw doctor` performs best-effort (heuristic) detection of UNC
  paths and mapped network drives and warns; the boundary is documented,
  not silently assumed.

### 2.4 Checkpoints

- A checkpoint is an **out-of-band, self-contained** manifest
  `checkpoints/ckpt-<seq>.json`: full post-images of every live entity at
  head seq. Never hashes referencing projection files — a checkpoint whose
  validity depends on projection integrity is useless in exactly the
  scenarios it exists for.
- Written under the lock at segment roll (and on `bclaw doctor --compact`):
  write manifest → fsync → append a `checkpoint_ref` event to the journal
  carrying the checkpoint's **sha256** → update meta last. A crash leaves
  at worst an orphan manifest with no ref (harmless) — cursors never see
  checkpoint content, the seq space is not inflated, and rebuild needs no
  terminator-scanning.
- **Verify before archive (normative):** a checkpoint must be fully
  re-parsed and schema-validated before any segment it supersedes moves to
  `archive/`. On checksum or parse failure at rebuild time, fall back to
  the previous checkpoint and replay more segments (guaranteed available by
  the two-checkpoint gc floor).
- Rebuild cost is bounded: latest verified checkpoint + replay of segments
  after it (≤ ~10 MB tail in the common case).

### 2.5 Cursors

- `AgentCursor` = `{last_seq, last_read}` — a **seq watermark**. Rotation,
  compaction, archival, and any future segment surgery cannot invalidate a
  watermark. Byte offsets are dead (they die under any file mutation,
  including the offline repairs in §2.6).
- `readUnseenEvents(agent)` = binary-search the segment containing
  `last_seq + 1` by filename, stream forward across segments.
- If the watermark predates the oldest non-archived segment, the reader
  gets `{gap: true}` plus a summary built from the latest checkpoint —
  notifications degrade gracefully; state rebuild never depended on them.

### 2.6 Append protocol, framing, torn tails

- One record = **one single-buffer write** (`"\n" + JSON + "\n"`) to an fd
  opened append-only (O_APPEND / FILE_APPEND_DATA). The lock is the primary
  concurrency guarantee; single-write atomicity on local FS is the seatbelt
  for the lock-steal window.
- The **leading `\n`** caps torn-write damage at exactly one event: if the
  previous append tore (no trailing newline), our leading newline
  terminates the fragment as its own malformed line instead of letting our
  valid record be absorbed into it.
- **Short-write check**: `bytesWritten !== buffer.length` ⇒ throw inside
  `mutate()`; the mutation fails loudly before any projection write.
- **Append failures are loud.** The current error swallow is removed for v2
  state events: a failed journal append is a failed mutation.
- Reader rules (normative):
  1. Split on `\n`, skip empty lines.
  2. A mid-file line failing parse or schema validation: skip, count,
     surface via doctor — never silently (trp_d5595086).
  3. A torn **tail** (final line, unparseable or missing trailing `\n`) is
     expected crash residue: skip it. This is correct even when the torn
     line *parses* validly — journal-first + fsync-before-projection (§2.7)
     means an unconfirmed tail can always be dropped, because the caller
     was never told "ok".
- **No hot-path rewrites, ever.** The journal is append-only; nothing
  truncates or moves bytes during normal operation. When a writer (under
  lock, before appending) detects a torn tail, it appends a `journal_note`
  event recording the fragment's segment, byte range, and content hash as
  *adjudicated*. Doctor counts adjudicated fragments separately from
  unexplained mid-file corruption — benign crash residue never raises a
  permanent alarm (alarm fatigue is how real corruption later slips
  through). Physical excision of damaged bytes into `quarantine/` exists
  only as an **offline doctor repair** (doctor holds the lock, no
  concurrent appender, parks bytes, never deletes).

### 2.7 Durability (fsync) and the journal-first invariant

- **Write order inside `mutate()` (the single most important invariant):**

  ```
  append v2 event(s) → fsync journal fd → write projection files → bump watermark in meta
  ```

  Program-order journal-first is fiction without a barrier: the OS may
  persist later projection writes before earlier journal appends, yielding
  a projection *from the future* that the journal cannot explain — which a
  reconciler would then wrongly regress (silent data loss).
- **Default: one `fsync` per `mutate()` call** — after the last append,
  before any projection write. Mutations are human-action frequency, not
  hot-loop; one fsync each is affordable on NTFS. Config escape hatch
  `store.journal.fsync: "mutation" | "never"`; **CI and tests run the prod
  default** (fidelity over speed, per the test-env-contamination history).
- **Never-regress guard (defense in depth — fsync can be configured off):**
  the reconciler refuses to overwrite a projection with replayed state that
  is *older* (lower `entity_rev`) than what the projection holds; a
  regressing mismatch is a doctor error, not a write.

### 2.8 Projections and event emission

- Projections are exactly today's per-entity JSON files — atomic,
  pretty-printed, git-diffable. They remain the store's human-readable and
  MCP-cheap representation.
- **Staleness check is O(1)**: read `meta.json`, compare per-family
  `last_applied_seq` to `next_seq - 1`. Equal (the overwhelmingly common
  case) → serve projection files directly; the MCP worker-per-call fresh
  path adds one small file read. Behind → acquire the lock, replay only the
  gap onto the projection files, bump the watermark, serve. pln#496 lazy
  reconcile; no daemon.
- **Lock contended** → serve the stale projection annotated `stale: true`
  rather than block; whoever wins the lock heals once (no thundering herd
  of identical reconciles). Whether claim-class entities may be served
  stale is a Juan call (§6).
- **Emission = diff synthesis at the persist choke point, permanently,
  plus verb-site intent annotation.** `persistStateUnlocked` computes an
  id-level diff (created / changed / removed) against the loaded state and
  synthesizes snapshot events — a single choke point provably consistent
  with what was persisted, immune to call-site drift. To preserve verb
  semantics (`claim` vs `update` vs `complete` — consumed by notifications
  and federation signaling), verb sites declare
  `(action, item_type, item_id, summary)` into the in-flight mutation
  context (today's ~30 `appendEvent` call sites already pass exactly these
  fields; they redirect to the context instead of the legacy stream); the
  diff supplies the payload and emits any *unannotated* change as `update`
  plus a doctor counter. There is **no migration to explicit call-site
  event emission** — explicit emission is justified only for registries
  that never pass through `State` (assignments/runs/loops), and those reuse
  the same append+project primitive.
- **Deletion authority** (journal-primary mode): a projection file is
  unlinked only when a tombstone for its id is applied. "Absent from
  in-memory state" stops being a deletion signal — closing the
  trp_d5595086 bug class structurally. The never-unlink-unparseable guard
  carries over on the projection side.
- **Heartbeat-class churn is never journaled.** Refresh/liveness field
  updates (claim `refreshed_at`, run heartbeats, lock metadata) are
  ephemeral — projection/registry layer only. Only lifecycle *transitions*
  (claimed, released, completed, failed) are events. Without this rule,
  20 agents × 30s heartbeats × 2 KB snapshots ≈ >100 MB/day of journal for
  zero information. **Falsifier (phase 0 deliverable):** from the dogfood
  store's 17k v1 events, compute per-item_type p95 entity size × event
  frequency; instrument event bytes by action class during the dual-mode
  sprint. If any non-heartbeat class exceeds ~50% of journal bytes, or any
  record would exceed 64 KB, that type needs `payload_ref` or a delta
  format in phase 1, not deferred.

### 2.9 Locking interplay

- The journal lives **inside** the existing `mutate()` critical section. No
  new lock protocol. Seq assignment, appends, fsync, projection writes, and
  the watermark bump all happen under the one store lock, journal-first.
- Lock-steal residual (a breaker briefly coexisting with a
  stale-but-alive owner) is handled by detection + containment (§2.2), not
  denied. The phrase "impossible by construction" is banned.
- Lock-hold growth (fsync + reconciling readers) is instrumented, not
  assumed away: the phase-1 dual sprint records lock wait-time
  distribution. **Falsifier:** p95 lock wait > ~200 ms under normal
  multi-agent load falsifies global-seq-under-lock and forces the
  per-writer-journal redesign (§2.2 boundary).
- Federation imports must chunk: a 10k-event pull takes and releases the
  lock per chunk rather than starving local agents.

## 3. Failure-mode matrix

| # | Scenario (round-2 attack) | Mitigation in this spec |
|---|---|---|
| 1 | Crash mid-append (torn tail) | Leading-`\n` framing caps loss at 1 event; reader skips tail; next writer appends adjudicating `journal_note`; doctor counts adjudicated residue separately from corruption (§2.6) |
| 2 | Torn line that parses validly | Dropped anyway: journal-first + fsync means an unconfirmed tail was never acknowledged to the caller (§2.6 rule 3) |
| 3 | Crash between append and projection write | Projection stale, never ahead (fsync barrier §2.7); lazy reconcile heals forward on next read |
| 4 | Projection from the future (no-fsync reorder) | One fsync per mutate before projection writes; never-regress guard keyed on `entity_rev` as second line (§2.7) |
| 5 | Two writers in the lock-steal window | O_APPEND seatbelt prevents byte interleaving; duplicate seq detected via `(seq, writer)`, applied in file order (snapshot double-apply is convergent), doctor warns (§2.2) |
| 6 | Seq counter corruption outliving the race (both writers rewrite meta, loser's bump lost, third writer reuses seq) | Tail validation at lock acquisition: `next_seq = max(meta, tail+1)` + `seq_repair` event; meta is a rebuildable cache, the journal is truth (§2.2) |
| 7 | Lockless appender writes into a just-rolled "immutable" segment | No lockless path exists; all appends take the lock and resolve the active segment inside it (§2.2, §2.3) |
| 8 | Crash mid-checkpoint | Out-of-band manifest; worst case orphan file with no `checkpoint_ref` (harmless); meta written last (§2.4) |
| 9 | Corrupt checkpoint discovered after segments archived | Verify-by-full-re-parse before archival; sha256 in `checkpoint_ref`; previous-checkpoint fallback; gc floor = second-newest verified checkpoint (§2.4) |
| 10 | Oversized record exits the O_APPEND atomicity envelope | Write-time cap: warn 64 KB, hard-fail 256 KB (§2.1) |
| 11 | Partial `write()` (signal, ENOSPC, quota) | Short-write check ⇒ loud mutation failure before projections (§2.6) |
| 12 | Rotation/sealing during concurrent read | Segments never renamed; active segment is just the newest file; seq watermarks survive any layout change (§2.3, §2.5) |
| 13 | Cursor predates archived history | `{gap: true}` + checkpoint-built summary; graceful notification degradation (§2.5) |
| 14 | Clock skew / ts collision | Irrelevant — ts never orders (§2.2) |
| 15 | 100k-event store cold read | Fresh path O(1) check + projection read; stale path replays only the gap; rebuild bounded by latest checkpoint (§2.4, §5) |
| 16 | `meta.json` corrupt/lost | Rebuilt from segment listing + tail read — it is a cache, not truth (§2.3) |
| 17 | Heartbeat churn floods segments (20-agent scale) | Heartbeat-class updates excluded from the journal by rule; volume falsifier instrumented (§2.8) |
| 18 | Store on a network mount | Documented local-FS-only support boundary; doctor warns heuristically (§2.3) |
| 19 | Wedged lock = no event capture; sandboxed workers can't append | Stated scope boundary: journal is truth of the store, not the system; offline capture falsifies the primitive and triggers the per-writer redesign (§2.2) |
| 20 | Mid-file malformed line (should be impossible under lock) | Skip + count + doctor alarm (unexplained-corruption class), never silent (§2.6) |

## 4. Migration plan

Flag: `store.journal_v2: off | dual | primary` (default `off`). Each phase
ships dark behind the flag; this repo's own store (~17k v1 events of real
multi-agent traffic) is the canary. A `.brainclaw/` backup is taken at every
phase flip (upgrade-style, park-don't-delete).

- **Phase 0 — format, no behavior change.** Land the v2 record schema (zod),
  segment reader/writer, meta cache, doctor counters,
  max-record-size enforcement, and the **snapshot-size falsifier
  measurement** (§2.8). v1 `events.jsonl` untouched.
- **Phase 1 — `dual`: journal-first dual-write.** One-shot
  `bclaw migrate journal`: backup store; emit a **genesis backfill** — one
  `backfill` snapshot event per current entity, built from the projection
  files (the only truth we have; the 17k payload-less v1 events are not
  translatable — parked to `events/archive/events.v1.jsonl`, readable
  forever for forensics); initialize meta. `persistStateUnlocked` reorders
  to append → fsync → existing file writes → watermark. Notifications
  switch to seq-watermark cursors. State dirs remain authoritative.
  **Rollback:** set `off` — projection files were written on every mutation
  in exactly today's format; park `events/`; zero data transformation in
  either direction.
- **Phase 2 — verification (promotion gate).**
  `bclaw doctor --verify-journal` rebuilds state from
  checkpoint + journal in a temp dir and diffs against live projections —
  the only check that validates the actual claim ("the journal is
  sufficient to reproduce state"). Runs in CI on **both OS families**,
  alongside: kill-9 storm tests (crash between append and projection must
  always converge), a two-process append stress test (N children × K
  events; assert no interleaved bytes, no lost `(seq, writer)` pairs), and
  the tail-validation test. Doctor counters (skipped lines, torn tails,
  adjudicated fragments, unannotated-diff emissions, network-FS warning)
  run always-on as continuous telemetry. **Exit criterion:** zero
  divergence across a full dogfooding sprint of real multi-agent traffic,
  including dispatch worktree churn; lock wait-time distribution recorded
  (§2.9 falsifier).
- **Phase 3 — `primary`.** Reads serve projections via lazy reconcile;
  deletion authority moves to tombstones; `mutateState` callers unchanged.
  Then per-entity ops: single-entity mutations append + patch one
  projection file without full-store load/rewrite; registries
  (assignments/runs/loops) unify on the same append+project primitive
  (entry phase is a Juan sequencing call, §6). **Rollback:** projections
  are at all times a complete materialized state in legacy format — flip
  to `dual` or `off`, re-arm legacy delete semantics, no data
  transformation.

## 5. Perf targets (measured, not asserted)

- `bclaw_work` cold read < 1 s on a 100k-event store.
- Single-entity op cost independent of store size: O(1) append + O(1)
  projection write + O(gap) reconcile.
- MCP worker-per-call overhead delta < 50 ms vs. today (fresh path = one
  extra small meta read).
- One fsync per `mutate()`; lock p95 wait < 200 ms under normal multi-agent
  load (falsifier threshold, §2.9).
- Segment roll ≈ every 2–3 weeks at current write rates (post heartbeat
  exclusion); checkpoint cost O(live entities) under lock.

## 6. OPEN QUESTIONS

Severity-ranked. Every open question from round 2 not resolved by this spec
is carried here.

### [JUAN — product calls] — RESOLVED 2026-06-10

| # | Sev | Decision |
|---|---|---|
| J1 | HIGH | **`doctor redact` ships in v1.** Immutability is "immutable except via audited `doctor redact`": tooled segment rewrite, audit-trailed, seq watermarks survive it. Rationale: the EU/GDPR positioning cannot answer "impossible" to an erasure request. (Write-time secret-detection may complement later; it does not replace redaction.) |
| J2 | HIGH | **Projections + checkpoints in git; segments and meta gitignored.** The store's git-diffable identity = the per-entity projections (diff/merge as today) plus checkpoints (single-file snapshots a human can adjudicate in a merge, making a bare git clone restorable without segments). No segment blobs in history; the branched-seq merge problem never enters git. |
| J3 | MED | **Read-through for claim-class entities.** Claims and active assignments read the journal tail even under contention — consistency before liveness for the coordination primitive (no double-work is the product promise). Tail-read cost is paid only on this hot-critical path; memory-class entities keep stale-annotated reads (§2.8). |
| J4 | MED | **Registry enters in a dedicated Phase 1.5.** Phase 1 = memory entities (low volume, proven reversibility); registry lifecycle transitions migrate once the journal is hardened in real use. Matches the off/dual/primary posture: the dispatch lifecycle is the product's credibility — it is not migrated first. |
| J5 | LOW | **Defer fine gc/archive thresholds.** The normative two-verified-checkpoint floor stands alone until federation defines its consumer; count/age knobs are trivial additive later. |

### [CODEX — schema/invariant review]

| # | Sev | Question |
|---|---|---|
| C1 | HIGH | **Envelope schema review.** Adversarially enumerate the full `EventAction` union against the payload-required rule (which actions carry payloads; holes?); tombstone semantics per item_type; schemas for `checkpoint_ref`, `journal_note`, `seq_repair`, `backfill`, genesis records; dup-seq reducer semantics for `(seq, writer)` collisions. |
| C2 | HIGH | **Payload schema versioning.** The envelope has `v: 2`, but entity payloads are zod-schema'd documents that will evolve. How does replay handle a checkpoint or old segment whose payloads predate a schema change — version field inside payloads, migration-on-replay, or schema-version in the envelope per record? Must be answered before phase 1 freezes the record format. |
| C3 | MED | **Snapshot-size falsifier** (phase-0 measurement): p95 size × frequency per item_type from the dogfood store. If a poison combination exists (record > 64 KB or segment rolls faster than ~weekly), `payload_ref` enters phase 1 and the record schema changes — decide before the format ships. |
| C4 | MED | **Federation conflict primitive** (with federation spec owner): scalar `entity_rev` + origin tag vs. a vector component; `(origin_store_id, seq)` slice transfer rules (segment slices must be header-prefixed). The journal design is agnostic; deciding now would front-run the federation architecture. |

## Appendix A — Rejected alternatives

- **Diff/patch payloads (RFC 6902 or field-deltas).** Every event becomes
  load-bearing: one torn line poisons all later state for that entity, and
  zero-dep means hand-rolling a patch engine. Snapshots are idempotent,
  self-healing, and compaction-trivial. (Both proposals; unanimous.)
- **A's rename-based sealing (`active.jsonl` → range name).** Contradicts
  its own cursor format (offsets dangle after rename), and rename-of-open-
  file is the exact Windows EPERM/EBUSY hazard it then needs retry logic
  for. Segments are born with their permanent first-seq name.
- **A's byte-offset cursors `{segment_id, offset}`.** Die under rename,
  under quarantine truncation, and under any future segment surgery
  (including J1 redaction). Seq watermarks survive all of it.
- **A's writer-inline torn-tail quarantine (truncate + move bytes).** A
  read-modify-write of the journal on the hot path: breaks append-only,
  races the very lock-steal window the seatbelt exists for, and can
  quarantine a live in-flight write. Demoted to offline doctor repair.
- **A's `fsync: rotate` default (no fsync per mutation).** Program-order
  journal-first without a barrier permits projections from the future and
  silent reconciler regression — the trp_d5595086 class. One fsync per
  mutate is affordable at human-action mutation rates.
- **B's in-journal checkpoint event runs (+ terminator).** Pollutes every
  seq-watermark cursor with O(entities) phantom events, leaves headless
  runs on crash that are schema-identical to real events, and stretches
  lock hold time. Out-of-band manifests have none of these.
- **A's "referencing" checkpoint variant (hashes of projection files).**
  Circular: a rebuild-from-truth artifact whose validity depends on
  projection integrity is useless precisely when projections are suspect.
  Killed without further study.
- **B's lockless observability appends (`seq: null`).** Races segment roll
  into "immutable" files, and seq-less records are unaddressable by B's own
  seq-watermark cursors. All appends take the lock; revisit only if
  instrumentation shows notification contention.
- **B's `(writer_id, writer_seq)` per-writer counter in the envelope.**
  Serves only federation and is derivable later; `entity_rev` serves three
  local masters today. Dead weight dropped.
- **B's `deleted: true` tombstone boolean.** Redundant with
  `action: "delete"`; one source of truth in the envelope.
- **B's two meta files (`HEAD.json` + `projections.json`).** Two reads per
  MCP call, two renames per mutation, plus cross-file ordering reasoning,
  for state always consumed together. Single `meta.json`, keeping B's
  rebuildable-cache property.
- **Migration to explicit verb-site event emission (A's end-state).** ~30
  call sites each become a chance to forget, double-emit, or
  emit-without-persisting. The diff choke point is provably consistent
  with what was persisted; verb semantics are preserved by intent
  annotation instead. Conversely, **pure diff with no annotation** (B's
  letter) was also rejected: it collapses the EventAction union to generic
  `update`, losing semantics notifications and federation signaling consume.
- **Splitting notification stream from state journal now (B Q6).** Same
  journal is simpler — one reader, one cursor type, one ordering; split
  only if volume instrumentation demands it.
- **Separate journal per entity (vs. one per store).** Global order comes
  free with one journal; per-entity journals reintroduce cross-entity
  ordering as a problem. (Proposal A §0; never contested.)

## Appendix B — Memory citations (union of rounds 1–2)

trp_d5595086 (silent-loss-via-swallow → loud appends, doctor-visible skips,
tombstone deletion authority, never-regress guard);
feedback_lazy_reconcile_pattern / pln#496 (read-path reconciliation, no
daemon); trp_e85e9fbe (dual-platform CI gates, Windows/POSIX divergence
discipline); trp_26e9634b (missing-store failure mode); trp_09988deb
(upgrade-style backups); feedback_no_init_force + park-don't-delete house
rule (retention, quarantine, archives, rollback);
federation_architecture_decisions + cross_project_signaling_vs_execution
(Pull-and-Materialize substrate, signaling-only foreign writes, no daemon);
feedback_bisect_state_before_code (doctor counters over silent skips);
feedback_ideation_loop_single_agent_method (multi-instance multi-round
method that produced this spec).
