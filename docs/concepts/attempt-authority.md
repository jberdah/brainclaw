# Attempt authority

`AttemptAuthority` is brainclaw's single writer for the identity and
commit-decision of a dispatched Loop turn. It is a **façade over the
existing TurnReservation core** (`src/core/loops/attempt-reservation.ts`),
not a new subsystem or a new journal. The Loop Engine gates every spawn on
its verdicts; every recovery pass consults the same records; nothing else
mutates the fields it owns.

> Scope. This document freezes the current model so higher-level docs can
> reference a stable vocabulary. It is descriptive: no runtime behavior
> changes with this page. Anything marked *(deferred)* is called out
> explicitly.
>
> Source: [dec#171](../../.brainclaw/memory/decisions/dec_3b1066f5.json) /
> [pln#676](../../.brainclaw/coordination/plans/pln_322b0def.json) /
> ideation `lop_5544188fb066171e`.

## Why a single authority

A dispatched Loop turn crosses several boundaries: the Loop Engine mints
identity, an assignment must be persisted, a run must be launched, evidence
must eventually be accepted. Each boundary can crash. Without a single
authoritative record, two recoverers or two supervisors can disagree about
whether a turn was ever committed, whether a worker actually crossed into
exec, or whether a completed run is genuinely the one this turn ordered.
Every one of those disagreements is a double-spawn or a phantom launch.

The authority owns two atomic decisions:

1. **Commit** — is this attempt `prepared`, `committed`, or `aborted`? A
   `committed` decision is repair-only: it can never become `aborted`. An
   `aborted` decision can never become `committed`. Only `committed`
   attempts may spawn.
2. **Launch** — for a committed attempt, has the pre-exec supervisor
   `crossed` into exec, or has the grant been `revoked` before it could? A
   `crossed` grant is never revocable; a `revoked` grant is never
   crossable.

Both are one-record, one-write CAS transitions. A recoverer that arrives
after a crash reads the record and knows exactly what to do — the state
answers the question, not marker-file presence or wall-clock heuristics.

## Vocabulary

- **Logical attempt** — a single durable intent to run one turn once. The
  `turn_id` identifies it. Derived deterministically from
  `(loop_id, slot_id, iteration)` so a duplicate dispatch of the same slot
  in the same iteration hits `reservation_exists` and adopts the existing
  attempt instead of minting a second one.
  `phase` is deliberately not part of the persisted hash. Within one iteration,
  a driver therefore assigns distinct role slots to distinct worker phases; an
  attempted phase reuse on the same slot fails the immutable-contract adoption
  check instead of minting a second identity. Changing the hash is a separate
  migration, not part of P0C.
- **Physical run** — the concrete process that executed the attempt. Its
  `run_id` is derived deterministically from `turn_id` (`deriveChildIds`),
  so a crashed reserver can be repaired idempotently without minting a
  second run.
- **Launch generation** — one arm/consume/revoke cycle for a committed
  attempt. Identified by `launch.epoch`. Re-arming after revocation
  requires a strictly greater epoch. The **evidence nonce** for the
  current generation is the consumed `launch.token`; workers echo it in
  their LANE-RESULT so the read-strict acceptance path can distinguish
  the current generation from any prior one.
- **Attempt status** (derived, never stored) — the projection of the two
  authoritative axes plus an optional run status:
  `reserved | launching | running | waiting_input | completed | failed |
  cancelled`. See `attemptStatus()` in
  [`src/core/loops/attempt-reservation.ts`](../../src/core/loops/attempt-reservation.ts).

The flat status is a projection only. The authority stores `decision` and
`launch.status` and derives everything else — one source of truth per
field.

## Identity matrix (P0)

The five identities that identify a dispatched Loop turn today, and where
each lives:

| Identity | Assigned by | Persisted where | Rewritable? |
|---|---|---|---|
| `turn_id` (`tat_…`) | Deterministic hash of `(loop_id, slot_id, iteration)` | `TurnReservation.turn_id` | No — write-once |
| `assignment_id` (`asgn_…`) | Derived from `turn_id` via `deriveChildIds` | `TurnReservation.child_ids.assignment_id` + brainclaw assignment record | No — write-once |
| `run_id` (`run_…`) | Derived from `turn_id` via `deriveChildIds` | `TurnReservation.child_ids.run_id` + `agent_run` record | No — write-once |
| `launch.epoch` | Caller of `armLaunch` (0-based; strictly greater than the previous one) | `TurnReservation.launch.epoch` | No — bumps on each new generation |
| `launch.token` (evidence nonce) | `armLaunch` (`crypto.randomUUID()` unless supplied) | `TurnReservation.launch.token` | No — one token per generation |

P0 keeps **one logical attempt = one physical run**. A future multi-run /
takeover model (with more than one run for a given `turn_id`) is
*deferred*; it will introduce a new generation counter, fencing, a
`minimum_reader_version` on records, and an explicitly incompatible
rollback path. Nothing today writes more than one `run_id` for a given
`turn_id`.

## Authoritative fields

Only `AttemptAuthority` writes the following:

- `TurnReservation.decision` — `prepared | committed | aborted`
- `TurnReservation.launch.status` — `armed | crossed | revoked`
- `TurnReservation.launch.epoch` / `.token` / `.lease_deadline`
- `TurnReservation.decided_at` / `.abort_reason` / `.armed_at` /
  `.crossed_at` / `.revoked_at` / `.revoke_reason`
- `TurnReservation.child_ids` — `assignment_id`, `run_id`

Every other field on the reservation is set at `reserve()` time and never
rewritten (`turn_id`, `loop_id`, `slot_id`, `phase`, `iteration`,
`agent`, `agent_id`, `claim_id`, `store_root`, `cwd`, `lease_deadline`,
`completion_mode`, `expected_artifacts`, `target_slot_generation`,
`loop_version_at_reserve`). Callers set them once; the authority never
mutates them.

Downstream artifacts — the assignment record, the agent_run row, the loop
slot's `current_turn_id` pointer — are **projections** of the authority
record. Since P0B (`pln#677`), they are created or validated idempotently
**before** the launch CAS crosses. A crash before crossing leaves the grant
armed and repairable from the same deterministic ids; a crash after crossing
therefore always leaves real Assignment, AgentRun, claim and slot projections
behind. Nothing else in the system may write to the authoritative fields
listed above.

## Surfaces and their roles

Four event surfaces exist. Only one of them is authoritative.

| Surface | Role | Owner | Notes |
|---|---|---|---|
| `TurnReservation` record + launch decision cell | **Authoritative** — atomic CAS of `decision` and `launch.status` | `AttemptAuthority` | Single writer. The decision file (`<turn_id>.launch-<epoch>.decision.json`) is an O_EXCL create; the first writer wins, the loser adopts the incumbent verdict. |
| Loop `LoopEvent` journal (`events/<loop_id>.jsonl`) | **Causal** — what happened inside a loop, in what order | Loop Engine (`bclaw_loop` verbs) | `seq` and `thread.version` advance in lockstep. Consumed for replay and resume. |
| Runtime `RuntimeEvent` stream | **Telemetry** — process-level observability of runs and adapters | Runtime | Not causal for the authority; a supervisor never decides commit/launch by reading it. |
| Legacy `events.jsonl` | **Compatibility-only** — pre-authority audit stream | Legacy readers | Retained for downstream consumers. New logic must not depend on it. Registry projections have moved to journal v2. |

The rule is: whoever asks "may this attempt spawn?" or "what is the
current generation nonce?" reads the reservation record. Every other
stream is for observability, causality, or backward compatibility — never
for authority.

## Functional API

The kind-neutral facade lives in
[`src/core/loops/attempt-authority.ts`](../../src/core/loops/attempt-authority.ts).
It exposes five operations and persists only the existing reservation record:

- `prepareAttempt` — reserve-or-adopt an identical immutable contract, commit
  it, then arm or adopt one launch generation.
- `projectAndCross` — run deterministic projections and cross the launch fence;
  only `{ kind: 'won' }` authorises a spawn.
- `inspectAttempt` — read the reservation plus its derived status and nonce.
- `matchEvidence` — require the full `(turn_id, run_id, nonce)` match.
- `revokeAttempt` / `abortAttempt` — fence an un-crossed generation or abort a
  still-prepared reservation.

[`src/core/loops/turn-execution.ts`](../../src/core/loops/turn-execution.ts)
composes this facade with the common Assignment, AgentRun, claim and slot
projections. [`src/core/loops/kind-policies.ts`](../../src/core/loops/kind-policies.ts)
declares which phases are `worker`, `engine`, or `manual`, their completion mode
and expected artifacts. Each worker phase also declares its earliest safe
finalization path: `report` for read-only results, or `integrate` when the
worktree must be integrated before Assignment/AgentRun settlement and claim
release. These policies do not contain phase graphs, gates or stop conditions:
`DEFAULT_PROTOCOLS` and the Loop Engine remain authoritative for those decisions.

The lower-level primitives remain in `attempt-reservation.ts`:

The public surface is a small set of functions in
`src/core/loops/attempt-reservation.ts`. They are pure with respect to
their inputs plus the reservation file for the given `turn_id`, and every
mutation goes through `withReservationLock` for cross-process exclusion.

**Identity**
- `deriveTurnId(loop_id, slot_id, iteration): string` — mint the
  deterministic turn id.
- `deriveChildIds(turn_id): { assignment_id, run_id }` — derive the two
  child ids the projection needs.

**Reserve / decide**
- `reserve(input): TurnReservation` — write a fresh `prepared`
  reservation. Throws `reservation_exists` if one is already on disk.
- `commitReservation(turn_id): TurnReservation` — CAS
  `prepared → committed`. Idempotent when already `committed`. Throws
  `aborted_not_committable` if aborted.
- `abortReservation(turn_id, reason): TurnReservation` — CAS
  `prepared → aborted`. Idempotent when already `aborted`. Throws
  `committed_not_abortable` if committed.
- `assertDispatchable(turn_id): TurnReservation` — the single dispatch
  choke point. Throws `not_dispatchable` unless the decision is
  `committed`.
- `isDispatchable(turn_id): boolean` — non-throwing variant.

**Launch grant (per generation)**
- `armLaunch(turn_id, { epoch, lease_deadline, token? }): TurnReservation`
  — arm a launch grant on a committed reservation. Refuses re-arm unless
  the prior grant was `revoked` and `epoch` is strictly greater. Refuses
  arm past the dispatch lease. Refuses arm on an unparseable launch
  lease.
- `consumeLaunchGrant(turn_id, token, epoch): ConsumeResult` — CAS
  `armed → crossed`. Returns `{ reservation, wonTransition }`.
  **`wonTransition === true` is the exactly-once spawn authority**; a
  caller with `wonTransition === false` MUST NOT spawn (the grant was
  already crossed by another invocation).
- `consumeLaunchGrantWithProjection(turn_id, token, epoch, project)` —
  dispatch choke point used by the Loop runtime. It holds the reservation
  lock, executes a short synchronous projection callback, rechecks the
  lock fence and lease, then performs the same crossed/revoked CAS. A
  projection error exits before crossing.
- `revokeLaunchGrant(turn_id, epoch, reason): TurnReservation` — CAS
  `armed → revoked`. Refused once crossed.
- `sweepExpiredLaunchGrants(): string[]` — revoke every armed grant
  whose lease has passed. Sole non-GET sweep owner.

**Evidence**
- `currentNonce(reservation): string | undefined` — the evidence nonce
  for the current live generation, or undefined if the generation is
  revoked / never armed.
- `evidenceMatchesAttempt(reservation, { turn_id, run_id, nonce }): boolean`
  — read-strict predicate: evidence is accepted only when
  `turn_id`, `run_id`, AND `nonce` all match the current generation.
  Stale prior-generation evidence and bare assignment-keyed signals
  can never match.

**Lookup / reconciliation**
- `getReservation(turn_id)` / `listReservations({ decision? })`
- `findReservationByRunId(run_id)` — reconciler discriminator for a
  turn-owned run vs a legacy run.
- `findReservationByAssignmentId(assignment_id)` — harvest discriminator
  for a turn-owned LANE-RESULT vs a legacy one. Restricted to
  `decision: 'committed'` so a `prepared`/`aborted` reservation never
  routes a lane.
- `attemptStatus(reservation, run_status?)` — the derived projection.

**Projection helpers (outside the authority record)**

- `ensureAssignmentProjection` and `ensureAgentRunProjection` are
  create-or-validate operations: an identical replay is a no-op; a
  conflicting deterministic id fails closed. P0 forces `attempt_index = 1`.
- `ensureClaimAssignmentBinding` binds an active claim without overwriting
  a live conflicting Assignment. A retained review/fix-cycle claim may move
  only after its previous Assignment is terminal.
- Concurrent slots receive distinct claims because the Claim projection has a
  single `assignment_id` pointer. Each scope identifies both loop and slot;
  protocol-specific prefixes remain a routing convention, not authority.
- `bindTurnProjection` performs the slot write under the loop lock. The same
  `(turn_id, assignment_id, claim_id)` tuple is a no-op and does not append a
  second `turn_assigned` event.

## Ordered dispatch

The authority contract has **one normative dispatch shape**. Every worker phase
of the five LoopKinds can use `prepareTurnExecution`; engine/manual phases are
refused before reservation. Review and multi-agent ideation coordinator
shortcuts call the common path today. Implementation, research and debug expose
the same contract to their loop drivers even where the operator still drives
the phase explicitly rather than through a kind-specific coordinator shortcut:

1. **`deriveTurnId`** — mint the deterministic turn id from
   `(loop_id, slot_id, iteration)`. A concurrent duplicate dispatch of
   the same slot in the same iteration derives the same id and adopts
   the existing reservation.
2. **`reserve`** — persist the `prepared` reservation with a validated
   dispatch lease. Fails closed on an unparseable lease at the boundary.
3. **`commitReservation`** — CAS `prepared → committed`.
4. **`armLaunch`** (or adopt an existing armed grant / re-arm a revoked
   one at a strictly greater epoch) — mint a fresh generation `epoch`
   and evidence nonce `token`.
5. **Durable projections** — inside
   `consumeLaunchGrantWithProjection`, create or validate the deterministic
   Assignment and AgentRun, bind the active claim to the Assignment, and bind
   the loop slot to `(turn_id, assignment_id, claim_id)`. Replays are
   idempotent; divergence fails closed.
6. **Cross the launch grant** — after the callback returns, the helper
   rechecks the reservation-lock fence and lease, then performs the atomic
   `armed → crossed` CAS. Only `wonTransition === true` may spawn; every
   other invocation observing a `crossed` incumbent must refuse to spawn.
7. **Worker execution** — the worker echoes `turn_id`, `run_id`, and
   the launch `token` (evidence nonce) in its LANE-RESULT and any signal
   files.
8. **Harvest / reconcile** — `findReservationByAssignmentId` /
   `findReservationByRunId` map the incoming lane onto its reservation.
   `evidenceMatchesAttempt` gates state mutation on a full triple match
   with the current generation. Typed `artifact_type` evidence is required;
   narrative summaries never become gate-driving artifacts. Read-only phases
   may settle during report harvest, while mutating phases remain claimed until
   `harvest --integrate` has integrated their worktree. Stale evidence is
   withheld from convergence and surfaced through harvest/reconcile diagnostics.
9. **Loop advance / close / reroute** — `revokeLaunchGrant` fences the
   old generation. Any future generation must arm at a strictly higher
   epoch.

The P0A characterization suite preserves the historical failure mode: crossing
before creating those projections could leave an irreversible orphaned grant
after a crash. P0B closes that gap without changing the persisted schema or
wire format. P0 still keeps *one logical attempt = one physical run*; a future
multi-run/takeover model requires explicit generation and compatibility work.

The cross-store lock order is **reservation → entity store → loop**. The
projection callback must stay synchronous and must never enter while already
holding an entity-store or loop lock. This prevents lock inversion while
keeping the launch CAS and all required projections in one recoverable critical
path.

## Recovery

Recovery is decision-driven, not marker-driven. A recoverer or a
supervisor arriving after a crash reads the reservation and acts by
state.

- **No reservation on disk** — nothing to recover. The turn was never
  reserved.
- **`prepared`** — an incomplete reserve. Two safe outcomes: commit the
  reservation and continue, or abort with a reason. Projections are created
  only after commit, inside the pre-crossing callback.
- **`committed`, no launch grant** — a committed attempt that never
  armed. Arm a fresh generation (`epoch = 0`) when policy permits;
  otherwise leave it for the sweep.
- **`committed`, `launch.status = armed`, lease live** — a live generation.
  A replay may idempotently repair any incomplete projections and then compete
  for the same crossing. The lease bounds the wait; when it expires,
  `sweepExpiredLaunchGrants` revokes the grant (`reserved_never_launched`).
- **`committed`, `launch.status = armed`, lease expired** — sweep it.
  The record stays committed (repair-only); it just never spawns for
  this generation. A new generation can be armed with a strictly
  greater epoch.
- **`committed`, `launch.status = crossed`** — the worker launched and all
  P0B projections exist. Treat as `launch_attempted_unknown`: never re-spawn.
  Wait for evidence; if none arrives, that is a bounded blocked outcome, not a
  re-dispatch.
- **`committed`, `launch.status = revoked`** — this generation is dead. A
  `reserved_never_launched` reconciliation retains the active claim while the
  longer dispatch lease remains live and keeps the deterministic run
  non-terminal for a fresh epoch. Once the dispatch lease expires, normal
  cancellation and release apply.
- **`aborted`** — terminal. No further action; the attempt will never
  dispatch. This is what closes the "recoverer aborted, stale reserver
  resumes and commits" split-brain: the CAS on `aborted` is
  irreversible.

The **launch decision cell**
(`<turn_id>.launch-<epoch>.decision.json`) is authoritative for
tie-breaking. It is written by O_EXCL exclusive-create; the first
writer wins. If a winner crashed after the atomic create but before
updating the record projection, `launchGrant()` reconciles the record
from the decision cell on read. There is no TOCTOU: the create — not a
prior check — is the commit.

Evidence acceptance is symmetric: `evidenceMatchesAttempt` reads the
current generation via `currentNonce`; a revoked or absent generation
has no current nonce, so every piece of evidence is rejected. A
completed prior-generation run that resurfaces after a takeover is
therefore inert.

## Invariants (I1–I18)

The authority preserves the following invariants. They are described
here descriptively; the characterization suite locks them empirically.

- **I1 — Write-once identity.** `turn_id`, `child_ids.assignment_id`,
  `child_ids.run_id` are set at `reserve()` and never rewritten. A
  crashed reserve is repaired by re-deriving the same ids from the
  turn id.
- **I2 — Deterministic derivation.** `deriveTurnId(loop_id, slot_id,
  iteration)` and `deriveChildIds(turn_id)` are pure functions of
  their inputs. Repair is idempotent.
- **I3 — Single dispatch choke point.** The Loop runtime reaches spawn only
  through `assertDispatchable` → `armLaunch` →
  `consumeLaunchGrantWithProjection`, and only when that helper returns
  `wonTransition === true`. Nothing else may bypass it.
- **I4 — Commit irreversibility.** `committed` never becomes
  `aborted`. `aborted` never becomes `committed`. The CAS decision is
  the fence.
- **I5 — Only committed spawns.** `assertDispatchable` throws
  `not_dispatchable` for every non-committed decision. Dispatch never
  proceeds on a `prepared` or missing reservation.
- **I6 — Fail-closed on unparseable leases.** `reserve` and
  `armLaunch` reject an unparseable `lease_deadline` at the boundary,
  so no committed reservation can carry a garbage lease that a
  downstream check would silently skip.
- **I7 — One decision per (turn_id, epoch).** The launch decision
  cell is created via O_EXCL. The first writer wins; the loser adopts
  the incumbent verdict. No lock is needed for the decision itself.
- **I8 — Consume XOR revoke.** For a given generation, `crossed` and
  `revoked` are mutually exclusive. A `crossed` grant is never
  revocable; a `revoked` grant is never crossable.
- **I9 — Exactly-once spawn.** Only the consuming invocation with
  `wonTransition === true` may spawn. Every other invocation observing a
  `crossed` incumbent must treat the attempt as `launch_attempted_unknown`
  and refuse to spawn. A crossed P0B turn already has all durable projections.
- **I10 — Fenced writes.** Every authoritative write inside
  `withReservationLock` performs a fence re-read of the lock's `mutation_id`.
  The projection callback runs before the decision-cell CAS, and the fence is
  re-read again after it; a reaped-then-recycled holder cannot cross.
- **I11 — Epoch monotonicity.** Re-arming a launch grant requires
  `input.epoch > prior.epoch`. Old generations can never re-arm.
- **I12 — Distinct token per generation.** `armLaunch` mints a random
  token by default; an explicit token is honored but the caller owns
  per-generation uniqueness. `evidenceMatchesAttempt` depends on
  distinct tokens to reject stale prior-generation evidence.
- **I13 — Read-strict evidence.** Evidence is accepted only when
  `turn_id`, `run_id`, AND the current-generation `nonce` all match.
  Assignment-keyed signals without a nonce match are rejected.
- **I14 — Current nonce is generation-live.** `currentNonce` returns
  a value only when `launch.status` is `armed` or `crossed`. Revoked
  and un-armed generations have no current nonce, so their evidence
  cannot match.
- **I15 — Reservation is the sole authority.** Nothing outside
  `AttemptAuthority` writes `decision`, `launch.status`,
  `launch.token`, `launch.epoch`, `child_ids`. Projections read from
  the reservation, never the reverse. The reservation's `claim_id` is the
  binding authority; caller disagreement fails before projection or crossing.
- **I16 — Recovery is decision-driven.** A recoverer's next action is
  a total function of `(decision, launch.status, launch.lease_deadline,
  now)`. Marker-file presence is never consulted for the decision.
- **I17 — Sweep is bounded.** `sweepExpiredLaunchGrants` revokes only
  `armed` grants past their lease. It never touches `crossed` or
  `revoked`, never mutates the `decision`, and is the sole non-GET
  sweep owner.
- **I18 — Journal separation.** The reservation record is authoritative;
  `LoopEvent` is causal; `RuntimeEvent` is telemetry; `events.jsonl`
  is compatibility-only. No consumer looks past its role. There is no
  fifth journal.

## Related

- Loop Engine — [`loop-engine.md`](./loop-engine.md)
- Loop protocols — [`../loops/`](../loops/)
- Dispatch lifecycle — [`dispatch-lifecycle.md`](./dispatch-lifecycle.md)
- Reference implementation —
  [`src/core/loops/attempt-authority.ts`](../../src/core/loops/attempt-authority.ts),
  [`src/core/loops/turn-execution.ts`](../../src/core/loops/turn-execution.ts),
  [`src/core/loops/kind-policies.ts`](../../src/core/loops/kind-policies.ts),
  [`src/core/loops/attempt-reservation.ts`](../../src/core/loops/attempt-reservation.ts),
  [`src/core/loops/reconcile-turn.ts`](../../src/core/loops/reconcile-turn.ts)
- Characterization tests —
  [`tests/unit/loops-attempt-reservation.test.ts`](../../tests/unit/loops-attempt-reservation.test.ts),
  [`tests/unit/loops-launch-grant.test.ts`](../../tests/unit/loops-launch-grant.test.ts),
  [`tests/unit/loops-conformance-harness.test.ts`](../../tests/unit/loops-conformance-harness.test.ts),
  [`tests/unit/loops-p0b-projections-before-crossing.test.ts`](../../tests/unit/loops-p0b-projections-before-crossing.test.ts),
  [`tests/unit/loops-p0c-conformance.test.ts`](../../tests/unit/loops-p0c-conformance.test.ts)
- pln#676 — this doc's rollout plan
- dec#171 — canonical decision behind the model
