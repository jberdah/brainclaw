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
record. They are written after the atomic CAS wins; a crash between the
CAS and the projection is repaired by re-deriving from the reservation
record. Nothing else in the system may write to the authoritative fields
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

## Ordered dispatch

The engine has **one shape** — deterministic id → reserve → commit → arm →
consume → spawn on `wonTransition === true` → harvest → advance/close. The
open question at P0 is *where the assignment / agent_run / slot-binding
projections land inside that chain*. Both the current and the target order
are described here so future changes can be sequenced against a shared
vocabulary.

### Current wired order

The path in
[`src/core/review-loop-turn-dispatch.ts`](../../src/core/review-loop-turn-dispatch.ts)
that ships today:

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
5. **`consumeLaunchGrant`** — the atomic fence immediately before the
   spawn. Only `wonTransition === true` may proceed; every other
   invocation observing a `crossed` incumbent must treat the attempt as
   `launch_attempted_unknown` and refuse to spawn.
6. **Assignment / agent_run / slot binding projections** — on
   `wonTransition === true` only, create the assignment record, create
   the agent_run record, and call `turn()` to bind the slot. All
   idempotent — driven off deterministic child ids.
7. **Worker execution** — the worker echoes `turn_id`, `run_id`, and
   the launch `token` (evidence nonce) in its LANE-RESULT and any signal
   files.
8. **Harvest / reconcile** — `findReservationByAssignmentId` /
   `findReservationByRunId` map the incoming lane onto its reservation.
   `evidenceMatchesAttempt` gates state mutation on a full triple match
   with the current generation. Stale evidence is rejected silently.
9. **Loop advance / close / reroute** — `revokeLaunchGrant` fences the
   old generation. Any future generation must arm at a strictly higher
   epoch.

The crash gap this leaves open: if the process dies **after**
`consumeLaunchGrant` returns `wonTransition = true` but **before** the
assignment/agent_run/turn projections are persisted, the grant is already
`crossed` (irreversible), so a recoverer cannot revoke and re-arm — and yet
no assignment/run exists for the LANE-RESULT to match against. The
symptoms surface as an orphaned crossed grant + a `launch_attempted_unknown`
attempt.

### Target order (dec#171)

The correctif called out in `dec#171` and staged by `pln#676` moves the
projections **before** the consume:

1. `deriveTurnId`
2. `reserve`
3. `commitReservation`
4. `armLaunch`
5. **Assignment / agent_run / slot binding projections** *(moved earlier)*
   — persist the deterministic assignment and run rows and bind the slot
   idempotently, before the fence.
6. `consumeLaunchGrant` — only `wonTransition === true` authorises spawn.
   Because the projections already exist, a post-consume crash leaves a
   crossed grant paired with a real assignment/run, so harvest and the
   read-strict evidence path have something to match against.
7. Worker execution
8. Harvest / reconcile
9. Loop advance / close / reroute

The target order does not change any wire format, API, or invariant on
this page; it moves an idempotent write earlier in the chain to close the
crash gap. P0 keeps *one logical attempt = one physical run*; the future
multi-run/takeover model is deferred and will land with an explicitly
incompatible generation counter, fencing, and `minimum_reader_version`.

## Recovery

Recovery is decision-driven, not marker-driven. A recoverer or a
supervisor arriving after a crash reads the reservation and acts by
state.

- **No reservation on disk** — nothing to recover. The turn was never
  reserved.
- **`prepared`** — an incomplete reserve. Two safe outcomes: repair
  forward by completing the projections then committing, or abort with
  a reason. Both are one CAS on the record.
- **`committed`, no launch grant** — a committed attempt that never
  armed. Arm a fresh generation (`epoch = 0`) when policy permits;
  otherwise leave it for the sweep.
- **`committed`, `launch.status = armed`, lease live** — a live
  generation. Either the supervisor is still running (leave alone) or
  it crashed. The lease bounds the wait; when it expires,
  `sweepExpiredLaunchGrants` revokes the grant
  (`reserved_never_launched`).
- **`committed`, `launch.status = armed`, lease expired** — sweep it.
  The record stays committed (repair-only); it just never spawns for
  this generation. A new generation can be armed with a strictly
  greater epoch.
- **`committed`, `launch.status = crossed`** — the worker launched.
  Treat as `launch_attempted_unknown`: never re-spawn. Wait for
  evidence; if none arrives, that is a bounded blocked outcome, not a
  re-dispatch.
- **`committed`, `launch.status = revoked`** — this generation is
  dead. A new generation may arm at a strictly greater epoch.
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
- **I3 — Single dispatch choke point.** The only path to spawn is
  `assertDispatchable` → `armLaunch` → `consumeLaunchGrant` with
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
- **I9 — Exactly-once spawn.** Only the `consumeLaunchGrant` invocation
  with `wonTransition === true` may spawn. Every other invocation
  observing a `crossed` incumbent must treat the attempt as
  `launch_attempted_unknown` and refuse to spawn.
- **I10 — Fenced writes.** Every durable write inside
  `withReservationLock` performs a fence re-read of the lock's
  `mutation_id`. A reaped-then-recycled holder aborts cleanly without
  writing.
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
  the reservation, never the reverse.
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
  [`src/core/loops/attempt-reservation.ts`](../../src/core/loops/attempt-reservation.ts),
  [`src/core/loops/reconcile-turn.ts`](../../src/core/loops/reconcile-turn.ts)
- Characterization tests —
  [`tests/unit/loops-attempt-reservation.test.ts`](../../tests/unit/loops-attempt-reservation.test.ts),
  [`tests/unit/loops-launch-grant.test.ts`](../../tests/unit/loops-launch-grant.test.ts),
  [`tests/unit/loops-conformance-harness.test.ts`](../../tests/unit/loops-conformance-harness.test.ts)
- pln#676 — this doc's rollout plan
- dec#171 — canonical decision behind the model
