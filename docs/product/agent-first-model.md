# Agent-first product model

Captured from a strategic session on 2026-04-18. This document frames
brainclaw's user model, the resulting two-layer product architecture,
and the loop-protocols roadmap implied by both. It supersedes the
implicit framing in the current audience playbooks (`docs/playbooks/*`)
and should be read before recommending new features.

## 1. Who is the user?

The playbooks describe personae as humans ("Non-Tech Creator", "Solo
Developer", "CI/CD Operator"). That framing is misleading. brainclaw is
built for LLM agents to consume — humans rarely type brainclaw CLI
commands. The lines blur because:

- The **user** of brainclaw is the agent. It calls MCP tools, consumes
  the context format, writes memory, participates in loops.
- The **adopter** of brainclaw is the human. The human installs it,
  chooses which agents to deploy, reviews outputs, and — at enterprise
  scale — must be able to audit what the agents did.

These are different people with different requirements. Mixing them
biases priorities toward "visible to the human" features (dashboards,
CLI UX, Slack webhooks) at the expense of "invisible but load-bearing
for the agent" features (context compounding, memory staleness,
cross-agent coordination).

## 2. Two-layer product architecture

brainclaw is really two products sharing a data substrate:

### The engine — agent-facing

- **Role.** Where the agent does work. Every feature here is designed
  to make the agent measurably more effective, which manifests
  externally as fewer re-prompts, better grounded outputs, and cleaner
  multi-agent coordination.
- **Surface.** MCP tools, context format, memory schema, Loop engine,
  claims/plans/handoffs, federation signals.
- **Design constraints.** Minimal cognitive load for the agent
  (structured inputs, discoverable vocabulary), no UX, machine-parseable
  outputs, strict contracts. The agent should be able to use it without
  the human intervening.
- **Success metric.** Agent effectiveness: does a long-running agent
  with months of history outperform a fresh one? Does multi-agent
  review produce better code than single-agent? Does session N+1 pick
  up where session N left off without re-prompting?

### The cockpit — human-facing

- **Role.** Where the human supervises, audits, and trusts. Rarely used
  operationally by the agent. Critical for adoption, especially at
  enterprise scale where visibility is a procurement gate.
- **Surface.** Dashboard (local or remote), audit narrative reports,
  cost attribution, risk/policy surface, reputation views, forensics
  and replay, CI governance gates, webhooks for operational alerts.
- **Design constraints.** Visual, aggregable, exportable,
  compliance-ready. Human cognitive model: time series, filters,
  drill-downs. Should run read-mostly on the data the engine emits.
- **Success metric.** Human confidence: does a tech lead understand
  what N agents did this week? Can a compliance officer produce a
  report? Can an ops engineer detect a misbehaving agent before
  damage?

### The relationship between the two

- The engine **emits** signals (events, audit entries, reputation
  scores, usage traces, loop transitions).
- The cockpit **consumes** those signals and aggregates them for the
  human.
- The engine is primary: without it, the cockpit is an empty chart.
  The cockpit is load-bearing for adoption: without it, the engine
  never reaches production at scale.
- Engineering discipline: every engine feature should ask "what
  machine-readable signal should this emit so the cockpit can
  consume it?". The cockpit is then incremental capitalization on
  engine investments, not a parallel product effort.

## 3. Loop engine strategy

The Loop engine (pln#394) was designed as a generic control plane —
one engine, many protocols. Review & Fix Loop (pln#395) was the first
shipped protocol. The strategic reflection clarifies that:

- We do **not** need to code eight protocols. The five shipped defaults
  cover the high-leverage kinds; future work should polish their entry
  points and document further patterns as composition variants.
- The engine already supports everything required: `open`, `turn`,
  `advance`, `complete_turn`, `add_artifact`, `pause`, `resume`,
  `close`, with per-phase `advance_when`, composite `StopCondition`,
  idempotency, and CAS.

### Supported protocol families

The runtime ships **five default protocols**, not just a review loop:

| Protocol | What it structures | Public entry point |
|---|---|---|
| `review` | change summary → findings → response → verdict | `bclaw_coordinate(intent="review", open_loop=true)` or `bclaw_dispatch(intent="review", openLoop=true)` |
| `ideation` | proposal → adversarial critique ↔ revision → synthesis | `bclaw_coordinate(intent="ideate")`, with the optional `bootstrap` preset |
| `implementation` | bind a plan/sequence → execute ↔ verify → handoff | direct `bclaw_loop(intent="open", kind="implementation", allow_orphan=true)`, then `bind` |
| `research` | investigate ↔ synthesize → conclude | direct `bclaw_loop(intent="open", kind="research", allow_orphan=true)` |
| `debug` | reproduce → hypothesize ↔ isolate ↔ fix → handoff | direct `bclaw_loop(intent="open", kind="debug", allow_orphan=true)` |

The direct entry point requires `allow_orphan=true` because the caller is
responsible for driving or dispatching the loop. It does not mean the loop is
unsupported: `bclaw_loop` publicly exposes `open`, `turn`, `complete_turn`,
`advance`, `add_artifact`, `pause`, `resume`, `close`, and the
implementation-specific `bind` and `verify` actions.

**Clarification is cross-cutting.** Any protocol may use `request_input` and
`provide_input` to pause for a bounded, evidence-backed operator decision.
Treating it as a shared primitive avoids inventing a review-shaped loop for a
simple missing decision.

### Variants, not new protocols

The following items are compositions of the shipped protocols and do not
require separate engine work:

- **Reflection / Self-Critique** = ideation loop with `mode:
  'symmetric'` and all slots assigned to the same agent. The engine
  already supports this.
- **Validation & Approval Multi-Audience** = review loop with N
  reviewer slots (one per audience) plus a consolidator slot. Purely
  a slot-configuration pattern.
- **Optimization / Refactoring** = implementation loop framed around a
  before/after artifact pair. A convention, not a new protocol.

### What "wiring" means concretely (per protocol)

For a new protocol or a material protocol extension:

- Polished `DEFAULT_PROTOCOLS` entry (phases, stop_condition, default
  roles) in `src/core/loops/types.ts`.
- A facade entry point: either a new intent on `bclaw_coordinate`
  (e.g. `intent='ideate'`) or a direct `bclaw_loop(open, kind=...)`
  call pattern documented in the RFC.
- A human-visible output: the terminal artifact should materialize as
  a candidate or handoff the human can read, not only an intra-loop
  artifact. This is how the loop becomes a "helper" rather than a
  process trace.
- End-to-end tests that cover the happy path plus at least one
  iteration round.

## 4. Playbook refactoring note

The current playbooks (`docs/playbooks/integration/`, `productivity/`,
`team/`) mix the agent-user and human-adopter perspectives within a
single "audience" section. They should be refactored so each audience
file contains two explicit sections:

- **For the agent-user.** What the agent gains operationally: memory,
  context, coordination, loops, review. This is the engine view.
- **For the human-adopter.** What the human gains in trust,
  visibility, governance, compliance, cost control. This is the
  cockpit view.

This split clarifies priorities: features that improve agent
effectiveness belong to the engine slice and trade against each other;
features that improve human confidence belong to the cockpit slice and
trade against each other. Mixing them biased the existing "Known Gaps"
sections toward visible-to-human items.

## 5. Practical implications

- Next implementation move: a reframer phase (pln#493) on top of the
  shipped ideation loop, then improved ergonomics and examples for the
  already-shipped debug and research protocols.
- Parallel track: the cockpit needs dedicated planning once the engine
  emits enough signals (event streaming, reputation exposure, audit
  narrative generation, cost attribution).
- Any new feature proposal should explicitly state which layer it
  serves (engine or cockpit) and which audience slice (agent-user or
  human-adopter). Proposals that don't declare this should be sent
  back for clarification.

## References

- `docs/concepts/loop-engine.md` — the v8 RFC (engine primitive)
- `docs/playbooks/*` — current audience playbooks (pending refactor
  per §4 above)
- pln#394 `feat/loop-engine-mvp` — shipped
- pln#395 `feat/review-loop-protocol` — shipped
