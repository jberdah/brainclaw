# Audience: AI Builders

Design constraints for agents developing brainclaw features that serve agent integrators, tool builders, and enterprise AI governance teams.

## Profiles

### Agent Integrators
Developers building new coding agents, CLI wrappers, or AI-powered tools who want to leverage brainclaw's memory and coordination instead of building their own.

### Enterprise AI Governance
IT and compliance teams who manage organizational policies across many AI agents on developer desktops. They need transparency, auditability, and control.

## Design Constraints

These rules apply to any feature that touches this audience:

1. **MCP is the integration contract.** External tools integrate through MCP (~60 published tools today; the canonical grammar — `bclaw_work`, `bclaw_context`, `bclaw_find/get/create/update/remove/transition` plus the multi-agent facades — is the stable surface), not by reading `.brainclaw/` files directly. The file-based store is an internal implementation detail. If an integration need cannot be met through MCP, the gap is a bug, not a reason to expose internals.

2. **The MCP schema is a public API.** Breaking changes to tool signatures, context format, or response shapes require versioning and changelog entries (`docs/context-format-changelog.md`, `docs/mcp-schema-changelog.md`). Integrators depend on stability — every schema change has downstream cost. The context schema is versioned (`context_schema` field in every response).

3. **Agent capability profiles must be factual.** The 3-tier system (A/B/C) in `agent-capability.ts` defines per-agent: MCP support, hooks, auto-approve, skills, instruction file path, invoke templates, role capabilities (execute/coordinate/review/consult), and delivery methods (inline_arg, temp_file, stdin_pipe, inbox_structured). Profiles can degrade at runtime (`agent-integrations.ts` assesses declared vs present surfaces) — Tier A can drop to B if hooks are missing, B to C if MCP is absent.

4. **Security boundaries are non-negotiable.** brainclaw operates in the user's local filesystem. It must never expose file contents, memory, or coordination state beyond the project scope. Cross-project leakage is a security bug. The policy system (`bclaw_check_policy`) enforces boundaries with glob-based scope matching. `bclaw_check_security` provides supply chain risk scoring via Socket.dev for npm/pip packages.

5. **Audit must be passive and complete.** Governance teams should not need to configure anything. The audit system (`audit.ts`) logs 30+ action types in JSONL with auto-rotation (10MB), captures actor/action/before-after/scope/session_id/host_id. The governance posture report (`bclaw_audit`) aggregates into constitution, red-lines, claim activity, and structured recommendations.

6. **Integration must not require brainclaw-specific agent code.** The ideal integration is: add MCP server config, the agent discovers tools, the agent uses them. The facades (`bclaw_work`, `bclaw_coordinate`) simplify the MCP surface to 2 entry points for agents that don't need granular access.

## Anti-Patterns

- Exposing `.brainclaw/` file structure as a stable interface (it is internal)
- Breaking MCP tool signatures without versioning
- Hardcoding agent-specific behavior in core brainclaw (use capability profiles instead)
- Storing sensitive data (tokens, credentials) in brainclaw memory or state
- Requiring agent-side code changes to use brainclaw (beyond MCP config)
- Shipping capability profiles that overstate what an agent can actually do
- Ignoring tier degradation — if an agent's surfaces drift, the effective tier must reflect reality

## Key Features for This Audience

### MCP Surface (primary integration point)
- MCP server (`brainclaw mcp`) — ~60 published tools over stdio (canonical grammar in the default catalog; the full advanced catalog available via `tools/list { catalog: "all" }`)
- `bclaw_work(intent)` — entry facade: session + context + claim in one call (returns a compact payload by default to stay under MCP token caps)
- `bclaw_context(kind)` — unified context read: `memory` / `execution` / `board` / `board_summary` / `delta`
- `bclaw_find` / `bclaw_get` / `bclaw_create` / `bclaw_update` / `bclaw_remove` / `bclaw_transition` — canonical CRUD across all entities
- `bclaw_coordinate(intent)` / `bclaw_dispatch(intent)` / `bclaw_loop(intent)` — multi-agent facades for assign / review / reroute / parallel execute / multi-turn loops
- Context format contract versioned via `context_schema` field

### Agent Detection & Configuration
- Auto-detection via env vars (`ai-agent-detection.ts`): BRAINCLAW_AGENT, CLAUDE_CODE_VERSION, CURSOR_*, WINDSURF_*, CLINE_*, GITHUB_COPILOT_PRODUCT, home dir checks for 10+ agents
- AI surface inventory (`ai-surface-inventory.ts`): detects desktop apps, web surfaces, CLI agents with status (not_detected → brainclaw_ready) and capability flags (supports_mcp, remote_connectors, context_export, etc.)
- 3-tier capability system with runtime degradation assessment
- 14+ agent profiles with per-agent invoke templates and role capabilities
- `bclaw_get_discovery` — scan workspace for MCP configs, skills, hooks, integrations
- `bclaw_context(kind="execution")` — platform, shell, git, toolchains, env signals snapshot

### Agent Profiles (reusable invocation templates)
- YAML profiles in `default-profiles/`: doctor, janitor, onboarder, reviewer
- Per-profile: trust_level, trigger (manual/auto), prompt template, invoke command
- User profiles override defaults; loaded via agent-profiles API
- `brainclaw run [profile-name]` — execute a profile

### Security & Governance
- `bclaw_check_policy` — pre-execution scope compliance with glob matching
- `bclaw_check_security` — supply chain risk scoring via Socket.dev (pass/warn/block per package)
- `bclaw_audit` — governance posture report with structured recommendations
- `bclaw_history` — full mutation history per item with before/after snapshots
- Lifecycle trigger tags (`trigger:post-claim`, `trigger:pre-session-end`) for event-driven constraints

### Cross-Project Federation
- Signal entities only: candidate, handoff, runtime_note (execution stays local)
- Schema-versioned federation messages with from_project/from_agent/target_project metadata
- Cycle detection (A→B→A prevention)
- CLI: `brainclaw federation push/pull/status`
- Inbox directory pattern: `coordination/inbox/cross-project/`

### Versioning & Contracts
- Context format: `docs/context-format.md` + `docs/context-format-changelog.md`
- MCP schema: `docs/mcp-schema-changelog.md`
- Document schemas with migration support (`schema.ts`, `migration.ts`)
- `bclaw_release_notes` — agent-first release notes with breaking risk assessment

## Known Gaps

Features this audience would naturally expect but that are not yet implemented:

### No plugin/extension system
Tools added via `bclaw_add_tool` are metadata-only — they don't become callable MCP tools. There is no way for third parties to register executable MCP extensions, custom memory store backends, custom validators, or export format plugins without modifying brainclaw core. The architecture is monolithic.
**Impact:** Integrators must fork brainclaw to add domain-specific functionality.

### No tool-level API versioning or deprecation
MCP protocol version exists (`2025-11-25` in `mcp.ts`), but individual tools have no version annotations. No compatibility negotiation ("client supports bclaw_work v2, server has v1.5"), no deprecation lifecycle (added/deprecated/removed dates), no feature flags for experimental tools.
**Impact:** Integrators discover breaking changes at runtime, not at integration time.

### No real-time event streaming
The event log (`event-log.ts`) supports cursor-based polling but there are no WebSocket, SSE, or pub/sub subscriptions. Agents must poll every N seconds to discover changes. No event filtering ("only claim events from agent X").
**Impact:** Integrators building real-time dashboards or reactive agents must build their own polling + change detection.

### No rate limiting or quota enforcement
No throttling or per-agent call budgets anywhere in the MCP handler path. `circuit-breaker.ts` exists but is unused. LLM-invoking tools (`bclaw_compact`, plus legacy experimental `codev` when enabled) have no usage limits. Agents can make unlimited calls.
**Impact:** A misbehaving agent can overwhelm the store or run up LLM costs without any guardrail.

### Memory type system is closed
Fixed set of types: constraint, decision, trap, handoff, candidate, plan, sequence, runtime_note, instruction (`schema.ts`). Integrators cannot define custom types (e.g., "ProjectRisk", "DesignPattern") with custom fields. No type inheritance or middleware for custom validation.
**Impact:** Domain-specific knowledge must be shoehorned into generic types or stored as untyped notes.

### No multi-tenant isolation beyond project boundaries
Isolation is project-directory level only. No team/department boundaries within a project, no role-based data visibility (all agents in a project see all memory), no data residency controls, no per-team audit segmentation.
**Impact:** Enterprise teams sharing a monorepo cannot enforce internal boundaries through brainclaw.

### Token/cost tracking exists but has no enforcement
Usage tracking (`usage.ts`) records chars and estimated tokens per tool/agent, but there is no cost model ($/token), no quota enforcement ("agent X gets 100M tokens/month"), no cost alerts, no projected spend.
**Impact:** Governance teams can see usage after the fact but cannot prevent overruns.

### Tool discovery lacks trust/dependency introspection
The default `tools/list` catalog is now curated around facades and daily runtime tools, and raw MCP clients can request the full registry, but there is still no trust-level annotation per tool and no tool dependency graph ("bclaw_dispatch requires active sequence"). Agents still need docs or source to understand tool preconditions.
**Impact:** New agent integrations require trial-and-error to discover which tools work in their context.

### No metrics MCP endpoint
CLI metrics exist (`brainclaw metrics`, `brainclaw usage`, `brainclaw estimation-report`) but none are exposed as MCP tools. Agents cannot programmatically query coordination health or usage data through the standard integration surface.
**Impact:** Governance dashboards must shell out to CLI instead of using the MCP contract.
