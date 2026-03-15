# Cursor Integration

brainclaw works well next to Cursor because Cursor can already operate with project rules and can benefit from explicit workspace context.

## Auto-setup

`brainclaw init` detects Cursor (`CURSOR_TRACE_ID`) and writes `.cursor/rules/brainclaw.md` automatically. Or manually:

```bash
brainclaw export --format cursor-rules --write
```

## Recommended approach

- the generated `.cursor/rules/brainclaw.md` tells Cursor to consult brainclaw before significant edits
- use `.brainclaw/project.md` for readable shared state
- use MCP for dynamic retrieval when available
- rely on claims and plans when multiple agents or humans are active in the same repo

## Key point

Cursor rules describe behavior.
brainclaw provides the living shared state those rules should point to.
