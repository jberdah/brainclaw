# brainclaw MCP Schema Changelog

This document tracks all breaking and notable changes to the brainclaw MCP server protocol.

See [docs/concepts/mcp-governance.md](concepts/mcp-governance.md) for the
versioning rules, breaking-change policy, deprecation window, and tier
guarantees this changelog follows.

---

## 0.7.0 (current)

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
