# Integration Overview

Brainclaw is designed to work with existing coding agents, not replace them.

The key integration rule is simple:

1. use MCP for dynamic shared state when the agent supports it
2. use native agent files for local behavioral guidance
3. use the CLI for setup, operator workflows, scripting, and fallback access

## Current Limitation

For now, Brainclaw should be used for sequential multi-agent collaboration, not true parallel editing in the same checkout.

One agent can hand work to another, and the next agent can recover good project context through shared memory, plans, claims, and handoffs. But without dedicated Git worktrees per agent/session, running several coding agents concurrently on the same project checkout is still risky and can create conflicts or unstable local state.

## Integration Surfaces

brainclaw can integrate through several surfaces, but they do not have the same role.

| Surface | Role |
|---|---|
| **MCP tools** | primary dynamic access path for context, plans, claims, board views, and runtime writes |
| **Native agent files** | local guidance in the agent's own surface: `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules/brainclaw.md`, `.windsurfrules`, etc. |
| **Readable files** | fallback readable state such as `.brainclaw/project.md` |
| **CLI commands** | setup, scripting, release, inspection, and fallback workflows |
| **System/project instructions** | static reminders about how Brainclaw should be used in this workspace |

## Recommended Pattern

A good default pattern is:

1. give the agent lightweight static instructions about how to use Brainclaw
2. let it retrieve fresh workspace state through MCP before significant edits
3. rely on plans, claims, and handoffs during execution
4. keep native files and readable project state available as fallback context
5. use hooks or repeated reminders where the host surface supports them

## Native Files Are Support, Not The Live Source Of Truth

Generated files such as `CLAUDE.md` or `.cursor/rules/brainclaw.md` are useful because they keep Brainclaw visible inside the agent surface already in use.

They are not meant to replace:

- fresh context retrieval
- live board state
- current claims
- recent runtime notes
- current handoffs

For those, use MCP when available.

## Getting The Native File Written Automatically

Run `brainclaw init` and Brainclaw will detect the current agent surface and write the appropriate local file automatically.

That includes OpenCode (`AGENTS.md` + `opencode.json`) and Antigravity/Gemini CLI (`GEMINI.md` + machine-local MCP config) when those environments are present.

Or at any time:

```bash
brainclaw export --detect --write
```

By default, generated workspace files are treated as local setup and added to `.gitignore`. `--shared` should only be used when you intentionally want the main exported instruction file to be versioned.

## Choose Your Next Page

- [mcp.md](mcp.md) — the nominal path for capable agents
- [agents.md](agents.md) — integration principles that apply to every agent
- [claude-code.md](claude-code.md)
- [codex.md](codex.md)
- [cursor.md](cursor.md)
- [copilot.md](copilot.md)
