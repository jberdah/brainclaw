# GitHub Copilot Integration

brainclaw complements Copilot by making shared project context explicit and local.

## Auto-setup

`brainclaw init` detects Copilot and writes `.github/copilot-instructions.md` automatically. Or manually:

```bash
brainclaw export --format copilot-instructions --write
```

## Recommended approach

- use MCP whenever the Copilot surface supports it for fresh context and coordination views
- keep `.github/copilot-instructions.md` lightweight and behavioral
- use `.brainclaw/project.md` as readable fallback, not as the only live context source
- use plans, claims, and handoffs to reduce ambiguity across sessions

## Why this matters

Copilot benefits from explicit project memory and shared coordination state instead of relying only on implicit memory features.
