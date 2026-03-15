# GitHub Copilot Integration

brainclaw complements Copilot by making shared project context explicit and local.

## Auto-setup

`brainclaw init` detects Copilot and writes `.github/copilot-instructions.md` automatically. Or manually:

```bash
brainclaw export --format copilot-instructions --write
```

## Recommended approach

- point Copilot to `.brainclaw/project.md` or use fresh context retrieval
- use plans, claims, and handoffs to reduce ambiguity across sessions
- use MCP where supported for dynamic collaboration views

## Why this matters

Copilot benefits from explicit project memory and shared coordination state instead of relying only on implicit memory features.
