# Codex Integration

brainclaw fits well with Codex-style workflows because Codex can work with project instructions, files, skills, and MCP.

## Auto-setup

`brainclaw init` detects Codex (`~/.codex/` directory) and writes `AGENTS.md` automatically. Or manually:

```bash
brainclaw export --format agents-md --write
```

## Recommended approach

- keep a lightweight instruction telling Codex to consult brainclaw
- let Codex read `.brainclaw/project.md` when simple file context is enough
- use MCP for fresher scoped context when available
- encourage use of plans, claims, and handoffs during multi-step work

## Good role for brainclaw here

Codex stays the coding agent.
brainclaw provides the shared workspace context and coordination layer.
