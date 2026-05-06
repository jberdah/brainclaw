# Ideation_loop

> Status: MVP shipped in **v1.5.0** (pln#492). Reframer phase (v1.1) tracked as pln#493.

The ideation_loop is brainclaw's structured-deliberation primitive. Where
the [review_loop](./loop-engine.md#automation-extending-bclaw_coordinateintentreview)
exists to validate work that already happened, the ideation_loop exists
to **stress-test work before it happens** — proposals get adversarial
pressure from project memory before they crystallise into plans.

A useful mental model: it's the [`review_loop`](./loop-engine.md#default-protocols)'s
inverse. Review takes a finished artifact and asks "is this good?" Ideation
takes a fresh proposal and asks "what does our accumulated experience say
will go wrong with this?"

## Why

In agentic workflows, two failure modes recur:

1. **AI slop.** A proposal that sounds plausible but ignores hard-won
   constraints, contradicts past decisions, or repeats a known trap.
2. **Echo chamber.** A single agent generating *and* evaluating its own
   proposal — useful pressure is structurally absent because no
   adversarial perspective is in scope.

Multi-agent diversity (champion vs critic with different model providers)
fixes #2 but most adopters only have one model on hand. The ideation_loop
sidesteps that by making the **adversarial substrate the project's
memory itself**: traps, feedback memos, runtime notes — accumulated
evidence of "what's gone wrong here before" — get pulled into the
critic's working set automatically. A single agent can produce useful
adversarial pressure if the context filter forces it to confront
adversarial memory rather than positive context.

This was validated empirically before any code was written (see
`feedback_ideation_loop_single_agent_method` in user auto-memory): a
3-round simulated ideation produced 12 substantive critique artifacts
all citing real memory ids, against a single-model setup.

## Phases

The default protocol has four phases:

```
proposal → critique ↔ revision → synthesis
            └─── iterate (≤3) ────┘
```

| Phase | Purpose | What the slot produces |
|---|---|---|
| `proposal` | Seed: the original idea / decision under consideration | A `proposal` artifact (the task text from the caller) |
| `critique` | Adversarial review against project memory | One or more `critique` artifacts citing real memory ids |
| `revision` | Champion's response to the critique batch | A `revision` artifact addressing the points raised |
| `synthesis` | Final plan_draft folding the cycle's outputs | A `plan_draft` artifact with `addresses_critique:[ids]` |

`critique ↔ revision` is the iteration block: the loop loops there,
incrementing `iteration_count`, until exit criteria are met.

## Per-phase context filter

Each phase pulls a **filtered slice** of memory rather than the full
project context. This is what makes single-agent ideation produce real
adversarial pressure.

| Phase | `context_filter` (memory categories visible) | Why |
|---|---|---|
| `proposal` | `decisions`, `constraints`, `plans`, `project_vision` | Positive context — what we want to build, what's already settled |
| `critique` | `traps`, `feedback`, `runtime_notes`, `critique_history` | Adversarial-only — known failure modes, prior critiques |
| `revision` | `*` (everything) | Champion needs full picture to address findings |
| `synthesis` | `*` (everything) | Final plan_draft must reflect all signal |

The closed-enum vocabulary lives in [`LOOP_CONTEXT_CATEGORIES`](../../src/core/loops/types.ts).
The wildcard `*` expands to every user-facing category. Loop-internal
categories (`critique_history` / `revision_history` / `synthesis_artifact`)
refer to artifacts produced earlier in the same loop and are pulled
from the thread directly, not from project memory.

If a phase declares no `context_filter`, the driver falls back to the
wildcard set — same behaviour as a non-ideation loop.

## Iteration block

The `LoopProtocolConfig.iteration` block describes the inner cycle:

```ts
iteration: {
  cycle: ['critique', 'revision'],
  max_iterations: 3,
  exit_when: 'no_new_critique_artifacts',
}
```

- `cycle` lists the phase names that repeat in order.
- `max_iterations` caps the number of rounds. The default is 3 — past
  empirical work (`runtime_note 'ideation_loop_mvp_simulation_transcript'`)
  found 3 rounds is the saturation point at which a memory-driven
  critique stops surfacing new conflicts on a typical proposal.
- `exit_when` chooses the convergence criterion:
  - `'no_new_critique_artifacts'` — a full cycle completes without
    adding any critique-typed artifact. Stable saturation.
  - `'critic_signal'` — the critic produced a `critic_signal` artifact
    declaring the proposal sufficient. Explicit early exit.

The [iteration engine FSM](../../src/core/loops/iteration-engine.ts)
(`decideNextPhase`) returns one of five outcomes at each transition:
linear `advance_to`, intra-cycle `iterate_to`, `exit_cycle` when
`exit_when` fires, `max_iterations` when the cap hits, or throws when
the current phase is the last with no successor.

## Phase-advance gate

The critique phase carries a default `advance_gate`:

```ts
advance_gate: {
  kind: 'min_artifacts_by_type',
  type: 'critique',
  n: 3,
  scope: 'phase',
}
```

The driver refuses to leave critique until at least 3 critique artifacts
have been produced in the current iteration. Below that floor the
adversarial pressure hasn't accumulated enough to make revision useful.

Gate evaluation is **iteration-window-aware**: counts only the artifacts
produced in the current iteration window, so a previous round's
critiques don't satisfy the gate for the new round.

When the gate fails, the driver:
- Emits a `phase_advance_blocked` system event with a structured
  `gate_reason` (e.g. `min_artifacts_by_type unmet: phase-scope count of
  type "critique" = 1 < n=3`).
- Throws an actionable error so the caller knows what's missing.

System events live in the same event journal as `turn_assigned` /
`phase_advanced`; they are NOT first-class artifacts (which would force
every consumer to filter `is_system` before processing content).

## Brief assembly

When a turn fires, the driver assembles a brief for the slot agent via
[`buildIdeationBrief`](../../src/core/loops/brief-assembly.ts). The
brief is the message the slot reads from its inbox.

```
# ideation_loop brief
loop: lop_…
phase: critique
iteration: 0
slot: critic
title: …
goal: …

## proposal
<proposal seed text>

## memory bundle (BM25-ranked, filtered by phase context)
### traps
- [trp_…] <trap text>
### feedback
- [fb_…] <feedback text>
### runtime_notes
…

## prior loop artifacts        ← only when iteration > 0
### critique_history (prior iterations)
- [art_…] (iter 0) <truncated body>

## what to produce
- Phase "critique" expects you to act in role "critic".
- Emit findings as LoopArtifacts via bclaw_loop intent='complete_turn'…
- Cite the memory ids you relied on so the synthesis can audit coverage.
```

The bundle is **size-capped** at 48 000 chars (~12 000 tokens at
~4 chars/token English). The cap is greedy: if the assembled bundle
overflows, the assembler appends a "memory bundle truncated…" tail and
reports `truncated`, `includedItems`, and `droppedItems` to the caller
so a per-slot warning can surface. The cap exists to mitigate
[trp#179](../../src/core/loops/brief-assembly.ts) — when memory
bundles get too large, agents fall back to CLI tools instead of
honouring MCP semantics.

Memory categories are fetched via an injectable `BriefMemoryProvider`.
The production implementation (in [`src/commands/mcp.ts`](../../src/commands/mcp.ts)
under the `intent='ideate'` handler) maps categories onto
[`src/core/search.ts`](../../src/core/search.ts) sections and uses
its BM25 ranking with the proposal text as the query. Top-K defaults
to 8 per category. Categories without a search-section mapping
(`runtime_notes`, `feedback`, `project_vision` in v1) silently return
empty — they will plug in when the corresponding stores get a search
index.

## Driver: `bclaw_coordinate(intent='ideate')`

The driver entry point is the existing coordinate facade with a new
intent. It opens an ideation_loop, registers slots, stores the task
as the proposal seed, and (in multi-agent mode) advances to critique
and dispatches the first turn.

### Single-agent mode (default)

```
bclaw_coordinate(intent='ideate', task='Should we extract the dispatcher into a separate package?')
```

- Opens a loop with one `champion` slot = caller.
- Stores `task` as a `proposal` artifact (sliced to fit the 4 KB
  artifact body cap).
- Stops at the proposal phase. The champion drives the loop manually
  via `bclaw_loop(intent='turn'|'advance')`.
- Returns `{loop_id, proposal_artifact_id, mode: 'single_agent',
  dispatched_critics: 0, current_phase: 'proposal'}`.
- Surfaces a single-agent warning so the caller knows dispatch is
  manual.

This is the right mode when you want the loop's structure (memory
filter, gate, iteration accounting) but want to drive each turn
yourself — useful for one-shot consultations or when you don't have
a separate critic agent on hand.

### Multi-agent mode

```
bclaw_coordinate(intent='ideate',
                 task='Should we adopt approach A or approach B?',
                 targetAgents=['codex'])
```

- Opens a loop with `champion` slot (caller) + one `critic` slot per
  target agent.
- Stores `task` as a `proposal` artifact.
- Advances proposal → critique.
- For each critic slot: assembles the brief via `buildIdeationBrief`
  honouring the critique phase's context_filter, calls
  `bclaw_loop(intent='turn')` to flip the slot to `assigned`, and
  queues a coordinate message with the brief as body and
  `{intent: 'ideate', loop_id, slot_id, phase, iteration,
  proposal_artifact_id}` payload.
- Returns `{loop_id, …, mode: 'multi_agent',
  dispatched_critics: N, current_phase: 'critique'}`.

When the critique phase brief is truncated for any slot, a per-slot
warning surfaces. When dispatch fails (e.g. an agent is unknown), the
overall response degrades to `partial` and the loop stays at the
proposal phase — callers can retry manually.

### Custom stop_condition

You can override the default `artifact_produced { phase: synthesis,
type: plan_draft }` stop_condition with anything from the
[`StopCondition`](../../src/core/loops/types.ts) vocabulary:

```ts
bclaw_loop(intent='open', kind='ideation', stop_condition: {
  kind: 'min_artifacts_by_type',
  type: 'critique',
  n: 5,
  scope: 'loop',     // counts across phases / iterations
})
```

This stops the loop after 5 critique artifacts have accumulated
loop-wide, regardless of phase or iteration. Useful for "harvest as
many criticisms as possible, then stop" patterns.

## Synthesis schema

The synthesis phase's `plan_draft` artifact MUST carry an
`addresses_critique: string[]` field listing the critique artifact ids
it folded in (or explicitly waived). Field-presence is enforced at
the zod level on `LoopArtifactSchema`. v1 enforces the field; v1.1
will add semantic validation (each id maps to a real critique
artifact). This makes synthesis auditable: a reviewer can check
which critiques were honoured vs ignored.

## When NOT to use

- **Quick clarifications.** A 2-turn back-and-forth in a normal
  message thread is cheaper than spinning up a loop.
- **Operationally urgent decisions.** The iteration block adds
  latency. For "the build is broken, what's the fix?" the right tool
  is `bclaw_coordinate(intent='consult')`.
- **Architectural debates with no project memory.** If you've never
  recorded any traps / feedback / runtime_notes for this domain, the
  critic will fetch nothing and the brief will be a no-op. Seed the
  memory first, or use a literal multi-agent loop where the critic
  brings its own perspective.

## Future direction

- **Reframer phase** ([pln#493](https://github.com/jberdah/brainclaw/blob/master/.brainclaw/coordination/plans/pln_36c9a4d1.json)).
  A fresh-eyes phase between iteration exit and synthesis. Sees only
  `project_vision`, `constraints`, and the synthesis_artifact — no
  critique/revision history. Surfaces simplifications, alternative
  framings, and "wrong question" findings that memory-driven critique
  is structurally unable to produce. Validated empirically; ships on
  its own cadence after MVP usage telemetry.
- **Profile-based slot diversity.** Champion / simplifier / pessimist
  as separate slot types with their own context filters. Deferred
  until the single-slot model is validated in production.
- **Cross-loop memory.** Promoting validated plan_drafts back into
  the project memory store with provenance. Today the synthesis
  artifact lives only in the loop event journal.

## Reference implementation

| Component | File |
|---|---|
| Schema (categories, iteration, gate, system events) | [`src/core/loops/types.ts`](../../src/core/loops/types.ts) |
| FSM (decideNextPhase, exit predicates) | [`src/core/loops/iteration-engine.ts`](../../src/core/loops/iteration-engine.ts) |
| Gate evaluator (`evaluatePhaseAdvanceGate`) | [`src/core/loops/verbs.ts`](../../src/core/loops/verbs.ts) |
| Brief assembler (`buildIdeationBrief`) | [`src/core/loops/brief-assembly.ts`](../../src/core/loops/brief-assembly.ts) |
| Driver (`bclaw_coordinate intent='ideate'`) | [`src/commands/mcp.ts`](../../src/commands/mcp.ts) (search `req.intent === 'ideate'`) |
| Tests (schema, FSM, assembler, dispatch, e2e) | [`tests/unit/loops-types.test.ts`](../../tests/unit/loops-types.test.ts), [`loops-iteration-engine.test.ts`](../../tests/unit/loops-iteration-engine.test.ts), [`loops-phase-advance-gate.test.ts`](../../tests/unit/loops-phase-advance-gate.test.ts), [`loops-advance-iteration.test.ts`](../../tests/unit/loops-advance-iteration.test.ts), [`loops-brief-assembly.test.ts`](../../tests/unit/loops-brief-assembly.test.ts), [`bclaw-coordinate.test.ts`](../../tests/unit/bclaw-coordinate.test.ts), [`ideation-loop-e2e.test.ts`](../../tests/unit/ideation-loop-e2e.test.ts) |
