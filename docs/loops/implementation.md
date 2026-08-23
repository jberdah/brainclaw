# Implementation loop

> Loop kind: `implementation`. One of five equal protocols driven by the shared
> [Loop Engine](../concepts/loop-engine.md). Identity, dispatch decisions and
> spawn authority belong to [`AttemptAuthority`](../concepts/attempt-authority.md);
> nothing on this page overrides them.

The `execute` worker returns `artifact_type: "execute_report"`. Because this
phase edits its worktree, report-only harvest does not settle the turn or
release its claim; convergence happens after `harvest --integrate`.

## Purpose

An `implementation` loop drives a bound plan+sequence to a green
verification command. It ADDS to the dispatch pipeline what that pipeline
lacked: a deterministic `command_green` gate, a bounded `execute ↔ verify`
cycle, and per-phase context sculpting. `bind` is an engine-only action: it
validates the plan/sequence link and advances to `execute`. It never launches
a worker. `execute ↔ verify` iterates until the verify command is green or
the cycle cap is hit.

## Default protocol

```
bind → execute ↔ verify → handoff_ready
        └── iterate (≤3) ───┘
```

| Phase | Purpose | Artifact | Context filter |
|---|---|---|---|
| `bind` | Validate the linked plan + sequence; advance to `execute` | link already stored on the loop | `plans`, `decisions`, `constraints`, `project_vision` |
| `execute` | Apply the sequence's steps in the worktree | edits + `execute_report` | `decisions`, `constraints`, `traps`, `runtime_notes` |
| `verify` | Run the declared verify command | `verify_report` | `traps`, `runtime_notes` |
| `handoff_ready` | Produce the handoff for downstream review | `handoff` | `handoffs`, `plans` |

**Iteration.** `execute ↔ verify` cycles up to `max_iterations: 3`.
`exit_when: 'command_green'` exits early on a passing `verify_report` in the
current iteration. `advance_when: 'all'` on each phase means every
participating slot must produce its expected artifact before advance fires.

## Entry points

- **Direct open (typical).**
  `bclaw_loop(intent='open', kind='implementation', slots=[…], linked={plan_ids:[…], sequence_ids:[…]}, allow_orphan=true)`
  followed by `bind`. `allow_orphan=true` acknowledges that the caller will
  drive worker turns.
- **Via bind.** `bclaw_loop(intent='bind', loop_id=…)` validates the linked
  sequence and advances `bind → execute`. Historical launch options
  (`lanes`, `auto_execute`, `model`, `max_assignments`) remain accepted
  during rollout but are ignored; the response carries a migration warning.
- **Explicit worker turn.** In `execute`, trusted
  `bclaw_loop(intent='turn', loop_id=…, slot_id=…, dispatch=true)` is the only
  worker launch path and uses the common AttemptAuthority fence. Independent
  slots may be dispatched concurrently. Without `dispatch=true`, `turn` is
  state-only and never starts a process.

## Advance gates

`verify` carries an `advance_gate`:

```ts
{ kind: 'min_artifacts_by_type', type: 'verify_report', n: 1, scope: 'phase' }
```

Advance cannot leave `verify` without a `verify_report` artifact **this
iteration** — this guards the narrated-verify anti-pattern where a slot
claims it verified without actually running the command. `command_green` in
the iteration engine reads the reports produced against this gate.

## Stop condition

```ts
{ kind: 'any', conditions: [
  { kind: 'artifact_produced', phase: 'handoff_ready', type: 'handoff' },
  { kind: 'max_iterations', n: 3 },
] }
```

- **Handoff produced** → close `completed`. The handoff is the downstream
  consumer's entry point.
- **Cycle cap** → close `blocked`; the last red `verify_report` is
  attached so a human or a `debug` loop can pick up.

## Artifacts

| Type | Phase | Body |
|---|---|---|
| `execute_report` | `execute` | inline text ≤ 4 KB, or ref-based when large |
| `verify_report` | `verify` | inline JSON: `{ command, exit_code, passed, duration_ms?, stdout_tail?, stderr_tail? }` |
| `file_diff` | any phase | ref-based body (`{ref, byte_count, sha256}`) |
| `handoff` | `handoff_ready` | `ref` to a `handoff` primitive |

## Routing

`implementation` is claim-routed: each worker `slot.claim_id` points at the
scope claim created by `turn(dispatch=true)`, and the common driver runs in
the worktree bound to that claim. `bind` creates neither claim nor assignment.
`session_id` is observability-only.
[Attempt authority](../concepts/attempt-authority.md#ordered-dispatch)
mints a deterministic `turn_id` from `(loop_id, slot_id, iteration)` on
every dispatch, so a concurrent re-dispatch hits `reservation_exists` and
adopts the existing attempt. If a reusable slot has already spent that legacy
identity in another worker phase of the same iteration, the common resolver
uses `(loop_id, slot_id, phase, iteration)` for a versioned successor logical
turn. This is a Loop Engine rule shared by every kind, not implementation-loop
special handling.

## Recovery

- **Execute worker crashed mid-iteration.** Launch grant lease expires;
  `sweepExpiredLaunchGrants` revokes it; a re-dispatch arms a new
  generation at a strictly greater epoch. Because `execute_report` and
  `verify_report` are per-iteration, a prior-iteration report never
  satisfies the current iteration's gate.
- **`verify_report` red at cap.** Loop closes `blocked`; the last red
  `verify_report` and the accumulated `execute_report`s stay on the loop
  as evidence.
- **Command-green mid-cycle.** `exit_when: 'command_green'` short-circuits
  the cycle; the driver advances to `handoff_ready` on the next `advance`.
- **Stale worker LANE-RESULT resurfaces after a cycle bump.**
  `evidenceMatchesAttempt` rejects it — the current-generation nonce no
  longer matches the stale token.

## When NOT to use

- **Debugging an already-broken build.** Use [`debug`](./debug.md) — its
  `reproduce` phase gives you a repro artifact the fix rides on, and its
  `command_green` gate is the same shape.
- **Validating a change that already exists.** Use
  [`review`](./review.md).
- **Choosing between architectural options.** Use
  [`ideation`](./ideation.md) — an implementation loop with no plan is
  empty.
- **Open-ended discovery.** Use [`research`](./research.md).

## Reference implementation

| Component | File |
|---|---|
| Default protocol | [`src/core/loops/types.ts`](../../src/core/loops/types.ts) (`DEFAULT_PROTOCOLS.implementation`) |
| Bind action | [`src/core/loops/impl-bind.ts`](../../src/core/loops/impl-bind.ts) (`runImplBind`) |
| Common worker driver | [`src/core/loop-turn-dispatch.ts`](../../src/core/loop-turn-dispatch.ts) (`dispatchLoopTurn`) |
| Iteration FSM (command_green) | [`src/core/loops/iteration-engine.ts`](../../src/core/loops/iteration-engine.ts) |
| Attempt authority | [`src/core/loops/attempt-authority.ts`](../../src/core/loops/attempt-authority.ts) |
| Turn execution policy | [`src/core/loops/kind-policies.ts`](../../src/core/loops/kind-policies.ts), [`src/core/loops/turn-execution.ts`](../../src/core/loops/turn-execution.ts) |
| Result reducer | [`src/core/loops/result-reducers.ts`](../../src/core/loops/result-reducers.ts) |
| Tests | [`tests/unit/loops-impl-bind.test.ts`](../../tests/unit/loops-impl-bind.test.ts), [`tests/unit/loops-impl-protocol.test.ts`](../../tests/unit/loops-impl-protocol.test.ts), [`tests/unit/loops-gate-content-integrity.test.ts`](../../tests/unit/loops-gate-content-integrity.test.ts) |

## Related

- [Loop Engine](../concepts/loop-engine.md)
- [Attempt authority](../concepts/attempt-authority.md)
- [plans-and-claims.md](../concepts/plans-and-claims.md)
- [dispatch-lifecycle.md](../concepts/dispatch-lifecycle.md)
