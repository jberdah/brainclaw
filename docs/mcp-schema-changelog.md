# brainclaw MCP Schema Changelog

This document tracks all breaking and notable changes to the brainclaw MCP server protocol.

See [docs/concepts/mcp-governance.md](concepts/mcp-governance.md) for the
versioning rules, breaking-change policy, deprecation window, and tier
guarantees this changelog follows.

---

## Unreleased

**Removed — `bclaw_list_agents` (pln#625; migrate to `bclaw_find(entity='agent')`)**
- `bclaw_list_agents` — the last surviving `bclaw_list_*` tool — is retired into
  `REMOVED_IN_V1_TOOLS`: hidden from every `tools/list`, with a direct-call
  deprecation warning pointing at `bclaw_find(entity='agent')`. The handler
  stays as a redacted read escape-hatch (`LEGACY_READ_TOOL_HANDLERS`), same as
  its `list_*` siblings.
- To preserve its one unique capability, `bclaw_find(entity='agent')` gains an
  agent-only `includeReputation` filter that attaches the public reputation
  summary per agent (same join the CLI `list-agents --with-reputation` uses).
- Net surface coherence: `agent` reads now flow through one grammar path with a
  single redacted projection (`projectAgentForRead`), closing the divergent
  double-surface (the old tool leaked raw `identity_key`/`invoke.env`).

**Changed — governance guard now covers grammar entities AND the filter contract (pln#625)**
- `tests/unit/mcp-governance.test.ts` folds two free-form parts of the callable
  contract into the public-surface fingerprint: the set of addressable grammar
  entities (`ENTITY_NAMES`) and the find/get filter grammar
  (`GRAMMAR_FILTER_CONTRACT` — accepted keys, entity-scoping, constrained
  values). Both were previously invisible (the `entity` and `filter` args are
  free-form and their enumerating descriptions are stripped), so wiring a new
  `bclaw_find/get(entity='…')` target or adding/re-scoping/re-valuing a filter
  key (e.g. the Phase 2c `scope`) could ship without a changelog entry.
- `GRAMMAR_FILTER_CONTRACT` (exported from `entity-operations.ts`) is now the
  single source of truth for the handler's filter validation AND the
  fingerprint, so the two can never drift. A mutation test proves the
  fingerprint reacts to an added entity, key, re-scope, and new value.
- Closes the blind spot surfaced by the Phase 2c ideation loop; the filter-grammar
  extension came from the Codex review of PR #82.

**Added — read-only `agent` entity in the canonical grammar (pln#625 Phase 2c)**
- `bclaw_find/get(entity='agent')` are now wired. They return a REDACTED,
  read-only projection: `id`, `name`, `kind`, `trust_level`, `capabilities`,
  `fingerprint` (full sha256(PEM) — the public canonical key id), `model`,
  `context_profile`, `created_at`. The private key material (`identity_key`,
  `public_key` PEM) and `invoke` (unpopulated dead field; would leak
  `invoke.command`) are never surfaced. Writes (`create/update/remove/transition`)
  return the `SystemManagedError` boundary — agents are managed via
  `bclaw_setup` / `enable-agent`, not the grammar.
- New agent-only filter `scope`: `bclaw_find(entity='agent')` defaults to the
  current project's registry; `filter.scope='global'` additionally unions the
  static dispatchable catalog (`getSpawnableAgents`) and annotates each entry
  with `dispatchable` (canBeSpawnedCli) + `registered`. `scope` is rejected for
  any other entity, and its value must be `project` (default) or `global`.
- `bclaw_list_agents` now redacts through the SAME projection (one source of
  truth). It previously spread the raw identity document, leaking
  `identity_key.public_key` and `invoke.env` in the clear — a pre-existing
  disclosure, now closed. `includeReputation` still attaches the reputation
  add-on.
- This supersedes the Phase 1a stopgap that reported `agent` as "not addressable
  via the canonical grammar" (never released; last tag v1.15.0).

**Fixed — `bclaw_transition(entity='handoff')` wired (pln#625 Phase 2a)**
- The handoff lifecycle (`open→accepted|closed`, `accepted→closed`) is now
  wired. It previously fell to the "not yet wired" default, which also broke
  `brainclaw stale resolve <handoff-id>` (that command routes through the
  canonical transition). A tip guard refuses to transition a handoff carrying
  `superseded_by` (an immutable correction tombstone) and points at the tip.
- No tool was added, removed, or renamed; no required argument changed.

**Fixed — `bclaw_coordinate` published-schema parity (pln#622 PR0b)**
- The published inputSchema of `bclaw_coordinate` now declares `preset`
  (loop preset selector, valid only with `intent='ideate'`; v1 ships the
  single preset `bootstrap`; unknown names are rejected with
  `unknown_preset`, other intents with `preset_kind_mismatch`) and
  `client_request_id` (caller-minted ULID/UUIDv7 for idempotent retries,
  observed on `intent='review'` + `open_loop=true`, safe elsewhere). Both
  were already accepted by `CoordinateRequestSchema` and used by the
  handler — and `next_actions` literally recommended
  `bclaw_coordinate(intent='ideate', preset='bootstrap')` — but the catalog
  never declared them, so strict MCP clients could not follow the product's
  own recommendation.
- New guard: `tests/unit/mcp-facade-structural-parity.test.ts` asserts
  bidirectional structural parity (keys + shared enum values) between the
  hand-written facade schemas (`bclaw_work`, `bclaw_coordinate`) and their
  zod sources, with an explicit allowlist for adapter-envelope fields
  (`agent`, `agentId`).
- No tool was added, removed, or renamed; no required argument changed.
- Surface fingerprint bumped in the `(current)` section below.

**Changed — MCP model selection parity (pln#520/#606)**
- `bclaw_dispatch` and `bclaw_coordinate` gain an optional `model` string that
  selects the spawned worker's model (e.g. `sonnet`, `gpt-5-codex`), decoupled
  from agent identity — closing the CLI/MCP gap (the CLI `dispatch run --model`
  already existed). Injected only for agents that declare a `model_flag`
  (claude-code / codex / github-copilot); no-op otherwise, and consistent with
  the dispatcher's resolveModel chain.
- No tool was removed or renamed; no required argument changed.
- Surface fingerprint bumped in the `(current)` section below.

**Added — `bclaw_move` cross-project relocation (pln#595)**
- New canonical-grammar verb `bclaw_move(entity, id, to_project, from_project?, force?)`:
  relocates a brainclaw item to another project in a multi-project workspace,
  PRESERVING its id. Relocatable: plan, decision, constraint, trap, handoff,
  sequence. Execution-local entities (claim, assignment, agent_run, session) are
  rejected. Refuses id collisions / active-claim moves (unless force); audits both
  stores. Additive — no tool removed or renamed.

**Changed — Code Map monorepo cascade (DGX Finding 2)**
- `bclaw_code_refresh` gains an optional `cascade: boolean`. In a
  `project_mode: multi-project` workspace it refreshes every nested
  brainclaw project into its own store + a child-scoped root store
  (zero double-indexing). No-op outside a multi-project workspace.
- `bclaw_code_status` gains an optional `cascade: boolean` that adds a
  per-child store-presence / freshness recap.
- No tool was removed or renamed; no required argument changed.
- Surface fingerprint bumped in the `(current)` section below.

**Changed — agent-UX read-path surface (pln#542)**
- `bclaw_work`, `bclaw_context`, `bclaw_find`, `bclaw_get`, `bclaw_search`
  gain an optional `budget_tokens` argument (relevance-ranked fill).
- `bclaw_work` compact payload now includes a trimmed `context_diff`
  (event-cursor sourced, all intents) and facade responses carry
  `next_actions` affordances.
- `bclaw_quick_capture` gains an optional caller-asserted `type` argument;
  contradiction detection is advisory metadata (no longer blocks promotion).
- No tool was removed or renamed; no required argument changed.
- MCP public surface fingerprint: `sha256:eaa8865070b10401`

**Changed — JSON Schema generation shift (pln#486, zod 4 migration)**
- Migration from zod 3.24 → 4.3.6 changes the introspection output that
  feeds `tools/list`. Schemas are semantically equivalent but the emitted
  JSON differs in incidental shape (key order, optional-property
  encoding). MCP clients that snapshot or hash schemas should re-pin.
- Public surface fingerprint moves from `sha256:a479f710ff043ef6` (zod 3)
  to `sha256:860fbaa30a486093` (zod 4). No tool was added, removed,
  renamed, or had its required arguments change.

**Changed — `bclaw_loop(intent: 'open')` anti-pattern gate (pln#461)**
- New optional field `allow_orphan: boolean` on `BclawLoopOpenSchema`.
- Default (absent / `false`) — handler rejects with `validation_error`
  and points to `bclaw_coordinate(intent: 'review', open_loop: true)`
  as the recommended path. Prevents the "loop opened without
  dispatch → no claim, no inbox, no agent picks it up" trap called
  out in `CLAUDE.md`.
- `allow_orphan: true` — explicit acknowledgement that the caller
  will drive `turn()` + dispatch manually (advanced / test use only).
- Internal callers (`bclaw_coordinate`, `bclaw_dispatch`) are not
  affected — they bypass `handleBclawLoop` and invoke the core
  `openLoop()` directly.

**Changed — sequence tools promoted to default discovery (pln#522)**
- `bclaw_list_sequences`, `bclaw_create_sequence`,
  `bclaw_update_sequence`, and `bclaw_delete_sequence` move from
  `advanced` to `standard`, so fresh agents see them in the default
  `tools/list` catalog. Sequences are a core agent-first coordination
  primitive for parallel dispatch, not an advanced-only admin surface.
- `bclaw_create_sequence.items` and `bclaw_update_sequence.items` now
  expose the full item shape in JSON Schema: `planId`, optional
  `stepId`, `rank`, `hard_after`, `soft_after`, `lane`, `scope_hint`,
  and `rationale`.

---

## 1.0.0 (current)

**Public launch candidate.** Phase 3 slice 3i of `pln_c6472192`.
Completes the canonical grammar refactor: canonical verbs promoted to
the default `standard` tier, legacy per-entity tools removed from the
discoverable surface.

**Changed — tier promotion**
All canonical verbs land in the default `standard` catalog:
- `bclaw_find`, `bclaw_get`, `bclaw_create`, `bclaw_update`,
  `bclaw_remove`, `bclaw_transition`
- `bclaw_context(kind)` — memory / execution / board / board_summary / delta
- `bclaw_dispatch(intent)` — analysis / execute / review
- `bclaw_correct_handoff` — P6.1 tombstone for handoff corrections

**Breaking — legacy per-entity tools removed from the catalog**
The following tools are no longer returned by `tools/list` default or
`catalog: "standard"`. They were marked deprecated throughout the
0.8.x window. Replacement is named in parentheses:

- `bclaw_list_plans` (→ `bclaw_find(entity: "plan")`)
- `bclaw_list_candidates` (→ `bclaw_find(entity: "candidate")`)
- `bclaw_list_claims` (→ `bclaw_find(entity: "claim")`)
- `bclaw_list_actions` (→ `bclaw_find(entity: "action")`)
- `bclaw_list_assignments` (→ `bclaw_find(entity: "assignment")`)
- `bclaw_list_runs` (→ `bclaw_find(entity: "agent_run")`)
- `bclaw_read_handoff` (→ `bclaw_get(entity: "handoff", id)`)
- `bclaw_create_plan` / `bclaw_create_candidate` (→ `bclaw_create`)
- `bclaw_update_plan` (→ `bclaw_update` + `bclaw_transition`)
- `bclaw_accept` / `bclaw_reject` (→ `bclaw_transition(entity: "candidate")`)
- `bclaw_get_execution_context` / `bclaw_get_agent_board` /
  `bclaw_get_agent_board_summary` (→ `bclaw_context(kind)`)
- `bclaw_dispatch_analysis` / `bclaw_dispatch_review` (→ `bclaw_dispatch(intent)`)
- `bclaw_update_handoff` (→ `bclaw_correct_handoff` — P6.1 tombstone)

The tool *handlers* remain in place for now as defensive code — a
direct call by a non-MCP-compliant caller that bypasses `tools/list`
will still succeed. A follow-up PR will strip the dead handler code.

**Changed — versions**
- `SCHEMA_VERSION` bump: `0.8.0 → 1.0.0`
- `package.json` bump: `0.63.0 → 1.0.0`

**Changed — governance guard**
- `tests/unit/mcp-governance.test.ts` now checks that the current
  changelog records the published MCP surface fingerprint. When a tool
  name, tier, category, or input schema changes, the test fails until
  this section is updated.
- MCP public surface fingerprint: `sha256:468f0103414e97e8`
  (updated 2026-07-18 for pln#625 PR #83 + Codex review: `bclaw_list_agents`
  retired and `bclaw_find(entity='agent')` gains `includeReputation` — now typed
  as a boolean in `GRAMMAR_FILTER_CONTRACT.booleanKeys` and validated at the MCP
  front door, so a non-boolean value is rejected instead of silently coercing to
  a no-op. The added boolean-type declaration moves the fingerprint.)
  Previous: `sha256:be0df1e4cc33936f`
  (updated 2026-07-17 for pln#625 PR #83: `bclaw_list_agents` retired from the
  published surface — migrated to `bclaw_find(entity='agent')` which gains an
  agent-only `includeReputation` filter. Both the removed tool and the new
  filter key move the fingerprint via the guard now covering PUBLISHED_TOOLS +
  ENTITY_NAMES + GRAMMAR_FILTER_CONTRACT.)
  Previous: `sha256:e12fd2f34dae1ac0`
  (updated 2026-07-17 for pln#625 Phase 2c + PR #82: the fingerprint now folds in
  two parts of the callable contract that the tool inputSchema cannot express —
  the set of grammar-addressable entities (`ENTITY_NAMES`) and the find/get
  filter grammar (`GRAMMAR_FILTER_CONTRACT`: accepted keys, entity-scoping, and
  constrained values such as `scope=project|global`). Both were invisible to the
  fingerprint before (`entity` and `filter` are free-form and their enumerating
  descriptions are stripped), so wiring a new addressable entity — or adding /
  re-scoping / re-valuing a filter key like the Phase 2c `scope` — slipped past
  this guard. Additive: no tool added, removed, or renamed.)
  Previous: `sha256:45c02576aff36244`
  (updated 2026-07-15 for pln#622 PR0b: `preset` and `client_request_id` added
  to the published `bclaw_coordinate` input schema. Both were already accepted
  by `CoordinateRequestSchema` and used by the handler — and `next_actions`
  recommended `bclaw_coordinate(intent='ideate', preset='bootstrap')` — but
  the catalog never declared them. Additive: no tool added, removed, or
  renamed; no required argument changed.
  Previous: `sha256:b53eb56d4391b5a6`
  updated 2026-07-15 for pln#520/#606: optional `model` string added to
  `bclaw_dispatch` and `bclaw_coordinate` input schemas — selects the spawned
  worker's model, decoupled from agent identity (CLI/MCP parity with
  `dispatch run --model`). Additive: no tool added, removed, or renamed; no
  required argument changed.
  Previous: `sha256:2b0dfbd62acd71b7`
  updated 2026-07-04 for trp#928: explicit `coordinator_override` boolean added
  to `bclaw_release_claim` and `bclaw_transition` input schemas — the coordinator
  path to release/stale a non-owned claim is now opt-in and audited rather than
  auto-derived from trust level. Additive: no tool added, removed, or renamed; no
  required argument changed. Previous: `sha256:188d2eba8828e4fe`
  updated 2026-06-24 for 1.11.0: `bclaw_move` added (pln#595) AND a `cascade`
  boolean added to `bclaw_code_refresh` / `bclaw_code_status` (DGX Finding 2).
  Additive: one new tool; nothing removed or renamed; no required argument changed.
  Supersedes the per-branch interim hashes sha256:dffcc868ae90e013 and
  sha256:41eb6d55010cdfb5.)
  Previous: `sha256:35fd83b0d124df94`,
  updated 2026-06-20 for 1.10.0: Code Map tools added to the published surface —
  `bclaw_code_find`, `bclaw_code_brief`, `bclaw_code_refresh`, `bclaw_code_status`.
  Additive: no tool removed or renamed.
  Previous: `sha256:70cf80b9615f631f`,
  updated 2026-06-18 for 1.9.1: monorepo project-scoping fix — session-aware
  effective-cwd resolution and read-path project scoping shift the published
  input-schema surface. Additive: no tool added, removed, or renamed.
  Previous: `sha256:b1d3c6a00a224509`,
  updated 2026-06-14: journal ON by default + `migrate --enable-journal`,
  registry post-image families + verify gate, and capped auto-handoff diff
  preview on `bclaw_get`; pln#567/#568/#569.
  Previous: `sha256:21fa9544977a3754`,
  updated 2026-06-11b: observability surfaces — composite
  `attention_required` in board_summary, observer-mode read flags,
  `bootstrap_verdict` in FacadeResponse; pln#557/#558/#559.
  Previous: `sha256:8f86d3998f8a24e3`,
  updated 2026-06-11: uninitialized setup mode — the server now boots with
  a minimal catalog on a missing project store instead of exit(1), and the
  empty-memory decision rule is surfaced in setup/work hints; pln#556.
  Previous: `sha256:eaa8865070b10401`,
  updated 2026-06-10: agent-UX read-path surface — `budget_tokens` on the
  read tools, `context_diff`/`next_actions` in facade payloads,
  caller-asserted `type` on quick_capture; see the Unreleased entry, pln#542.
  Previous: `sha256:333be7c3cda7e166`,
  updated 2026-06-09: added the `preflight` boolean to the bclaw_coordinate
  inputSchema — pln#533, the pre-flight spawn validation for open_loop reviews
  (run one trivial validation spawn per reviewer before opening the loop so an
  environment death surfaces with a clear reason instead of a generic timeout).
  Prior value `sha256:a1881ff57ddce377` added the `ref` property to the
  bclaw_coordinate inputSchema (2026-05-27, pln#520 Tier 2 / trp#371, the
  scope-aware dirty guard; `ref` lets a dispatch build its worktree from an
  explicit git ref). `sha256:0a4ba280aeff142b` exposed `allow_dirty` in the
  bclaw_coordinate inputSchema. `sha256:e88c1a97fc29cfd1` came from the
  pln#520 LoopPhase/LoopSlotInput schema resync, which itself reconciled
  earlier unrecorded drift from `sha256:724085642dc3e2d7`.)

See `docs/integrations/mcp.md` for the full canonical surface + an
example gallery per verb. See `docs/concepts/mcp-governance.md` for
the stability contract now that v1.0 has shipped.

---

## 0.8.0

Phase 3 canonical grammar slices shipped under `pln_c6472192` (slices
3a–3g). Every addition is behind `catalog: "all"` until the v1.0 cut
(slice 3i) promotes the new verbs to the default catalog and removes
the deprecated surface.

**Added (canonical CRUD verbs)**
- `bclaw_find(entity, filter?)` — list query with default provenance
  filter (excludes `legacy` + `auto_reflect < 0.6`; override via
  `filter.includeLegacy` / `filter.minAutoReflectConfidence`).
- `bclaw_get(entity, id)` — fetch by id or short_label.
- `bclaw_create(entity, data)` — auto-stamps provenance (kind: user
  by default).
- `bclaw_update(entity, id, patch)` — rejects non-updatable fields
  per EntityRegistry.
- `bclaw_remove(entity, id, purge?)` — archive (default) or purge.
- `bclaw_transition(entity, id, to, reason?)` — validated against
  declarative transition matrix; returns side-effect tags.

**Added (unified intent dispatchers)**
- `bclaw_context(kind)` — unifies `bclaw_get_context` /
  `_execution_context` / `_agent_board` / `_agent_board_summary`.
  Adds `kind: "delta", since: <session_id>` for memory diffs (P6.4).
- `bclaw_dispatch(intent)` — intent discriminator over the existing
  bclaw_dispatch tool. `analysis` / `execute` (default, legacy) /
  `review` (with openLoop + reviewMode).
- `bclaw_correct_handoff(originalId, ...)` — P6.1 tombstone pattern.
  Writes a correction handoff with `supersedes` / `superseded_by`
  pointers; refuses to supersede already-superseded or closed
  handoffs.

**Added (schema)**
- `Provenance` discriminated union: agent / auto_reflect / user /
  loop_artifact / federation / correction / legacy. Exported from
  `src/core/schema.ts`. Stamped on creates; federation-safe.
- `Handoff.superseded_by` and `Handoff.supersedes` — P6.1 tombstone
  pointers, optional passthrough.

**Deprecated (19 tools)**
All redirects are non-breaking (old tools still work until slice 3i
removal). Warnings surface on every call through the
`executeMcpToolCall` exit wrapper:
- `bclaw_list_plans/candidates/claims/actions/assignments/runs` →
  `bclaw_find(entity, filter)`
- `bclaw_read_handoff` → `bclaw_get(entity: "handoff", id)`
- `bclaw_create_plan/candidate` → `bclaw_create`
- `bclaw_update_plan` → `bclaw_update` / `bclaw_transition`
- `bclaw_accept/reject` → `bclaw_transition(entity: "candidate")`
- `bclaw_get_execution_context/_agent_board/_agent_board_summary` →
  `bclaw_context(kind)`
- `bclaw_dispatch_analysis/_review` → `bclaw_dispatch(intent)`
- `bclaw_update_handoff` → `bclaw_correct_handoff` (P6.1)

---

## 0.7.0

Shipped in brainclaw app `0.63.0`. Consolidates the surface listed
below — previously accumulating under an inaccurate `SCHEMA_VERSION = '0.6.0'`
constant — and brings the runtime value in line with the documented
state. Governance cross-check now passes (see governance doc).

**Added (this landing)**
- `bclaw_doctor --after-migration` — post-v1-upgrade health check
  reporting one finding per invariant (provenance coverage, handoff
  review-strip, candidate archive, schema-version marker). Exits
  non-zero on any failure.
- `brainclaw upgrade --to=1.0` — one-shot v1 schema migration
  covering candidate archive (P6.6), handoff review-strip (P6.1
  groundwork), provenance rollout (P6.3), schema-version bump
  (0.6.0 → 0.8.0 in the store marker). Plus `--backup` /
  `--no-backup` / `--rollback` flags.
- `provenance` optional passthrough field on Decision, Constraint,
  Trap, Handoff, RuntimeNote — discriminated-union typing lands in
  Phase 3 (`pln_c6472192 / 3f`). The declaration lets migration
  patches stamp `{ kind: 'legacy' }` without Zod stripping it on
  persist.

**Added (previously unreleased 0.7.0 surface)**
- `bclaw_check_policy` — pre-execution governance check for a scope
  - Input: `scope` (required), `agent`, `agentId`, `action`
  - Returns `allowed` boolean, `blocks[]` (hard stops), `warnings[]` (context)
  - Checks: claim active, claim conflict, constraint matching, trap matching
  - Returns `governance_context` with active instructions count, matching items
- `bclaw_audit` now supports `governance: true` parameter
  - Returns aggregated posture report instead of chronological log
  - Includes: constitution (global instructions), red lines (constraints by category), claims by agent, open traps by severity, mutations without claim, recommendations
  - Supports `scope` filter for governance mode
- `bclaw_claim` response now includes automatic policy warnings
  - Constraints and traps matching the claimed scope are surfaced as warnings
  - No extra call needed — governance context is provided at claim time
- Enriched `AuditEntry` fields: `scope`, `session_id`, `host_id`
  - Claim/release entries include the scope being claimed
  - Session start/end entries include session and host IDs
  - `promote_direct` and `trust_change` actions now propagated to events.jsonl

**Changed**
- MCP schema version bumped to 0.7.0
- Governance report filters machine/private traps — only shared-visibility traps affect project posture
- Audit chronological mode now shows `scope` field for claim actions

---

## 0.6.0

**Added**
- `bclaw_get_capabilities` — list all registered project capabilities with optional filtering by category
  - Returns array of capabilities with id, name, category, and tags
  - Supports category filtering parameter
- `bclaw_list_tools` — list all registered project tools with optional filtering by type
  - Returns array of tools with id, name, type, and tags
  - Supports type and tag filtering parameters
- `bclaw_search_tools` — full-text search across project tools
  - Filters by query string, type, and tags
  - Returns matching tools with detailed metadata
- Enhanced `bclaw_get_context` to include metadata discovery:
  - New `available_capabilities` field in structured content (array of capability objects)
  - New `available_tools` field in structured content (array of tool objects)
  - Suggestions section in text output showing relevant capabilities and tools (up to 5 each)
- Support for `category` and `outcome` fields in `bclaw_create_candidate`:
  - Constraints can now have a category: architecture, performance, security, reliability, compatibility, process, other
  - Decisions can now have an outcome: approved, rejected, deferred, pending
- Doctor check `metadata_consistency` — validates capability and tool completeness
- `bclaw_bootstrap` now returns adaptive interview prompts alongside the import proposal when bootstrap confidence is incomplete
  - `structuredContent.import_plan.interview` exposes `summary`, `question_count`, and audience-tagged questions
  - Questions can be targeted to `cli`, `ide_chat`, or `any`
  - Interview questions now expose stable IDs and `target_hints`
  - `structuredContent.onboarding_mode` distinguishes `empty_workspace`, `existing_documented`, and `existing_sparse`
  - `structuredContent.import_plan.confirmed_suggestion_count` reports how many suggestions were confirmed by interview answers
- `bclaw_bootstrap` now accepts `interviewAnswers`, `apply`, `uninstall`, `audience`, and `interview`
  - capable agents can preview confirmed selective imports through MCP before applying them
  - bootstrap apply/uninstall now covers selective canonical memory imports beyond instructions

**Changed**
- MCP schema version bumped to 0.6.0 to reflect new metadata discovery capabilities

---

## 0.5.0

**Added**
- `bclaw_delete_memory` — delete a constraint, decision, or trap by ID (trusted trust required)
  - Searches across store chain to locate item
  - Supports deletion from any store level (local, repo, workspace, user)
  - Returns `deleted_id`, `item_type`, `store_level` in response
- `bclaw_update_memory` — update text/tags or move an item to a different store level (trusted trust required)
  - Supports updating constraint, decision, or trap in-place
  - `moveToStore` parameter enables moving items between levels (local → repo → workspace → user)
  - Returns `updated_id`, `item_type`, `previous_store`, `new_store` in response
- Doctor checks `scope_hygiene` and `cross_level_duplicates` — warn about machine-level items at project scope and potential duplicates across store levels

**Changed**
- `bclaw_get_context` and related tools now properly merge instructions from parent stores in the chain

---

## 0.4.0

**Added**
- `bclaw_create_plan` — create a plan item from an agent (contributor trust required)
- `bclaw_update_plan` — update status, actual effort, priority, or assignee of a plan item
- `bclaw_add_step` — add a sub-step to a plan item
- `bclaw_complete_step` — mark a plan sub-step as done
- All plan management tools return structured `plan_id`, `step_id`, `status`, `progress` fields

**Fixed**
- `bclaw_release_claim`: `planStatus` parameter was declared in the schema but not applied — now correctly updates the linked plan's status when provided

---

## 0.3.0

**Added**
- `initialize` handshake support (MCP protocol conformance)
- `schema_version: "0.3.0"` field in all `structuredContent` responses
- Write tools: `bclaw_write_note`, `bclaw_create_candidate`, `bclaw_accept`, `bclaw_reject`, `bclaw_claim`, `bclaw_release_claim`, `bclaw_session_start`, `bclaw_session_end`
- `bclaw_search` tool — full-text BM25 search across all memory items
- Trust-level access control on write tools (contributor / trusted / curator)
- `context_schema` field in `bclaw_get_context` structured responses
- Explicit identity arguments on mutation tools:
  - `agentId` on `bclaw_write_note`, `bclaw_create_candidate`, `bclaw_claim`, `bclaw_session_start`, `bclaw_session_end`
  - `byId` on `bclaw_accept`, `bclaw_reject`
- Stable MCP tool errors:
  - `identity_error`
  - `trust_error`
  - `validation_error`

**Changed**
- All read tool responses now include `schema_version` in `structuredContent`
- `bclaw_get_context` `structuredContent` flattens the full `ContextResult` object
- `bclaw_get_context` now exposes `context_schema: "1.2"` and additive fields from the current public context contract
- Mutation tools now require a registered identity on write paths; `agent`/`agentId` and `by`/`byId` must resolve to the same registered identity when both are provided
- `bclaw_reject` is now restricted to `trusted` / `curator` agents, aligned with `bclaw_accept`

---

## 0.2.0

**Added**
- `bclaw_get_agent_board` read tool
- `bclaw_read_handoff` read tool
- Tool prefix renamed: `tmem_` → `bclaw_`

**Changed**
- Environment variables renamed: `TEAM_MEMORY_*` → `BRAINCLAW_*`
- Storage directory renamed: `.memory/` → `.brainclaw/`

---

## 0.1.0

**Initial**
- `bclaw_get_context` read tool (was `tmem_get_context`)
- Basic stdio NDJSON transport
