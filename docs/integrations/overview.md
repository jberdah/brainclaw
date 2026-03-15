# Integration Overview

brainclaw is designed to work with existing coding agents, not replace them.

## Integration surfaces

brainclaw can integrate through several surfaces:

- **Readable files** — `.brainclaw/project.md`, `AGENTS.md`, `.github/copilot-instructions.md`
- **Native agent files** — `CLAUDE.md`, `.cursor/rules/brainclaw.md`, `.windsurfrules`, etc. (via `brainclaw export`)
- **CLI commands** — direct operational entry point
- **MCP tools** — dynamic access path for capable agents
- **System or project instructions** — static guidance for how to use brainclaw

## Recommended pattern

A good default pattern is:

1. use lightweight system instructions to tell the agent how to use brainclaw
2. retrieve fresh workspace context before significant edits
3. use shared plans and claims during execution
4. use handoffs and runtime notes when switching work or surfacing issues

## Important principle

Do not rely on a single point of contact.

Agents are not perfectly reliable at following instructions every time.
The strongest integrations combine:

- instructions (static)
- readable workspace state (file)
- MCP or CLI access (dynamic)
- repeated reminders in the workflow
- optional hooks where supported

## Getting the native file written automatically

Run `brainclaw init` — it detects the running agent and writes to its native file automatically.

Or at any time:

```bash
brainclaw export --detect
```

## Related pages

- [agents.md](agents.md)
- [mcp.md](mcp.md)
- [copilot.md](copilot.md)
- [cursor.md](cursor.md)
- [claude-code.md](claude-code.md)
- [codex.md](codex.md)
