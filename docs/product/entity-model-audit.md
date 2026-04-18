# Entity model audit — pre-v1.0 strategic reflection

Captured 2026-04-18 during a second round of strategic review before
the MCP grammar Phase 3 refactor. This document complements
`docs/product/agent-first-model.md` (which defines the two-layer
product model) and should be read before any entity-shape or API-verb
decision.

## Context

brainclaw has grown organically over months and some older concepts
deserve challenge before the public launch:

- The MCP surface has 70 tools, 26 dedicated to CRUD variants per
  entity type.
- Some lifecycles (candidate review queue) are rarely used as designed.
- Some entities overlap in role (runtime_note vs decision-candidate,
  capability vs tool).
- The upcoming API grammar refactor (Phase 3 in the broader plan)
  will bake current entity shapes into permanent verbs. Cleaning the
  model first avoids fossilising bad decisions.

Since brainclaw is not yet publicly distributed, backward compatibility
is not a blocker — the priority is internal coherence at v1.0 launch.

## Design principles that emerged

### P1 — Engine delivers value, cockpit sells adoption
See `agent-first-model.md`. Every engine feature should emit
machine-readable signals the cockpit can consume. Human visibility is
a critical adoption gate at enterprise scale, not optional.

### P2 — Three review modes must coexist without penalty
brainclaw must support three review intensities and let the agent
choose consciously:

| Mode | When | Cost | Entry point today |
|---|---|---|---|
| Self-review inline | Solo default path (~70% of sessions) | Few LLM cycles | No brainclaw tool, agent self-checks |
| Dispatch-review | When a second opinion is worth a round-trip | One inbox message + reply | `bclaw_dispatch_review(openLoop: false)` |
| Review loop | Quality bar high, multi-round likely, structured feedback needed | Multiple rounds, multi-slot | `bclaw_dispatch_review(openLoop: true)` or `bclaw_loop(intent='open', kind='review')` |

The simpler modes must not pay a tax because the heavier mode exists.
Primitives like session, claim, handoff, inbox must all work fully
without loops.

### P3 — Loops are opt-in enhancement, not default path
Loops (review, ideation, debug, research) are structured, multi-agent,
expensive. In the majority of sessions agents work directly without
them. Every primitive must be fully usable without a loop; loops are
invoked when the complexity justifies the cost.

### P4 — Teams cross-machine is a first-class scenario
brainclaw supports three modes of work without compromise:

- **Solo agent** — local, no coordination, fast.
- **Solo dev + external reviewer** — dispatch-review or review_loop.
- **Teams cross-machine** — federation push/pull, inbox cross-project,
  handoff as the artifact for resuming on another machine.

Team primitives (federation, cross-project inbox, handoff) must stay
load-bearing; simplifications cannot break them.

## Entity-by-entity verdicts

### ✅ Keep as-is

- **Plan / Step / Sequence** — the three-tier hierarchy is
  semantically distinct and useful for precise agent communication.
  - Plan: a work item with a goal, text, priority, status, tags,
    dependencies, steps.
  - Step: sub-element of a plan; inherits lifecycle from its parent
    but has its own status.
  - Sequence: coordinates execution across plans/steps by defining
    parallelizable lanes with hard/soft dependencies between items.
  The distinction was confirmed as valuable by the operator.

- **Decision / Constraint / Trap (trichotomy)** — each carries
  distinct semantics that earn their keep:
  - **Decision**: anchors a strategic choice (e.g., "chose
    PostgreSQL", "use X testing framework"). Retrospective reference.
  - **Constraint**: imposes a process or rule that must be followed
    (e.g., "minimize core dependencies", "all APIs must be REST",
    "never init --force"). Strongest concept; drives hook injection
    to remind agents of the process.
  - **Trap**: environmental or process pitfall to avoid (e.g., "git
    merge wipes node_modules", "sandbox X blocks MCP writes"). May
    trigger a corrective plan when resolvable.
  All three drive different agent behaviours (decisions = retrieve for
  context, constraints = enforce, traps = warn + resolve).

- **Claim** — file-level advisory lock, scope boundary, worktree
  attachment point. Clear lifecycle (active → released/expired).

- **Session** — execution envelope, links work to an agent identity.

- **Assignment / AgentRun** — runtime tracking of dispatched work.
  Distinction is technical (assignment = the ask, run = the execution)
  but useful for observability; the agent does not need to interact
  with them directly.

### 🔴 Remove

- **Candidate lifecycle** — the "create candidate → accept/reject →
  promote to decision/constraint/trap/handoff" workflow is badly used
  in practice. Very few candidates in the current store have been
  processed; most are auto-generated and ignored. The review queue
  concept duplicates what the Loop engine now provides better via
  `review_loop`.

  **After removal:**
  - `bclaw_create_candidate`, `bclaw_list_candidates`, `bclaw_accept`,
    `bclaw_reject`, `bclaw_harvest_candidates` disappear from the
    surface.
  - Auto-reflection at session_end writes directly to decision /
    constraint / trap / handoff with a `source: 'auto'` field and a
    `confidence` score. Agents or humans filter low-confidence auto
    items via `bclaw_find(source: 'auto', confidence_gte: 0.8)`.
  - Intentional batch review moves to `review_loop` (open a loop
    whose change_summary points to the memory items under review).
  - Cross-project signals arrive directly in `inbox/cross-project/`
    (already the pattern for other signals).

### ⚠️ Downscale

- **Handoff** — keep as a session-end auto-artifact, strip the
  review sub-flow.

  **Keep:**
  - Automatic generation at `bclaw_session_end` with commits, files
    touched, narrative, pre/post conditions, linked plans.
  - Read-only access via `bclaw_get(entity='handoff', id)` for context
    resumption on the same or another machine.
  - Federation push/pull across linked projects (critical for teams;
    without this teammate B's agent loses teammate A's session story).
  - Optional linking to a `review_loop` when a structured review is
    dispatched via `bclaw_dispatch_review(openLoop: true)`.

  **Drop:**
  - The `review` sub-object on the handoff entity (requester,
    reviewer, thread_id, requested_at, review_message_id). Never
    used as designed.
  - Active `update_handoff` for mid-life edits. Only the narrative
    override at session_end stays (single write at creation).

  **Rationale:** handoffs are a *passive artefact* of the default
  path, not a coordination surface. Review happens via dispatch-review
  or review_loop, not via mutating a handoff.

### 🟡 Examine further during implementation

- **RuntimeNote** — if auto-reflect + direct memory writes land,
  runtime_note becomes redundant with low-confidence decision/trap
  candidates. Consider removing. Keep for this audit, revisit during
  Phase 3 implementation.

- **Instruction layers** (global / project / agent) — functionally
  similar to constraints with different scopes. Could merge into a
  unified `memory` entity with a `scope` field. Not urgent; valid to
  keep distinct for now since instructions have lifecycle triggers
  (`trigger:post-claim`, `trigger:pre-session-end`) that constraints
  do not.

- **Capability vs Tool** — two registries under `.brainclaw/memory/`
  with a thin distinction (capability = what the project can do, tool
  = what the project uses). Good candidate for merger under a
  `resource` entity with a `kind` field. Low priority.

## Phase 3 grammar outline (post-audit)

### Canonical verbs (6)

```
bclaw_find(entity, filters, limit, offset)      — query many
bclaw_get(entity, id | short_label)             — fetch one
bclaw_create(entity, data)                      — new item, returns id
bclaw_update(entity, id, patch)                 — partial merge
bclaw_remove(entity, id, purge?)                — archive (default) or hard delete
bclaw_transition(entity, id, to, reason?)       — state machine transitions with side effects
```

### Workflow intents that stay distinct

```
bclaw_work(intent)          — session + claim + context facade
bclaw_coordinate(intent)    — multi-agent coordination
bclaw_loop(intent)          — loop lifecycle
bclaw_dispatch(intent)      — dispatch analysis + execution + review (unified from 3 tools)
bclaw_quick_capture(text)   — NL → typed memory
bclaw_bootstrap, bclaw_setup, bclaw_switch, bclaw_compact
bclaw_context(kind)         — unified from get_context, get_execution_context, get_discovery, get_agent_board, get_agent_board_summary
bclaw_audit(mode)           — chronological or governance report
bclaw_doctor, bclaw_check_policy, bclaw_check_security
bclaw_history, bclaw_estimation_report, bclaw_release_notes
```

### Approximate surface size

From 70 tools to ~20. Each verb is memorable, schema-discoverable, and
has a clear semantic.

### EntityRegistry as single source of truth

A new `src/core/entity-registry.ts` module holds:

- Short-label prefix per entity (plan → `pln`, claim → `clm`, …)
- Updatable fields per entity (Zod schema — what `update` can touch)
- Valid status transitions per entity (state machine definition)
- Side effects per transition (hardcoded for MVP, configurable later)

`bclaw_update` and `bclaw_transition` both consult this registry. A
grammar-consistency test suite verifies every entity has a complete
schema declaration.

### Transition logging — three destinations

| Destination | For whom | Why |
|---|---|---|
| `audit.log` | Forensics, compliance, governance | Authoritative chronological record |
| `events.jsonl` (already exists) | Reactive agents + cockpit live feed | Low-level event stream |
| `bclaw_activity` (new derived tool) | Humans, coordinator agents | Narrative digest, aggregated by entity/agent/session |

The cockpit (human-visibility layer) is built by consuming these
signals. Engine features emit; cockpit aggregates.

## Open questions for external validation

Before committing to implementation, we are consulting external
perspectives (codex, another claude-code instance, github-copilot) to
pressure-test these decisions. The four questions:

**Q0 — Teams cross-machine completeness.** Our current primitives
(handoff federation, inbox cross-project, claims local, runtime_note
federation) — do they cover common team cases (2–5 devs on different
machines, shared monorepo, distributed reviewers)? Is there an obvious
missing pattern?

**Q1 — Handoff simplification safety.** After stripping the review
sub-flow and keeping the handoff as a passive session-end artefact
(with federation + read-only + optional review_loop link), is there
any agent-facing use case this simplification breaks that we haven't
seen?

**Q2 — Transition side effects hardcoded vs configurable.** For MVP we
plan to hardcode side effects of transitions (close claims on
plan.status=done, promote candidate on accept, etc.) in the
`bclaw_transition` handler rather than declaring them in the
EntityRegistry. Is this the right tradeoff for now, or does the
configurable approach pay for itself early?

**Q3 — Version strategy pre-public.** Given we are pre-public with no
external integrators, should we:
- (a) bump v0.8 → v1.0 directly with the cleaned grammar, accepting
  the internal breaking change in one go; or
- (b) go v0.8 → v0.9 (add new verbs, deprecate legacy) → v1.0 (remove
  legacy), using two internal releases as buffer?

Option (a) is cleaner but less battle-tested before public launch;
(b) is slower but lets us dogfood the new grammar before removing the
old.

## §6 — Patches integrated post-consult

Three external reviewers (codex, a second claude-code instance,
github-copilot) returned verdict `proceed_with_patches` on the audit.
Their convergent recommendations are integrated below. Each patch is
load-bearing for Phase 3 and must land either before or during the
grammar refactor.

### P6.1 — Tombstone pattern for handoff corrections

**What.** Handoffs stay immutable session-end artefacts. Post-session
corrections (a teammate spotted a mistake, a follow-up clarified
something) do not mutate the original handoff — they create a *new
correction handoff* that carries a `superseded_by` pointer back to the
original.

**Why.** Preserves the "passive artefact" property while keeping an
audit trail of who revised what. Federation remains safe (each record
is whole, no partial merges).

**How to apply.** Reject all `bclaw_update(entity='handoff', …)`
outside the narrative override at creation. Expose instead a
`bclaw_correct_handoff(original_id, correction_data)` helper that
writes a new handoff and patches `original.superseded_by`.

### P6.2 — Declarative transition matrix + imperative side effects

**What.** Valid status transitions per entity live in the
EntityRegistry as a declarative matrix (`{ from: [to1, to2] }`). Side
effects (close linked claims, write audit entry, emit event) stay
imperative in `bclaw_transition` for MVP.

**Why.** Hybrid lets us test the declarative matrix (grammar
consistency tests, static analysis) without over-engineering a rules
engine we do not need yet. Migration to declarative side effects later
is a drop-in without breaking callers.

**How to apply.** `EntityRegistry[entity].transitions` is the
authoritative matrix; `bclaw_transition` rejects moves not in the
matrix, then runs a hardcoded side-effect dispatch per (entity, to)
pair.

### P6.3 — Provenance as a typed discriminated union

**What.** Replace the single `source: 'auto' | 'user' | …` string with
a typed discriminated union:

```ts
type Provenance =
  | { kind: 'agent';         agent_id: string; session_id: string }
  | { kind: 'auto_reflect';  source_session: string; confidence: number }
  | { kind: 'user';          author: string }
  | { kind: 'loop_artifact'; loop_id: string; slot: string; turn: number }
  | { kind: 'federation';    source_project: string; remote_id: string }
  | { kind: 'correction';    supersedes: string }
  | { kind: 'legacy' };
```

**Why.** Each origin has different downstream implications (retention,
confidence, federation behavior, audit narrative). A single string
field cannot carry the metadata cleanly; a union keeps type-safety and
makes queries like `bclaw_find(provenance.kind='auto_reflect',
confidence_gte:0.8)` natural.

**How to apply.** Add `provenance` field to
decision/constraint/trap/handoff/runtime_note schemas. On v1.0
migration, existing records receive `{ kind: 'legacy' }`. Default
filter on memory reads: exclude `legacy` + auto below threshold,
configurable via the query.

### P6.4 — Delta context via bclaw_context(kind='delta')

**What.** `bclaw_context` currently returns full state every call. Add
a `kind: 'delta', since: <handoff_id | timestamp | event_seq>`
parameter that returns only what changed since the reference point.

**Why.** At scale (long sessions, cross-agent resumption, federation
sync) returning full state is a token tax. Resumption needs the delta,
not the world.

**How to apply.** Implement as a filter over the events.jsonl stream +
a diff against the referenced snapshot. Falls back to full context if
the reference point is too old (compacted out).

### P6.5 — MCP schema version strategy: 0.6 → 0.7 → 0.8 → 1.0

**What.** The MCP schema version (`SCHEMA_VERSION` in
`src/commands/mcp.ts`, currently `0.6.0`) is distinct from the app
version (`package.json`, currently `0.62.0`). Progression:

| Step | MCP schema | App version | Scope |
|---|---|---|---|
| Now | 0.6.0 | 0.62.x | baseline |
| Patches | 0.7.0 | 0.63.x | P6.1–P6.4 + provenance rollout |
| Migration | 0.8.0 | 0.64.x | `brainclaw migrate` + candidate archive |
| Phase 3 | 1.0.0 | 1.0.0 | canonical 6 verbs + legacy removal |

**Why.** App version tracks code changes; schema version tracks the
contract MCP clients bind to. Agents that cache tool catalogs need to
know when verbs changed shape.

**How to apply.** Bump `SCHEMA_VERSION` at each step. Tool catalog
response always includes schema_version so clients can invalidate.

### P6.6 — Pending candidates archived on migration

**What.** On v1.0 migration, existing candidates are not promoted or
rejected — they are archived to `.brainclaw/archive/candidates/` with a
manifest listing their original paths. The runtime stops reading them.

**Why.** No information loss (archive stays on disk for later
inspection), no forced triage on the operator, clean cutover.

**How to apply.** `brainclaw migrate --to-schema=1.0` copies
`.brainclaw/memory/candidates/` to `.brainclaw/archive/candidates/<date>/`,
writes an index, removes the live directory.

### P6.7 — Schema migration as a hard pre-Phase-3 step

**What.** Do not start Phase 3 (the grammar refactor) until
`brainclaw migrate` command exists and has been dogfooded on both live
installations (this machine + the monorepo test server).

**Why.** Phase 3 ships the canonical grammar. Existing stores must
upgrade cleanly to v1.0 schema before any tool rewrites remove the
legacy paths. Migration first = safety net; grammar refactor second =
execute with confidence.

**How to apply.** Migration plan (`feat/v1-schema-migration`, see §7)
is a hard blocker on the Phase 3 plan (`feat/phase-3-canonical-grammar`).

### P6.8 — Keep runtime_note / instruction / capability/tool distinct

**What.** Reviewers recommended leaving runtime_note, instruction
layers, and capability/tool as distinct entities for v1.0. They were
flagged as "examine further" in §5 — verdict is *keep as-is*.

**Why.** Instructions carry lifecycle triggers (`post-claim`,
`pre-session-end`) that constraints do not. Capability vs tool has a
semantic distinction (what the project *can do* vs what it *uses*)
that matters for discoverability. Runtime notes remain a natural
slot for low-confidence, scoped observations that do not yet deserve
promotion to decision/trap. Premature merger would lose information.

**How to apply.** No change for v1.0. Flag for a dedicated audit pass
post-v1.0 once usage data confirms or contradicts the distinctions.

## §7 — Consolidated Phase 3 checklist

Hard prerequisite before any item below: **`feat/v1-schema-migration`
plan must be executed and dogfooded** (see P6.7).

Phase 3 itself is sliced into nine sub-items; each is independently
mergeable behind a feature flag or catalog filter:

- **3a — EntityRegistry core.** New `src/core/entity-registry.ts`:
  short-label prefixes, updatable-field Zod schemas, transition
  matrices, side-effect map. Grammar consistency tests.
- **3b — Six canonical CRUD verbs.** Implement `bclaw_find`,
  `bclaw_get`, `bclaw_create`, `bclaw_update`, `bclaw_remove`,
  `bclaw_transition` consuming EntityRegistry. Behind `catalog: "all"`
  filter first, public in `catalog: "default"` at v1.0.
- **3c — `bclaw_context(kind)` unified.** Consolidates
  `bclaw_get_context`, `bclaw_get_execution_context`,
  `bclaw_get_agent_board`, `bclaw_get_agent_board_summary` under one
  intent with a `kind` discriminator. Includes `kind='delta'` from
  P6.4.
- **3d — `bclaw_dispatch(intent)` unified.** Consolidates
  `bclaw_dispatch_analysis`, `bclaw_dispatch_review`, and the raw
  `bclaw_dispatch`. Review sub-intent carries `openLoop` flag for the
  review_loop escalation path.
- **3e — Handoff downscale.** Strip the review sub-object, remove
  `bclaw_update_handoff`, expose `bclaw_correct_handoff` for tombstone
  corrections (P6.1). Federation push/pull preserved end-to-end.
- **3f — Provenance rollout.** Apply discriminated-union provenance
  (P6.3) to decision/constraint/trap/handoff/runtime_note. Default
  memory reads filter on confidence + non-legacy.
- **3g — Legacy deprecation warnings.** Keep old tool names in
  `catalog: "all"` with `LEGACY_MCP_TOOL_WARNINGS` entries pointing to
  the new verb. Warnings fire server-side on every call during 0.9.x.
- **3h — Docs sync.** Update `docs/integrations/mcp.md`,
  `CLAUDE.md`, release notes, and agent profile exports. Canonical
  grammar example galleries.
- **3i — Legacy removal + v1.0 cut.** Remove deprecated tool names
  from the MCP surface entirely. Bump schema to 1.0.0 and app to
  1.0.0. Public launch candidate.

Slices 3a–3b are the architecture core; 3c–3e are the intent
consolidations; 3f is cross-cutting; 3g–3i are the soft→hard cutover.

## Sources

- `docs/product/agent-first-model.md` — engine/cockpit two-layer model
- `docs/concepts/loop-engine.md` — v8 RFC for the loop primitive
- Session transcript 2026-04-18 (strategic round 2) — post-consult
  integration pass
- Memory decisions `cnd#587` (product model) and `cnd#588` (loop
  protocols roadmap)
- External consult verdicts 2026-04-18 (codex / claude-code /
  github-copilot) — all `proceed_with_patches`, patches integrated in
  §6
