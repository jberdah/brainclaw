# Event-Log Store — Converged Design Spec

> Synthesis (round 3) of ideation loop lop_3bf55b9492e0d96c, pln#543 step 1.
> Distills proposal-A, proposal-B, and both cross-critiques. Where the two
> round-2 VERDICT blocks agree, this spec follows them; where they diverge,
> one option is chosen and the loser recorded in Appendix A. Status: SPEC,
> product calls ARBITRATED (Juan, 2026-06-10 — see §6); C1–C4 resolved by
> the symmetric schema review of 2026-06-10 (§2.1.1–2.1.4, §2.2, §2.10,
> §2.11); residue R1–R4 + new product call J6 in §6, pending the Codex
> second pass.

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
  (`session_start`, notification verbs) are payload-free. The normative
  action-class → payload-requirement mapping is §2.1.1.
- **Tombstones**: `action: "delete"`, payload omitted. No redundant
  `deleted` boolean. Per-item_type semantics in §2.1.3.
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
  `journal_note` (§2.6), `seq_repair` (§2.2), `backfill` (§4). Normative
  schemas in §2.1.2.
- **Writer identity** is pid + per-process random start-nonce. Pid reuse
  makes bare pid unreliable over a journal's lifetime; agent name is
  metadata, not identity.
- **Max record size, enforced at write time**: payloads > 64 KB are
  externalized via `payload_ref` (§2.10); the *envelope line* hard-fails at
  256 KB (with payload_ref no legitimate record approaches it). The cap is
  the tripwire that tells us when the snapshot-everywhere assumption expires
  (see falsifier, §2.8 — it fired on handoffs in phase 0, hence §2.10).

#### 2.1.1 Action taxonomy → payload requirement (C1 resolution)

The v2 `action` field extends today's `EventAction` union
(`src/core/event-log.ts`, 34 members) with five journal-meta actions
(`checkpoint_ref`, `journal_note`, `seq_repair`, `backfill`,
`federation_apply`) and three progress-split verbs (`run_progress`,
`assignment_amended`, `run_amended` — see the heartbeat/durable split
below), and classifies every action into exactly one of five classes.
`EventItemType` gains `journal` (journal-meta records) and, at registry
unification (§4 phase 3), `loop`.

**Encoding (R1 resolution, 2026-06-12):** the class is **never
serialized** — `action` remains the only discriminant on the wire. Code
carries one `ACTION_CLASS_BY_ACTION` table typed
`satisfies Record<EventAction, ActionClass>` so adding a 35th action
without classifying it is a compile error, and the zod schema is a
discriminated union keyed on `action` (zod ≥ 4 accepts enum values per
branch — 4.4.3 is the installed runtime dep). The phase-gated payload
requiredness of registry-lifecycle (OPTIONAL until phase 1.5) is a
runtime refinement selected by journal mode
(`off | dual | primary | registryPrimary`), not a frozen schema variant —
the wire format never changes across the cutover, only the validator
strictness. A serialized `class` field was rejected: a derived persisted
field is drift waiting to happen (same failure family as trp#180).

| Class | Actions | `payload` | `item_id` | `entity_rev` |
|---|---|---|---|---|
| entity-state | `create`, `update`, `accept`, `reject`, `claim`, `release_claim`, `rollback`, `upgrade`, `backfill` | REQUIRED — versioned post-image (§2.1.4) or `payload_ref` (§2.10) | REQUIRED | REQUIRED, bumped |
| tombstone | `delete` | FORBIDDEN | REQUIRED | REQUIRED, bumped |
| journal-meta | `checkpoint_ref`, `journal_note`, `seq_repair`, `federation_apply` | REQUIRED — meta-schema per action (§2.1.2), never an entity post-image | FORBIDDEN (`item_type: "journal"`) | absent |
| observability | `session_start`, `session_end`, `assignment_offered`*, `assignment_progress`†, `run_progress`† | FORBIDDEN | optional | absent |
| registry-lifecycle | `assignment_created/accepted/started/completed/cancelled/failed/blocked/timed_out/expired/retrying/rerouted`, `assignment_amended`†, `run_amended`†, all other `run_*` (`run_running` = the transition into running, emitted once†) | OPTIONAL until registry families go journal-primary (J4 phase 1.5); REQUIRED post-image from then on | REQUIRED | absent until phase 1.5, then REQUIRED, bumped |

\* `assignment_offered` is a status transition of the assignment doc and
moves to registry-lifecycle at phase 1.5; until then it is notification-only.
† See the heartbeat/durable-progress split below.

Holes found by the adversarial enumeration, resolved as follows:

- **`item_id` is optional in today's `MemoryEvent`.** v2 makes it REQUIRED
  for entity-state, tombstone, and registry-lifecycle records — a
  payload-carrying or rev-bumping record without an addressable entity is
  unreplayable and rejected at write time.
- **Heartbeat vs durable progress (pre-P0 codex review, 2026-06-12).**
  Today's code conflates the two on a single verb:
  `recordAssignmentProgress` persists `status_reason` and **appends to
  `artifacts`** (durable, accumulating state) on the same path that bumps
  `last_heartbeat_at`, then emits `assignment_progress`
  (`assignments.ts:296-301`); `recordAgentRunProgress` likewise mutates
  `session_id`/`status_reason`/`artifacts` and re-emits `run_running` on
  every tick (`agentruns.ts:318-325`). If those verbs stayed
  heartbeat-class/no-replay, journal-primary replay would silently drop
  artifacts reported mid-run. Normative invariant: **any event reflecting
  a durable-field mutation must be replayable by the phase its family goes
  journal-primary.** Resolution, effective at phase 1.5 (no write-path
  code change before then):
  - `assignment_progress` and `run_progress` (new) are **pure ticks** —
    observability-class, payload FORBIDDEN, touching only ephemeral-class
    fields (`last_heartbeat_at`, `updated_at`, `last_event_at`); excluded
    from replay, exactly as §2.8 masks them.
  - `run_running` re-scopes to the status **transition into** running —
    registry-lifecycle, emitted once per transition, never as a tick.
  - A progress call that carries durable mutations (`status_reason`,
    `artifacts`, `session_id` binding) emits `assignment_amended` /
    `run_amended` instead — registry-lifecycle, REQUIRED post-image,
    `entity_rev` bumped. The write path splits on argument presence;
    existing tests that assert artifacts-on-progress move to the amended
    verbs with the phase 1.5 migration.
- **Whole-store operations** (`rollback`, `upgrade` — today emitted once
  with `item_type: "state"`): in v2 the diff choke point (§2.8) emits them
  *per entity* (entity-state class, post-image each), plus one
  `journal_note` kind `store_marker` recording the store-level operation
  for audit. The coarse `item_type: "state"` event class disappears; the
  `state` item_type survives only inside `store_marker` notes.
- **Compactor archival vs deletion**: archival removal emits `delete` with
  `summary: "archived"` (the archived copy lives outside live dirs and is
  not journal-visible). Restore emits `create` continuing the entity_rev
  counter. **`entity_rev` is per item_id and never resets**, including
  across delete→recreate — required by federation LWW (§2.11).
- **Sessions stay observability-class.** `current_session` /
  `session_snapshot` docs remain projection-only (ephemeral-class, like
  heartbeats); if sessions ever need replay they move to entity-state, but
  nothing today consumes a replayed session.

#### 2.1.2 Journal-meta record schemas (C1 resolution)

All journal-meta records use `item_type: "journal"`, omit `item_id` and
`entity_rev`, and carry a payload discriminated as follows:

```jsonc
// checkpoint_ref — appended AFTER manifest fsync (§2.4)
{ "action": "checkpoint_ref", "item_type": "journal", "payload": {
    "file": "ckpt-00018000.json",  // name under checkpoints/
    "sha256": "…",                  // hash of the manifest bytes
    "head_seq": 18342,              // last seq the manifest covers
    "entities": 913,                // live entity count
    "bytes": 481332,
    "blobs": ["…"]                  // payload_ref closure (§2.10); [] if none
} }

// journal_note — discriminated by payload.kind
{ "action": "journal_note", "item_type": "journal", "payload": {
    "kind": "torn_tail_adjudicated",
    "segment": "seg-00018000.jsonl",
    "byte_start": 104832, "byte_end": 105219,
    "sha256": "…" } }                // hash of the adjudicated fragment
{ "payload": { "kind": "genesis",    // phase-1 migration marker (§4)
    "migrated_from": "v1", "v1_events_parked": 17727,
    "backfill_count": 913, "tool_version": "…" } }
{ "payload": { "kind": "redaction",  // J1 audit trail — doctor redact
    "segments": ["seg-00000001.jsonl"],
    "redacted": [{ "seq": 1234, "writer": "w_…" }],
    "reason": "…", "by": "…" } }
{ "payload": { "kind": "store_marker",  // whole-store ops (§2.1.1)
    "op": "rollback",                   // "rollback" | "upgrade"
    "detail": "…" } }

// seq_repair — tail-validation correction (§2.2)
{ "action": "seq_repair", "item_type": "journal", "payload": {
    "meta_next_seq": 18301,    // stale value found in meta.json
    "tail_seq": 18342,         // observed at the active-segment tail
    "repaired_next_seq": 18343 } }

// federation_apply — local record of an applied remote slice
// (required by identity-model-proposal §"local apply"; declared NOW so
// the frozen v2 union needs no post-freeze extension — emitted only once
// federation ships, inert until then)
{ "action": "federation_apply", "item_type": "journal", "payload": {
    "origin_id": "org_a1b2…", "origin_epoch": 3,
    "seq_range": [120, 184],        // remote seqs covered by the slice
    "applied": 64,                   // records materialized locally
    "conflicts": 1,                  // LWW losers surfaced as candidates (§2.11)
    "slice_sha256": "…" } }          // hash of the ingested slice bytes
```

`backfill` is **entity-state class**, not journal-meta: normal envelope
with `item_type`/`item_id`/`entity_rev`/payload. Genesis (§4 phase 1) = one
`journal_note` kind `genesis` followed by one `backfill` per live entity
with `entity_rev: 1`, all under a single lock hold. Doctor-initiated
re-syncs reuse `backfill` with the entity's current rev + 1.

#### 2.1.3 Tombstone semantics per item_type (C1 resolution)

- Payload FORBIDDEN; `item_id` REQUIRED; `entity_rev` bumped. The rev
  counter survives deletion (§2.1.1 — never resets per item_id).
- Projection unlink happens iff a tombstone is applied (§2.8). The
  never-unlink-unparseable guard **wins over the tombstone**: the file is
  preserved and the divergence is a *persistent, counted* doctor item —
  divergence-by-design, distinct from corruption.
- Singleton item types (`state`, `session`) never tombstone —
  schema-forbidden; an encountered one is a doctor error.
- Claims: lifecycle release is `release_claim` (entity-state, post-image
  with `status: released`); `delete` on a claim appears only from prune.
- Archival is `delete` + `summary: "archived"` (§2.1.1), not a distinct
  action.

#### 2.1.4 Payload schema versioning (C2 resolution)

Decision: **version-in-payload + migration-on-replay, reusing the existing
versioned-document registry** (`src/core/migration.ts`). No new envelope
field.

- Every entity payload — and every checkpoint post-image — is persisted
  exactly as its projection file is today: the document carries
  `schema_version` and is registered in the migration registry keyed by
  `VersionedDocumentType`.
- Replay runs each payload through the same detect → stepwise-migrate →
  zod-validate path projections already use (`loadVersionedJsonFile`
  semantics). One mechanism, one registry, one set of migration tests —
  the journal adds zero new versioning machinery.
- The envelope's `v: 2` governs ONLY envelope shape (seq/writer/action
  fields). Envelope and payload version independently.
- **Migration-retention invariant (normative):** journal immutability makes
  migration paths load-bearing — a stepwise migration may never be deleted
  while any non-archived segment, or either of the **two** newest verified
  checkpoints, contains a payload at the pre-migration version. (Two, not
  one: the §2.4 fallback chain replays from the second-newest checkpoint,
  so the version floor is the state of the *second-newest* checkpoint.)
  Checkpoints rewrite post-images at current schema versions when written,
  so each checkpoint advances the floor; in the common case replay spans
  only the post-checkpoint tail (weeks of records, ≤ 1–2 schema versions).
  Archived segments may outlive migration paths: doctor warns
  "archive predates migration floor" rather than promising eternal
  replayability of archives.
- **Replay validation failure** (unknown version / migration throws / zod
  fails): skip + count + doctor (the §2.6 mid-file rule). If the failed
  record is the entity's *newest*, the projection keeps its current content
  (never-regress, §2.7) and the entity is flagged divergent — rebuild never
  silently regresses to the previous snapshot.

Alternatives rejected (recorded in Appendix A): per-record envelope
schema-version (redundant — payloads self-describe); segment-rewrite
migration (violates immutability and J1's audited-rewrite-only rule).

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
  identifying owners by pid + random token (verified against today's
  `lockIsOwnedByCurrentProcess` — token-based, pid reuse alone cannot forge
  ownership).
- **Dup-seq reducer semantics (normative, C1 resolution).** Replay
  processes records strictly in (segment, file-line) order — never sorted
  by seq. Collision cases:
  1. Identical `(seq, writer)`, identical payload bytes → idempotent
     duplicate (e.g. ambiguous-retry residue): second occurrence skipped,
     doctor counter.
  2. Identical `(seq, writer)`, different content → doctor **ERROR**
     (should be impossible — a writer never reuses its own seq); both
     applied in file order, later wins, entity flagged.
  3. Same `seq`, different writers → the lock-steal anomaly above: both
     applied in file order, doctor **WARNING**.
  4. `entity_rev` ties produced by case 3 on the same entity: later file
     order wins wholesale; the never-regress guard (§2.7) treats
     equal-rev-different-writer as a doctor-flagged overwrite, not a
     regression.
  5. `entity_rev` *gaps* during replay (expected prev+1, observed larger):
     doctor warning (possible lost event) — snapshot payloads self-heal
     state, the counter records that history is incomplete.
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
  head seq ("self-contained" = manifest + its blob closure once
  `payload_ref` exists — §2.10). Never hashes referencing projection files — a checkpoint whose
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
- **Cursor key and self-exclusion.** Cursors are keyed today by agent
  *name*; the identity-model proposal re-keys them name → actor instance
  (its migration step 3 — one-time rename, cursors are caches). v2
  self-exclusion compares the record's `writer` (or actor id), never the
  display name: three same-name claude-code instances sharing one cursor
  and consuming each other's notifications was an observed incident
  (2026-06-10).

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
  carries over on the projection side. The **same id-level diff** that
  synthesizes events is what drives the unlink — one diff, two consumers,
  cannot disagree (today's `deleteMissing` path and event emission are
  separate code; v2 fuses them). The coarse `agent: "system"` /
  `item_type: "state"` ping today's `persistStateUnlocked` appends is
  replaced by the per-entity diff events.
- **Heartbeat-class churn is never journaled.** Refresh/liveness field
  updates (claim `expires_at` extensions, run `last_heartbeat_at`,
  assignment `last_progress`, lock metadata) are ephemeral —
  projection/registry layer only. Only lifecycle *transitions* (claimed,
  released, completed, failed) are events. Without this rule, 20 agents ×
  30s heartbeats × 2 KB snapshots ≈ >100 MB/day of journal for zero
  information.
- **Ephemeral-field masking (normative consequence).** Ephemeral fields
  mutate projections without journal events or `entity_rev` bumps, so a
  projection can legitimately differ from replayed state at *equal* rev.
  Therefore: the reconciler never overwrites a projection at equal rev (it
  only fills gaps forward), `doctor --verify-journal` masks the ephemeral
  field set per item_type before diffing, and the §2.8 diff synthesizer
  emits **no event** for ephemeral-only changes. The ephemeral field set
  is declared once per schema — a single source consumed by all three. **Falsifier (phase 0 deliverable):** from the dogfood
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
  per-writer-journal redesign (§2.2 boundary). Note for the instrumented
  baseline: today's `persistStateUnlocked` already runs a **git commit**
  (`commitMemoryChange`) inside the critical section — the pre-existing
  dominant lock-hold term. The fsync the journal adds is marginal against
  it; attribute wait-time per phase (append/fsync/projection/git) so the
  falsifier indicts the right component.
- Federation imports must chunk: a 10k-event pull takes and releases the
  lock per chunk rather than starving local agents.

### 2.10 Oversized payloads — `payload_ref` and the handoff diet (C3 resolution)

The phase-0 measurement (`event-log-store-phase0-measurements.md`) fired
the §2.8 falsifier: handoff entities are p50 109,700 B / p95 225,157 B —
15–45× over the 64 KB threshold at p50 already — while every other
item_type sits at p95 ≤ 7.5 KB. Per C3's own rule this enters **phase 1**;
the record format ships with it. Two composable mechanisms, **both
adopted**:

1. **Handoff diet (primary fix).** The dominant bytes are the inline
   `snapshot.diff` (same root cause as the 41 MB
   `handoffs/compacted.jsonl`). Externalize `snapshot.diff` from the
   handoff document to a content-addressed attachment under
   `events/blobs/` referenced by hash; the handoff entity returns to the
   2–8 KB class every other entity lives in. One move fixes the journal
   record size, checkpoint size, J2's git posture, and the legacy
   compacted.jsonl pathology. The schema change rides the existing
   migration registry (§2.1.4). Product call J6 (§6) confirms portability
   implications.
2. **`payload_ref` (permanent safety net).** If a serialized payload
   exceeds 64 KB, the writer stores it at
   `events/blobs/<sha256[0:2]>/<sha256>` (content-addressed, write-once)
   and the record carries `payload_ref: { sha256, bytes }` *instead of*
   `payload`. Readers resolve transparently; a missing or hash-mismatched
   blob is a doctor **ERROR** for that entity — never silent.
   - **Blob-before-ref ordering (normative):** the blob is written and
     fsync'd *before* the journal append that references it — the §2.7
     barrier extended one link left. A crash between the two leaves an
     orphan blob (harmless, gc-able), never a dangling ref.
   - **Checkpoint closure:** checkpoints store oversized post-images as
     the same `payload_ref` (manifests stay small); the
     `checkpoint_ref.payload.blobs` list (§2.1.2) enumerates the closure.
     "Self-contained" (§2.4) is redefined as *manifest + blob closure*;
     verify-before-archive verifies the manifest hash AND presence + hash
     of every blob in the closure.
   - **Blob gc:** park-don't-delete. A blob moves to `archive/blobs/` only
     when referenced by zero records in non-archived segments AND by
     neither of the two newest verified checkpoints' closures — the §2.3
     floor extended verbatim.
   - **Redaction closure (J1 × `payload_ref`, normative — resolves the
     blocking half of R2, 2026-06-12):** `doctor redact` of a record whose
     payload lives in a blob must also **delete the blob** (true erasure —
     the one exception to park-don't-delete; an erasure request is not
     satisfied by parking) AND regenerate any checkpoint whose closure
     references it *before* the redaction completes — manifest rewritten
     minus the redacted post-image, re-verified, the stale checkpoint
     parked. The redaction `journal_note` (§2.1.2) lists rewritten
     checkpoints alongside segments. Invariant: after `doctor redact`
     returns, no live segment, no `archive/blobs/` entry, and no
     checkpoint closure can yield the redacted bytes. The *federation*
     half of R2 (peer re-presenting a pre-redaction record or checkpoint)
     stays open in §6 — it cannot be closed before the federation
     transport exists.
   - **Git (J2 boundary):** `events/blobs/` is gitignored like segments.
     With the diet in place no live entity ships an oversized payload, so
     bare-clone restorability from projections + checkpoints holds in
     practice; doctor flags any checkpoint whose closure references a
     gitignored blob as not-clone-restorable. This becomes a real product
     trade-off only if J6 rejects the diet.

Residual falsifier follow-up: `runtime_note`/`session` event *count* (10k
of 17.7k v1 events) is volume, not bytes — both classes are payload-free
in v2 (observability), so they contribute line overhead only (~2–3 MB at
historical rates) and do not threaten the weekly-roll target. No per-class
retention knob needed ahead of J5.

### 2.11 Federation conflict primitive (C4 resolution)

Cross-checked against `identity-model-proposal.md` (origin-partitioned
write authority; scalar `entity_rev` + origin tag;
`(origin_id, origin_epoch, seq)`-headed slices — the epoch handles
restore-from-backup, see the proposal). Both symmetric reviews attacked the
same concurrent-edit hole independently and produced two complementary
detection mechanisms; this section reconciles them (coordinator synthesis
2026-06-11, flagged for Codex adjudication in §6 R-C4).

- **Execution entities** (claims, runs, locks, assignments): single-writer
  per origin; other origins materialize read-only. Authority partition
  means no concurrent-write conflict exists; the scalar is trivially
  sufficient. (The advisory cross-machine claim race is *arbitration*, not
  journal conflict — deferred to the cloud dispatcher per the proposal.)
- **Memory entities**: LWW ordered by the total order
  `(entity_rev, origin_id)` — rev first, origin_id lexicographic as the
  deterministic tiebreak. **No wall clock anywhere** (the "LWW by what
  clock?" answer: by revision counter + origin id, never time). Convergent:
  every origin applying the same record set reaches the same head.
- **The attack (resolution ≠ detection):** origin A edits entity e
  rev 7→8→9; origin B, offline, edits e 7→8. B's slice reaches A after A
  is at rev 9. *Resolution* is correct (9 > 8, deterministic LWW). But
  *detection* — the proposal's "conflicts surface as candidates, never
  silent overwrite" — cannot be decided from head comparison: B's rev-8 is
  concurrent with A's lineage, not an ancestor of it, and a bare scalar
  head cannot distinguish "stale copy of what I already incorporated" from
  "divergent edit with a lower rev".
- **Adopted detection rules (two, complementary — reconciled with the
  identity proposal's hardened model):**
  1. **PRIMARY — `base_rev` fast-forward check** (from the identity
     proposal, post-review): every *exported* memory-entity record carries
     `base_rev`, the rev the write was based on. Receiver rule: incoming is
     a clean fast-forward iff `incoming.base_rev >= current.rev`; otherwise
     the write was concurrent → LWW materializes the winner AND a conflict
     candidate carries both post-images. One integer per exported record,
     decided from the record alone — **independent of local history
     retention**, so it survives gc/compaction and works on a fresh
     materialize.
  2. **DEFENSE-IN-DEPTH — `(rev, origin)` journal collision at replay**:
     import replays the incoming slice through the reducer; an incoming
     record whose `(item_id, entity_rev)` already exists locally **with a
     different origin** is a conflict (the §2.2 dup-detection generalized
     from `(seq, writer)`). Catches legacy/foreign slices lacking
     `base_rev` and cross-checks rule 1, at zero envelope cost — but only
     reaches back to the gc floor.
  In the attack above, both rules fire: B's record has `base_rev 7 <
  current rev 9` (rule 1) and B's (e, 8) collides with A's journaled
  (e, 8) (rule 2) → candidate surfaced while LWW keeps A's rev 9.
- **Residual miss-window, now narrow:** only a record that *lacks*
  `base_rev` (legacy exporter) AND whose colliding rev is archived past
  the gc floor escapes surfacing — convergence still never breaks.
  The per-origin high-watermark map (a bounded vector clock, size =
  origin count, typically ≤ 3) remains the **named upgrade path** if dogfooding
  shows missed candidates; it slots into import metadata without touching
  the envelope, which stays origin-agnostic (origin appears only in
  exported slice headers, per the proposal's migration step 2).
- **Cross-requirement flowing back to the identity proposal:**
  `entity_rev` must never reset per item_id — tombstone → recreate
  continues the counter (§2.1.1/§2.1.3) — otherwise (rev, origin)
  collisions become false positives after delete→recreate races.

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
| 10 | Oversized record exits the O_APPEND atomicity envelope | Payloads > 64 KB externalized via `payload_ref` (§2.10); envelope line hard-fails at 256 KB (§2.1) |
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
| 21 | Crash between blob write and referencing append | Blob-before-ref ordering: worst case an orphan blob (harmless, gc-able), never a dangling `payload_ref` (§2.10) |
| 22 | `payload_ref` blob missing or hash-mismatched at read | Doctor ERROR for that entity, read fails loudly — never silent (§2.10) |
| 23 | Replay diff flags ephemeral-only field drift as divergence | Ephemeral field set masked per item_type in verify-journal and the reconciler; equal-rev projections never overwritten (§2.8) |

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
  Phase 1 also lands `payload_ref` + the handoff diet (§2.10) — the
  phase-0 falsifier fired on handoffs, so the record format ships with
  both.
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

### Phase 2 gate status (pln#565, 2026-06-12)

The promotion gate is now **mechanically checkable** via one command and an
automated hardening suite. Status of each Phase-2 exit criterion:

| Criterion | Status | Evidence |
| --- | --- | --- |
| Journal reproduces projections (the core claim) | ✅ | `brainclaw doctor --verify-journal` — rebuilds from journal, diffs vs live projections, exit 1 on drift. GREEN on this repo's store (mode=dual). |
| Tail validation / torn-tail adjudication | ✅ | `journal-v2.test` (torn tail → `torn_tail_adjudicated`, stale meta → `seq_repair`). |
| Two-process append stress | ✅ | `journal-concurrency.test` — N processes × K appends, gap-free 1..N*K seq, N distinct writers, zero torn/lost. |
| Kill-9 storm convergence | ✅ | `journal-concurrency.test` — SIGKILL mid-append storm: journal stays readable, seqs never duplicate, post-storm append re-derives a non-colliding seq, state still materializes. |
| Migration + rollback tooling | ✅ | genesis backfill + `rollbackJournal` (park `events/`, projections untouched). |
| Dual-OS CI | ✅ | `.github/workflows/ci.yml` matrix `[ubuntu, windows]`. |
| **Zero divergence across a real multi-agent sprint** | ✅ | seq#47 (2026-06-12): 4 parallel claude-code lanes + dispatch worktree churn + 4 merges → `verify-journal` zero drift throughout. |
| Lock wait-time distribution (§2.9 falsifier) | ◐ | Lock serialization proven under contention by `journal-concurrency.test`; explicit p50/p95 telemetry via doctor counters is the one remaining instrumentation item — lands with the cutover (it touches the mutate hot path). |

**Verdict:** the correctness gate is GREEN. The only residual is wait-time
*telemetry* (not a correctness blocker). The primary cutover (Phase 3) is a
Juan sequencing call (§6) and a distinct implementation chantier (tombstones +
per-entity append/patch), not gated on more verification.

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

### [JUAN — new product call raised by C3]

| # | Sev | Question |
|---|---|---|
| J6 | MED | **Handoff diet (§2.10):** externalize `snapshot.diff` from handoff documents to content-addressed blob attachments. Affects handoff export/import and federation transfer (the blob closure must travel with the document). Recommended: **accept** — it also fixes the 41 MB `compacted.jsonl` class and keeps J2's bare-clone restorability intact. |

### [CODEX — schema/invariant review] — RESOLVED 2026-06-10 (symmetric pass)

| # | Sev | Resolution |
|---|---|---|
| C1 | HIGH | Resolved in §2.1.1 (action taxonomy, 5 classes, holes closed: required `item_id`, `assignment_progress` heartbeat-class, store-ops per-entity + `store_marker`, archival-vs-delete, rev-never-resets), §2.1.2 (journal-meta schemas incl. genesis + J1 redaction audit note), §2.1.3 (tombstones per item_type), §2.2 (dup-seq reducer, 5 normative cases). |
| C2 | HIGH | Resolved in §2.1.4: version-in-payload + migration-on-replay reusing the existing `migration.ts` versioned-document registry; migration-retention invariant pinned to the *second-newest* checkpoint; alternatives in Appendix A. |
| C3 | MED | Falsifier FIRED on handoffs (phase-0 measurements). Resolved in §2.10: handoff diet (primary) + `payload_ref` (safety net), blob-before-ref ordering, checkpoint blob closure, gc floor extension, J2 git posture. Residual product call → J6. |
| C4 | MED | Resolved in §2.11 against `identity-model-proposal.md`: scalar `(entity_rev, origin_id)` survives — convergence intact; conflict *surfacing* via (rev, origin) journal collision; documented miss-window past the gc floor with the per-origin watermark as named upgrade path. |

### [CODEX pre-P0 review] — RESOLVED 2026-06-12 (claude-code, codex out of credits)

Codex's final pass before P0 implementation surfaced 5 findings; all
verified against code and resolved in this revision:

| # | Sev | Resolution |
|---|---|---|
| F1 | MED/HIGH | `assignment_progress` carried durable state (`status_reason`, `artifacts`) on the heartbeat path — un-replayable as specced. Resolved in §2.1.1: heartbeat/durable split (`assignment_progress`/`run_progress` = pure ticks; `assignment_amended`/`run_amended` = registry-lifecycle with post-image), effective phase 1.5. |
| F2 | MED | Same ambiguity on `run_running` (re-emitted per tick). Resolved with F1 — one decision: `run_running` = transition-only; ticks move to `run_progress`. |
| F3 | MED | `federation_apply` required by the identity proposal but absent from the taxonomy. Resolved: declared as journal-meta NOW (§2.1.1 table + §2.1.2 schema), inert until federation ships — avoids a post-freeze union extension. |
| F4 | MED | Redaction × payload_ref/checkpoints under-specified. Blocking half resolved in §2.10 (redaction closure: blob deletion + checkpoint regeneration, normative invariant); federation re-import half stays open as R2 below. |
| F5 | LOW | Spec said 32 `EventAction` members; code has 34. Corrected in §2.1.1. |

### [CODEX residue — needs a second model's schema instincts]

| # | Sev | Question |
|---|---|---|
| R1 | MED | ~~Zod encoding of §2.1.1~~ **RESOLVED 2026-06-12** (codex recommendation, claude-code verified zod 4.4.3 installed): `action` stays the only discriminant — no serialized `class` field (derived-field drift, trp#180 family). `ACTION_CLASS_BY_ACTION` table `satisfies Record<EventAction, ActionClass>` for compile-time exhaustiveness; zod discriminatedUnion on `action` enums per class; phase-gated payload requiredness = runtime refinement by journal mode, not schema variants. See §2.1.1. |
| R2 | MED | **Redaction × cursors × federation — federation half only** (blob/checkpoint closure resolved in §2.10). Does seq-watermark survival hold for a cursor positioned *inside* a redacted range? And the re-import hole: a federation peer that pulled a record pre-redaction can re-present it — `(seq, writer)` dedup would *reject* the redacted copy (good) but the peer's checkpoint may still embed the payload. The redaction note likely needs to propagate as a federation signal; decide with the federation transport (cannot be closed before it exists). |
| R3 | LOW | **Ephemeral field set enumeration (§2.8).** Adversarial sweep of the real zod schemas for fields beyond `last_heartbeat_at` / claim `expires_at` / `last_progress` that mutate without semantic change (counters, denormalized caches?) — the masking set must be complete or verify-journal cries wolf. |
| R4 | LOW | **C4 miss-window sizing (§2.11).** Gc-floor window (weeks) vs realistic offline-origin durations; should the per-origin watermark ship in federation v1 regardless of dogfood evidence? |
| R-C4 | MED | **Dual conflict-detection adjudication (§2.11, reconciliation 2026-06-11).** The two symmetric reviews independently produced `base_rev` fast-forward (identity proposal) and `(rev, origin)` journal collision (this spec); the coordinator kept BOTH (primary + defense-in-depth). Adjudicate: is the redundancy worth the dual maintenance, or should one become normative? Note `base_rev` is the only one that survives gc and fresh materializes. |

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
- **Per-record envelope schema-version for payloads (C2 alternative).**
  Redundant: payloads already self-describe via `schema_version` + the
  migration registry; a second version field in the envelope creates two
  sources of truth that can disagree.
- **Migration-by-segment-rewrite (C2 alternative).** Rewriting old
  segments to the current payload schema violates append-only immutability
  and J1's audited-rewrite-only rule; replay-time migration is
  pure-functional and leaves bytes untouched.
- **Hash in every envelope, inline payloads included (C3 variant).**
  Inline payloads are already line-framed and zod-validated; mandatory
  hashing buys federation dedup nothing (dedup keys on `(seq, writer)`)
  at a per-mutation CPU cost. The hash lives where it is load-bearing:
  `payload_ref` and `checkpoint_ref`.
- **A vector-clock component in the envelope (C4 alternative).** Origin-
  partitioned write authority makes convergence scalar-safe (§2.11); the
  only thing a vector adds is complete conflict *surfacing* across
  gc-floor-sized offline windows. Deferred to import metadata (per-origin
  watermark) — the envelope stays origin-agnostic.

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
