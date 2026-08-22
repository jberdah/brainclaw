# Research loop

> Loop kind: `research`. One of five equal protocols driven by the shared
> [Loop Engine](../concepts/loop-engine.md). Identity, dispatch decisions and
> spawn authority belong to [`AttemptAuthority`](../concepts/attempt-authority.md);
> nothing on this page overrides them.

## Purpose

A `research` loop converges an open-ended question into a synthesised
answer. It runs findings-then-synthesis rounds until the synthesiser
declares the question sufficiently answered. Unlike
[`implementation`](./implementation.md) or [`debug`](./debug.md), `research`
has no "green command" — the exit is an explicit sufficiency signal from
the synthesiser, and there is no `blocked` outcome: every research loop
lands in `conclude`.

## Default protocol

```
investigate ↔ synthesize → conclude
     └── iterate (≤3) ──┘
```

| Phase | Purpose | Artifact | Context filter |
|---|---|---|---|
| `investigate` | Gather findings against the question | `finding` (repeatable) | `plans`, `decisions`, `constraints`, `project_vision`, `candidates`, `runtime_notes`, `traps` |
| `synthesize` | Fold findings; assess sufficiency | `synthesis`, optional `critic_signal` | `*` |
| `conclude` | Publish the final synthesis | `synthesis` | `*` |

**Iteration.** `investigate ↔ synthesize` cycles up to
`max_iterations: 3`. `exit_when: 'critic_signal'` — the synthesiser opts an
explicit early exit by emitting a `critic_signal` artifact when it judges
the question answered. Explicit sufficiency beats saturation-by-absence for
open-ended research.

## Entry points

- **Direct open.**
  `bclaw_loop(intent='open', kind='research', title=…, goal=…, allow_orphan=true)`
  followed by manual `turn`/`advance`. There is no coordinator shortcut for
  `research` today; the caller drives each round.
- **Custom stop_condition** — override the default artifact-produced stop
  with any [`StopCondition`](../../src/core/loops/types.ts) — e.g.
  `min_artifacts_by_type { type: 'finding', n: 5, scope: 'loop' }` for a
  "harvest at least five findings" pattern.

## Advance gates

`investigate` carries an `advance_gate`:

```ts
{ kind: 'min_artifacts_by_type', type: 'finding', n: 1, scope: 'phase' }
```

Advance cannot leave `investigate` without at least one `finding` produced
in the current iteration window. This prevents synthesising an empty round.

## Stop condition

```ts
{ kind: 'artifact_produced', phase: 'conclude', type: 'synthesis' }
```

The loop closes `completed` on the first `synthesis` artifact in `conclude`.
There is **no `max_iterations` in the stop condition** — research always
lands in `conclude` and produces a synthesis, even if the cycle cap was
reached earlier (the driver advances anyway).

## Artifacts

| Type | Phase | Body |
|---|---|---|
| `finding` | `investigate` | inline ≤ 4 KB; cites the source memory / files used |
| `synthesis` | `synthesize` / `conclude` | inline ≤ 4 KB, or ref-based when large |
| `critic_signal` | `synthesize` | inline signal that the question is answered |

Findings should cite the memory ids or file paths they draw from so the
final synthesis is auditable.

## Routing

`research` routes turns by `slot_id`; the caller assigns investigator and
synthesiser slots when opening the loop. Multiple investigator slots may
run in parallel per iteration when `advance_when: 'any'` is set on the
phase — otherwise the default `all` requires every investigator to turn
in before synthesise fires.

## Recovery

- **Investigator worker crashed mid-turn.** Launch grant lease expires;
  `sweepExpiredLaunchGrants` revokes it; a re-dispatch arms a new
  generation. Prior-iteration findings never satisfy the current
  iteration's gate.
- **Synthesiser did not emit `critic_signal` by cap.** The cycle exits on
  `max_iterations_reached` (system event) and the driver advances to
  `conclude`; the last `synthesis` becomes the concluding artifact.
- **`finding` gate blocked with zero findings.** The
  `phase_advance_blocked` system event records the structured reason.
  Add a finding, or open a new loop with the gate overridden.
- **Stale prior-generation LANE-RESULT.** Rejected by
  [`evidenceMatchesAttempt`](../concepts/attempt-authority.md#functional-api).

## When NOT to use

- **The question already has a candidate answer to validate.** Use
  [`review`](./review.md).
- **The question is "how do we build X?" with an architectural choice
  hidden inside.** Use [`ideation`](./ideation.md) — memory-driven
  critique surfaces conflicts that generic research does not.
- **The question is "why is the build broken?"** Use
  [`debug`](./debug.md) — its `reproduce` phase is exactly the
  find-the-cause pattern.
- **Executing an already-planned change.** Use
  [`implementation`](./implementation.md).

## Reference implementation

| Component | File |
|---|---|
| Default protocol | [`src/core/loops/types.ts`](../../src/core/loops/types.ts) (`DEFAULT_PROTOCOLS.research`) |
| Iteration FSM (`critic_signal`) | [`src/core/loops/iteration-engine.ts`](../../src/core/loops/iteration-engine.ts) |
| Gate evaluator | [`src/core/loops/verbs.ts`](../../src/core/loops/verbs.ts) (`evaluatePhaseAdvanceGate`) |
| Tests | [`tests/unit/loops-iteration-engine.test.ts`](../../tests/unit/loops-iteration-engine.test.ts), [`tests/unit/loops-phase-advance-gate.test.ts`](../../tests/unit/loops-phase-advance-gate.test.ts) |

## Related

- [Loop Engine](../concepts/loop-engine.md)
- [Attempt authority](../concepts/attempt-authority.md)
