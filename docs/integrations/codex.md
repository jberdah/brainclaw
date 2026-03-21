# Codex Integration

brainclaw fits well with Codex-style workflows because Codex can work with project instructions, files, skills, and MCP.

## Auto-setup

`brainclaw init` detects Codex (`~/.codex/` directory) and writes `AGENTS.md` automatically. Or manually:

```bash
brainclaw export --format agents-md --write
```

## Recommended approach

- use MCP as the default runtime path for fresh context, plans, claims, and runtime notes
- keep `AGENTS.md` lightweight and behavioral: it should remind Codex how to use Brainclaw, not duplicate live state
- use `.brainclaw/project.md` only as a readable fallback when MCP is unavailable or when a human wants a simple snapshot
- encourage plans, claims, and handoffs during multi-step work

## Good role for brainclaw here

Codex stays the coding agent.
brainclaw provides the live workspace context and coordination layer.
