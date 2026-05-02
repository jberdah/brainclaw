# Loop engine

brainclaw coordinates many agents against shared state.
The Loop engine turns repetitive multi-turn workflows
— reviews, ideation rounds, implementation handoffs —
into **first-class, persistable, automatable objects**.

Status: design draft v8 (pln#394 step 1). v6 added a hard mutation deadline + consistent opt-out-`open` and unified terminology. v7 made `turn` strictly async and fenced committing writes with `mutation_id` re-reads. v8 applies Codex's follow-up lock-check (cnd#580 / `dec_4ba1a20f`) and introduces the symmetric review-and-fix protocol mode. Codex-authored fixes: the commit protocol now makes **journal replay before CAS normative**, `complete_turn` and any future slot-bound mutation now require the caller's `agentId` to match the slot owner (with `created_by` as the only admin fallback), and lock-heartbeat renewals are written by temp-file + atomic rename so fence reads always observe a coherent JSON blob. Final symmetric-mode integration: `open` accepts `mode: 'asymmetric' | 'symmetric'`, the resolved selection is persisted on the loop thread for deterministic resume/turn handling, and per-turn execution degrades cleanly to asymmetric behavior when a slot cannot safely apply fixes.

## Why

Today, recurring multi-agent work is done by hand:
an operator copies a diff, pastes it to a reviewer, collects the findings,
pastes them back to the author, re-asks for a re-review.
Each round is glue work, lost context, and copy-paste errors.

A Loop captures the whole cycle as state:
*participants, phases, current position, artifacts, stop criteria*.
Agents read the loop, know exactly what phase we are in, and advance it.
The operator becomes optional in the hot path.

## What a Loop is

A Loop is a **persistent thread of structured work** with:

- a **kind** (review, ideation, implementation, research, debug) that defines a protocol
- an ordered list of **phases**
- a set of **slots** — participant positions, each filled by an agent instance playing a role
- **artifacts** attached to phases (findings, syntheses, verdicts, …)
- optional **links** to existing brainclaw primitives (plans, sequences, claims, handoffs, candidates)
- a **stop condition** that determines when the loop auto-closes
- an **append-only event journal** for resume and debug

A Loop stores *references* to existing objects — it never duplicates them.
Claims, handoffs, and candidates remain the source of truth for their own data.

## Data model

```ts
type LoopId = `lop_${string}`;
type SlotId = `lsl_${string}`;

interface LoopThread {
  schema_version: 1;                    // schema revision; bump on breaking changes
  id: LoopId;                           // repo convention (not `loop_id`)
  version: number;                      // monotonic; incremented on every mutation
  mutation_id: string;                  // ULID of the last write; used for optimistic concurrency + idempotent retries

  kind: LoopKind;
  title: string;
  goal?: string;
  protocol?: LoopProtocolConfig;        // persisted protocol knobs resolved at `open` time

  status: LoopStatus;
  phases: LoopPhase[];                  // ordered; each phase carries its own advance policy
  current_phase: string;                // must match some phases[i].name
  iteration_count: number;              // incremented on re-entry into an earlier phase

  slots: LoopSlot[];
  artifacts: LoopArtifact[];
  linked?: LoopLinks;                   // top-level context only (plan/sequence). Other refs live on artifacts/slots.
  stop_condition?: StopCondition;

  created_at: string;                   // ISO
  updated_at: string;
  closed_at?: string;
  created_by: string;                   // agentId
}

type LoopStatus = 'open' | 'paused' | 'completed' | 'blocked' | 'cancelled';
type ReviewMode = 'asymmetric' | 'symmetric';

interface LoopProtocolConfig {
  review_mode?: ReviewMode;             // review loops persist their selected mode so resume/turn handlers are deterministic
}

interface LoopPhase {
  name: string;
  advance_when?: 'all' | 'any';         // default 'all' — every slot turn in this phase must be `done` before advance
}

interface LoopSlot {
  slot_id: SlotId;
  role: string;                         // e.g. "reviewer", "author", "challenger"
  agent?: string;                       // agent type, e.g. "codex"
  agent_id?: string;                    // specific registered agent id
  assignment_id?: string;               // set when a turn is dispatched
  claim_id?: string;                    // for execution loops, the claim held by this slot
  phase?: string;                       // which phase this slot currently participates in (supports parallel slots per phase)
  status: 'open' | 'assigned' | 'working' | 'done';
}

interface LoopArtifact {
  artifact_id: string;
  phase: string;
  type: string;                         // "finding" | "synthesis" | "verdict" | "plan_draft" | ...
  ref?: LoopRef;                        // preferred: link to an existing primitive
  body?: string;                        // inline content ≤ 4 KB; else force `ref`
  produced_by?: SlotId;
  produced_at: string;
}

type LoopRef =
  | { kind: 'plan'; id: string }
  | { kind: 'sequence'; id: string }
  | { kind: 'claim'; id: string }
  | { kind: 'handoff'; id: string }
  | { kind: 'candidate'; id: string }
  | { kind: 'message'; id: string };

// Top-level context only — handoff/claim/candidate refs belong on artifacts or slots.
interface LoopLinks {
  plan_ids?: string[];
  sequence_ids?: string[];
}

// StopCondition is composite: atomic clauses can be combined with any/all.
type AtomicStopCondition =
  | { kind: 'phase_reached'; phase: string }
  | { kind: 'reviewer_green' }                          // an `accepted` verdict artifact in any phase
  | { kind: 'max_iterations'; n: number }               // hard cap; on hit, close with status=blocked
  | { kind: 'artifact_produced'; phase: string; type: string }
  | { kind: 'manual' };                                 // only closes on explicit close

type StopCondition =
  | AtomicStopCondition
  | { kind: 'any'; conditions: StopCondition[] }        // OR — any matching clause closes the loop
  | { kind: 'all'; conditions: StopCondition[] };       // AND — every clause must match

// LoopEvent is a discriminated union with typed per-kind payloads (no loose `payload` map).
interface LoopEventBase {
  event_id: string;                                     // ULID
  loop_id: LoopId;
  seq: number;                                          // monotonic per loop, starts at 1
  at: string;
  by?: string;                                          // agentId or slot_id
  mutation_id: string;                                  // matches the thread.mutation_id written in the same 2-phase commit
}

type LoopEvent =
  | (LoopEventBase & { kind: 'opened'; initial_phase: string; created_by: string })
  | (LoopEventBase & { kind: 'phase_advanced'; from_phase: string; to_phase: string; iteration: number; reason?: string })
  | (LoopEventBase & { kind: 'turn_assigned'; slot_id: SlotId; phase: string; assignment_id?: string; input?: string; retry_of?: string /* prior event_id */ })
  | (LoopEventBase & { kind: 'turn_completed'; slot_id: SlotId; phase: string; artifact_id?: string; outcome: 'done' | 'failed' | 'cancelled'; failure_reason?: string })
  | (LoopEventBase & { kind: 'artifact_added'; artifact_id: string; phase: string; type: string; produced_by?: SlotId })
  | (LoopEventBase & { kind: 'linked'; target: LoopRef })
  | (LoopEventBase & { kind: 'paused'; reason?: string })
  | (LoopEventBase & { kind: 'resumed' })
  | (LoopEventBase & { kind: 'closed'; final_status: Exclude<LoopStatus, 'open' | 'paused'>; reason?: string });

// Conflict records are NOT committed to the main journal — they do not carry `seq` and do
// not advance `thread.version`. They live in a separate observability log (`loops/conflicts/<id>.jsonl`)
// and are returned as-is in the error response of the rejected call.
interface LoopConflictRecord {
  conflict_id: string;                                  // ULID
  loop_id: LoopId;
  at: string;
  attempted_by: string;                                 // caller agentId
  expected_version: number;
  actual_version: number;
  rejected_intent: string;                              // e.g. "advance" | "complete_turn"
  client_request_id?: string;
}
```

## Lifecycle verbs

The engine exposes four active verbs. Each one mutates state, appends an event, and returns the updated `LoopThread`. **All verbs are strictly synchronous-on-state and asynchronous-on-work**: any downstream dispatch (spawning a CLI, calling another MCP tool) is fire-and-forget from the commit window, so the per-loop lock is always released quickly.

- **open** — create a new loop. Inserts `opened` event; `current_phase` set to `phases[0].name`.
- **turn** — record that a phase's work is assigned to a slot. Fire-and-forget dispatch: the handler kicks off the downstream call (e.g. `bclaw_coordinate` to spawn a CLI) and returns immediately. `slot.status` flips to `'assigned'` with an `assignment_id`; the actual work continues outside the lock. Inserts `turn_assigned`. The slot reports back later via a separate `complete_turn` call.
- **advance** — evaluate `stop_condition`; if satisfied, `close` with `status=completed`. Otherwise, transition `current_phase` to the next phase (or a specified one). Inserts `phase_advanced`. If `advance` revisits an earlier phase (e.g. a fixup round re-enters `findings`), `iteration_count` increments.
- **close** — terminal: set `status` to `completed | cancelled | blocked` and `closed_at`. Inserts `closed`.

Two auxiliary verbs cover quality of life:

- **pause** / **resume** — suspend a loop without closing (e.g. waiting on an external input).
- **add_artifact** — attach an artifact to a phase without moving on.
- **complete_turn** — close out a previously-assigned turn: flips `slot.status` to `'done'` (or `'failed' | 'cancelled'`), optionally attaches an artifact carrying the outcome. Emitted by the slot agent itself when its dispatched work returns. Separate from `turn` precisely because the dispatch is async. Authorization is strict: the caller's `agentId` must equal that slot's `agent_id`, unless the caller is the loop's `created_by`, which is the only admin override.

## MCP facade: `bclaw_loop(intent)`

Consistent with `bclaw_work` and `bclaw_coordinate`: a single unified tool with an `intent` argument, a caller-identity envelope (`agent`, `agentId`), and a standard `FacadeResponse` envelope on the output.

```ts
// Caller identity + idempotency envelope, consistent with bclaw_work / bclaw_coordinate.
interface BclawLoopCallerEnvelope {
  agent?: string;                       // caller agent name
  agentId?: string;                     // caller registered agent id
  client_request_id?: string;           // caller-minted ULID/UUIDv7 for idempotent retries (mutating intents only)
}

// Per-intent payloads. Every mutating intent supports `expected_version` + `client_request_id`.
type BclawLoopInput = BclawLoopCallerEnvelope & (
  | { intent: 'open';          kind: LoopKind; title: string; goal?: string; phases?: LoopPhase[]; slots?: Partial<LoopSlot>[]; linked?: LoopLinks; stop_condition?: StopCondition; mode?: ReviewMode /* review only; persisted to loop.protocol.review_mode; default 'asymmetric' */ }
  | { intent: 'turn';          loop_id: LoopId; slot_id?: SlotId; role?: string; input?: string; dispatch?: boolean; expected_version?: number }
  | { intent: 'complete_turn'; loop_id: LoopId; slot_id: SlotId; artifact?: Omit<LoopArtifact, 'artifact_id' | 'produced_at'>; outcome?: 'done' | 'failed' | 'cancelled'; failure_reason?: string; expected_version?: number }
  | { intent: 'advance';       loop_id: LoopId; to_phase?: string; reason?: string; force?: boolean; expected_version?: number }
  | { intent: 'add_artifact';  loop_id: LoopId; artifact: Omit<LoopArtifact, 'artifact_id' | 'produced_at'>; expected_version?: number }
  | { intent: 'pause';         loop_id: LoopId; reason?: string; expected_version?: number }
  | { intent: 'resume';        loop_id: LoopId; expected_version?: number }
  | { intent: 'close';         loop_id: LoopId; status: 'completed' | 'cancelled' | 'blocked'; reason?: string; expected_version?: number }
  | { intent: 'get';           loop_id: LoopId; include_events?: boolean }
  | { intent: 'list';          kind?: LoopKind; status?: LoopStatus; linked_plan_id?: string; limit?: number; offset?: number }
);

// Standard facade envelope, matching bclaw_work / bclaw_coordinate output shape.
interface BclawLoopOutput {
  status: 'ok' | 'error';
  schema_version: string;               // e.g. "0.6.0"
  duration_ms?: number;
  warnings?: string[];
  artifacts?: Array<{ type: 'loop' | 'loop_event' | 'message'; id: string }>;
  side_effects?: Array<{ action: 'create' | 'update'; entity: 'loop' | 'loop_event' | 'assignment'; id: string }>;
  result: {
    loop?: LoopThread;                  // single-loop intents
    loops?: LoopThread[];               // list
    events?: LoopEvent[];               // get with include_events
    next_expected?: NextExpectedHint | null;
  };
}

// Self-describing hint for the downstream agent: what intent to call next, with concrete ids.
type NextExpectedHint =
  | { action: 'turn';    intent: 'bclaw_loop.turn';    phase: string; slot_id: SlotId; role: string; blocking_on: SlotId[] }
  | { action: 'advance'; intent: 'bclaw_loop.advance'; from_phase: string; to_phase: string; blocking_on: SlotId[] }
  | { action: 'close';   intent: 'bclaw_loop.close';   reason: string };
```

**Why a single facade, not `bclaw_loop_open`/`_advance`/`_close` tools.** Consistency beats granularity for agent-facing DX. The two existing facades are intent-based; adding a third in the same style keeps the surface small and predictable. Agents that need low-level control can still go to the underlying store (local file reads, not MCP).

**Slot-bound auth.** `complete_turn` is a slot-owned mutation, so the server must resolve the target slot inside the lock and verify `caller.agentId === slot.agent_id`. If not, reject with `unauthorized_slot_write`. The single admin fallback is `caller.agentId === loop.created_by`, which allows the loop owner to recover a wedged slot or cancel it explicitly. Any future slot-specific intent added to this facade inherits the same rule.

**Concurrency control.** See the Persistence section below for the full lock-file CAS mechanism. In short: the server serializes all mutations on a given loop with an exclusive per-loop lock file, re-reads `thread.version` inside the lock, validates `expected_version` if supplied, and only then commits. Two racing writers cannot both succeed — one gets the updated version, the other gets a `409 conflict` with the observed `actual_version` to retry against. Conflict records live in a separate observability log and do not disturb the `seq`/`version` lockstep.

**Idempotency.** Mutating intents accept an optional `client_request_id` (caller-minted ULID/UUIDv7). The server caches the final response keyed on `(loop_id, client_request_id)` — or `(agent_id, client_request_id)` for `open`, which has no `loop_id` yet — alongside a `request_hash = sha256(canonical_json(request_without_caller_envelope))`. The idempotency lookup happens **inside the commit lock**, so concurrent retries serialize and see each other's cached result. If the same `client_request_id` arrives with a different `request_hash`, the call is rejected with `idempotency_key_reused_with_different_body` — callers must mint a fresh key for semantically different requests. Cache TTL is 24 h. The `mutation_id` inside the thread/event is server-minted and drives the 2-phase-commit replay story; it is orthogonal to caller idempotency.

> **Caller note.** For `request_hash` to match on retry, the caller must replay the request body byte-for-byte, including any volatile fields it chose to include (timestamps, generated ids in the payload). Retries that differ in such fields will be treated as distinct requests and rejected with the reuse error. Practical rule: build the request once, snapshot it, and resend that exact snapshot on retry. The caller envelope itself (agent, agentId, client_request_id) is excluded from the hash.

## Default protocols

Each `kind` ships a default `phases[]` and `stop_condition`. Users can override either at `open` time.

| kind | phases | default stop_condition |
|---|---|---|
| `review` | `change_summary` → `findings` → `author_response` → `followup_review` → `verdict` | `reviewer_green` OR `max_iterations: 3` |
| `ideation` | `proposal` → `critique` → `revision` → `synthesis` | `artifact_produced { phase: synthesis, type: plan_draft }` |
| `implementation` | `sequence_build` → `dispatch` → `execute` → `self_check` → `handoff_ready` | `artifact_produced { phase: handoff_ready, type: handoff }` |
| `research` / `debug` | user-defined | `manual` |

## Relation to existing primitives

The Loop engine is a **control plane**; existing primitives remain the **data plane**.

| Primitive | Role in a loop |
|---|---|
| Plan | Often the output of an `ideation` loop; referenced from `linked.plan_ids` |
| Sequence | Compiled from a plan by an `implementation` loop |
| Claim | Scope lock held by an execution slot; pointed to from `slot.claim_id` |
| Handoff | Produced at `handoff_ready`; referenced as an artifact |
| Candidate | Reviewable artifact produced during implementation |
| Message | Human-readable turn content; can be referenced from artifacts |

A Loop never copies these objects — it links them. Deleting the linked primitive does not break the loop; the reference just becomes dangling, surfaced in diagnostics.

## Automation: extending `bclaw_coordinate(intent='review')`

This is the user-visible promise of the MVP — manual review round-trips disappear.

The existing `review` intent in `bclaw_coordinate` already creates a review candidate. We extend it — **strictly backward-compatible** — with an optional flag `open_loop?: boolean` that **defaults to `false`**. Every existing `review` call behaves exactly as today; a caller must explicitly opt in by passing `open_loop: true`. We do **not** introduce a new intent; the coordinate enum (`assign | consult | review | reroute | summarize`) stays stable. A future minor version may flip the default after telemetry confirms adoption, but such a flip will be gated by MCP schema versioning (pln#392) and surfaced in the changelog.

When `bclaw_coordinate(intent='review', open_loop: true)` is called, it:

1. Creates the review candidate as today.
2. Opens a `review` loop via `bclaw_loop(intent: 'open', kind: 'review', ...)` with slots `{role: 'author', agent: caller}`, `{role: 'reviewer', agent: target}`.
3. Links the provided handoff/candidate to the loop as an artifact at `change_summary`.
4. Advances to `findings` and calls `bclaw_loop(intent: 'turn')` to dispatch to the reviewer.
5. On turn completion with a verdict artifact, auto-advances; `reviewer_green` stop closes.
6. On non-green verdict with `iteration_count < max`, advances to `author_response`, dispatches to author.

### Symmetric review-AND-fix mode

By default, the phases `findings` and `author_response` follow the classical asymmetric split — the reviewer identifies issues, the author applies fixes on the next turn. That doubles the number of round-trips: every issue needs one full turn to be identified, then another to be fixed.

When both slots are coding agents with write access to the artifact under review (the common case with `bclaw_coordinate(intent='review', open_loop: true, mode: 'symmetric')`), the protocol collapses those two roles into one behavior per turn: **the reviewer reviews AND applies whatever fixes it can make directly**, then returns a summary artifact of changes applied + a request for the other slot to review those changes. The other slot then takes its turn with the same semantics — review-and-fix on whatever is left — and so on. Exit is reached when a reviewer turn produces a green verdict with no unapplied findings and with `changes_applied` omitted or empty for that turn, or when `max_iterations` is hit.

The phase sequence stays the same (`findings → author_response → followup_review`), but each turn may emit at most one `changes_applied` artifact alongside any `finding` artifacts. That artifact must summarize the concrete edits made in that turn and point at the mutated object via `ref` when one exists (candidate, handoff, message, or other linked primitive); it is a turn summary, not a second source of truth. The next-turn handler always starts from the committed-and-reviewed state of the previous turn, not from the original draft. This halves the round-trip count when fixes are mechanical enough for the reviewer to own, which is the common case for spec work and small-to-mid refactors.

Selector: `mode: 'symmetric' | 'asymmetric'` on the `open_loop` call (or directly on `bclaw_loop(intent='open', kind='review', mode:…)`). Defaults to `asymmetric` for safety. On `open`, the server persists the resolved selection to `loop.protocol.review_mode` so resume/turn handlers do not depend on the original request envelope. If `symmetric` is requested but the active slot is human-operated or lacks write authority to the reviewed artifact, that turn degrades gracefully to asymmetric behavior for that slot: findings/verdicts are still allowed, `changes_applied` is omitted, and the loop proceeds without protocol error. Implementation-loops and security reviews typically stay asymmetric; RFC and doc reviews benefit most from symmetric.

The operator never copy-pastes. They see status in the board (`bclaw_context(kind="board")`) and can `bclaw_loop(intent="get", loop_id=…)` for detail.

## Persistence

```
.brainclaw/loops/
  threads/<id>.json                                      # main state
  events/<id>.jsonl                                      # append-only journal (seq/version authoritative)
  locks/<id>.lock                                        # per-loop exclusive lock (all intents on an existing loop, and opt-out `open`)
  locks/open/<agent_id>/<client_request_id>.lock        # idempotent-`open` lock keyed on idempotency scope
  idempotency/<id>/<client_request_id>.json              # 24h cache of completed mutation responses (one loop)
  idempotency-open/<agent_id>/<client_request_id>.json   # 24h cache for `open` intent (no loop_id yet)
  conflicts/<id>.jsonl                                   # observability-only log of rejected CAS attempts
```

**Lock scoping.** Two lock-path families exist:

- `locks/<loop_id>.lock` — used by every mutation on an existing loop (`turn`, `advance`, `complete_turn`, `add_artifact`, `pause`, `resume`, `close`), **and** by `open` when the caller does not supply `client_request_id`. In the opt-out `open` case, the `loop_id` (ULID) is minted by the handler **before** step 1 and reused as the lock key; since nothing else can observe this id yet, there is no race between concurrent opt-out calls.
- `locks/open/<agent_id>/<client_request_id>.lock` — used by `open` when the caller supplies `client_request_id`. The lock is keyed on the idempotency scope, not on a `loop_id`. Concurrent retries of the same `open` request serialize on this path before any id is minted. The real `loop_id` is minted inside the lock at step 3 and persisted into the idempotency record so retries return the same id.

**Lock file contents.** Every lock file is a small JSON blob, not an empty marker:

```json
{
  "pid": 12345,
  "host_id": "frams99l000391",
  "agent_id": "agt_…",
  "acquired_at": "2026-04-17T06:30:12.000Z",
  "lease_until": "2026-04-17T06:31:12.000Z",
  "hard_deadline": "2026-04-17T06:35:12.000Z",
  "mutation_id": "01HZ…"
}
```

**Server-owned lease renewal, bounded by a hard deadline.** `lease_until` is set to `acquired_at + 60 s` on lock acquisition. `hard_deadline` is set once at acquisition time to `acquired_at + max_mutation_duration` and **never moves**. The MCP handler spawns an internal heartbeat that rewrites `lease_until = now + 60 s` every 30 s while the mutation is still in flight — but **only as long as `now < hard_deadline`**. Heartbeat updates use the same temp-file + atomic-rename pattern as `thread.json`: write the full lock blob to a sibling temp file, fsync it, atomic-rename over `locks/<id>.lock`, fsync the directory. Readers therefore either see the old blob or the new blob, never a torn partial JSON document. The heartbeat refuses to renew past the deadline, the handler is instructed to abort its mutation, and the lock becomes reclaimable after the next `grace` window.

Default `max_mutation_duration` per intent:

| Intent | `max_mutation_duration` | Rationale |
|---|---|---|
| `open`, `turn`, `advance`, `pause`, `resume`, `close` | 30 s | Pure state transitions. `turn` is fire-and-forget — the dispatch call is kicked off inside the lock but the handler does not await its completion, so the lock window stays tight. |
| `add_artifact`, `complete_turn` | 60 s | May write small external ref files. |

The cap is configurable in `config.yaml` under `loops.max_mutation_duration_ms` (per-intent map). A wedged handler therefore cannot hold the lock past its intent-specific deadline; after the deadline, the lock is reclaimable by any recovery pass per the rules below. Callers never interact with the lease or deadline — both are server-internal.

**Why `turn` is fire-and-forget.** If `turn` awaited the downstream CLI/MCP call synchronously, a single slow agent (e.g. a 5-minute Codex review) would hold the per-loop lock and block every other mutation — a head-of-line-blocking hazard. Instead, the handler issues the dispatch, captures the `assignment_id`, writes `slot.status='assigned'`, commits, and releases the lock. The spawned process reports back later via `complete_turn`, which takes its own (short) lock. This is also consistent with brainclaw's existing dispatch contract: assignments are always async.

**Commit protocol (lock-file CAS with intra-lock idempotency):**

Before step 1, for the opt-out `open` path only (no `client_request_id`), the handler **pre-mints** the `loop_id` (ULID). Every other intent already has a `loop_id`; the idempotent `open` path postpones minting to step 3 so the idempotency cache can guard it.

1. **Acquire lock.** Open the appropriate lock path (see *Lock scoping* above) with `O_CREAT | O_EXCL` (POSIX) or `CreateFile` with exclusive share mode (Windows) and write the owner blob. On `EEXIST`, retry with jittered backoff (10 ms base, capped at 500 ms total). After timeout, fail with `lock_timeout`. Start the lease-renewal heartbeat (bounded by `hard_deadline`).
2. **Idempotency short-circuit (inside lock).** If the caller supplied `client_request_id`:
   - For mutations on an existing loop: look up `idempotency/<id>/<client_request_id>.json`.
   - For `open`: look up `idempotency-open/<agent_id>/<client_request_id>.json`.
   - If found, verify the stored `request_hash` matches `sha256(canonical_json(request_without_caller_envelope))`. On match, release the lock and return the cached response. On mismatch, return `{ status: 'error', code: 'idempotency_key_reused_with_different_body', stored_hash, submitted_hash }`.
3. **Replay / auth / CAS check / id minting.**
   - For mutations on an existing loop: read the current `thread.json`, then inspect `events/<id>.jsonl`. If `max(event.seq) > thread.version`, first replay the missing journal entries into the materialized thread and rewrite `thread.json` so `thread.version = max(event.seq)` before evaluating any new mutation. This replay-before-CAS step is mandatory: the next mutation always starts from the latest journal-authoritative state, never from a stale materialized thread.
   - For slot-bound intents (`complete_turn` today): resolve the target slot from that up-to-date thread and verify `caller.agentId === slot.agent_id` or `caller.agentId === thread.created_by`. Otherwise, release the lock and return `{ status: 'error', code: 'unauthorized_slot_write' }`.
   - After replay/auth, if the caller supplied `expected_version` and `thread.version !== expected_version`: append a `LoopConflictRecord` to `conflicts/<id>.jsonl` (observability only, no `seq`, no `version` bump), release the lock, and return `{ status: 'error', code: 'version_conflict', actual_version }`.
   - For idempotent `open` (locked on the idempotency scope): mint a fresh random `loop_id` (ULID) here. This is the only id-mint point for the idempotent path.
   - For opt-out `open`: `loop_id` was already minted before step 1; nothing to do here.
4. **Append event** *(fenced)*. Fence check: re-read `locks/<id>.lock` and verify its `mutation_id` still equals the value this handler wrote at step 1. If it differs, the lock has been reaped and a different handler owns the loop — **abort immediately without writing**, return `{ status: 'error', code: 'lock_lost' }`. Otherwise, write the new event to `events/<loop_id>.jsonl` with `seq = prev_seq + 1` (or `seq = 1` for `open`) and the handler's own `mutation_id` (ULID, minted at step 1 into the lock blob). Fsync the file.
5. **Atomic-rename thread** *(fenced)*. Repeat the same fence check on `locks/<id>.lock`. On mismatch, abort. Otherwise, write the new thread state (with `version = prev_version + 1`, or `version = 1` for `open`, and the same `mutation_id`) to a temp file, atomic-rename over `threads/<loop_id>.json`, fsync the directory.
6. **Persist idempotency record.** If `client_request_id` was supplied, write `{ response, request_hash, stored_at }` to the relevant idempotency path. (For `open`, the stored response includes the minted `loop_id` so retries get the same id back.)
7. **Release lock.** Stop the lease-renewal heartbeat and remove the lock file.

**Fencing token — what the re-read catches.** Every handler writes its own `mutation_id` into the lock blob at step 1. If the handler later blocks on a slow fs call or a dispatch kickoff and the deadline/liveness rules kick in, the recovery pass removes the lock. A different handler can then acquire a fresh lock with a **different** `mutation_id`. The late-unblocking handler's fence re-read at steps 4 and 5 will see the foreign `mutation_id` and abort cleanly — no write, no corruption, no phantom events in the journal. This closes the "late unblock after reap" hole: lock ownership is checked not only at acquisition but at every committing I/O point.

The `event.seq` and `thread.version` advance in lockstep — a successful commit produces exactly one new event with `seq = new_version`. Conflict records in `conflicts/<id>.jsonl` are out-of-band and never affect `seq` or `version`. The shared `mutation_id` on both committed files pins which event materialized which thread revision. Because step 3 always replays `events/<id>.jsonl` before a new CAS decision, a stale materialized thread cannot cause the next writer to append a journal event "ahead" of `thread.json`; the journal remains authoritative, and each new mutation must first catch the thread up to it.

**Stale-lock recovery (owner-liveness + deadline, not age-based):**

- Read the lock blob. If `now > hard_deadline` → the mutation exceeded its intent-specific cap → remove the lock regardless of liveness.
- Else if `host_id === current_host_id` and no process with `pid` exists (checked via `kill -0` / `OpenProcess`), the owner is dead → remove the lock.
- Else if `now > lease_until + grace` (default grace = 30 s) and the owner has not renewed, treat as abandoned → remove the lock.
- Else the lock is considered live; callers keep retrying.

The three rules are independent: `hard_deadline` bounds pathological "heartbeat alive but mutation wedged" cases; liveness check bounds crash cases; `lease_until + grace` bounds network/fs stalls. This fully replaces the unsafe "age > 10 s ⇒ reap" rule — a legitimate writer blocked on a slow fs call is no longer killed by age alone, but is still bounded by the intent-specific deadline.

**Journal crash recovery:**

- If `max(event.seq) > thread.version` → the journal has events past the last materialized state. Replay them to rebuild `thread.json`, then rewrite it with the final `mutation_id`. This is not just a background repair path: step 3 above must do this replay synchronously before the next mutation proceeds.
- If `max(event.seq) < thread.version` → impossible under the protocol above; surface a diagnostic (corrupted journal).
- If `max(event.seq) === thread.version` but `mutation_id` differs → crash mid-commit (temp file written, rename not flushed). Re-materialize from the journal's last event.

**GC:** closed loops older than N days are archived into `.brainclaw/gc-backups/loops/` alongside plans and handoffs. Idempotency records older than 24 h, stale lock files, and conflict logs older than 7 d are swept at the same time.

## Routing and multi-instance

- Discussion loops (`review`, `ideation`) route by `slot_id` — the engine writes to the slot's agent inbox via the existing coordinate path.
- Execution loops (`implementation`) route by `claim_id` — preserved from the claim-routed model already in use.
- `session_id` is not a routing key; it remains observability-only. This is consistent with `architecture_session_centric_identity` in memory.

## Open questions (resolved / deferred)

Status after Codex schema review (cnd#574 / `dec_be66ccbf`, verdict `needs_revision` → addressed in v8):

1. **Custom phases per loop** — **Resolved: allow with validation.** `open` accepts arbitrary `LoopPhase[]` (non-empty, unique `name` values, at least one phase must be reachable from `phases[0]`). Built-in protocols still ship with defaults.
2. **Parallel slots in a single phase** — **Resolved: per-phase `advance_when`.** Each `LoopPhase` carries an optional `advance_when: 'all' | 'any'` (default `'all'`). `advance` blocks until the policy is satisfied by the slots participating in the current phase.
3. **Cross-project loops** — **Deferred to phase 2.** MVP is single-project. Tracked alongside `pln_12d33efe` (cross-project coordinate).
4. **Reopening a closed loop** — **Deferred.** `close` is terminal in MVP. Fixup reuse is done by opening a new loop that `linked` references the original.
5. **Artifact size cap** — **Resolved: 4 KB inline `body`, else force `ref`.** Encoded in the `LoopArtifact` contract. Above 4 KB the handler rejects and suggests creating a `message` or `handoff` to reference.

## Next steps

1. If this final v8 review is green, lock the schema (this doc → `types.ts` in `src/core/loops/`).
2. Implement the four verbs (`open`, `turn`, `advance`, `close`) with the 2-phase-commit persistence described above.
3. Wire `bclaw_loop` into the MCP surface (pending pln#392 versioning policy).
4. Build the `review` protocol end-to-end (pln#395) as the first user-visible loop.
5. Add the `open_loop` opt-in on the existing `bclaw_coordinate(intent='review')` — the first manual-process killer.

## Related

- [plans-and-claims.md](plans-and-claims.md)
- [coordination.md](coordination.md)
- [runtime-notes.md](runtime-notes.md)
- pln#394 `feat/loop-engine-mvp`
- pln#395 `feat/review-loop-protocol`
- pln#392 `doc/mcp-versioning-and-surface-governance` (prerequisite)
