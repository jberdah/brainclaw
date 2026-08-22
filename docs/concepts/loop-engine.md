# Loop engine

brainclaw coordinates many agents against shared state. The Loop engine
turns repetitive multi-turn workflows — review, ideation, implementation,
research, and debug — into **first-class, persistable, automatable objects**
sharing one common runtime.

Status: **shipped**. `bclaw_loop` exposes the persistent engine and its five
built-in protocols; `bclaw_coordinate` and `bclaw_dispatch` add ergonomic
shortcuts for ideation and review. This document retains the RFC-level
concurrency contract and implementation history where it explains an
invariant, but its operational sections describe the surface available today.

**How this doc is organised.** It starts with the shared engine — authority,
phases, artifacts, lifecycle verbs, gates, recovery, observability — and
then points at five per-protocol guides. Each protocol has its own page in
[`docs/loops/`](../loops/); this page is not a review guide. The five
protocols are equal citizens of the engine, and this is not a review feature
with a few extensions.

- [Review](../loops/review.md) — validate a change against a reviewer.
- [Ideation](../loops/ideation.md) — pressure-test a proposal against
  project memory.
- [Implementation](../loops/implementation.md) — drive a plan+sequence to a
  green verify.
- [Research](../loops/research.md) — converge open-ended investigation to
  a synthesis.
- [Debug](../loops/debug.md) — drive a broken system back to green.

Identity, dispatch decisions and spawn authority live in a separate façade
over the reservation core — see
[Attempt authority](./attempt-authority.md).

## Why

Without a loop, recurring work is easy to reduce to manual ping-pong:
an operator relays a proposal and its critique, asks an implementer to retry a
failed check, gathers research findings, or forwards review feedback. Each
round is glue work, lost context, and copy-paste errors.

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

## Attempt authority

Every dispatched turn crosses several boundaries — the loop mints identity,
an assignment must be persisted, a run must be launched, evidence must
eventually be accepted. `AttemptAuthority` is the single writer for that
turn's identity and commit-decision fields; the Loop engine never
double-writes them. It is a façade over the existing `TurnReservation` core
in [`src/core/loops/attempt-reservation.ts`](../../src/core/loops/attempt-reservation.ts),
not a new subsystem or a new journal. Its normative turn-owned chronology is
`reserve → commit → arm → durable projections → consume → wonTransition ===
true`. `prepareTurnExecution` applies it to worker phases of all five kinds and
refuses `engine`/`manual` phases before reservation. Review and multi-agent
ideation use it through their coordinator shortcuts; implementation, research
and debug use the same contract when their driver dispatches a worker, even
where the phase is still operator-driven. The pre-crossing callback creates or validates
the Assignment and AgentRun, binds the active claim, and binds the slot. A turn
crossed through that adapter is therefore harvestable; a pre-crossing crash is
repairable by replaying the same deterministic ids.

Phase-specific execution metadata lives in `LOOP_KIND_POLICIES`; phase graphs,
gates, iteration and stop conditions remain exclusively in `DEFAULT_PROTOCOLS`.
The current execution split is deliberately visible here for all five protocols:

| Kind | Worker phases | Engine phases | Manual phases | Integration required before convergence |
|---|---|---|---|---|
| `review` | `findings`, `author_response`, `followup_review` | `verdict` | `change_summary` | `author_response` |
| `ideation` | `critique` | — | `proposal`, `revision`, `synthesis` | — |
| `implementation` | `execute` | `bind`, `verify` | `handoff_ready` | `execute` |
| `research` | `investigate`, `synthesize` | `conclude` | — | — |
| `debug` | `reproduce`, `hypothesize`, `isolate`, `fix` | — | `handoff` | `fix` |

Every worker result must carry the phase's explicit `artifact_type`. A summary
is useful observability, but it is never proof that opens a gate. Report harvest
may reconcile read-only phases; mutating phases keep their claim until
`harvest --integrate` has integrated the worktree.
The concurrency and recovery contract lives in the dedicated document —
see [Attempt authority](./attempt-authority.md) for the full model,
identity matrix, ordered dispatch and invariants I1–I18. This page assumes
that contract without restating it.

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

## Artifact body shapes

`LoopArtifact.body` has two known shape categories. Ref-based bodies keep large
content out of the loop thread JSON and store only file metadata in `body`.
Inline bodies keep the whole structured payload in `body` for small artifacts
such as operator questions and answers.

Ref-based bodies are JSON encoded as `RefBasedArtifactBody`:

- `ref`: string filename within the loop's `artifacts/` directory.
- `byte_count`: exact byte length of the referenced file at attach time.
- `sha256`: lowercase hex SHA-256 digest of the referenced file content.

The referenced file lives at
`.brainclaw/loops/threads/<loop_id>/artifacts/<ref>`. The champion or driver
code that calls `complete_turn` / `add_artifact` is responsible for writing the
file before or during the attach call, then attaching only
`JSON.stringify({ ref, byte_count, sha256 })` as the artifact body.

These artifact types use the ref-based shape:

- `signals_report`: structured discovery or bootstrap signals, often larger
  than the inline body cap.
- `project_md_draft`: draft `PROJECT.md` content prepared by a loop slot.
- `project_md_final`: final `PROJECT.md` content accepted by the loop.
- `file_diff`: unified diff or patch content produced for review or apply.

Typical attach flow:

```ts
const body = '<content>';
const ref = `<artifact-id>.<ext>`;
const artifactsDir = path.join(memoryDir(cwd), 'loops', 'threads', loopId, 'artifacts');
fs.mkdirSync(artifactsDir, { recursive: true });
fs.writeFileSync(path.join(artifactsDir, ref), body, 'utf8');
const byte_count = Buffer.byteLength(body, 'utf8');
const sha256 = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
complete_turn(
  {
    ...,
    artifact: {
      phase,
      type,
      body: JSON.stringify({ ref, byte_count, sha256 }),
    },
  },
  cwd,
);
```

`RefBasedArtifactBodySchema` in `src/core/loops/types.ts` is the authoritative
validator for this metadata shape. `KNOWN_ARTIFACT_BODY_SCHEMAS` in the same
file lists which artifact types are ref-based and which use inline JSON bodies.

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

## Supported workflows

The engine is one control plane, not a review feature with a few extensions.
All five `LoopKind` values below ship a default protocol in
`src/core/loops/types.ts`; callers may override phases and stop conditions when
opening a loop. Review has the most automated coordinator shortcut, but it is
one workflow among the five.

| kind | default progression | normal entry point | converges on |
|---|---|---|---|
| `review` | `change_summary` → `findings` → `author_response` → `followup_review` → `verdict` | `bclaw_coordinate(intent="review", open_loop=true)` or `bclaw_dispatch(intent="review", openLoop=true)` | an accepted verdict or the bounded iteration cap |
| `ideation` | `proposal` → `critique` ↔ `revision` → `synthesis` | `bclaw_coordinate(intent="ideate")`; `preset="bootstrap"` selects the onboarding variant | a `plan_draft` synthesis; see [ideation-loop.md](./ideation-loop.md) |
| `implementation` | `bind` → `execute` ↔ `verify` → `handoff_ready` | `bclaw_loop(intent="open", kind="implementation", allow_orphan=true)`, then `bind` | a handoff after a green verification command, or a bounded blocked result |
| `research` | `investigate` ↔ `synthesize` → `conclude` | `bclaw_loop(intent="open", kind="research", allow_orphan=true)` | a synthesis after at least one finding per investigation round |
| `debug` | `reproduce` → `hypothesize` ↔ `isolate` ↔ `fix` → `handoff` | `bclaw_loop(intent="open", kind="debug", allow_orphan=true)` | a handoff after the reproducing command is green, or a bounded blocked result |

`allow_orphan=true` is an explicit acknowledgement for direct opens: the caller
will drive or dispatch the resulting loop rather than creating an inert thread.
The shared lifecycle verbs are `turn`, `complete_turn`, `advance`,
`add_artifact`, `pause`, `resume`, and `close`. Implementation loops additionally
use `bind` to dispatch their linked sequence and `verify` to run their declared
command.

### Clarification is a cross-cutting primitive

Clarification is deliberately not a sixth protocol. Any workflow can call
`request_input` to record an evidence-backed operator question, pause either a
slot or the whole loop, and resume through `provide_input`. This keeps a missing
decision from being confused with a review finding or a failed implementation
check.

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

## Per-protocol guides

Each of the five kinds has its own operator-facing guide with the same
template — purpose, default protocol, entry points, advance gates, stop
condition, artifacts, routing, recovery, "when NOT to use", reference
implementation. Consult them for anything protocol-specific.

- [Review](../loops/review.md) — the most automated coordinator shortcut,
  autonomous fix cycle on `request_changes`, symmetric review-and-fix mode.
- [Ideation](../loops/ideation.md) — memory-confrontation with a
  per-phase context filter and a `critique↔revision` iteration block; see
  also the full RFC in [ideation-loop.md](./ideation-loop.md).
- [Implementation](../loops/implementation.md) — `bind → execute↔verify →
  handoff_ready`, deterministic `command_green` exit.
- [Research](../loops/research.md) — `investigate↔synthesize → conclude`,
  no `blocked` outcome, `critic_signal` exit.
- [Debug](../loops/debug.md) — `reproduce → hypothesize↔isolate↔fix →
  handoff`, mirrors implementation's `command_green` gate on the repro.

`bclaw_coordinate` exposes two of these as ergonomic shortcuts today:
`intent='review'` (with `open_loop: true`) and `intent='ideate'`. Both
were extended strictly backward-compatibly — every prior call still
behaves as before. The current coordinate vocabulary is
`assign | consult | review | reroute | summarize | ideate`.

## Common engine extensions used by protocols

Three engine extensions are shared across protocols; per-protocol guides
reference them rather than re-defining them.

- **`LoopPhase.context_filter?: LoopContextCategory[]`** — closed enum
  with `'*'` wildcard. Drives per-phase memory selection at brief
  assembly time (ideation, implementation, research, debug all use it).
- **`LoopPhase.advance_gate?: StopCondition`** — re-uses the
  `StopCondition` vocabulary as a phase-exit guard. When unmet, the driver
  emits a `phase_advance_blocked` system event with a structured
  `gate_reason` and throws an actionable error. Every protocol except
  `review` ships at least one default gate.
- **`LoopProtocolConfig.iteration?: { cycle, max_iterations, exit_when }`**
  — wraps an inner cycle. The FSM (`decideNextPhase` in
  `iteration-engine.ts`) handles cycle progress and the `exit_when`
  predicates (`no_new_critique_artifacts`, `critic_signal`,
  `command_green`), and emits `max_iterations_reached` when the cap
  fires.

Both new event kinds — `phase_advance_blocked` and
`max_iterations_reached` — live in the same event journal as
`turn_assigned` / `phase_advanced`. They are intentionally **not**
artifacts (which would force every consumer to filter `is_system`
before processing content).

## Recovery and observability

Recovery of a dispatched turn is decision-driven, not marker-driven — a
recoverer reads the reservation record and acts on its
`(decision, launch.status, lease_deadline)` triple. The full set of
transitions and their handling lives in
[attempt-authority.md#recovery](./attempt-authority.md#recovery). Loop-level
recovery on top of that:

- **Projection repair before crossing.** The common dispatch choke point
  replays create-or-validate operations for Assignment, AgentRun, claim and
  slot while the grant is still armed. It crosses only after all four exist;
  an already-crossed replay never acquires spawn authority again.
- **Terminal loop early-return.** Every mutating convergence
  (`reconcileTurn`, `reconcileFailedTurn`) idempotent no-ops on a closed
  loop and still releases the coordinator claim.
- **Journal crash recovery.** `max(event.seq) > thread.version` triggers
  a synchronous journal replay before any new mutation proceeds (see the
  commit protocol below).
- **Superseded-turn guard.** A newer turn taking over a slot binds
  `slot.current_turn_id`; a late reconcile of the old turn no-ops.
- **Contradictions.** A turn-keyed completed+failed pair on the same
  attempt withholds convergence and journals a `run_blocked` runtime
  event with `status_reason: turn_evidence_contradiction`.

Observability is split across four surfaces — see
[attempt-authority.md#surfaces-and-their-roles](./attempt-authority.md#surfaces-and-their-roles).
In short: the `TurnReservation` record + launch decision cell is
**authoritative**; `LoopEvent` is **causal**; `RuntimeEvent` is
**telemetry**; the legacy `events.jsonl` stream is **compatibility-only**.
No consumer looks past its role. There is no fifth journal.

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

- Collaborative loops (`review`, `ideation`, and `research`) route turns by `slot_id` — the engine writes to the slot's agent inbox via the existing coordinate path.
- Execution-oriented loops (`implementation` and `debug`) can route work by `claim_id`, preserving the claim-routed model already in use.
- `session_id` is not a routing key; it remains observability-only. This is consistent with `architecture_session_centric_identity` in memory.

### Project resolution gate (pln#521 P1)

`bclaw_coordinate(intent='review', open_loop=true)` resolves WHICH project the
loop belongs to before it writes anything. A loop that lands in the wrong store
persists a candidate, claim, assignment and loop where nobody is watching, and
spawns the reviewer against the wrong repo.

The ladder, in order: an explicit `project` argument; then any selector that
already won upstream (`--cwd`, `BRAINCLAW_PROJECT`, a session switch, the
physical child store, the workspace `active-project.json`); then the bare cwd
fallback. The fallback is accepted in a single-project store — there is exactly
one answer — and **refused** with `needs_project_selection` when the store can
host several projects (`project_mode: multi-project`, or a `store_type: workspace`
parent with nested project stores). The error lists the candidates and creates
nothing; fix it by passing `project='<name>'` or by making the choice sticky with
`bclaw_switch`. Ref, scope and path are never used to guess the project (B3
rejected in `art_e29e88878209`: a wrong guess costs more than an explicit choice).

Both `bclaw_coordinate` (open_loop reviews) and `bclaw_dispatch_status` echo the
decision as `project_name` / `project_cwd`. `dispatch_status` additionally carries
`_resolution_trace` (`source_cwd`, `effective_cwd`, `active_source`, `project_arg`)
so a misroute can be diagnosed without reverse-engineering cwd and store state.

## Open questions (resolved / deferred)

Status after Codex schema review (cnd#574 / `dec_be66ccbf`, verdict `needs_revision` → addressed in v8):

1. **Custom phases per loop** — **Resolved: allow with validation.** `open` accepts arbitrary `LoopPhase[]` (non-empty, unique `name` values, at least one phase must be reachable from `phases[0]`). Built-in protocols still ship with defaults.
2. **Parallel slots in a single phase** — **Resolved: per-phase `advance_when`.** Each `LoopPhase` carries an optional `advance_when: 'all' | 'any'` (default `'all'`). `advance` blocks until the policy is satisfied by the slots participating in the current phase.
3. **Cross-project loops** — **Deferred to phase 2.** MVP is single-project. Tracked alongside `pln_12d33efe` (cross-project coordinate).
4. **Reopening a closed loop** — **Deferred.** `close` is terminal in MVP. Fixup reuse is done by opening a new loop that `linked` references the original.
5. **Artifact size cap** — **Resolved: 4 KB inline `body`, else force `ref`.** Encoded in the `LoopArtifact` contract. Above 4 KB the handler rejects and suggests creating a `message` or `handoff` to reference.

## Implementation status

The historical acceptance items in this RFC are complete: the verbs are exposed
through `bclaw_loop`, built-in protocols are defined in
`src/core/loops/types.ts`, and review/ideation receive coordinator shortcuts.
Future protocol work should extend the shared engine and update the workflow
table above rather than treating review as the default abstraction.

## Related

- [attempt-authority.md](./attempt-authority.md) — identity, dispatch decisions and spawn authority for every turn
- [P0B projection-boundary tests](../../tests/unit/loops-p0b-projections-before-crossing.test.ts) — crash/replay coverage around the common pre-crossing boundary
- [Per-protocol guides](../loops/) — review / ideation / implementation / research / debug
- [plans-and-claims.md](plans-and-claims.md)
- [coordination.md](coordination.md)
- [dispatch-lifecycle.md](dispatch-lifecycle.md) — entity FSMs (loop / assignment / agent_run / claim), brief-ack semantics, log-file diagnostic playbook
- [runtime-notes.md](runtime-notes.md)
- pln#394 `feat/loop-engine-mvp`
- pln#395 `feat/review-loop-protocol`
- pln#392 `doc/mcp-versioning-and-surface-governance` (prerequisite)
- pln#676 / dec#171 — attempt-authority rollout
