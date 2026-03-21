# MCP Integration

brainclaw can expose collaboration and context views through MCP-readable tools.

## Why MCP matters

MCP is especially useful when the agent should retrieve fresh workspace state directly instead of relying only on static files.

That is valuable for:

- ranked context retrieval
- collaboration board views
- write flows such as runtime notes
- scoped activity retrieval

## Available tools

| Tool | Purpose |
|---|---|
| `bclaw_get_context` | Ranked prompt-ready context, supports `digest: true` |
| `bclaw_bootstrap` | Derive brownfield bootstrap signals, adaptive interview prompts, and an import proposal when memory is still sparse |
| `bclaw_get_execution_context` | Inspect local execution context and agent tooling |
| `bclaw_write_note` | Record a runtime note, supports `autoReflect: true` |
| `bclaw_read_handoff` | Read active handoffs |
| `bclaw_get_agent_board` | Coordination snapshot |
| `bclaw_list_plans` | Structured plan listing with CLI-equivalent filters |
| `bclaw_list_claims` | Structured claim listing with CLI-equivalent filters |
| `bclaw_list_agents` | Registered agent inventory, optionally with bounded reputation |
| `bclaw_list_instructions` | Raw or resolved instruction listing |
| `bclaw_list_candidates` | Pending or archived review queue listing |
| `bclaw_search` | Full-text search across memory |

## Recommended use

Use MCP as the dynamic access path for:

- fresh context
- runtime coordination views
- structured list views for plans, claims, agents, instructions, and review queues
- shared board state
- write operations that should preserve session continuity

Readable files still matter, but MCP gives a stronger path for dynamic state.

## Practical layering

| Surface | When to use |
|---|---|
| Files (`.brainclaw/project.md`) | Simple readable fallback, always available |
| CLI | Explicit operational entry point, scripting |
| MCP | Best dynamic integration path for capable agents |
