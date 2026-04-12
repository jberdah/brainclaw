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

That now also includes Brainclaw's own install channel state: `bclaw_get_execution_context` surfaces whether a newer npm or local-pack build is available, so the agent can notice upgrades without relying on a human to run `brainclaw version --check`.

## Recommended Agent Pattern

The default dynamic workflow is:

1. `bclaw_work` to start the session and load the relevant context in one call
2. `bclaw_get_execution_context` early when the agent needs local tooling signals or package update visibility
3. `bclaw_get_context` only when the target path changes or the agent needs a narrower refresh than the facade returned
4. `bclaw_coordinate` for assign, consult, review, reroute, or summarize flows across agents
5. `bclaw_read_inbox` and `bclaw_read_handoff` when resuming delegated work
6. `bclaw_write_note` or `bclaw_quick_capture` for runtime observations during work
7. `bclaw_create_candidate` when the result should enter the review queue as durable shared memory

This keeps session continuity inside Brainclaw instead of pushing the agent back to manual CLI usage.

When a human operator needs the CLI equivalent of `bclaw_write_note`, use `brainclaw runtime-note <text>`.

## Available Tools

The default published MCP catalog is curated around facades and everyday runtime tools. Advanced tools remain callable if an agent already knows their exact names, but they are intentionally not the default discovery path. Raw MCP clients can request the full registry with `tools/list` params `{ "catalog": "all" }`.

This section highlights the primary runtime tools agents are expected to use most often first, then documents the broader advanced surface.

**Default published tools**:

| Tool | Purpose |
|---|---|
| `bclaw_work` | Facade entry point: start session + load context + optionally claim a scope in one call |
| `bclaw_coordinate` | Multi-agent coordination facade: assign, consult, review, reroute, or summarize |
| `bclaw_get_context` | Ranked prompt-ready context for a specific path or scope |
| `bclaw_get_execution_context` | Inspect local execution context, installable update status, and agent tooling |
| `bclaw_session_start` | Start an agent session explicitly when a granular workflow needs session registration |
| `bclaw_session_end` | End a granular session cleanly, optionally reflecting notes or handoffs |
| `bclaw_claim` | Claim a scope explicitly before editing outside the facade path |
| `bclaw_release_claim` | Release an explicit claim when the granular workflow is done |
| `bclaw_bootstrap` | Brownfield bootstrap signals, interview prompts, and selective import preview/apply |
| `bclaw_release_notes` | Agent-first release notes for the latest installable Brainclaw version |
| `bclaw_switch` | Switch the active Brainclaw project in a multi-project workspace before further calls |
| `bclaw_get_agent_board` | Coordination snapshot for plans, claims, handoffs, and instructions |
| `bclaw_list_plans` | Structured plan listing with filters and compact mode |
| `bclaw_list_claims` | Structured claim listing with CLI-equivalent filters |
| `bclaw_list_candidates` | Pending or archived review queue listing |
| `bclaw_read_inbox` | Read messages from an agent inbox |
| `bclaw_read_handoff` | Read active handoffs |
| `bclaw_write_note` | Record a runtime note |
| `bclaw_quick_capture` | Capture free-form text and classify it into a decision, trap, or runtime note |
| `bclaw_create_candidate` | Create a memory candidate |
| `bclaw_ack_message` | Acknowledge a processed assignment or review request |
| `bclaw_setup` | Agent-driven onboarding wizard |

**Advanced read tools** (any trust level):

| Tool | Purpose |
|---|---|
| `bclaw_get_context` | Ranked prompt-ready context, supports `digest: true` |
| `bclaw_bootstrap` | Derive brownfield bootstrap signals, return adaptive interview prompts, accept structured interview answers, and preview/apply a selective import proposal |
| `bclaw_get_execution_context` | Inspect local execution context, installable update status, and agent tooling |
| `bclaw_release_notes` | Agent-first release notes for the latest installable Brainclaw version: highlights, breaking risk, and action recommendation |
| `bclaw_read_handoff` | Read active handoffs |
| `bclaw_get_agent_board` | Coordination snapshot |
| `bclaw_list_plans` | Structured plan listing with filters, pagination (`limit`/`offset`), `compact` mode, and `id` lookup |
| `bclaw_list_sequences` | Coordination sequence listing with filters on status and id, supports `compact` mode |
| `bclaw_list_claims` | Structured claim listing with CLI-equivalent filters |
| `bclaw_list_agents` | Registered agent inventory, optionally with bounded reputation |
| `bclaw_list_instructions` | Raw or resolved instruction listing |
| `bclaw_list_candidates` | Pending or archived review queue listing |
| `bclaw_search` | Full-text search across memory |
| `bclaw_check_policy` | Pre-execution policy check: verify claims, constraints, traps for a scope |
| `bclaw_audit` | Audit log or governance posture report (`governance: true`) |
| `bclaw_history` | Full mutation history of a memory item |
| `bclaw_doctor` | Health checks (JSON output) |
| `bclaw_get_discovery` | Scan workspace for MCP configs, skills, hooks, integrations |
| `bclaw_conflict_check` | Check for overlapping claims between agents |
| `bclaw_who` | List active agent sessions on this workspace |
| `bclaw_estimation_report` | Estimation accuracy report for completed plans |
| `bclaw_get_capabilities` | List registered project capabilities |
| `bclaw_list_tools` | List registered project tools |
| `bclaw_search_tools` | Search tools by name or description |
| `bclaw_read_inbox` | Read messages from an agent inbox; filter by status, type, or thread; supports `markAsRead` |
| `bclaw_get_thread` | Get all messages in a thread across all agent inboxes |
| `bclaw_dispatch_analysis` | Analyze the active sequence: show ready, active, blocked, and done lanes plus available agents |
| `bclaw_check_security` | Supply chain security scores for npm/pypi packages via Socket.dev (pass/warn/block verdict) |

**Advanced write tools** (contributor trust or above):

| Tool | Purpose |
|---|---|
| `bclaw_write_note` | Record a runtime note, supports `autoReflect: true` |
| `bclaw_quick_capture` | Capture free-form text and classify it into a decision, trap, or runtime note using keyword heuristics |
| `bclaw_create_candidate` | Create a memory candidate (decision, constraint, trap, handoff) |
| `bclaw_accept` | Accept a pending candidate into canonical memory |
| `bclaw_reject` | Reject a pending candidate |
| `bclaw_claim` | Claim a work scope (advisory lock, auto-surfaces policy warnings) |
| `bclaw_release_claim` | Release a claim, optionally updating the linked plan status |
| `bclaw_session_start` | Start an agent session and register identity |
| `bclaw_session_end` | End session, optionally auto-reflect notes as candidates |
| `bclaw_create_plan` | Create a new plan item |
| `bclaw_update_plan` | Update plan status, actual effort, priority, or assignee |
| `bclaw_add_step` | Add a sub-step to a plan item |
| `bclaw_complete_step` | Mark a plan sub-step as done |
| `bclaw_create_sequence` | Create a coordination sequence shared by agents |
| `bclaw_update_sequence` | Update a sequence's status, metadata, or items |
| `bclaw_send_message` | Send a message to another agent's inbox (assign, review, rfc, info, reply) |
| `bclaw_ack_message` | Acknowledge a message in your inbox after processing it |
| `bclaw_switch` | Change the active project for subsequent tool calls |
| `bclaw_setup` | Agent-driven onboarding wizard |
| `bclaw_delete_memory` | Delete a memory item by ID |
| `bclaw_update_memory` | Update a memory item's text or metadata |
| `bclaw_update_handoff` | Update a handoff status or add narrative |
| `bclaw_add_capability` | Register a project capability |
| `bclaw_add_tool` | Register a project tool |

**Advanced write tools** (trusted trust or above):

| Tool | Purpose |
|---|---|
| `bclaw_dispatch` | Run a dispatch cycle: analyze the active sequence, generate briefs for ready lanes, and send assignment messages to available agents; supports `dryRun` and `spawn` |
| `bclaw_dispatch_review` | Dispatch code reviews for completed handoffs: auto-detects reviewable handoffs, generates a structured review brief, and delivers it via inbox or spawn |
| `bclaw_compact` | LLM-driven semantic memory compaction (two-phase): phase 1 returns pressure assessment and eligible items, phase 2 archives items and creates new durable memory entries |

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

The MCP server serializes all mutations through a single-writer queue (`McpTaskRunner`). When an agent calls a write tool (e.g. `bclaw_claim`, `bclaw_write_note`, `bclaw_create_plan`), the request is enqueued and executed one at a time. This guarantees:

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
