# Debug loop

> Loop kind: `debug`. One of five equal protocols driven by the shared
> [Loop Engine](../concepts/loop-engine.md). Identity, dispatch decisions and
> spawn authority belong to [`AttemptAuthority`](../concepts/attempt-authority.md);
> nothing on this page overrides them.

Worker results use `repro`, `hypothesis`, `isolation_report`, and
`verify_report` respectively. The mutating `fix` phase remains claimed until
`harvest --integrate`; the earlier read-only phases may converge on report.

## Purpose

A `debug` loop drives a broken system back to green. The invariant it
enforces: "bug fixed" ⟺ "the reproducing command is now green" ⟺ "a passing
`verify_report`". It mirrors [`implementation`](./implementation.md)'s
`execute ↔ verify` pattern but starts one step earlier: `reproduce` must
land a concrete repro before hypothesise-isolate-fix begins.

## Default protocol

```
reproduce → hypothesize ↔ isolate ↔ fix → handoff
              └────── iterate (≤3) ─────┘
```

| Phase | Purpose | Artifact | Context filter |
|---|---|---|---|
| `reproduce` | Land a reliable repro of the bug | `repro` | `traps`, `runtime_notes`, `handoffs`, `plans` |
| `hypothesize` | Propose a cause | `hypothesis` | `decisions`, `constraints`, `traps`, `runtime_notes` |
| `isolate` | Narrow to a single change | `isolation_report` | `decisions`, `constraints`, `traps`, `runtime_notes` |
| `fix` | Apply the fix; re-run the repro | edits + `verify_report` | `traps`, `runtime_notes`, `constraints` |
| `handoff` | Ship the diff to review | `handoff` | `handoffs`, `plans` |

**Iteration.** `hypothesize ↔ isolate ↔ fix` cycles up to
`max_iterations: 3`. `exit_when: 'command_green'` — the same predicate
`implementation` uses — exits early on a passing `verify_report` in the
current iteration. `advance_when: 'all'` is the default.

## Entry points

- **Direct open (typical).**
  `bclaw_loop(intent='open', kind='debug', linked={handoff_ids:[…]}, allow_orphan=true)`
  followed by a `turn` for the `reproduce` phase. There is no coordinator
  shortcut for `debug` today. Plain `turn` is state-only; trusted
  `turn(dispatch=true)` launches a worker phase through the common
  AttemptAuthority path.
- **Referred from `implementation`.** An `implementation` loop that
  closes `blocked` at the cycle cap with a red `verify_report` is a
  natural feeder — open a `debug` loop that links the red report as its
  seed `repro` artifact.

## Advance gates

Two phases carry gates:

**`reproduce`** — cannot start hypothesising without a concrete repro:

```ts
{ kind: 'artifact_produced', phase: 'reproduce', type: 'repro' }
```

**`fix`** — cannot leave `fix` without a `verify_report` this iteration
(same shape as `implementation`'s verify gate):

```ts
{ kind: 'min_artifacts_by_type', type: 'verify_report', n: 1, scope: 'phase' }
```

## Stop condition

```ts
{ kind: 'any', conditions: [
  { kind: 'artifact_produced', phase: 'handoff', type: 'handoff' },
  { kind: 'max_iterations', n: 3 },
] }
```

- **Handoff produced** → close `completed`. The handoff carries the diff
  for a downstream `review` loop.
- **Cycle cap** → close `blocked`; the last red `verify_report` stays on
  the loop as evidence. A human picks up.

## Artifacts

| Type | Phase | Body |
|---|---|---|
| `repro` | `reproduce` | inline ≤ 4 KB: the command / test / URL that fails, and the exit signature |
| `hypothesis` | `hypothesize` | inline ≤ 4 KB |
| `isolation_report` | `isolate` | inline ≤ 4 KB |
| `verify_report` | `fix` | inline JSON: `{ command, exit_code, passed, duration_ms?, stdout_tail?, stderr_tail? }` |
| `file_diff` | any phase | ref-based body (`{ref, byte_count, sha256}`) |
| `handoff` | `handoff` | `ref` to a `handoff` primitive |

## Routing

`debug` is claim-routed: `slot.claim_id` points at the scope claim the
fixer slot holds. The scope of the claim should cover the code under
investigation so the isolation and fix turns can edit freely.
`session_id` is observability-only.

## Recovery

- **Fixer worker crashed mid-cycle.** Launch grant lease expires;
  `sweepExpiredLaunchGrants` revokes it; re-dispatch arms a new
  generation at a strictly greater epoch. A prior-iteration
  `verify_report` cannot satisfy the current iteration's gate.
- **Command-green mid-cycle.** `exit_when: 'command_green'`
  short-circuits the cycle; the driver advances to `handoff` on the next
  `advance`.
- **Reproduce blocked.** The `phase_advance_blocked` system event records
  the missing `repro`. Add a repro artifact, or narrow the loop scope.
- **Red `verify_report` at cap.** Loop closes `blocked`; the accumulated
  hypotheses, isolation reports, and red verify reports stay on the loop
  so the next human or agent has the trail.

## When NOT to use

- **Building something new that doesn't reproduce anything.** Use
  [`implementation`](./implementation.md).
- **Investigating an open-ended "why?" with no failing command.** Use
  [`research`](./research.md).
- **Choosing between two architectural fixes.** Use
  [`ideation`](./ideation.md) to pressure the choice against project
  memory first.
- **Validating a landed fix.** Use [`review`](./review.md); the
  `handoff` a debug loop emits is exactly what a review loop consumes.

## Reference implementation

| Component | File |
|---|---|
| Default protocol | [`src/core/loops/types.ts`](../../src/core/loops/types.ts) (`DEFAULT_PROTOCOLS.debug`) |
| Iteration FSM (`command_green`) | [`src/core/loops/iteration-engine.ts`](../../src/core/loops/iteration-engine.ts) |
| Gate evaluator | [`src/core/loops/verbs.ts`](../../src/core/loops/verbs.ts) (`evaluatePhaseAdvanceGate`) |
| Attempt + execution policy | [`src/core/loops/attempt-authority.ts`](../../src/core/loops/attempt-authority.ts), [`src/core/loops/kind-policies.ts`](../../src/core/loops/kind-policies.ts) |
| Result reducer | [`src/core/loops/result-reducers.ts`](../../src/core/loops/result-reducers.ts) |
| Tests | [`tests/unit/loops-iteration-engine.test.ts`](../../tests/unit/loops-iteration-engine.test.ts), [`tests/unit/loops-phase-advance-gate.test.ts`](../../tests/unit/loops-phase-advance-gate.test.ts), [`tests/unit/loops-impl-protocol.test.ts`](../../tests/unit/loops-impl-protocol.test.ts) |

## Related

- [Loop Engine](../concepts/loop-engine.md)
- [Attempt authority](../concepts/attempt-authority.md)
- [dispatch-lifecycle.md](../concepts/dispatch-lifecycle.md)
