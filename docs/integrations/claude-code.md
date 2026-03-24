# Claude Code Integration

brainclaw is a good fit for Claude Code because Claude Code can work with files, instructions, MCP, and hook-like workflow mechanisms.

## Auto-setup

`brainclaw init` detects Claude Code (`CLAUDE_CODE_VERSION`) and writes `CLAUDE.md` automatically. Or manually:

```bash
brainclaw export --format claude-md --write
```

## Recommended approach

- use MCP as the default runtime path for dynamic retrieval and writes
- keep `CLAUDE.md` lightweight and behavioral: it should tell Claude Code when to call Brainclaw, not carry all mutable workspace state
- use `.brainclaw/project.md` as a readable fallback (it is a derived view, regenerated best-effort — run `brainclaw rebuild` if stale)
- use hooks or workflow checks when a stronger reminder is needed

## Key idea

Claude Code should not carry all workspace state in static instructions.
brainclaw provides the living workspace layer through MCP plus local workflow guidance.
