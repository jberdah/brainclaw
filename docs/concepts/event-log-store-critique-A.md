# Event-Log Store — Cross-Critique by Slot A (round 2)

> Ideation artifact for lop_3bf55b9492e0d96c (pln_2290bc70 / pln#543 step 1).
> Slot A attacking proposal B, the shared spine, and adjudicating divergences.
> Convergence between A and B is treated as suspect, not as validation.

## 1. Attacks on Proposal B

### 1.1 "Two mutating writers: impossible by construction" — FALSE, and B has no detection

B §5.3 claims two mutating writers are "impossible by construction" because the
store lock serializes them. The lock can still be **broken on presumed owner
death**, and presumed death is fallible:

- **Pid-liveness false negative**: on Windows, a permissions error or a
  transient process-query failure can make a live owner look dead → breaker
  takes the lock while the owner is mid-mutation. Two writers.
- **Pid reuse false positive** (inverse): dead owner's pid recycled to an
  unrelated process → lock looks held forever → availability stall, and the
  eventual manual/timeout break lands while operators are improvising.

B records `writer`/`pid` in the envelope but defines **no reader rule for a
duplicate seq**. Worse, B's `HEAD.json` makes the failure compound: two
writers both read `next_seq = N`, both append seq N, both rewrite `HEAD.json`
via temp+rename — last rename wins, the loser's bump is lost, so a **third**
writer can reuse N again. Seq uniqueness silently degrades with no anomaly
surfaced anywhere.

A's `(seq, writer-nonce)` identity + "duplicate seq from different writers =
detected anomaly, apply in file order, doctor warning" is the minimum viable
answer. The synthesis additionally needs a **writer-side tail validation**: on
lock acquisition, before first append, read the last record of the active
segment and assert `next_seq > last_seq_in_file`; if not, self-heal
`next_seq = last_seq_in_file + 1` and emit a `seq_repair` event. That closes
the HEAD-regression hole that neither proposal closes.

Note `writer` must be **pid + start-nonce** (A's shape), not agent name + pid
(B's shape): pid reuse makes bare pid an unreliable writer identity over a
journal's lifetime.

### 1.2 Lockless observability appends race the segment roll — B's immutability claim is unenforced

B §5.1 lets observability events append **without the lock** (`seq: null`).
B §3.1 rolls segments by creating a new file and updating `HEAD.json` —
**never renaming** the old active segment. Combine them: a lockless appender
that resolved the active segment path before the roll (or holds an open fd,
which is the natural way to implement an appender) keeps appending **into the
just-sealed segment**. "Rolled segments are immutable" is therefore not an
invariant; it is a hope that every writer notices the roll. Consequences:

- Checkpoint-based archival (B §3.2) can park a segment that is still
  receiving writes — silent event loss into `archive/`.
- Segment-name-encodes-first-seq stays true, but "segment content is frozen
  after roll" — which cursors, federation pulls, and doctor verification all
  implicitly assume — is false.

A has no lockless append path, so A doesn't have this bug, at the cost of
notification appends contending for the lock. The fix is cheap: **all appends
take the lock** (mutation frequency is human-action-scale; B itself concedes
"they can cheaply take the lock"). If notification traffic ever measurably
contends, split the streams (B's own Q6) — but do not ship an unlocked write
path into a file whose immutability the whole design leans on.

### 1.3 In-journal checkpoints pollute every cursor and inflate seq space

B §3.2 emits checkpoints as ordinary journal records: one snapshot event per
live entity + a terminator. Three problems:

1. **Cursor spam.** Cursors are seq watermarks; after a checkpoint, every
   notification consumer "sees" N phantom snapshot events it must parse and
   filter. B never says checkpoint records are excluded from
   `readUnseenEvents` — and if they are excluded, that's a special-case rule
   contradicting "checkpoint is appended like any event."
2. **Crash mid-checkpoint** leaves a headless run (snapshots, no terminator).
   B's terminator implies the recovery rule (use last *complete* checkpoint)
   but never states it, and a rebuild scanning backward must now distinguish
   "real entity event" from "stale partial-checkpoint snapshot" — they are
   schema-identical.
3. **Lock hold time.** O(live entities) appends + fsync under the store lock;
   at 20-agent scale this stretches toward the lock-refresh/expiry windows the
   sprint-1 hardening just tuned.

A's out-of-band checkpoint manifest (`checkpoints/ckpt-<seq>.json`) has none
of these: cursors never see it, partial write = orphan file (harmless,
meta-written-last), and the journal stays purely a stream of real events.
A's Q3 must resolve to **self-contained** post-images: the "referencing"
variant (hashes of projection files) couples checkpoint validity to projection
integrity — exactly the dependency direction a rebuild-from-truth artifact
must not have.

### 1.4 Checkpoint-gated archival without checkpoint verification

B §3.2 moves superseded segments to `archive/` once a checkpoint covers them.
If that checkpoint later turns out corrupt (torn during write, disk fault),
the archived segments are suddenly **not** redundant — and recovery now
depends on operators realizing the archive must be un-parked. Neither proposal
states the guard, so the synthesis must: **verify a checkpoint by full
re-parse (and schema-validate) before any segment it supersedes is archived.**
Park-don't-delete makes this survivable either way, but survivable-by-forensics
is not the bar; the bar is no-human-needed convergence.

### 1.5 Torn-tail handling: B's reader rules conflict with themselves

B §2.2 rule 3: torn tail → "skip without warning." But after the next append,
the leading-`\n` framing converts that torn tail into a **mid-file malformed
line**, which rule 2 says doctor must flag forever. So a routine, benign crash
permanently raises a doctor warning on a healthy store — alarm fatigue, which
trp_d5595086 teaches is how real corruption later slips through. Fix in §3.3
below (a `journal_note` event marks the fragment as adjudicated; doctor counts
adjudicated fragments separately from unexplained corruption).

Also under-specified in B: a torn write can, in the worst case, end exactly at
the record's final `}` with only the trailing `\n` missing — a line that
**parses validly** yet was never confirmed (crash before fsync). B's rule 3
skips it, which is the correct call, but B never argues why it's correct
(answer: journal-first + fsync-before-projection means an unconfirmed tail can
always be dropped; the caller was never told "ok"). The synthesis should state
this argument, because the rule looks wrong without it.

### 1.6 O_APPEND seatbelt has a size ceiling nobody enforces

Both proposals say "single write of a few KB doesn't interleave." True for
small records on local FS — but single-`write()` append atomicity degrades for
multi-page writes (>4KB is where guarantees get murky across FS
implementations, and NTFS makes no formal promise at any size). B's own size
math admits long plan bodies can grow; B's `payload_ref` escape hatch is
deferred until "a real entity exceeds ~64 KB" — meaning large records **will
ship before the mitigation exists**, silently exiting the envelope where the
seatbelt works. Since the lock is the primary guarantee, this only bites in
the lock-steal window — but that's precisely the window the seatbelt exists
for. Synthesis: enforce a **max-record-size check at write time** (warn at
64 KB, hard-fail at 256 KB with a pointer to payload_ref), so the day the
ceiling matters, it fails loud at the writer, not subtly at a reader.

### 1.7 Network drives: B warns, neither proposal decides

B's "doctor warns when the store sits on a network mount" is the right
instinct but under-specified: detection (Windows UNC paths and mapped drives,
`fs.statfs` is not in stable Node API) is nontrivial, and the consequence
("journal correctness guaranteed on local FS only") is buried in a caveat.
The synthesis should promote it to a documented support boundary + best-effort
UNC/mapped-drive detection in doctor, and accept that detection is heuristic.

### 1.8 MCP fresh-path: two meta files create a torn-state window and double the reads

B reads `HEAD.json` + `projections.json` (two files, two atomic renames at
write time). The write order (watermark last) keeps `applied_seq ≤ next_seq`
— fine — but two files means two reads per MCP call and two rename syscalls
per mutation for state that is always consumed together. A's single
`journal/meta.json` carrying `next_seq` + per-family `last_applied_seq` is
strictly cheaper and removes the ordering reasoning entirely. Keep B's
property that the meta file is a **rebuildable cache** (reconstructible from
segment listing + tail read), which A never claimed and should.

### 1.9 Clock skew / federation — B survives, one nit

B is clean here (seq orders, ts decorates, `(origin_store_id, seq)` dedups).
One nit: stamping `origin_store_id` once per **segment header record** means a
federation pull must transfer whole segments or carry the header along with
any slice; fine for the rsync/dumb-bus model, but the spec should say slices
must be header-prefixed. Cosmetic, not structural.

## 2. Attacks on the SHARED spine

Convergence on snapshots + global-seq-under-lock + segments + lazy projections
is exactly where groupthink would hide (both slots are the same model — the
single-agent-method memory applies). Two scenarios where the spine is wrong:

### 2.1 Full-snapshot-per-event is wrong for high-frequency partial updates on fat entities

The poison combination is **large entity × high update frequency**: an
agent_run receiving progress/heartbeat updates every few seconds, or a plan
with a long body where every step-completion rewrites the whole doc. A 100 KB
plan updated 50× = 5 MB of journal for one entity in one session; each record
individually exceeds the O_APPEND atomicity comfort zone (§1.6) **and** makes
the per-mutation fsync slower, all to record a one-field change. The spine's
defense ("entities are 1–10 KB") is an observation about today's store, not
an invariant of the schema.

**Falsifier (measurable now, before phase 1):** from the dogfood store,
compute per-`item_type` p95 entity size × per-entity event frequency from the
17k v1 events. If any type's (size × freq) implies segment rolls faster than
~weekly, or any single record would exceed 64 KB, then snapshots-everywhere is
the wrong call for that type and `payload_ref` (or per-type field-delta) must
ship in phase 1, not deferred. This measurement is cheap and should be a
phase-0 deliverable.

### 2.2 Global-seq-under-lock welds event capture to lock availability

Three concrete failure shapes:

1. **Wedged lock** = no events at all (A) or seq-null limbo events (B). The
   sprint-1 hardening reduced but did not eliminate stuck-owner scenarios.
2. **Federation import** must take the lock to assign local seqs to every
   imported batch; a 10k-event pull holds the lock long enough to starve local
   agents at 20-agent scale. Needs chunked import with lock release between
   chunks — neither proposal says so.
3. **Sandboxed/worktree workers cannot append at all** — not because MCP is
   unreachable (dec#133 later refuted that: a sandboxed worker DOES reach the
   out-of-process MCP server; the earlier "facades-in-sandbox" failure was about
   `.git`/out-of-worktree file writes, not MCP), but because a worktree worker's
   writes land in its own worktree, not the main store journal.
   Their work produces zero main-store journal events until a sync point — meaning the
   journal is the truth of the *store*, not of the *system*, and nobody should
   pretend otherwise.

**Falsifier:** the moment any roadmap item requires offline/sandboxed local
event capture (a worker journaling into its worktree for later merge),
global-seq-under-lock is the wrong primitive — that world needs per-writer
seqs + merge, i.e., the federation mechanism applied locally. Until then the
spine holds, but the spec must state this boundary explicitly so the
assumption is visible when it breaks.

## 3. Divergence adjudication

### 3.1 Diff-to-event synthesis at `persistStateUnlocked` (A) vs `diffToEvents` in `mutateState` (B)

Substantively the same mechanism at the same layer; the real defect is shared:
**diff inference destroys verb semantics.** A diff knows created/changed/
removed; it cannot know `claim` vs `update` vs `complete` — the EventAction
union's expressiveness, which notifications and federation signaling consume,
collapses to generic `update`. A waves at "verb sites migrate
opportunistically afterwards"; B defers to phase 3. Both lose semantics in the
interim.

**Verdict: third option beats both.** Diff-synthesis stays as the
**correctness backstop** (it guarantees no mutation escapes the journal —
that property is what makes the journal trustworthy), plus a per-mutation
**intent annotation**: verb sites declare `(action, item_type, item_id,
summary)` into the in-flight mutation context (they already call
`appendEvent` with exactly these fields today — the call sites exist, they
just need to write to the mutation context instead of the legacy stream); the
diff supplies the payload and emits any *unannotated* change as `update` +
doctor counter. Semantic fidelity from day one, correctness regardless.

### 3.2 Cursors: `{segment_id, offset}` (A) vs `{last_seq}` (B)

**Verdict: B wins outright.** Seq watermarks are rotation-proof,
compaction-proof, trivially comparable, and survive any future re-layout.
A's byte offsets are broken **by A's own design**: A's quarantine repair moves
torn bytes out of the active segment — a rewrite that shifts every subsequent
offset, invalidating A's own cursors. Self-inflicted. The cost of seq cursors
(scan from segment start to find seq N, no per-line index) is bounded by the
10 MB segment size and irrelevant in practice. B's `{gap: true}` +
checkpoint-summary degradation for ancient watermarks is also the right
notification semantics and should be kept verbatim.

### 3.3 Torn-tail handling: quarantine-and-repair (A) vs leading-`\n` framing (B)

**Verdict: B's framing wins; A's repair must die.** A's writer-side repair
(move torn bytes to `quarantine/`, truncate) is a **read-modify-write of the
journal** — it breaks append-only (the one structural property everything
else leans on), breaks A's offset cursors (§3.2), and adds a crash window
*inside the repair itself*. B's leading-`\n` caps damage at one event with
zero mutation of existing bytes and costs one byte per record.

Take from A the **loudness**, repaired: when a writer (under lock, before
appending) detects a torn tail, it appends a `journal_note` event recording
the fragment's segment + byte range + content hash as *adjudicated*. Doctor
then distinguishes adjudicated fragments (expected crash residue, count only)
from unexplained mid-file corruption (alarm). This resolves B's
self-contradiction (§1.5) and keeps park-don't-delete: the fragment stays in
the file, annotated, forever.

### 3.4 `doctor --verify-journal` (A) vs scattered doctor checks (B)

**Verdict: A wins; union with B's counters.** A's full rebuild-in-temp-dir +
diff-against-projections is the only check that validates the actual claim
("journal is sufficient to reproduce state") and is the only credible phase-2
exit gate. B's incremental counters (skipped lines, torn tails, network-FS
warning) are cheap continuous telemetry and complement it. Synthesis ships
both: counters always-on, `--verify-journal` in CI on both OS families + as
the dual→primary promotion gate.

### 3.5 Additional divergences spotted

| Divergence | A | B | Verdict |
|---|---|---|---|
| Segment naming/sealing | Range-named, **rename at seal** | First-seq-named at birth, **never rename** | **B.** A's rename-of-open-file is the exact Windows EPERM/EBUSY hazard A then mitigates with retry logic. B's name-at-birth needs no rename, no retry, no Windows caveat. Don't build the problem. |
| fsync default | `rotate` (seal+checkpoint only) | one fsync per `mutate()` | **B.** A's argument (fsync cost vs MCP cheapness) conflates paths: fsync is on the write path; MCP read cost is untouched. A journal-as-truth that confirms mutations the disk may not have is a contradiction in terms. Mutations are human-frequency; one fsync each is affordable. Keep the config escape hatch, drop the `rotate` default. |
| Envelope: `entity_rev` (A) vs `(writer_id, writer_seq)` (B) | per-entity monotonic rev | per-writer counter | **A.** `entity_rev` serves three masters (cheap dirty checks, optimistic concurrency, federation conflict detection); `writer_seq` serves only federation and is derivable later. Don't carry dead weight in every record. |
| Writer identity | pid + start-nonce | agent name + bare pid | **A** (pid reuse, §1.1). |
| Meta files | single `meta.json` | `HEAD.json` + `projections.json` | **A's single file, B's rebuildable-cache property** (§1.8). |
| Tombstone shape | `action:"delete", payload:null` | `deleted:true`, payload omitted | Either works; pick **`action:"delete"` + payload omitted** (no boolean redundant with the action union). Codex schema review should confirm. |
| Observability events | in-lock, payload-exempt | lockless, `seq:null` | **A** (roll race, §1.2). All appends take the lock; revisit only with contention data. |
| Checkpoint placement | out-of-band manifest | in-journal event run | **A** (§1.3), self-contained, + verify-before-archive (§1.4). |

## 4. VERDICT

### The 5 decisions the synthesis MUST take

1. **Segment lifecycle = B's:** first-seq-named at creation, never renamed,
   immutable after roll; **all appends under the store lock** (no lockless
   path — closes the roll race §1.2); cursors are **seq watermarks** (B),
   with `{gap:true}` checkpoint-summary degradation.
2. **Torn-tail protocol = B's framing + A's loudness, no rewrites:**
   leading+trailing `\n` per record; torn fragments stay in place forever;
   writer appends an adjudicating `journal_note` under lock; doctor separates
   adjudicated residue from unexplained corruption. Max-record-size enforced
   at write (warn 64 KB / fail 256 KB).
3. **Checkpoints = A's:** out-of-band, self-contained manifests in
   `checkpoints/`, fsync'd, meta-written-last; **verified by full re-parse
   before any superseded segment is archived**; never referenced-by-hash.
4. **Two-writer honesty = A's, hardened:** writer identity = pid+start-nonce;
   duplicate `(seq)` from distinct writers is a *detected anomaly* (file
   order wins, doctor warns); on lock acquisition, writer validates
   `next_seq` against the actual segment tail and self-heals upward
   (`seq_repair` event). The phrase "impossible by construction" is banned
   from the synthesis.
5. **Write path = journal-first, fsync-per-mutate (B), diff-synthesis as
   backstop + verb-site intent annotation (third option, §3.1);**
   single rebuildable `meta.json`; `entity_rev` in the envelope;
   `doctor --verify-journal` as the dual→primary promotion gate, doctor
   counters always-on.

### Open questions, severity-ranked

| # | Sev | Owner | Question |
|---|---|---|---|
| 1 | HIGH | **Juan** | Journal-in-git policy (B's Q5). Recommendation: **gitignore segments inside the store repo; commit checkpoints only.** Committing segments bloats history (10 MB blobs) and — fatal — if journal files ever live on diverging branches/worktrees that merge, seq uniqueness dies in a union merge. Needs a product decision because it touches the "git-diffable identity" constraint's interpretation. |
| 2 | HIGH | **Codex** | Envelope schema review: payload-required-per-EventAction mapping (A's Q1), tombstone shape (§3.5), checkpoint manifest schema, `journal_note`/`seq_repair` event kinds. The action union → payload contract has hole potential and is exactly schema-review territory. |
| 3 | MED | **Juan** | Stale-read policy under lock contention (B's Q3): serve stale-with-annotation everywhere except claim verbs (read-through-journal)? Liveness-vs-consistency product call; affects dispatch correctness at 20-agent scale. |
| 4 | MED | **Codex + measurement** | Snapshot-size falsifier (§2.1): run the p95-size × frequency analysis on the dogfood store in phase 0. If poison combination exists, `payload_ref` enters phase 1 and the record schema changes — decide before, not after, the format ships. |
| 5 | LOW | **Juan** | Federation conflict semantics (A-Q2/B-Q4) and gc/archive thresholds (A-Q5). Genuinely deferrable: the journal design is agnostic; both only need answering when federation lands. |

### Abstract

B's spine survives; its perimeter doesn't: the "two writers impossible" claim
is false and undetected, the lockless append path races segment roll into
"immutable" files, and in-journal checkpoints pollute every cursor. A's
quarantine repair is self-defeating (rewrites the journal, breaks its own
offset cursors) and must be replaced by B's framing. Synthesis: B's segment
lifecycle + cursors + fsync, A's checkpoints + two-writer detection +
verify-journal gate, plus three rules neither proposal had — verify
checkpoints before archival, enforce max record size, validate next_seq
against the segment tail on lock acquisition.
