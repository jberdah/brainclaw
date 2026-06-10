# Event-Log Store — Cross-critique by slot B (round 2)

> Loop lop_3bf55b9492e0d96c, pln#543 step 1. Attacks proposal A
> (`event-log-store-proposal-A.md`), the shared spine, and adjudicates every
> divergence between A and B. Author: claude-code slot B. Status: CRITIQUE.

Convergence note: A and B independently chose the same spine (full snapshots,
sealed segments + checkpoints, global seq under the existing lock, lazy
projections, off/dual/primary migration). That raises confidence in the spine
but proves nothing about the edges — and the edges are where both proposals
have real bugs. Found below: one design contradiction in A (cursors vs.
sealing), one in B (seq:null vs. seq cursors), one shared escalation (seq
counter corruption in the lock-steal window), and one durability hole in A
(fsync policy silently breaks journal-first).

---

## 1. Attacks on proposal A

### A1. Rename-based sealing breaks A's own cursor format — HIGH, design contradiction

A seals by renaming `active.jsonl` → `segments/seg-<first>-<last>.jsonl`
(A §5) and defines cursors as `{segment_id, offset, last_read}` (A §5,
"Cursors survive rotation"). These two choices contradict each other:

- A cursor pointing into the *active* segment carries `segment_id =
  "active"` (or the active file's identity, whichever — A never says how the
  active segment is identified before it has a seq-range name). After the
  seal-rename, that identity now refers to a **different file** (the fresh
  `active.jsonl`). The cursor's byte offset lands in the middle of unrelated
  content. The reader either reads garbage from a record boundary that
  doesn't exist, or silently re-reads/skips events. This is the v1 rotation
  bug reintroduced with extra steps.
- Byte offsets are additionally invalidated by A's own torn-tail repair
  (attack A2), which truncates the active file.
- On Windows, renaming a file held open by a concurrent reader fails
  EPERM/EBUSY. A acknowledges this and says "retry/defer" — but MCP readers
  are worker-per-call processes that come and go constantly; under steady
  read traffic the seal can starve for a long time, during which the active
  segment grows unboundedly past 10MB, eroding the bounded-rebuild claim.
  "Retry until quiet" is not a protocol; it's a hope.

B's design (never rename; the active segment is born with its permanent
first-seq name; cursors are seq watermarks) dissolves all three problems
structurally. **Verdict: B wins outright; A's §5 layout and cursor format
should not survive synthesis in any part.**

### A2. Writer-inline torn-tail quarantine is a race against the seatbelt — HIGH

A §3: "the next writer, before appending, checks the last byte of the file;
if it is not `\n`, it moves the torn bytes into quarantine." Problems:

1. **It mutates the append-only file.** "Move bytes out" = read tail +
   truncate. Truncation under a concurrent reader (who is streaming the
   active segment from a byte offset, per A's own cursor format) yields
   short reads or garbage. The one file class whose integrity the whole
   design rests on is now edited in place on the hot path.
2. **It races the two-writer window A itself defends against.** In the
   lock-expiry break (O2 residual), writer W2 runs the last-byte check while
   stale-but-alive W1 is mid-`write()`. W2 sees no trailing `\n` — because
   W1's write is *in flight, not torn* — and quarantines live bytes, then
   appends. W1's syscall may complete after the truncate (fd offsets under
   O_APPEND are kernel-managed; truncate + concurrent append behavior is
   exactly the kind of cross-platform UB this spec must not contain). A's
   O_APPEND seatbelt exists *for* this window; the repair path defeats it
   *in* this window.
3. The check-then-truncate-then-append sequence is three syscalls where the
   seatbelt's guarantee covers exactly one.

B's leading-`\n` framing is passive: a torn fragment is *neutralized* (it
becomes one malformed line, capped at one event) without anyone touching
existing bytes. **Verdict: B's framing wins for the hot path. Keep A's
quarantine as an offline `doctor` repair only (doctor runs under the lock,
with no concurrent appender by construction, and can safely excise + park).**

### A3. fsync=rotate default silently breaks journal-first — HIGH

A §3 defaults to **no fsync per mutation** (only on seal/checkpoint), while
A §3.1 claims journal-first ordering. Program-order journal-first is **not**
durable-media journal-first: the OS may persist the (later) projection
writes before the (earlier) journal append. Crash in that window ⇒ a
projection **from the future** — state the journal cannot explain. B §2.3
names this exact hazard as "the single most important invariant" and pays
one fsync per `mutate()` to keep it. A's design then makes it worse: the
lazy reconciler sees `applied_seq > head_seq`... actually no — A's
`last_applied_seq` lives in `meta.json`, which is also written without
fsync, so the watermark itself may or may not have survived. Depending on
which writes hit disk, the reconciler may (a) detect an impossible
watermark, (b) see a consistent-looking but regressed journal and **replay
backwards over newer projection state**, destroying a committed mutation's
visible effects. (b) is silent data loss — the trp_d5595086 class A invokes
everywhere else.

Two acceptable fixes; synthesis must take at least one, preferably both:
- **B's policy**: one `fsync` on the journal fd per `mutate()`, after the
  last append, *before* any projection write. At brainclaw mutation rates
  (user-action frequency, not hot-loop) this is affordable even on NTFS.
- **Never-regress guard**: the reconciler refuses to overwrite a projection
  whose content disagrees with replay *toward an older state*; mismatch in
  the regressing direction ⇒ doctor error, not write. Cheap with
  `entity_rev` in the projection metadata.

**Verdict: B's fsync default wins; add the never-regress guard regardless
(defense in depth — fsync can be configured off).**

### A4. Seq counter corruption escalates beyond the race window — HIGH (applies to B too, but A is blinder to it)

Both proposals persist `next_seq` in a small meta file (`meta.json` /
`HEAD.json`) written under the lock. In the lock-steal window, W1 and W2
both read `next_seq = N`, both append seq N, both write meta `next_seq =
N+1`. A treats this as a bounded anomaly: "duplicate seq detected via
`(seq, writer)`, reducer applies both in file order." But the damage is
**not bounded to the window**:

- The counter itself is now wrong relative to history if either writer had
  appended *more than one* event (A §3 explicitly allows "append event(s)"
  plural per mutation): W1 appends N, N+1; W2 appends N; meta ends at N+1 or
  N+2 depending on write order — future writers can mint seqs that collide
  with already-written ones **after** the race is over.
- Duplicate seqs break every consumer that treats seq as an address:
  `last_applied_seq` watermarks (replay from N+1 misses the second N),
  notification cursors, federation idempotency keys `(origin_store_id,
  seq)`, and segment-name binary search.

A's mitigation (writer id in the envelope) detects but does not contain.
The containment fix is cheap and must be normative in the synthesis: **on
lock acquisition, the writer validates `meta.next_seq` against the actual
tail of the active segment** (read last line — O(1)) **and takes
`max(meta, tail+1)`**. This re-derives truth from the journal (the meta file
is a cache, per B's discipline) and caps any collision to the single
in-flight race write, restoring A's "bounded anomaly" claim, which is
currently asserted but not earned.

Also unaddressed by A: **pid reuse against the lock itself.** A's `writer =
pid + start-nonce` correctly survives pid reuse *for the envelope*, but if
`lock.ts` liveness-checks the owner by pid, a recycled pid makes a dead
owner look alive (lock never breakable — availability bug) or contributes to
premature breaks. Out of scope to fix here, but the spec must state the
dependency: the journal's two-writer story is only as rare as lock.ts's
steal rate, and should cite how lock.ts identifies owners (token, not pid).

### A5. Checkpoint design: the "referencing" variant (Q3) is circular — MEDIUM, kill it

A's Q3 offers checkpoints that reference projection files by hash. This
inverts the truth direction: checkpoints exist to rebuild state when
projections are suspect; a checkpoint whose validity depends on projection
integrity is useless in exactly the scenarios it exists for (projection
corruption, the regression in A3, divergence found by `--verify-journal`).
**Verdict: kill the referencing option without further study. Checkpoints
are self-contained.** Remaining real choice: A's external file +
`checkpoint_ref` event vs. B's in-journal checkpoint event run — see D5.

A's external checkpoint also lacks a corruption story: `ckpt-<seq>.json`
has no checksum, and A's crash matrix covers only the *orphan* case (file
without meta ref), not the *corrupt referenced* case. Recovery must be:
checksum in the `checkpoint_ref` event; on mismatch, fall back to the
previous checkpoint and replay more segments (which requires sealed
segments older than the latest checkpoint to remain locally readable —
consistent with park-don't-delete, but it constrains A's `gc` archiving Q5:
never archive past the *second*-newest verified checkpoint).

### A6. Stale-path reads take the write lock with no contention fallback — MEDIUM

A §6: read path "Behind → acquire lock, replay the delta." Two problems:

1. **Reads now contend with writes.** After every external mutation, *every*
   MCP worker that reads is "behind" and queues on the store lock — a
   thundering herd of reconcilers during dispatch storms (20-agent target),
   each wanting to do the same replay. A has no answer for lock-unavailable;
   B serves the stale projection with a `stale: true` annotation. Synthesis:
   B's fallback, plus reconcile-once semantics (whoever gets the lock heals;
   others serve stale or retry briefly).
2. A second-order cost A doesn't price: with `fsync` per mutation (A3 fix),
   lock hold time grows; reads queuing on that lock amplify it.

B's open question Q3 (are stale reads acceptable for claims?) is the right
question and is a **Juan call** — claims are correctness-bearing; everything
else can tolerate annotated staleness.

### A7. Git-diffability of segments is a non-claim — LOW, but scope both proposals honestly

A §2 ("the journal is diffable too, just verbose") and B's Q5 both flirt
with committing segments via memory-git. Attack: any branched/concurrent
store history (two worktrees, a restored backup, federation pull) appends
different lines to the **same active segment file** with **colliding seqs**
minted from divergent `next_seq` — a git merge produces line-level
conflicts in JSONL, a meta/HEAD conflict, and a semantically unmergeable seq
space. There is no sane merge driver for this. The journal is a
single-writer-lineage artifact; git is a DAG. **Verdict: segments and meta
are gitignored inside the store repo. The git-diffable identity of the store
is the projections, full stop (plus optionally checkpoints, which are
single-file snapshots and merge as whole-file conflicts a human can
adjudicate). This answers B Q5 and deletes A's "journal is diffable too"
sentence.** Cross-machine transport of segments is federation's job
(rsync/dumb-bus of immutable files), not git's.

### A8. Smaller holes in A — LOW

- **Network filesystems**: A is silent; B correctly scopes correctness to
  local FS and has doctor warn on network mounts. Adopt B's stance. Note
  O_APPEND on NFS/SMB is *not* atomic; a store on a network share gets
  corrupted journals under concurrency, silently.
- **Short writes**: neither proposal checks `writeSync`'s return value.
  POSIX permits partial writes on regular files (signals, quota, ENOSPC
  mid-write); Windows similar. A partial write *with* the lock held is a
  torn line that the framing heals, but the mutation must **fail loudly** at
  that point, not proceed to projections. One-line spec fix: `bytesWritten
  !== buffer.length` ⇒ throw inside `mutate()`.
- **>4KB appends**: the "single write doesn't interleave" folklore is solid
  for small buffers on local FS but has no formal guarantee at arbitrary
  sizes on either platform. With the lock as primary and framing as
  containment, this is acceptable risk — but the spec should cap a single
  event line (say 256KB hard error) so a pathological payload can't turn
  the folklore into a bet. Connects to B Q1 (`payload_ref` deferral): the
  cap is the tripwire that tells us when deferral expires.
- **`journal_repair` events** (A §3): an event about journal damage written
  *to the damaged journal* by the racy inline path (A2) — fold into doctor.

---

## 2. Attacks on the SHARED spine

### S1. Full-snapshot-per-event is wrong for heartbeat-class churn — must be scoped now

Both proposals wave at assignments/agent_runs/claims as future journal
citizens (A Q4: "highest churn — biggest win, biggest blast radius"). Attack
with numbers: a claim refresh or run heartbeat every ~30s × 20 agents × 2KB
snapshot ≈ **>100MB/day of journal for zero information** — segment rolls
every couple of hours, checkpoint runs constantly, sealed-segment storage
growing ~3GB/month, all to record "still alive." Snapshot-per-event is the
*right* call for intentional state transitions and the *wrong* call for
liveness signals.

**Synthesis must rule, not defer:** heartbeat/refresh-class field updates
(claim `refreshed_at`, run liveness, lock metadata) are **ephemeral, not
journaled state** — they live in the projection/registry layer only, or in
their own non-authoritative sidecar. Only lifecycle *transitions* (claimed,
released, completed, failed) are events. **Falsifier for the spine choice:**
instrument event volume by action type during one dogfooding sprint in
`dual` mode; if any non-heartbeat action class exceeds ~50% of journal bytes
with snapshots, that class needs a delta or ref format — until then,
snapshots stand.

### S2. Immutable history + park-don't-delete = no redaction path — product risk

A snapshot journal embeds every entity's full content in sealed, immutable,
never-deleted segments. Today, removing a leaked secret or personal datum
from the store means editing one JSON file (+ git history surgery, which is
at least *possible*). Under this design the datum persists in N sealed
segments and M checkpoints with no normative way to excise it — and the
house rule says never delete. Given the EU/GDPR positioning in the project's
strategy, "we cannot redact" is not a footnote. **Synthesis needs a
redaction mechanism**: a `redact` event + doctor-driven rewrite of affected
sealed segments (breaking immutability under a documented, locked, audited
procedure — sealed-segment immutability becomes "immutable except via
`doctor redact`"). Ugly, but the alternative is discovering this during an
incident. **Juan call on whether this ships in v1 or is a documented gap.**

### S3. Global-seq-under-lock: where it's the wrong call, and the falsifier

The choice couples *event ordering* to *mutation serialization*. That is
correct **iff** the store lock remains a low-contention, store-global
primitive. Two falsifiers:

1. **Lock contention at 20-agent scale.** With fsync-per-mutation (A3 fix)
   plus reconciling readers (A6), the lock becomes the system's global
   serialization point. If dispatch-storm profiling shows mutation latency
   dominated by lock waits, the fix is per-writer journals merged on read
   (vector ordering) — a real redesign. Decide by measurement, not
   speculation: the Phase 1 `dual` sprint must record lock wait-time
   distribution. If p95 lock wait > ~200ms under normal multi-agent load,
   the spine choice is falsified.
2. **Seq is presented as an identity but is only an *almost*-identity.**
   Both proposals admit duplicate seqs in the steal window. Every downstream
   consumer (cursors, federation keys, segment names) must therefore treat
   `(seq)` as an address and `(seq, writer)` as the identity — A says this
   once and then names segments, checkpoints, and federation keys by bare
   seq. The synthesis must make `(seq, writer)` the normative identity
   everywhere, with bare seq legal only where the lock guarantees held
   (i.e., after the A4 tail-validation fix bounds collisions).

Where global-seq is *definitely* right: it costs zero new coordination
today, and every alternative (vector clocks, per-writer logs) imports
merge complexity that brainclaw's actual write rates don't justify. Keep
it; instrument the falsifier.

---

## 3. Divergence adjudications (A vs B)

| # | Divergence | A | B | Verdict |
|---|---|---|---|---|
| D1 | Cursor format | `{segment_id, offset}` | `{last_seq}` watermark | **B**, decisively. Offsets die under rename (A1), quarantine truncation (A2), and any future segment surgery (S2 redaction). Watermarks survive all of it and make `readUnseenEvents` rotation-proof. B's `{gap:true}` + checkpoint-summary degradation for archaeology-aged watermarks is the right notification semantics. |
| D2 | Sealing mechanics | Rename `active.jsonl` → seq-range name | Never rename; segment born with first-seq name; HEAD is a rebuildable cache | **B**, decisively (A1). Bonus: B's first-seq filename gives binary-search addressing with no index. Adopt A's `quarantine/` directory into B's layout for doctor-parked bytes. |
| D3 | Torn-tail handling | Writer-inline check + truncate-to-quarantine + `journal_repair` event | Leading-`\n` framing; reader skips; doctor reports | **B** on the hot path (A2: race-free, append-only preserved); **A's quarantine demoted to offline doctor repair**. Third option adopted: both — framing for containment, doctor for cleanup. Add the short-write check (A8) to both. |
| D4 | fsync default | `rotate` (none per mutation) | One per `mutate()`, before projection writes | **B** (A3: program-order journal-first is fiction without a barrier). Plus never-regress guard in the reconciler as defense in depth. Config knob stays; CI uses prod default (B Q2 — fidelity over speed, per test-env-contamination history). |
| D5 | Checkpoint shape | External `ckpt-<seq>.json` + `checkpoint_ref` event (+ referencing variant Q3) | In-journal checkpoint event run + terminator record | **A's external file, hardened by B's corruption discipline**: self-contained, sha256 recorded in the `checkpoint_ref` event, fall back to previous checkpoint on mismatch. Reasons: keeps segments lean (checkpoint = O(live entities) bytes that would otherwise inflate the seq-addressed stream), rebuild = load 1 file + replay tail without scanning for a terminator, and whole-file checkpoints are the one journal artifact that *can* be git-committed sanely (A7). B's terminator trick is elegant but its partial-checkpoint-run detection is strictly replaced by the checksum. **A's referencing variant is killed** (A5). |
| D6 | Event emission | Diff synthesis at `persistStateUnlocked`, then "opportunistic migration to explicit verb-level emission" | `diffToEvents` in `mutateState`, permanent | **B's permanence wins; A's migration goal is deleted.** Same mechanism, different end-state. Explicit emission at ~30 verb sites is a drift machine: every new call site is a chance to forget, double-emit, or emit-without-persisting. The diff boundary is a single choke point that is *provably* consistent with what was persisted. Explicit emission is justified only for registries that never pass through `State` (assignments/runs/loops) — and those should reuse the same append+project primitive. |
| D7 | `entity_rev` (A) vs per-writer `writer_seq` (B) | Per-entity monotonic rev in envelope | Per-writer counter for federation | **A's `entity_rev`** — it powers the never-regress guard (D4), cheap projection dirty-checks, and optimistic concurrency. It is scalar and per-store, so it is *not* sufficient for federation conflict detection (A's own Q2); origin-tagging or a vector component is federation-spec work. B's `writer_seq` adds nothing locally — drop until federation demands it. |
| D8 | Observability events | All appends under lock, with seq (implied) | Lock-free append, `seq: null`, excluded from rebuild | **A (all under lock, all get seqs)** — B has an internal contradiction: B's cursors are seq watermarks (D1), and `seq:null` records are *unaddressable* by a seq watermark; B's own notification reader cannot deliver them. B's escape ("they can cheaply take the lock") is the actual design. Notification volume is low; lock cost is negligible; uniformity means one reader, one cursor type, one ordering. B Q6 (separate notification stream) resolves to **no — same journal** unless S1 instrumentation shows notification bytes dominating segments. |
| D9 | `doctor --verify-journal` | Phase 2: rebuild in temp dir, diff vs live projections, CI on both OS + full dogfood sprint | doctor checks + kill-9 convergence tests | **Both, merged**: A's verify-rebuild-diff is the acceptance instrument (it would have caught A3's regression class); B's kill-9 storm tests are the crash-matrix executor. Neither subsumes the other. Add: two-process append stress test on both OS families (A §3) and the A4 tail-validation test. |
| D10 | Legacy v1 events | Park to `journal/legacy/` | Park to `events/archive/events.v1.jsonl` | Equivalent (both park-don't-delete, both decline to translate payload-less v1). Cosmetic; follow D2's layout. |
| D11 | Payload elision rule | Q1: payload required iff action mutates a persisted entity | Same rule, stated as design (§1.1) | Agreed by both; **adopt as normative, send the action-union → payload-requirement mapping to Codex** for hole-hunting (A Q1 stands). |

---

## 4. VERDICT

### Five decisions the synthesis MUST take

1. **Segment lifecycle (D1+D2):** never rename; segments named by first seq;
   active segment is just the newest segment; `HEAD`/meta is a rebuildable
   cache; cursors are seq watermarks. A's rename/offset design is dead.
2. **Append protocol (D3+A4+A8):** leading-`\n` framing, single-buffer
   write, short-write ⇒ loud mutation failure, single-line size cap;
   `next_seq = max(meta, tail+1)` validated on every lock acquisition;
   torn-tail excision is offline doctor-only; `(seq, writer)` is the
   normative event identity.
3. **Durability (D4):** fsync journal fd once per `mutate()` *before* any
   projection write (configurable, prod default everywhere incl. CI), plus
   a never-regress guard in the reconciler keyed on `entity_rev`.
4. **Emission & scope (D6+S1):** diff-to-event synthesis at the persist
   choke point is permanent — no migration to explicit call-site emission;
   heartbeat/refresh-class updates are ephemeral and never journaled, only
   lifecycle transitions are; all events (including observability) append
   under the lock and carry seqs (D8).
5. **Checkpoints & git (D5+A5+A7):** self-contained external checkpoint
   files with sha256 recorded in an in-journal `checkpoint_ref` event,
   previous-checkpoint fallback chain, gc never archives past the
   second-newest verified checkpoint; segments/meta are **gitignored** —
   the store's git-diffable identity is projections (+ optionally
   checkpoints) only.

### Open questions that genuinely need escalation (severity-ranked)

| Rank | Question | Owner | Why it can't be settled here |
|---|---|---|---|
| 1 | **Redaction in immutable segments** (S2): ship a `doctor redact` segment-rewrite procedure in v1, or document the gap? | **Juan** (product/compliance) | Trades the immutability invariant against GDPR positioning; pure product risk call. |
| 2 | **Stale reads for claims** (A6 / B Q3): may a contended reader serve a stale claims projection, or must claims read through the journal? | **Juan** | Correctness-vs-availability for the one entity class where staleness can cause double-work or conflicting edits. |
| 3 | **Action-union → payload mapping** (D11 / A Q1): exact rule for which `EventAction`s carry payloads, tombstone semantics per type, checkpoint/`checkpoint_ref`/genesis record schemas, dup-seq reducer semantics | **Codex** (schema review) | Needs adversarial enumeration of the full action union against the envelope; exactly Codex's strength per capability mapping. |
| 4 | **Federation conflict primitive** (A Q2 / B Q4): scalar `entity_rev` + origin tag vs vector component | **Codex + federation spec owner** | Journal design is agnostic (both proposals agree); deciding now would front-run the federation architecture. |
| 5 | **Registry entities' journal entry phase** (A Q4, post-S1-scoping): assignments/runs/claims lifecycle transitions in Phase 1 or 1.5 | **Juan** (sequencing/risk) | Pure blast-radius sequencing once S1 has excluded heartbeats; depends on sprint appetite, not design. |
| 6 | **gc archiving policy** (A Q5, now constrained by D5's two-checkpoint floor) | defer | No federation consumer exists yet; constraint recorded, policy can wait. |

### What this critique changes about my own round-1 proposal (B)

For symmetry: B loses D5 (in-journal checkpoint run → external+checksum),
loses D8 (its `seq:null` lock-free observability events contradicted its own
cursor design), had not spotted the A4 counter-corruption escalation (B's
"impossible by construction" two-writer row was overconfident — the lock can
be broken), and B's missing `entity_rev` is adopted from A (D7). B's Q5
resolves to gitignore (A7). Convergence was not validation in either
direction.
