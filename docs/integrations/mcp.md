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

1. `bclaw_session_start` to open work and get the current board/context
2. `bclaw_get_execution_context` early in the session when the agent needs local tooling signals or package update visibility
3. `bclaw_get_context` when the target path or task changes
4. `bclaw_list_plans` and `bclaw_list_claims` to inspect active work
5. `bclaw_claim` before editing
6. `bclaw_write_note` for runtime observations
7. `bclaw_session_end` to close cleanly and hand work off

This keeps session continuity inside Brainclaw instead of pushing the agent back to manual CLI usage.

## Available Tools

| Tool | Purpose |
|---|---|
| `bclaw_get_context` | Ranked prompt-ready context, supports `digest: true` |
| `bclaw_bootstrap` | Derive brownfield bootstrap signals, return adaptive interview prompts, accept structured interview answers, and preview/apply a selective import proposal |
| `bclaw_get_execution_context` | Inspect local execution context, installable update status, and agent tooling |
| `bclaw_write_note` | Record a runtime note, supports `autoReflect: true` |
| `bclaw_read_handoff` | Read active handoffs |
| `bclaw_get_agent_board` | Coordination snapshot |
| `bclaw_list_plans` | Structured plan listing with CLI-equivalent filters |
| `bclaw_list_claims` | Structured claim listing with CLI-equivalent filters |
| `bclaw_list_agents` | Registered agent inventory, optionally with bounded reputation |
| `bclaw_list_instructions` | Raw or resolved instruction listing |
| `bclaw_list_candidates` | Pending or archived review queue listing |
| `bclaw_search` | Full-text search across memory |

## When To Use MCP Versus Other Surfaces

| Need | Best surface |
|---|---|
| Fresh path-scoped context | MCP |
| Current plans, claims, board state | MCP |
| Runtime writes with session continuity | MCP |
| Local behavioral reminders inside the agent UI | native agent files |
| Human inspection or scripting | CLI |
| Simple readable fallback | `.brainclaw/project.md` |

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

## Important Rule

If the agent has MCP available, do not treat the CLI as the primary runtime interface.

The CLI remains valuable for:

- setup
- bootstrap by a human operator
- scripting
- release and packaging
- debugging and fallback access

But for capable agents, MCP should be the first-class path for dynamic state.
