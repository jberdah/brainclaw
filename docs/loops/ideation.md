# Ideation loop

> Loop kind: `ideation`. One of five equal protocols driven by the shared
> [Loop Engine](../concepts/loop-engine.md). Identity, dispatch decisions and
> spawn authority belong to [`AttemptAuthority`](../concepts/attempt-authority.md);
> nothing on this page overrides them.

The automated critic returns `artifact_type: "critique"` with a non-empty
`body`. A narrative `summary` alone never creates a critique or opens the gate.

## Purpose

An `ideation` loop stress-tests a proposal **before** it crystallises into a
plan. Where [`review`](./review.md) validates a finished artifact and asks
"is this good?", `ideation` takes a fresh proposal and asks "what does our
accumulated project experience say will go wrong with this?"

The adversarial substrate is the project's own memory — traps, feedback
memos, runtime notes. Even a single-agent run produces useful pressure
because the phase context filter forces the critic to confront adversarial
memory rather than the positive context that seeded the proposal. See
[ideation-loop.md](../concepts/ideation-loop.md) for the full RFC-level
design; this page is the operator-facing summary.

## Default protocol

```
proposal → critique ↔ revision → synthesis
            └─── iterate (≤3) ────┘
```

| Phase | Purpose | Artifact | Context filter |
|---|---|---|---|
| `proposal` | Seed: the original idea | `proposal` (text ≤ 4 KB) | `decisions`, `constraints`, `plans`, `project_vision` |
| `critique` | Adversarial review against project memory | `critique` (repeatable) | `traps`, `feedback`, `runtime_notes`, `critique_history` |
| `revision` | Champion responds to the critique batch | `revision` | `*` |
| `synthesis` | Fold the cycle's outputs into a plan draft | `plan_draft` | `*` |

**Iteration.** `critique ↔ revision` iterates up to
`max_iterations: 3`; `exit_when: 'no_new_critique_artifacts'` stops the cycle
when a full round adds no new critique. `critic_signal` is available for
explicit early exit.

## Entry points

- **Coordinator shortcut (recommended).**
  `bclaw_coordinate(intent='ideate', task=…, [targetAgents=[…]])` opens the
  loop with a `champion` slot (caller) and one `critic` slot per target
  agent, stores `task` as the `proposal` artifact, advances to `critique`
  in multi-agent mode, and dispatches the first critic with a brief
  assembled by [`buildIdeationBrief`](../../src/core/loops/brief-assembly.ts).
- **Single-agent mode** — omit `targetAgents`. The champion drives each
  turn manually via `bclaw_loop(intent='turn'|'advance')`. Useful when you
  want the loop's structure (memory filter, gate, iteration accounting)
  but not multi-slot orchestration.
- **Direct open.** `bclaw_loop(intent='open', kind='ideation', allow_orphan=true)`.

## Advance gates

The `critique` phase carries a default `advance_gate`:

```ts
{ kind: 'min_artifacts_by_type', type: 'critique', n: 3, scope: 'phase' }
```

Advance to `revision` is refused until at least 3 `critique` artifacts have
been produced **in the current iteration window**. A previous round's
critiques do not satisfy the gate for a new round. On gate failure, the
driver emits a `phase_advance_blocked` system event with a structured
`gate_reason` and throws an actionable error.

## Stop condition

```ts
{ kind: 'artifact_produced', phase: 'synthesis', type: 'plan_draft' }
```

The loop closes `completed` on the first `plan_draft` artifact in
`synthesis`. Override via
`bclaw_loop(intent='open', stop_condition: …)` — e.g. a
`min_artifacts_by_type { type: 'critique', n: 5, scope: 'loop' }` stops after
five critiques have accumulated loop-wide.

## Artifacts

| Type | Phase | Body |
|---|---|---|
| `proposal` | `proposal` | inline text ≤ 4 KB |
| `critique` | `critique` | inline ≤ 4 KB; must cite memory ids used |
| `revision` | `revision` | inline ≤ 4 KB |
| `plan_draft` | `synthesis` | inline ≤ 4 KB; MUST carry `addresses_critique: [artifact_id, …]` |
| `critic_signal` | `critique` | inline ≤ 4 KB; opts an explicit early cycle exit |

`plan_draft` field-presence is enforced at the zod level on
`LoopArtifactSchema` — a synthesis that omits `addresses_critique` is
rejected at write time.

## Brief assembly

Each critic turn ships a size-capped brief (48 KB) with a BM25-ranked
memory bundle scoped to the phase's `context_filter`. When the bundle
overflows, the assembler appends a truncation tail and surfaces `truncated`,
`includedItems`, and `droppedItems` per-slot. This mitigates
[trp#179](../../src/core/loops/brief-assembly.ts) — oversized bundles push
agents onto CLI tools instead of MCP semantics.

## Routing

`ideation` routes turns by `slot_id`; the coordinator shortcut queues a
message per critic with the brief as body and
`{intent: 'ideate', loop_id, slot_id, phase, iteration, proposal_artifact_id}`
as payload. Dispatch failures per slot surface as `partial`; the loop stays
at the proposal phase and callers can retry manually.

## Recovery

- **Critic worker crashed mid-turn.** Launch grant lease expires;
  `sweepExpiredLaunchGrants` revokes it; the coordinator can re-dispatch
  with a fresh generation.
- **Gate blocked at critique.** The `phase_advance_blocked` system event
  records the structured reason. Champion adds more `critique` artifacts,
  or overrides the gate on `open` for a permissive one-shot run.
- **Cycle cap hit without saturation.** `iteration-engine` emits
  `max_iterations_reached`; the driver moves to `synthesis` regardless.
- **Synthesis missing `addresses_critique`.** Rejected at
  `complete_turn` — the champion re-emits with the ids populated.

## When NOT to use

- **Quick clarification.** A 2-turn message thread is cheaper.
- **Operationally urgent decisions.** The iteration block adds latency —
  use `bclaw_coordinate(intent='consult')` for "the build is broken".
- **A domain with no accumulated project memory.** The critic will fetch
  nothing and the brief will be a no-op; seed memory first, or run a
  literal multi-agent loop where the critic brings its own perspective.
- **Validating a change that already exists.** Use
  [`review`](./review.md).

## Reference implementation

| Component | File |
|---|---|
| Default protocol | [`src/core/loops/types.ts`](../../src/core/loops/types.ts) (`DEFAULT_PROTOCOLS.ideation`) |
| Iteration FSM | [`src/core/loops/iteration-engine.ts`](../../src/core/loops/iteration-engine.ts) |
| Gate evaluator | [`src/core/loops/verbs.ts`](../../src/core/loops/verbs.ts) (`evaluatePhaseAdvanceGate`) |
| Brief assembler | [`src/core/loops/brief-assembly.ts`](../../src/core/loops/brief-assembly.ts) |
| Driver | [`src/commands/mcp-write-coordination.ts`](../../src/commands/mcp-write-coordination.ts) (`req.intent === 'ideate'`) |
| Attempt + execution policy | [`src/core/loops/attempt-authority.ts`](../../src/core/loops/attempt-authority.ts), [`src/core/loops/kind-policies.ts`](../../src/core/loops/kind-policies.ts) |
| Result reducer | [`src/core/loops/result-reducers.ts`](../../src/core/loops/result-reducers.ts) |
| Tests | [`tests/unit/loops-iteration-engine.test.ts`](../../tests/unit/loops-iteration-engine.test.ts), [`tests/unit/loops-phase-advance-gate.test.ts`](../../tests/unit/loops-phase-advance-gate.test.ts), [`tests/unit/loops-brief-assembly.test.ts`](../../tests/unit/loops-brief-assembly.test.ts), [`tests/unit/ideation-loop-e2e.test.ts`](../../tests/unit/ideation-loop-e2e.test.ts) |

## Related

- [Loop Engine](../concepts/loop-engine.md)
- [Attempt authority](../concepts/attempt-authority.md)
- [ideation-loop.md](../concepts/ideation-loop.md) — full RFC
