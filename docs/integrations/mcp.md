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

All 57 MCP tools are discoverable via `tools/list`. Each tool carries an `annotations` object with `tier` and `category` metadata so clients can filter or group tools without server-side hiding.

### Tool tiers

Every tool has one of three tiers in its `annotations.tier` field:

- **facade** — High-level entry points for agents that don't need granular access. Start here.
- **standard** — Day-to-day coordination tools: plans, claims, messaging, dispatch, review, memory. Returned by default alongside facades.
- **advanced** — Specialized governance, audit, registry, sequences, and power tools.

By default, `tools/list` returns **facade + standard** tools (~33 tools). To get all tools including advanced, pass `{ "catalog": "all" }`, `{ "include": "all" }`, or `{ "advanced": true }`. To filter by a single tier, pass `{ "tier": "facade" }`, `{ "tier": "standard" }`, or `{ "tier": "advanced" }`.

All tools remain callable regardless of catalog filtering — the tier only affects discovery via `tools/list`.

### Tool categories

Each tool also has an `annotations.category` field: `session`, `context`, `memory`, `coordination`, `governance`, or `discovery`.

### Facade tools

| Tool | Category | Purpose |
|---|---|---|
| `bclaw_work` | session | Start session + load context + optionally claim a scope in one call |
| `bclaw_coordinate` | coordination | Assign, consult, review, reroute, or summarize across agents |
| `bclaw_setup` | session | Agent-driven onboarding wizard |

### Standard tools

| Tool | Category | Purpose |
|---|---|---|
| `bclaw_get_context` | context | Ranked prompt-ready context for a specific path or scope |
| `bclaw_get_execution_context` | context | Inspect local execution context, update status, and agent tooling |
| `bclaw_bootstrap` | context | Brownfield bootstrap signals, interview prompts, selective import |
| `bclaw_release_notes` | context | Agent-first release notes with breaking risk assessment |
| `bclaw_session_start` | session | Start a session explicitly (granular workflow) |
| `bclaw_session_end` | session | End session, optionally auto-reflect notes or handoffs |
| `bclaw_switch` | session | Switch active project in a multi-project workspace |
| `bclaw_get_agent_board` | coordination | Coordination snapshot: plans, claims, handoffs, instructions |
| `bclaw_list_plans` | coordination | Plan listing with filters, pagination, compact mode |
| `bclaw_list_claims` | coordination | Claim listing with filters |
| `bclaw_list_candidates` | coordination | Review queue listing (pending, accepted, rejected) |
| `bclaw_read_inbox` | coordination | Read messages from an agent inbox |
| `bclaw_read_handoff` | coordination | Read active handoffs with git diff and state snapshot |
| `bclaw_dispatch_analysis` | coordination | Analyze active sequence: ready, active, blocked, done lanes |
| `bclaw_claim` | coordination | Claim a work scope (advisory lock, auto-worktree) |
| `bclaw_release_claim` | coordination | Release a claim, optionally updating linked plan status |
| `bclaw_create_plan` | coordination | Create a new plan item |
| `bclaw_update_plan` | coordination | Update plan status, effort, priority, or assignee |
| `bclaw_add_step` | coordination | Add a sub-step to a plan item |
| `bclaw_complete_step` | coordination | Mark a plan sub-step as done |
| `bclaw_dispatch` | coordination | Run a dispatch cycle, generate briefs, assign to agents |
| `bclaw_dispatch_review` | coordination | Dispatch code reviews for completed handoffs |
| `bclaw_send_message` | coordination | Send a message to another agent's inbox |
| `bclaw_ack_message` | coordination | Acknowledge a processed inbox message |
| `bclaw_update_handoff` | coordination | Update handoff status, contract, or review verdict |
| `bclaw_write_note` | memory | Record a runtime note |
| `bclaw_quick_capture` | memory | Capture text, auto-classify as decision/trap/note |
| `bclaw_create_candidate` | memory | Create a memory candidate for review |
| `bclaw_accept` | memory | Accept a pending candidate into canonical memory |
| `bclaw_reject` | memory | Reject a pending candidate |
| `bclaw_search` | memory | Full-text search across all memory items (BM25) |

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
| `bclaw_list_sequences` | coordination | Coordination sequence listing |
| `bclaw_create_sequence` | coordination | Create a coordination sequence |
| `bclaw_update_sequence` | coordination | Update a sequence's status, metadata, or items |
| `bclaw_get_thread` | coordination | Get all messages in a thread across inboxes |
| `bclaw_delete_memory` | memory | Delete a memory item by ID |
| `bclaw_update_memory` | memory | Update a memory item's text or metadata |
| `bclaw_compact` | memory | LLM-driven semantic memory compaction (two-phase) |

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
