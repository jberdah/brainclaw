# MCP Integration

MCP is the primary Brainclaw integration path for capable coding agents.

Use it whenever the agent can retrieve or mutate shared state directly instead of relying only on static files.

## Why MCP Is The Nominal Path

MCP matters because Brainclaw's value is mostly in dynamic state:

- fresh context for the exact path being edited
- current board state
- active plans and claims
- runtime observations
- handoffs and review queues

Static files still help, but they age immediately. MCP is the stronger path for live coordination.

That now also includes Brainclaw's own install channel state: `bclaw_context({ kind: "execution" })` surfaces whether a newer npm or local-pack build is available, so the agent can notice upgrades without relying on a human to run `brainclaw version --check`.

## Recommended Agent Pattern

The default dynamic workflow is:

1. `bclaw_work` to start the session and load the relevant context in one call (returns compact payload by default — pass `compact: false` for the full context result)
2. `bclaw_context({ kind: "execution" })` early when the agent needs local tooling signals or package update visibility
3. `bclaw_context({ kind: "memory" })`, `bclaw_context({ kind: "board" })`, or `bclaw_context({ kind: "delta" })` when the target path changes or full memory is needed beyond the compact summary
4. `bclaw_code_brief({ target })` / `bclaw_code_find({ query })` before editing unfamiliar code — get a ranked reading list (with related decisions/traps) and locate symbols from the Code Map instead of grepping blind. Use `bclaw_code_impact({ target, depth: 2 })` when you need an explainable local blast radius; its `tests_for` separates resolved imports from low-confidence filename suggestions. Use `bclaw_code_export({ target, direction, depth, maxNodes, maxEdges })` when you need a compact bounded subgraph; every returned edge keeps `kind`, `source`, and `confidence`, and `format: 'mermaid'` is projected from that same JSON model. A `missing_index` badge means run `bclaw_code_refresh` first. See [code map](../code-map.md)
5. `bclaw_find` / `bclaw_get` / `bclaw_create` / `bclaw_update` / `bclaw_remove` / `bclaw_transition` for entity reads and writes
6. `bclaw_coordinate`, `bclaw_dispatch`, or `bclaw_loop` for assign, consult, review, reroute, summarize, dispatch, or multi-turn loop flows
7. `bclaw_read_inbox` when resuming delegated work
8. `bclaw_write_note`, `bclaw_quick_capture`, or `bclaw_create({ entity: "candidate", ... })` when the result should become runtime or durable shared memory

This keeps session continuity inside Brainclaw instead of pushing the agent back to manual CLI usage.

When a human operator needs the CLI equivalent of `bclaw_write_note`, use `brainclaw runtime-note <text>`.

## Available Tools

All 65 published MCP tools are discoverable via `tools/list`. Each tool carries an `annotations` object with `tier` and `category` metadata so clients can filter or group tools without server-side hiding.

### Tool tiers

Every tool has one of three tiers in its `annotations.tier` field:

- **facade** — High-level entry points for agents that don't need granular access. Start here.
- **standard** — Day-to-day coordination tools: plans, claims, messaging, sequences, dispatch, review, memory. Returned by default alongside facades.
- **advanced** — Specialized governance, audit, registry, and power tools.

By default, `tools/list` returns **facade + standard** tools (49 tools). To get all tools including advanced, pass `{ "catalog": "all" }`, `{ "include": "all" }`, or `{ "advanced": true }`. To filter by a single tier, pass `{ "tier": "facade" }`, `{ "tier": "standard" }`, or `{ "tier": "advanced" }`.

Published tools remain callable regardless of catalog filtering — the tier only affects discovery via `tools/list`.

See [docs/concepts/mcp-governance.md](../concepts/mcp-governance.md) for
the stability contract of each tier (what counts as a breaking change,
deprecation window, schema versioning rules). Changelog entries for
every version live in [docs/mcp-schema-changelog.md](../mcp-schema-changelog.md).

### Tool categories

Each tool also has an `annotations.category` field: `session`, `context`, `memory`, `coordination`, `loops`, `governance`, or `discovery`.

### Facade tools

| Tool | Category | Purpose |
|---|---|---|
| `bclaw_work` | session | Start session + load context + optionally claim a scope in one call (compact payload by default) |
| `bclaw_context` | context | Unified context read for memory, execution, board, board summary, and deltas |
| `bclaw_coordinate` | coordination | Assign, consult, review, ideate, reroute, or summarize across agents |
| `bclaw_dispatch` | coordination | Analyze, execute, or review dispatch work through one intent-based entry point |
| `bclaw_loop` | loops | Drive review, ideation, implementation, research, or debug loops, including fenced physical-run takeover |
| `bclaw_setup` | session | Agent-driven onboarding wizard |

### Standard tools

| Tool | Category | Purpose |
|---|---|---|
| `bclaw_bootstrap` | context | Brownfield bootstrap signals, interview prompts, selective import |
| `bclaw_release_notes` | context | Agent-first release notes with breaking risk assessment |
| `bclaw_search` | memory | Full-text search across memory items |
| `bclaw_assignment_events` | coordination | List correlated runtime events for assignments and runs |
| `bclaw_switch` | session | Switch active project in a multi-project workspace |
| `bclaw_read_inbox` | coordination | Read messages from an agent inbox |
| `bclaw_send_message` | coordination | Send assignments, review requests, RFCs, notifications, or threaded replies |
| `bclaw_ack_message` | coordination | Acknowledge a processed inbox message |
| `bclaw_write_note` | memory | Record a runtime note |
| `bclaw_quick_capture` | memory | Capture text and classify it locally as a decision, trap, or runtime note |
| `bclaw_claim` | coordination | Claim a work scope (advisory lock, auto-worktree) |
| `bclaw_release_claim` | coordination | Release a legacy/unsettled-independent claim, optionally updating linked plan status; v2 loop claims are released by settlement projections or audited coordinator override |
| `bclaw_session_start` | session | Start a session explicitly (granular workflow) |
| `bclaw_session_end` | session | End session, optionally auto-reflect notes or handoffs |
| `bclaw_add_step` | coordination | Add a sub-step to a plan item |
| `bclaw_complete_step` | coordination | Mark a plan sub-step as done |
| `bclaw_update_step` | coordination | Update a plan sub-step's status, text, or assignee |
| `bclaw_delete_step` | coordination | Remove a sub-step from a plan |
| `bclaw_list_sequences` | coordination | Coordination sequence listing |
| `bclaw_create_sequence` | coordination | Create a coordination sequence |
| `bclaw_update_sequence` | coordination | Update a sequence's status, metadata, or items |
| `bclaw_delete_sequence` | coordination | Delete a sequence by ID |
| `bclaw_correct_handoff` | coordination | Write an immutable correction handoff that supersedes an earlier one |
| `bclaw_assignment_update` | coordination | Report assignment lifecycle status; v2 logical Assignments require the full generation fence and accept only accepted/started/progress before settlement |
| `bclaw_assignment_action` | coordination | Resolve or reject a pending ActionRequired item |
| `bclaw_harvest_candidates` | coordination | Harvest sandboxed worktree candidate files into the main project store |
| `bclaw_find` | memory | List canonical entities with filters |
| `bclaw_get` | memory | Fetch a canonical entity by id or short label |
| `bclaw_create` | memory | Create a canonical entity |
| `bclaw_update` | memory | Partially update mutable fields on a canonical entity |
| `bclaw_remove` | memory | Archive or purge a canonical entity |
| `bclaw_transition` | memory | Move an entity through its validated state machine |
| `bclaw_move` | memory | Relocate an item to another project, id-preserving (multi-project) |
| `bclaw_code_status` | discovery | Active-session Code Map freshness + stats; `cascade:true` follows durable monorepo refresh progress and exceptions |
| `bclaw_code_find` | discovery | Search the Code Map symbol index by name (function/class/component/hook/type) |
| `bclaw_code_brief` | discovery | Ranked reading list + related decisions/traps before editing a symbol or path |
| `bclaw_code_impact` | discovery | Explainable local blast radius from resolved imports: definition, direct dependents, opt-in bounded transitives, tests, and count-based risk |
| `bclaw_code_export` | discovery | Compact bounded local nodes/edges around one symbol or file; preserves edge kind/source/confidence, with optional Mermaid projection |
| `bclaw_code_outline` | discovery | Source-ordered symbols of one indexed file (span, exported, confidence) — no reparse |
| `bclaw_code_refresh` | discovery | Rebuild the Code Map index (`scope: changed \| all`); `cascade:true` starts a durable background job |

See [code map](../code-map.md) for the full Code Map reference (CLI, freshness model, supported languages).

### Advanced tools

| Tool | Category | Purpose |
|---|---|---|
| `bclaw_audit` | governance | Audit log or governance posture report |
| `bclaw_check_policy` | governance | Pre-execution policy check for a scope |
| `bclaw_check_security` | governance | Supply chain security scores via Socket.dev |
| `bclaw_conflict_check` | governance | Check for overlapping claims between agents |
| `bclaw_doctor` | governance | Health checks on the memory store |
| `bclaw_history` | governance | Full mutation history of a memory item |
| `bclaw_estimation_report` | governance | Estimation accuracy report for completed plans |
| `bclaw_list_agents` | discovery | Registered agent inventory with reputation |
| `bclaw_list_instructions` | discovery | Raw or resolved instruction listing |
| `bclaw_get_capabilities` | discovery | List registered project capabilities |
| `bclaw_list_tools` | discovery | List registered project tools |
| `bclaw_search_tools` | discovery | Search tools by name or description |
| `bclaw_get_discovery` | discovery | Scan workspace for MCP configs, skills, hooks |
| `bclaw_who` | discovery | List active agent sessions on workspace |
| `bclaw_add_capability` | discovery | Register a project capability |
| `bclaw_add_tool` | discovery | Register a project tool |
| `bclaw_get_thread` | coordination | Get all messages in a thread across inboxes |
| `bclaw_delete_plan` | coordination | Delete a plan item by ID |
| `bclaw_delete_memory` | memory | Delete a memory item by ID |
| `bclaw_update_memory` | memory | Update a memory item's text or metadata |
| `bclaw_compact` | memory | LLM-driven semantic memory compaction (two-phase) |

### What a response tells you to do next (v1.19.0+)

Responses are self-teaching: rather than requiring you to memorise the API, they
carry the follow-up derived from **what actually happened**.

**`next_actions`** — an array of `{tool, args?, when?}`. Present only when there is
a genuine follow-up, so its presence is meaningful; a handler with nothing to add
omits the key entirely rather than padding it. It is derived from the outcome, not
from a static table: releasing a claim proposes something different depending on
whether the plan cascade fired or refused. Fan-out is capped at 3, with an explicit
note when more were available.

**`warning_details`** — the structured sibling of `warnings: string[]`. Each entry
carries a stable `code`, human `message`, the `data` the prose mentions, and — the
part a bare string could never hold — `next_actions` naming the way out.

```jsonc
{
  "code": "wrote_outside_claim_scope",
  "message": "Claim clm_… declared 'src/core' but 2 touched file(s) sit outside it: …",
  "data": { "claim_id": "clm_…", "scope": "src/core", "unexpected_paths": ["docs/x.md"] },
  "next_actions": [{ "tool": "bclaw_update", "args": { "entity": "claim", "…": "…" } }]
}
```

`warnings` keeps its type **and** its byte-identical historical contents, so a
consumer that ignores `warning_details` sees no change. Read `warnings` for
completeness and `warning_details` for the codes that carry a recovery path — the
structured channel is a subset, not a mirror.

Codes you may see today:

| Code | Emitted by | Meaning |
|---|---|---|
| `scope_already_claimed` | `bclaw_coordinate` | Another agent holds the scope |
| `plan_already_assigned` | `bclaw_coordinate` | A second assignment on one plan |
| `agent_validation_failed` | `bclaw_coordinate` | Target is not dispatchable |
| `wrote_outside_claim_scope` | release / assignment-completed / harvest / session-end | Files were written outside the claim's declared scope. **Advisory** — the write already happened |
| `generated_surfaces_stale` | `session-start` | Generated guidance on disk was written by an older brainclaw. Recovery is `brainclaw export --write`; no MCP tool performs it, so no `next_actions` is offered rather than one the engine would reject |

Conformity warnings are **silent on doubt** by construction: a claim whose scope is
a loop reference, free prose or a glob — 42.4% of the real corpus — yields
`unverifiable` and emits nothing. An accuser that is wrong that often teaches
agents to ignore the channel, which is worse than shipping no check at all.

### Canonical grammar (standard tier, v1.0+)

Phase 3 shipped a unified grammar that replaces the per-entity tools
listed above. All canonical verbs are in the default `standard` tier
as of v1.0. The legacy per-entity tools have been removed from the
catalog (still callable as a migration escape hatch — see the redirect
warnings they emit).

See [docs/concepts/mcp-governance.md](../concepts/mcp-governance.md)
for the stability contract and [docs/mcp-schema-changelog.md](../mcp-schema-changelog.md)
for the full 1.0.0 changelog.

#### Six CRUD verbs

| Verb | Purpose | Replaces |
|---|---|---|
| `bclaw_find(entity, filter?)` | List query (default: hides `legacy` + `auto_reflect<0.6`) | `bclaw_list_plans/candidates/claims/actions/assignments/runs` |
| `bclaw_get(entity, id)` | Fetch one by id or short_label | `bclaw_read_handoff` |
| `bclaw_create(entity, data)` | Create with auto-stamped provenance | `bclaw_create_plan/candidate` |
| `bclaw_update(entity, id, patch)` | Partial merge (updatable fields only) | `bclaw_update_plan`, `bclaw_update_memory` |
| `bclaw_remove(entity, id, purge?)` | Archive (default) or hard-delete | `bclaw_delete_memory`, `bclaw_delete_plan` |
| `bclaw_transition(entity, id, to, reason?)` | State machine transition with side-effect tags | `bclaw_accept`, `bclaw_reject`, status-update flows |
| `bclaw_move(entity, id, to_project, from_project?, force?)` | Id-preserving cross-project relocation (plan/decision/constraint/trap/handoff/sequence; execution entities rejected) | — (new in 1.11.0) |

Supported entities: plan, decision, constraint, trap, handoff,
runtime_note, candidate, sequence, claim, action, assignment, agent_run
(with assignment lifecycle now writable through `bclaw_transition` and
`bclaw_remove`; `agent_run` remains read-only). Declarative transition matrix +
updatable field list live in [src/core/entity-registry.ts](../../src/core/entity-registry.ts).

#### Sequence workflow

Sequences are in the default catalog because they are the normal path
for parallel agent work. Use the specialized sequence tools when
building lanes; the canonical grammar can still read or patch the same
entity when that is more convenient.

Sequence items use this shape:

```json
{
  "planId": "pln_xxx",
  "stepId": "stp_xxx",
  "rank": 1,
  "hard_after": [],
  "soft_after": [],
  "lane": "api",
  "scope_hint": "src/api/**",
  "rationale": "Independent API lane"
}
```

`planId` and `rank` are required. `stepId` is optional and narrows the
sequence item to a specific plan step. `hard_after` blocks readiness
until predecessor items complete; `soft_after` is advisory.

Typical MCP flow:

1. `bclaw_create_sequence({ name, status: "draft", items })`
2. `bclaw_update_sequence({ id, status: "active" })`
3. `bclaw_dispatch({ intent: "analysis" })`
4. `bclaw_dispatch({ intent: "execute", agents: [...] })`

For assignments specifically:
- `bclaw_transition(entity="assignment", id=..., to="cancelled", reason=...)` is the canonical supervisor/admin cancel path.
- `bclaw_remove(entity="assignment", id=...)` archives by cancelling the assignment.
- `bclaw_remove(entity="assignment", id=..., purge=true)` hard-deletes the assignment record.

##### `bclaw_find` filter keys

The `filter` object accepts the following keys. **Unknown keys are
rejected with `validation_error`** (pln#460) — a typo like
`{staus:'todo'}` fails fast instead of silently returning unfiltered
results.

| Key | Type | Applies to | Effect |
|---|---|---|---|
| `status` | string | all entities with a `status` field | Exact match on the entity's lifecycle status |
| `tag` | string | entities with `tags[]` | Returns items where `tags` contains the value |
| `author` | string | entities with an `author` field | Exact match |
| `plan_id` | string | handoff, candidate, runtime_note, claim, action, assignment, agent_run | Filter to items linked to a given plan |
| `source` | string (`auto` / `agent` / `human`) | candidate | Provenance source filter |
| `auto_generated` | boolean | candidate | `true` keeps only auto-generated candidates, `false` excludes them (matches `source === 'auto'` OR legacy `origin` starting with `session-end`) |
| `limit` | number (default 50) | all | Max items returned (paging) |
| `offset` | number (default 0) | all | Paging offset |
| `includeLegacy` | boolean (default false) | all | Include records with `provenance.kind='legacy'` |
| `minAutoReflectConfidence` | number 0-1 (default 0.6) | all | Threshold below which `auto_reflect` records are hidden |

Notes:
- `candidate` has an active bucket of `pending` only; accepted / rejected
  candidates are archived on transition and don't appear in `bclaw_find`.
- Combining filters intersects them (AND, not OR).
- Filters that don't apply to a given entity (e.g. `plan_id` on `plan`)
  are currently no-ops — they don't error, but they don't match either.

#### Cross-project access (pln#359)

The canonical grammar (`bclaw_find` / `bclaw_get` / `bclaw_create` /
`bclaw_update` / `bclaw_remove` / `bclaw_transition`), the read
dispatcher `bclaw_context`, and the coordination facade `bclaw_coordinate`
accept an optional `project` parameter that routes the operation to a
**linked project** instead of the current one. The CLI exposes the same
parameter as a global `--project <name>` flag.

Two link kinds are accepted:
- `cross_project_links` (sibling/peer projects in `config.yaml`, managed
  via `brainclaw link add/list/remove`).
- Workspace store-chain children (monorepo-style nested projects).

Arbitrary directory paths are rejected — adoption requires an explicit
link, which gives the user a single point of control over what an agent
can reach.

**Read / write on canonical entities (phase 1a):**

```jsonc
// Read a trap from a sibling project linked as 'brainclaw-site'
bclaw_get({ entity: 'trap', id: 'trp_795bbfb5', project: 'brainclaw-site' })

// Update a plan in the linked site repo
bclaw_update({ entity: 'plan', id: 'pln_abc', patch: { priority: 'high' }, project: 'brainclaw-site' })

// Capture context from a child project in a monorepo
bclaw_context({ kind: 'memory', project: 'web-app' })
```

Identity (`author` / `agent`) is resolved from the **source** project's
agent registry — an agent does not need to be registered in the target
to write into it. Audit log entries land in the **target** project.
Unknown project arguments throw `validation_error` with a hint listing
the configured links — no silent fallback.

**Coordinate / dispatch into a linked project (phase 1b-α):**

```jsonc
// Dispatch the brainclaw-site claude-code agent without leaving brainclaw
bclaw_coordinate({
  intent: 'assign',
  task: 'Refactor the homepage hero variant',
  scope: 'src/pages/index.astro',
  targetAgents: ['claude-code'],
  project: 'brainclaw-site',
  agent: 'claude-code',  // self-attribution from the source side
})
```

Cross-project dispatch is **inbox-only**: the target agent picks up the
brief async via its own `bclaw_work`. Auto-spawn from the source process
is force-disabled when `project` is set, because spawn cwd / worktree
semantics are tied to the target's git repo. A warning surfaces in
`FacadeResponse.warnings` so the caller knows auto-spawn was downgraded.
The same logic applies to `intent=consult|review|reroute|ideate`.

**CLI parity (phase 1c):**

```bash
# Read the linked project's plans without leaving the current dir
brainclaw --project=brainclaw-site list-plans

# Write a decision into the linked project
brainclaw --project=brainclaw-site decision "Switch hero variant to v3"

# Scoped variants: --project works on every subcommand. Mutually exclusive
# with --cwd; use one or the other.
```

#### Unified intent dispatchers

| Tool | Consolidates | Example |
|---|---|---|
| `bclaw_context(kind, since?)` | `bclaw_get_context` / `bclaw_get_execution_context` / `bclaw_get_agent_board` / `bclaw_get_agent_board_summary` + new `kind='delta'` (P6.4) | `bclaw_context({ kind: 'delta', since: 'sess_abc' })` |
| `bclaw_dispatch(intent, …)` | `bclaw_dispatch_analysis` / `bclaw_dispatch` / `bclaw_dispatch_review` | `bclaw_dispatch({ intent: 'review', openLoop: true })` |

#### Handoff correction (tombstone)

| Tool | Purpose |
|---|---|
| `bclaw_correct_handoff(originalId, text?, narrative?, tags?, reason?)` | Write a new handoff that supersedes an earlier, incorrect one. Original becomes immutable with `superseded_by` back at the correction; correction carries `supersedes`. Federation-safe (both records stay on disk). |

Use `bclaw_correct_handoff` instead of `bclaw_update_handoff` — the
latter was removed from the catalog at v1.0 (direct calls still succeed
as a migration escape hatch but emit a redirect warning).

#### Example gallery

```jsonc
// List all recent high-priority plans (legacy provenance hidden by default)
bclaw_find({ entity: 'plan', filter: { status: 'in_progress', limit: 10 } })

// Include legacy records + lower auto_reflect confidence threshold
bclaw_find({ entity: 'decision', filter: { includeLegacy: true, minAutoReflectConfidence: 0.3 } })

// Fetch a specific handoff by short_label
bclaw_get({ entity: 'handoff', id: 'hnd#42' })

// Create a decision (provenance auto-stamped as kind:user)
bclaw_create({ entity: 'decision', data: { text: 'switch to postgres', author: 'jberdah' } })

// Transition a candidate (validated against transition matrix)
bclaw_transition({ entity: 'candidate', id: 'cnd_abc', to: 'accepted' })

// Get memory delta since a previous session
bclaw_context({ kind: 'delta', since: 'sess_07c...' })

// Compact board summary (replaces bclaw_get_agent_board_summary)
bclaw_context({ kind: 'board_summary' })

// Review dispatch with structured loop
bclaw_dispatch({ intent: 'review', openLoop: true, reviewMode: 'symmetric' })

// Open a single-agent ideation loop. Proposal is manual; critique, revision and
// synthesis are worker phases available through trusted turn(dispatch:true).
bclaw_coordinate({ intent: 'ideate', task: 'Should we extract the dispatcher into a separate package?' })

// Multi-agent ideation: critic gets a context-filtered, BM25-ranked brief auto-dispatched
bclaw_coordinate({
  intent: 'ideate',
  task: 'Should we adopt approach A or approach B?',
  targetAgents: ['codex'],
})

// Open a direct implementation loop. The caller owns subsequent bind/turn
// actions, which is why allow_orphan is explicit. Bind is engine-only; after
// it advances to execute, turn(dispatch:true) is the worker launch path.
bclaw_loop({
  intent: 'open',
  kind: 'implementation',
  title: 'Implement the extracted dispatcher',
  allow_orphan: true,
  linked: { plan_ids: ['pln_abc'], sequence_ids: ['seq_abc'] },
  verify: { command: ['npm', 'test'] },
})

bclaw_loop({ intent: 'bind', loop_id: 'lop_abc' })
bclaw_loop({
  intent: 'turn', loop_id: 'lop_abc', slot_id: 'lsl_worker',
  dispatch: true, target_agents: ['codex', 'claude-code'],
})

// Direct research/debug loops use the same facade. A plain turn records state;
// trusted dispatch:true actually prepares, fences and launches a worker.
bclaw_loop({
  intent: 'open',
  kind: 'research',
  title: 'Determine the safe migration boundary',
  goal: 'Produce a sourced synthesis',
  allow_orphan: true,
})
bclaw_loop({
  intent: 'turn',
  loop_id: 'lop_research',
  slot_id: 'lsl_investigator',
  dispatch: true,
  target_agents: ['codex', 'claude-code'], // only used when the slot is unbound
})

bclaw_loop({
  intent: 'open',
  kind: 'debug',
  title: 'Reproduce and fix the Windows dispatch failure',
  allow_orphan: true,
})
bclaw_loop({ intent: 'turn', loop_id: 'lop_debug', slot_id: 'lsl_reproducer', dispatch: true })

// Fence a stale physical generation without changing the logical turn or Assignment.
// This arms the successor; dispatch the same turn afterwards to contend on launch.
bclaw_loop({
  intent: 'takeover',
  loop_id: 'lop_abc',
  slot_id: 'lsl_abc',
  turn_id: 'tat_abc',
  expected_epoch: 0,
  cause: 'heartbeat and process evidence are stale',
  liveness_evidence: 'no heartbeat for 30m; wrapper exited',
  external_effect_policy: 'idempotent',
  next_workspace_path: 'C:\\worktrees\\brainclaw-retry-1',
  agent: 'coordinator',
})

// Correct a handoff instead of mutating it
bclaw_correct_handoff({ originalId: 'hnd_xyz', reason: 'wrong contract', text: '...' })
```

For the full ideation loop design (phases, context filters, iteration block,
advance gate, brief assembly, single vs multi-agent UX), see
[docs/concepts/ideation-loop.md](../concepts/ideation-loop.md). The underlying
engine supports the five built-in `review`, `ideation`, `implementation`,
`research`, and `debug` workflows, plus cross-cutting `request_input` /
`provide_input`; see [docs/concepts/loop-engine.md](../concepts/loop-engine.md).
Takeover is likewise cross-cutting, not review-specific. Once a turn has an
AttemptAuthority v2 generation chain, terminal evidence must echo the complete
`assignment_id`, `turn_id`, `attempt_epoch`, `run_id`, `nonce`,
`execution_contract_hash`, and `workspace_digest` fence; a stale generation is
retained for audit but cannot converge loop state. See
[docs/concepts/attempt-authority.md](../concepts/attempt-authority.md).

#### Deprecation status

The v1.0-removed legacy tools named in the changelog emit a
deprecation warning server-side on each direct call. The warning names
the canonical replacement. Warnings fired during the 0.8.x window. As
of v1.0 those tools are removed from every `tools/list` catalog,
including `{ catalog: "all" }`, but direct calls still succeed as a
migration escape hatch and keep emitting redirect warnings.

## When To Use MCP Versus Other Surfaces

| Need | Best surface |
|---|---|
| Fresh path-scoped context | MCP |
| Current plans, claims, board state | MCP |
| Runtime writes with session continuity | MCP |
| Local behavioral reminders inside the agent UI | native agent files |
| Human inspection or scripting | CLI |
| Simple readable fallback | `.brainclaw/project.md` (derived view, may be stale) |

## Starting The Server

```bash
brainclaw mcp
```

In practice, most agents pick this up through generated MCP config such as `.mcp.json`, `~/.cursor/mcp.json`, or other agent-specific config files written by `brainclaw setup`, `brainclaw init`, or `brainclaw export`.

By default, installable update checks use the public npm channel `brainclaw@latest`. Projects that need a different channel can override `brainclaw_update_source`, for example with `type: npm` and `dist_tag: prelaunch`, or with `type: local-pack` for local tarball workflows.

## Bootstrap Through MCP

For agent-first onboarding, `bclaw_bootstrap` is the nominal path:

1. call `bclaw_bootstrap` to get the current `import_plan` and adaptive interview questions
2. collect answers in the agent surface
3. call `bclaw_bootstrap` again with `interviewAnswers` to preview confirmed `decision`, `constraint`, `instruction`, or `trap` suggestions
4. call `bclaw_bootstrap` with `apply: true` to create canonical memory
5. call `bclaw_bootstrap` with `uninstall: true` to revert the last bootstrap-managed import

Interview answers are keyed by question ID and may contain:

- `response_text`
- `response_items`
- `response_boolean`
- optional explicit `suggestions` when the agent wants to confirm exact canonical memory items

## Mutation Safety

The MCP server serializes all mutations through a single-writer queue (`McpTaskRunner`). When an agent calls a write tool (e.g. `bclaw_claim`, `bclaw_write_note`, `bclaw_create({ entity: "plan", ... })`), the request is enqueued and executed one at a time. This guarantees:

- no concurrent writes from the same MCP connection
- no partial state from interleaved mutations
- deterministic ordering of operations

A secondary file-based lock (`mutate()`) provides cross-process safety in case CLI commands run alongside MCP. But for agents, MCP is the safe path by design — no extra precautions needed.

## Important Rule

If the agent has MCP available, do not treat the CLI as the primary runtime interface. All agent mutations MUST go through MCP tools.

The CLI remains valuable for:

- setup and initialization
- bootstrap by a human operator
- scripting and automation
- release and packaging
- debugging and fallback access

But for capable agents, MCP is the first-class path for both reads and writes.
