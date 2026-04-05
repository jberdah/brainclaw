# Quickstart

## The fastest way to start

Ask your coding agent:

> "Install brainclaw and initialize it in this project."

The agent will run `brainclaw setup` and `brainclaw init`, detect your environment, write the right config files, and activate MCP. After reloading, brainclaw tools become available.

If you prefer doing it manually:

```bash
npm install -g brainclaw
brainclaw init
```

`init` creates the user store if needed (no separate `setup` step required), initializes the project, detects your agent, and writes all integration files.

## What happens after init

Once initialized, your agent can:

1. **See project context** — constraints, decisions, traps, plans, handoffs
2. **Coordinate with other agents** — claim files before editing, check who's working where
3. **Build shared memory** — record observations, create plans, track work
4. **Resume across sessions** — the next agent (or the same one tomorrow) picks up where you left off

## For agents with MCP (most agents)

This is the primary path. The agent calls brainclaw tools directly.

```text
bclaw_session_start   → identify yourself, see the board
bclaw_get_context     → load relevant memory for your target scope
bclaw_claim           → signal what you're about to edit
bclaw_write_note      → record observations during work
bclaw_session_end     → clean up claims and update plans
```

Instruction files like `CLAUDE.md` or `.cursor/rules/brainclaw.md` provide the protocol and constraints. The live state (plans, claims, traps) comes through MCP.

## For agents without MCP (Copilot)

The instruction file (`.github/copilot-instructions.md`) contains everything: constraints, active plans, traps, and decisions. Use the brainclaw-context skill to refresh.

Regenerate the instruction file when project memory changes:

```bash
brainclaw export --detect --write
```

## Onboarding an existing project

If the repo already has code, brainclaw can extract context from it:

```bash
brainclaw bootstrap --json        # see what brainclaw detected
brainclaw bootstrap --apply       # import into memory
```

Or let your agent drive the conversation — it can call `bclaw_bootstrap`, review the detected signals, ask you about gaps, and structure the results into brainclaw memory.

## Desktop AI surfaces

brainclaw can also track work for desktop AI tools on your machine (ChatGPT Desktop, Claude Desktop, Gemini CLI) as a project-scoped task queue:

```bash
brainclaw surface-task create "Generate hero visual" --target chatgpt --kind visual_asset
brainclaw surface-task list
```

This keeps non-code work visible to the project without overloading the active coding agent.

## Important: one agent at a time

brainclaw serializes all store mutations (file lock + MCP single-writer queue), so writes are safe. But running multiple agents in parallel on the same checkout can still cause Git conflicts and confusing state transitions.

Use brainclaw for sequential collaboration by default: one agent works, finishes, and the next one picks up from shared context. If you need stronger isolation, use a dedicated Git worktree per session with `brainclaw worktree` or let MCP claims create one automatically where supported. Use `bclaw_session_end` to hand off cleanly.

## Next reads

- [integrations/overview.md](integrations/overview.md) — how brainclaw adapts to each agent
- [integrations/mcp.md](integrations/mcp.md) — the dynamic runtime path
- [release-maintenance.md](release-maintenance.md) — release checklist when the shipped surface changes
- [server-operations.md](server-operations.md) — operator and remote-server workflow guidance
- [concepts/memory.md](concepts/memory.md) — what project memory includes
- [concepts/plans-and-claims.md](concepts/plans-and-claims.md) — coordination layer
- [cli.md](cli.md) — full CLI reference
