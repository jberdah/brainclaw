# Cursor Integration

brainclaw works well next to Cursor because Cursor can already operate with project rules and can benefit from explicit workspace context.

## Auto-setup

`brainclaw init` detects Cursor (`CURSOR_TRACE_ID`) and writes `.cursor/rules/brainclaw.md` automatically. Or manually:

```bash
brainclaw export --format cursor-rules --write
```

## Recommended approach

- use MCP as the default dynamic path for context, board state, plans, and claims
- let the generated `.cursor/rules/brainclaw.md` tell Cursor when to consult Brainclaw and how to stay inside the workflow
- use `.brainclaw/project.md` only as readable fallback shared state
- rely on claims and plans when multiple agents or humans are active in the same repo

## Key point

Cursor rules describe behavior.
brainclaw provides the living shared state those rules should point to through MCP.
