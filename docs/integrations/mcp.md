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
| `bclaw_write_note` | Record a runtime note, supports `autoReflect: true` |
| `bclaw_read_handoff` | Read active handoffs |
| `bclaw_get_agent_board` | Coordination snapshot |

## Recommended use

Use MCP as the dynamic access path for:

- fresh context
- runtime coordination views
- shared board state
- write operations that should preserve session continuity

Readable files still matter, but MCP gives a stronger path for dynamic state.

## Practical layering

| Surface | When to use |
|---|---|
| Files (`.brainclaw/project.md`) | Simple readable fallback, always available |
| CLI | Explicit operational entry point, scripting |
| MCP | Best dynamic integration path for capable agents |
