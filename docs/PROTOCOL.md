# Brainclaw Protocol — v0.1 (draft)

> Status: **draft** — pre-public RFC. Versioned in [docs/PROTOCOL.md](./PROTOCOL.md);
> brainclaw is the reference implementation.
>
> Feedback target: external OSS agent integrators (Cline, OpenCode, Hermes,
> Mistral Vibe, Continue) — see "Feedback wanted" at the bottom.

## 1. What this spec is

Brainclaw runs a multi-agent coordination loop on top of a shared project
memory. The implementation has converged on a small grammar — entities, verbs,
lifecycle sentinels — that the rest of the system (CLI, MCP server, writers,
hooks) is just a delivery channel for.

This document carves out that grammar as a **transport-agnostic protocol** so
other agents and agent platforms can either:

  - speak it natively (via brainclaw's MCP server, the reference transport), or
  - implement it themselves and interoperate with brainclaw-managed projects.

The protocol does **not** standardize storage, file layouts, or the internal
state machine. Those are implementation details; brainclaw's are documented
under [`docs/concepts/`](./concepts/).

## 2. Versioning

| Field             | Rule                                                                    |
|-------------------|-------------------------------------------------------------------------|
| `protocol.major`  | Bumped only for breaking entity / verb / sentinel changes.              |
| `protocol.minor`  | Bumped for additive entities, verbs, sentinels, or new optional fields. |
| `protocol.patch`  | Editorial / clarifying changes; no behavioral impact.                   |

Current draft: **0.1** — entity surface stable; verb surface stable on the
"canonical grammar" (see §4); lifecycle sentinels stable for sessions, claims,
plans, assignments. Coordination / loop verbs are explicitly experimental.

Implementers SHOULD advertise the maximum supported version via an
`X-Brainclaw-Protocol` header (HTTP transports) or a server-info field
(MCP transports). Brainclaw's MCP server returns `0.1` in `serverInfo.version`.

## 3. Entities

The protocol recognises eight kinds of memory objects. Each has a unique `id`,
a canonical `kind`, and a small set of mutable fields. Storage of additional
fields is implementation-defined.

| Kind         | Purpose                                                              | Lifecycle states                                        |
|--------------|----------------------------------------------------------------------|---------------------------------------------------------|
| `constraint` | Active rule the project must respect.                                | `active` → `resolved` / `expired`                       |
| `decision`   | Recorded architectural / process decision.                           | `pending` → `approved` / `rejected` / `deferred`         |
| `trap`       | Known failure mode; reminder for future work.                        | `active` → `resolved` / `expired`                       |
| `plan`       | Unit of work tracked across agents.                                  | `open` → `in_progress` → `done` / `cancelled`           |
| `claim`      | Mutex over a file scope.                                             | `open` → `released` (or `expired` via TTL)              |
| `handoff`    | Asynchronous instruction from one agent to another.                  | `open` → `accepted` → `closed`                          |
| `candidate`  | Proposed memory item awaiting review.                                | `proposed` → `accepted` / `rejected` / `merged`         |
| `assignment` | Dispatched work item routed to a specific agent.                     | `offered` → `accepted` → `started` → `completed` / `failed` / `blocked` / `cancelled` |

Entities have these well-known fields (implementations MAY add more):

```
id          string   // implementation-assigned, opaque, stable
kind        string   // one of the kinds above
status      string   // one of the lifecycle states above
text        string?  // human-readable summary
tags        string[]?
created_at  string   // ISO-8601 UTC
updated_at  string   // ISO-8601 UTC
provenance  object?  // {kind: 'agent'|'human'|'auto'|'legacy', author, source}
```

Brainclaw's full field set lives in [`src/core/schema.ts`](../src/core/schema.ts).
Future protocol minors will promote additional fields to "well-known" as they
prove portable across implementations.

## 4. The canonical grammar (verbs)

The protocol exposes seven canonical verbs. Implementations MUST support these
in order to claim protocol compliance. They are deliberately narrow so the
surface stays small; richer ergonomic helpers are facades on top.

| Verb              | Shape                                                          | Effect                                                  |
|-------------------|-----------------------------------------------------------------|---------------------------------------------------------|
| `work(intent)`    | `intent: consult \| execute \| resume \| review`                 | Open a session; optionally claim a scope.               |
| `context(kind)`   | `kind: memory \| execution \| board \| delta`                    | Read shared state.                                      |
| `find(entity, …)` | `entity, filter, limit`                                         | Query entities.                                         |
| `get(entity, id)` | `entity, id` (or `short_label`)                                 | Fetch one entity by identifier.                         |
| `create(entity)`  | `entity, data`                                                  | Insert a new entity (validated against schema).         |
| `update(entity)`  | `entity, id, patch`                                             | Patch mutable fields. Status changes go via `transition`. |
| `transition(…)`   | `entity, id, status`                                            | Move an entity along its lifecycle. Triggers side-effects. |

The reference implementation surfaces these as MCP tools named
`bclaw_work`, `bclaw_context`, `bclaw_find`, `bclaw_get`, `bclaw_create`,
`bclaw_update`, `bclaw_transition`. The same names appear in
`src/commands/mcp.ts:MCP_CANONICAL_GRAMMAR_TOOL_NAMES` and are derived from
the tool catalog, not hand-curated. Hermes and other narrow-surface agents
include exactly this set in their MCP `tools.include`.

### 4.1 Coordination verbs (experimental — protocol v0.2 candidates)

These are present in the reference implementation but **not yet stable**.
Implementations MAY support them but should expect breaking changes:

  - `coordinate(intent: assign|consult|review|reroute)` — multi-agent routing.
  - `dispatch(plan, agents)` — concrete spawn / claim ledger.
  - `loop(kind: ideation|implementation|review)` — multi-round loops.

## 5. Lifecycle sentinels

The protocol defines **named state transitions** so any compliant agent can
reason about another's progress without parsing free-form text. These are the
strings agents are expected to emit at protocol-defined moments.

### 5.1 Session sentinels

| Moment                | Sentinel                                                              |
|-----------------------|-----------------------------------------------------------------------|
| Agent reaches its loop | Filesystem heartbeat: `.brainclaw-heartbeat-<assignment_id>`           |
| Session opens         | `work(intent)` response carries the `session_id` and seed context.    |
| Session ends          | `work(intent: …)` is terminal; or implementation-specific close call. |

### 5.2 Assignment sentinels

The lifecycle a coordinator can observe on a dispatched assignment:

```
offered → accepted → started → (progress)* → completed
                                             | failed
                                             | blocked
                                             | cancelled
```

Each transition is emitted via `transition('assignment', id, <status>)`.
A worker that cannot reach the protocol transport (sandboxed) MAY drop a
`LANE-RESULT.json` file at the worktree root as the fallback signal — the
coordinator harvests it.

### 5.3 Claim sentinels

```
open → released         (worker calls transition('claim', id, 'released'))
open → expired          (TTL-driven; reaper marks expired)
```

A claim that converged on `done` MAY carry a `planStatus` hint so the
coordinator updates the linked plan atomically with the release.

### 5.4 Plan-step sentinels

Plans contain ordered steps with their own status. The grammar verbs
`update('plan', id, {steps:[…]})` and `transition('plan', id, 'done')`
operate over the whole plan; the canonical step sentinel is a step-level
`status: done`. Implementations MAY surface `bclaw_complete_step` as a
sugar on top.

## 6. Conformance levels

| Level | What conformance means                                                                 |
|-------|----------------------------------------------------------------------------------------|
| **L1 — Read** | Implementation can issue `work(intent: consult)` + `context` + `find` + `get` and respect active claims. Minimum bar for "I can run inside a brainclaw-managed project without breaking it." |
| **L2 — Write** | All of L1 plus `create` / `update` / `transition` on the entities above with valid lifecycle transitions. |
| **L3 — Coordinate** | All of L2 plus the experimental coordination verbs (§4.1) and assignment sentinels. Required for spawning / accepting dispatched work. |

Hermes and Mistral Vibe ship at L1 (narrow surface). Claude Code, Codex,
Copilot, and Cline are L3. The reference implementation enforces the
L3 contract via assignment-convergence tests (see
[`tests/unit/assignment-convergence.test.ts`](../tests/unit/assignment-convergence.test.ts)).

## 7. Transport bindings

The protocol is transport-agnostic. The reference implementation ships an
MCP server (`brainclaw mcp`); other implementations MAY add JSON-RPC over
stdio, HTTP, or a local IPC socket without changing the entity / verb /
sentinel surface.

A transport binding MUST specify:

  - how the seven canonical verbs are named (mapping to the binding's call shape),
  - how entity identifiers are serialised (recommend opaque strings),
  - how lifecycle sentinels are encoded (recommend `transition` calls,
    not free-form status strings).

## 8. Storage and federation

Out of scope for v0.1. The reference implementation uses git-backed
JSON/YAML in `.brainclaw/`. Multi-project federation is a planned
extension — see [docs/concepts/](./concepts/) and the brainclaw memory
files for the current direction. A future protocol version will define
the wire format for cross-project signaling.

## 9. Reference implementation map

| Protocol concept              | Reference implementation in brainclaw                                 |
|-------------------------------|-----------------------------------------------------------------------|
| Entity schemas                | [`src/core/schema.ts`](../src/core/schema.ts)                          |
| Canonical grammar tool set    | [`src/commands/mcp.ts`](../src/commands/mcp.ts) — `MCP_CANONICAL_GRAMMAR_TOOL_NAMES` |
| MCP tool catalog              | [`src/commands/mcp.ts`](../src/commands/mcp.ts) — `ALL_TOOLS`          |
| Per-agent writer wiring       | [`src/core/agent-files.ts`](../src/core/agent-files.ts) — `AGENT_WIRING_REGISTRY` |
| Capability profiles           | [`src/core/agent-capability.ts`](../src/core/agent-capability.ts)       |
| Assignment lifecycle          | [`src/core/assignments.ts`](../src/core/assignments.ts) + [`tests/unit/assignment-convergence.test.ts`](../tests/unit/assignment-convergence.test.ts) |
| Claim lifecycle / TTL         | [`src/core/claims.ts`](../src/core/claims.ts)                          |

## 10. Feedback wanted

The following questions are open for v0.2. We're soliciting input from agent
integrators before declaring any of them stable:

  1. **Coordination verb shape (§4.1)** — should `coordinate(intent: assign|…)`
     stay as a single verb with an intent enum, or split into named verbs
     (`assign`, `reroute`, `review_request`) per L3 capability?
  2. **Sentinel transport for sandboxed workers** — the `LANE-RESULT.json`
     fallback file is brainclaw-specific. Is there an interest in
     standardising a "filesystem fallback" format so any coordinator can
     harvest results from any sandboxed worker?
  3. **Entity field portability** — which fields beyond the well-known set
     (§3) are universal enough to promote in v0.2? Candidates: `severity`,
     `priority`, `category`, `effort_minutes`, `assignee`.
  4. **L1-only adoption surface** — would a CLI-only L1 reference (no MCP
     dependency) lower the adoption bar for OSS agents that don't speak MCP
     yet?

Open an issue, ping `ai@thomgroup.com`, or comment on the brainclaw plan
tracking this draft (pln#546).
