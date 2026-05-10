# brainclaw MCP Schema Changelog

This document tracks all breaking and notable changes to the brainclaw MCP server protocol.

See [docs/concepts/mcp-governance.md](concepts/mcp-governance.md) for the
versioning rules, breaking-change policy, deprecation window, and tier
guarantees this changelog follows.

---

## Unreleased

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
- MCP public surface fingerprint: `sha256:92979717f0e10376`

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
