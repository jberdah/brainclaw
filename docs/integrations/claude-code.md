# Claude Code Integration

brainclaw is a good fit for Claude Code because Claude Code can work with files, instructions, MCP, and hook-like workflow mechanisms.

## Auto-setup

`brainclaw init` detects Claude Code (`CLAUDE_CODE_VERSION`) and writes `CLAUDE.md` automatically. Or manually:

```bash
brainclaw export --format claude-md --write
```

## Recommended approach

- add lightweight usage instructions for brainclaw in `CLAUDE.md`
- use `.brainclaw/project.md` as a readable baseline
- prefer MCP for dynamic retrieval when available
- use hooks or workflow checks when a stronger reminder is needed

## Key idea

Claude Code should not carry all workspace state in static instructions.
brainclaw provides the living workspace layer.
