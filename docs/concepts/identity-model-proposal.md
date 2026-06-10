# Federated Identity Model — PROPOSAL

> Status: **PROPOSAL** for the architecture loop (Codex schema review + Juan
> product calls). Not a decision. Produced 2026-06-11 from a two-track
> identity analysis (local model + federation readiness); full reports held
> by the coordinator. Couples directly with `event-log-store.md` OPEN
> QUESTION **C4** (federation conflict primitive) — review them together.

## Why

The federation ambition: several human users, each running one or more
agents, working on the same project from different machines. Today's
identity tuple `{agent_name, agent_id, host_id, user}` is locally minted,
unauthenticated, and name-keyed at every load-bearing point:

- Cloud inbox routed by **bare agent name** (`/api/v1/inbox/claude-code`)
  — two humans' claude-codes are one identity to the bus.
- Event cursors, claim ownership comparisons, reputation, trust: keyed by
  name or per-store registry doc; "Juan's claude-code" is **inexpressible**.
- `FederationMessage.from` is self-asserted under a single API key; routing
  uses machine-local `project_path`.
- ed25519 keypairs are generated per agent and **never used** (private keys
  currently under `~/.codex/brainclaw/keys`).
- 2,000+ store files carry the OS username; worktree paths are absolute.
- No write-authority model exists for same-project-multi-machine (the
  signaling-vs-execution decision covered cross-*project* only). C4 cannot
  be answered without one.

Local incidents (2026-06-10) showing the same root: VS Code extension
inherited agent env → impersonation + cursor consumption; directory
presence (`~/.config/opencode`) minted a **trusted** identity; three
simultaneous claude-code instances shared one agent_id (loop slot auth
distinguishes nothing); a copilot worker committed as the human.

## The model

```
principal  prn_<id>   a HUMAN (or service account), optionally under org_<id>
                      (org = the premium billing/management unit)
actor      agt_<id>   an AGENT INSTANCE = (principal, machine, agent software)
                      keeps today's agt_ ids; gains principal_id, origin_id,
                      public key
origin     orig_<id>  a STORE REPLICA on a machine — minted once at
                      init/materialize, stored next to project.identity.json.
                      NOT os.hostname() (hostnames collide; one machine can
                      hold several replicas). host_id stays as metadata.
display    name       "claude-code" demoted to a label. Never a key.
```

### Write authority (answers C4's prerequisite)

- **Execution entities** (claims, sessions, runs, locks): origin-scoped,
  **single-writer**. Other origins materialize them read-only, tagged with
  their origin. Claims get eager push-on-write to the bus (piggybacked on
  the existing claim mutation path — still no daemon) for advisory
  cross-machine visibility; true atomic arbitration is deferred to the
  cloud dispatcher (Durable Object, premium) and local-first never blocks
  on it. **Eager-push messages MUST carry the same record identity as
  journal slices** — `(origin_id, origin_epoch, seq, entity_rev)` plus the
  full post-image. Then arrival order vs the periodic pull is irrelevant:
  the receiver applies any copy through the same never-regress comparison
  (apply iff incoming rev > materialized rev for that origin), and a push
  that lands after the pull already delivered it is a no-op. A push lacking
  this identity would reintroduce ordering bugs; it is not optional.
- **Memory entities** (decisions, traps, plans…): **highest-rev-wins with
  origin tiebreak** — not wall-clock LWW; timestamps never order anything
  (same rule as the event-log spec §2.2). On equal `entity_rev` from two
  origins, the winner for the materialized view is deterministic
  (lexicographic `origin_id`) and the loser is surfaced as a conflict
  candidate, never silently dropped.
- **The scalar-rev hole, named and fixed**: a bare rev comparison cannot
  distinguish *descends-from* from *concurrent-with*. Origin A edits
  rev 5→6→7; origin B concurrently edits 5→6. A's 7 beats B's 6 and the
  comparison looks like a clean fast-forward — B's edit is lost with **no
  conflict surfaced**. Scalar `entity_rev` alone therefore cannot honor the
  "conflicts surface as candidates" promise. The minimal fix (still no
  vectors): exported memory-entity records carry **`base_rev`** — the rev
  the write was based on. Receiver rule: incoming wins only if
  `incoming.base_rev >= current.rev` (true fast-forward); otherwise the
  write was concurrent → materialize the winner by the tiebreak above AND
  emit a conflict candidate carrying both post-images. One extra integer
  per exported record; local writes don't need it (single store, the lock
  serializes). This is sufficient *because* payloads are full post-images
  (event-log §2.1) — no merge, just detect-and-surface.
- **Restore-from-backup breaks `(origin_id, seq)` — origin epochs**: a
  store restored from backup at seq 700 will re-issue seqs 701… with
  different content under the same `origin_id`, while peers hold cursors
  at, say, 1000 — the divergent range is silently ignored and the
  addressing invariant (one `(origin_id, seq)` = one immutable record) is
  violated. Fix: slice headers carry **`origin_epoch`** (integer, starts
  at 0). Detection is cheap and reliable: the cloud keeps a per-origin
  high-water mark; an origin reconnecting with `local next_seq <=
  cloud watermark` has been restored → it bumps its epoch (recorded
  locally as a `seq_repair`-class event) before pushing anything. Peers
  treat a new epoch as a rebase: drop the cursor for that origin and
  re-pull from the origin's latest checkpoint. Never-regress stays intact
  *within* an epoch; epochs make the restore case explicit instead of
  silent.
- **Consequence for C4**: with partitioned authority, **scalar
  `entity_rev` + origin tag + `base_rev` on exported memory records**
  suffices — no vector clocks. Federation transfers are
  `(origin_id, origin_epoch, seq)`-headed segment slices.

### Authn — the minimal dumb-bus guarantee

Activate the dormant ed25519 keys. `brainclaw cloud register` (already
specced in the cli-cloud plan) binds *actor public key → principal* once,
under the principal's API token (one token per human). The cloud verifies
each message signature once and stamps `verified_principal`; receivers
trust the stamp and MUST reject unstamped messages on cloud transport. No
PKI web. Routing moves from `project_path` to `project_id` + channel.
(Local cross-project-link transport stays a separate, weaker trust domain:
same machine, same OS user — signatures optional there.)

#### FederationMessage v2 envelope & signature block (concrete)

```jsonc
{
  "schema_version": 2,
  "id": "msg_...",
  "from": {
    "principal_id": "prn_...",
    "actor_id": "agt_...",
    "origin_id": "orig_...",
    "origin_epoch": 0,
    "origin_msg_seq": 412,        // per-origin monotonic counter (replay watermark)
    "agent_name": "claude-code"   // display only — never a key
  },
  "to": { "project_id": "proj_...", "channel": "signals", "actor_id": "agt_..."? },
  "type": "signal|handoff|candidate|runtime_note|board_snapshot|claim_advisory|slice",
  "payload_hash": "sha256:...",   // hash of canonical payload bytes
  "payload": { ... },             // inline iff <= 64 KB, else payload_ref (see slices)
  "created_at": "...",
  "causal_parent": "msg_..."?,
  "idempotency_key": "...",       // DEDUP ONLY — explicitly not a security control
  "sig": {
    "alg": "ed25519",
    "key_fingerprint": "...",     // selects among the actor's registered keys
    "sig": "base64..."
  }
}
```

- **What is signed**: the ed25519 signature covers the **RFC 8785 (JCS)
  canonical JSON** of the envelope with `sig` removed and `payload`
  replaced by `payload_hash`. Today's `JSON.stringify` of a parsed object
  is insertion-order-dependent and NOT a stable signing base across
  writers/runtimes — canonicalization is required, not optional. Signing
  `payload_hash` instead of inline payload means oversized payloads can
  move out-of-band (blob transfer, below) without changing the signature
  scheme.
- **Replay protection**: `idempotency_key` (content hash, today truncated
  to 64 bits) is **dedup, not replay defense** — it only helps if the
  receiver retains seen-keys forever, and it cannot distinguish a
  legitimate redelivery from a malicious replay. The actual defense is the
  **per-origin monotonic watermark**: every v2 message carries
  `(origin_id, origin_epoch, origin_msg_seq)`; receivers keep a high-water
  mark per origin and reject anything at-or-below it. This unifies signal
  messages with slice cursor semantics — one mechanism, no retention
  window to tune. `idempotency_key` survives for content-level dedup but
  its computation must move to canonical JSON (same JCS bytes as signing).
- **Key rotation**: actor registration holds a **list** of keys with
  `created_at` / `retired_at` validity windows, not a single key. Rotation
  = registering a new key under the principal's API token (same act as
  initial registration — no cross-signing chain needed because the token,
  not the old key, is the root of the binding). The cloud verifies against
  whichever registered key the `key_fingerprint` selects, checking the
  validity window against `created_at`.
- **Revocation (the fired-teammate case)**: revocation is enforced at the
  **single online verification point** — the org admin revokes the
  principal (dashboard / `members` projection); the cloud immediately stops
  stamping that principal's messages and rejects its API token. Because
  receivers trust the stamp rather than verifying raw signatures
  themselves, **revocation does not need to propagate to offline stores to
  stop new writes** — an offline store cannot receive new federation
  messages anyway. What offline stores DO hold: (a) previously
  materialized data from the revoked principal — that is history, not
  authority; it stays, attributed; (b) a stale `members` projection that
  still lists the principal — bounded by re-pull on reconnect. The
  residual product call: whether a store whose members projection exceeds
  a max staleness age should degrade to read-only federation (deny new
  grants by default) — see [JUAN] below.

### Authz

Trust moves from per-local-agent-doc to **per (principal, project)**
grants, distributed as a signed `members` projection (managed in the
Phase-2 dashboard, materialized locally like everything else). Local-only
operation is unchanged: principal defaults to an implicit `prn_local`.

### Slice transfer & event-log coupling

The event-log spec is written for ONE store-global seq space assigned
under the local lock. Foreign events cannot be appended into it (their
seqs are foreign); the spec's own §2.2 scope boundary anticipates exactly
this. The ingestion model, stated so the two documents stop hand-waving at
each other:

- **Export** is what the proposal already says: slices of the local
  journal, header `{origin_id, origin_epoch, from_seq, to_seq,
  slice_hash}` — zero local schema cost, origin appears only on export.
- **Import — per-origin sidecar journals, not seq renumbering.** Ingested
  slices land in `events/foreign/<origin_id>/seg-*.jsonl`, preserving the
  remote `(epoch, seq)` addressing (verifiable against `slice_hash`,
  re-requestable). The receiver keeps **one cursor per foreign origin**
  (`{origin_epoch, last_seq}`) — a new mechanism; the spec's `meta.json`
  per-family watermarks don't cover it and must grow a `foreign_origins`
  map. Renumbering foreign events into the local seq space was rejected:
  it destroys the remote addressability that re-sync, audit, and
  `slice_hash` verification depend on.
- **Materialization is a local journal event.** Applying a foreign batch
  appends a local `federation_apply` event (local seq, payload = the
  per-entity outcomes: applied / regressed-skip / conflict-candidate).
  Local rebuild therefore replays to the same state WITHOUT consulting
  foreign journals — checkpoints stay self-contained, and the spec's
  rebuild/gc/verify story is untouched. Foreign sidecars are cache-class:
  re-pullable, gc-able by their own retention, never part of local
  checkpoint verification.
- **Remote gc floor**: the origin may have archived segments below a
  requested cursor (spec §2.3 retention). The slice protocol therefore has
  two response shapes, mirroring §2.5's `{gap: true}`: contiguous events,
  OR a checkpoint-derived snapshot slice (full post-images at the origin's
  latest checkpoint) from which the receiver re-bases its cursor.
  Snapshot slices and the epoch-rebase path (above) are the same code.
- **Oversized payloads**: the phase-0 falsifier FIRED on handoffs (p50
  ~110 KB, 15-45× over the 64 KB record threshold). Whatever shape
  `payload_ref` takes in event-log phase 1, federation inherits it:
  slices reference blobs by sha256; receivers fetch
  content-addressed blobs (`blobs/<sha256>`) out-of-band and verify the
  hash. The envelope/signature design above already accommodates this
  (signatures cover `payload_hash`, never inline bytes). Note the
  composable alternative flagged in the measurements doc — a handoff
  "diet" externalizing `snapshot.diff` — also shrinks the federation
  privacy surface (the diff is the #1 secret-leak channel) and should be
  preferred where possible.
- **Idempotency for slices**: the event-log spec says federation dedup
  uses `(seq, writer)`. At the transfer layer this becomes
  `(origin_id, origin_epoch, seq)` — the per-origin watermark — with
  `slice_hash` as the integrity check. The content-hash `idempotency_key`
  is for *signal* messages only; do not use it for slices.

### Privacy boundary

The federation export strips or rewrites — verified against
`src/core/schema.ts`, not just the obvious fields:

- `user` (OS username — Claim, CurrentSessionState) → dropped;
  `principal_id` is the human attribution.
- **`author` / `author_id`** (present on every memory entity; in practice
  the OS username or a human name, occasionally an email) → mapped to the
  principal's display handle. The original strip list missed this — it is
  the single most widespread PII field in the store (2,000+ files).
- **Reviewer/actor name fields**: `HandoffReview.requester/reviewer/
  reviewed_by`, `Candidate.starred_by[]/resolved_by`,
  `ActionRequiredResponse.responded_by`, `assignee`, `Sequence.owner` →
  same principal-handle mapping.
- **`host_id`** — today raw `os.hostname()` (src/core/host.ts), and
  hostnames routinely embed personal names ("juans-macbook"). Kept as
  *metadata* locally, but on export it is hashed (or dropped; `origin_id`
  already provides replica identity).
- Absolute paths: `worktree_path`, `related_paths` → repo-relative.
  **Also**: `AgentRun.command` / `shell` (spawn command lines embed
  absolute paths, usernames, and potentially tokens) → stripped on export,
  not relativized — command lines are not reconstructable safely; and
  `verify_cmd` (decisions/traps) → redaction-pattern pass.
- pid, session env internals (`CurrentSessionState.pid/user/
  active_project.path`) → dropped.
- **Existing leak, fix independent of v2**: `FederationMessage.from.
  project_path` / `to.project_path` are REQUIRED absolute paths in v1 and
  are pushed to the cloud **today** whenever cloud_sync is enabled. v2
  routing by `project_id` removes them; until then this is a live PII
  exposure, not a future risk.
- **Narrative content (`text`, `narrative`, `snapshot.diff`,
  `InboxMessage.payload`, `RuntimeEvent.metadata`) cannot be schema-
  stripped** — free text can quote anything, including secrets and names.
  This is policy + redaction territory only: the existing
  `RedactionConfig` patterns, the explicit `visibility: 'shared'` opt-in
  (already enforced for handoffs/candidates), and the J1 `doctor redact`
  erasure path. The proposal claims no schema-level guarantee here, by
  design.

Pairs with the J1 `doctor redact` decision.

## Identity acquisition (local prerequisite, pln#562)

Detection conflates three questions today; they split as follows:

| Question | Owner | Legitimate evidence |
|---|---|---|
| What is installed on this machine? | `agent-inventory` (single source) | disk presence — an **origin** attribute; doubles as the capability advertisement the cloud dispatcher needs |
| Who is calling? | `detectAiAgent` | process-scoped env markers ONLY — never directory presence; claimed identity sanity-checked *against* inventory |
| What trust? | explicit acts (human at setup, dispatcher at spawn), capped at contributor | never a read-path side effect |

## Migration (additive where verified; two steps are NOT)

Each claim re-checked against the actual zod schemas and call sites:

1. `AgentIdentityDocument` += optional `principal_id`, `origin_id` —
   **verified additive** (schema.ts keeps `version: z.literal(1)`; new
   fields zod-optional; old docs parse). Do NOT bump the version literal.
2. `origin_id` minted lazily at first federation use, stored next to
   `project.identity.json`; the v2 event envelope stays agnostic (origin
   added only to *exported* slices via segment headers — zero local
   *export* cost). **Import is not zero-cost**: per-origin cursors +
   foreign sidecars (see slice section) are new mechanisms, landing only
   with federation itself.
3. Cursors and cloud inboxes re-keyed name → instance. **Two corrections**:
   (a) local event cursors (`events/.cursors/<agent>.json`) are being
   migrated to seq watermarks by event-log phase 1 anyway — do the re-key
   *in that migration*, not as a separate rename done twice; (b) the cloud
   inbox re-key (`/api/v1/inbox/<agent_name>` → instance-keyed) is a
   **coordinated cloud API change, not a local rename** — an old client
   pulling the name-keyed endpoint against a re-keyed cloud silently gets
   an empty inbox (the pull error path returns `[]`). Needs an API
   version window or dual-key serving.
4. Wire `isDuplicate` + a persisted `since` watermark for cloud pulls now
   (pre-federation bugfix — **verified real**: session-start.ts pulls with
   `{limit: 100}`, no `since`, no dedup; every session re-materializes the
   same signals as new entities). Slightly more than "wire it":
   `materializeFederationSignal` mints fresh local ids and **discards the
   incoming `idempotency_key`**, so there is nothing on disk to dedup
   against — the fix must (a) persist a seen-keys watermark file and
   (b) stamp `provenance.kind: 'federation'` + `remote_id` on
   materialized entities (the provenance schema already has the slot).
5. `FederationMessage` v2 — **the secretly-breaking step**.
   `FederationMessageSchema` pins `schema_version: z.literal(1)` and
   `deserializeMessage` hard-parses; a v1-only receiver given a v2 message
   throws, and `pullSignals`' catch-skip **silently drops it forever**
   (local-transport inboxes are written by the *sender* into the target
   project). And v1's required `project_path` fields mean a v2 message
   that omits them fails v1 parsing by absence too. Mitigation: ship the
   v1|v2 **union reader first** (accept both, one release ahead), only
   then switch writers to v2; cloud negotiates per-client version during
   the window. `idempotency_key` survives as dedup-only, recomputed over
   canonical JSON (see envelope section).

## Open questions for this review

Resolved by the 2026-06-10 schema review pass (claims now in the body
above): envelope/signature concretization (JCS canonical form, payload_hash
detachment, per-origin replay watermark, key rotation via token-rooted key
list); the scalar-rev concurrency hole (`base_rev` fix); restore-from-backup
(`origin_epoch`); eager-push ordering (envelope identity + never-regress);
slice ingestion vs the event-log seq space (per-origin sidecars +
`federation_apply`); remote-gc snapshot slices; the privacy strip-list gaps
(author/reviewer fields, raw-hostname host_id, AgentRun.command, the live
v1 project_path leak); the two non-additive migration steps (3b, 5).

Residual — genuinely needs a second model's eye:

- **[CODEX]** `members` projection wire format: exact signed structure
  (who signs — the cloud as trust root, or the org-admin principal key?),
  grant granularity (per-project role enum vs capability list), and the
  max-staleness/deny-by-default semantics interaction with local-only
  stores that NEVER reconnect. The revocation *enforcement point* is
  settled (cloud stamp); the projection's own authenticity chain is not.
- **[CODEX]** `base_rev` adversarial check: can a malicious or buggy
  origin *forge* fast-forwards (claim `base_rev = current.rev` to suppress
  conflict surfacing)? Within-org actors are semi-trusted — decide whether
  conflict suppression by a hostile insider is in scope, or accepted as
  "history is signed and attributable, dispute via audit".
- **[CODEX]** `federation_apply` event schema vs event-log C1 review (it
  joins the `checkpoint_ref`/`journal_note`/`seq_repair`/`backfill` set):
  payload shape for per-entity outcomes, and whether a huge foreign batch
  (10k entities) needs chunked apply events to respect the 256 KB record
  cap and §2.9 chunked-lock rule.
- **[JUAN]** org model scope for v1 (implicit single-org? explicit org
  onboarding?); one API token per human vs per machine; whether claim
  eager-push is acceptable bus chatter on the free tier; members-projection
  max-staleness → read-only-federation degradation (availability vs
  security posture).
