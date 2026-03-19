# Memory

brainclaw uses the term **memory** in an explicit, workspace-oriented sense.

This is not an opaque cloud memory feature.
It is shared project state stored locally in a structured, inspectable form.

## What memory includes

Durable memory can include:

- **instructions** — agent workflow instructions written to native formats (CLAUDE.md, .cursor/rules/, etc.)
- **constraints** — active project constraints that agents must respect
- **decisions** — logged architectural or process decisions
- **traps** — documented pitfalls to avoid (with severity and remediation)
- **handoffs** — structured context transfers between agents or sessions
- **plans** — shared work items with status, priority, and estimation data
- **claims** — active file/scope ownership signals for collision avoidance
- **runtime notes** — short-lived observations from the current session
- **audit log** — timestamped record of all brainclaw operations in the workspace

These are the pieces of context that should survive across sessions and be readable by both humans and agents.

## Durable vs runtime

A useful mental model is to separate:

### Durable memory
Shared project knowledge worth keeping.

Examples: constraints, decisions, traps, completed plans, handoffs.

These live in `.brainclaw/store.json` and are shared via Git (or by reading the same file).

### Runtime memory
Operational observations that may be short-lived, host-specific, or private.

Examples: "this API key only works in staging", "the test server is slow today", temporary notes during a session.

Runtime notes are stored separately and can be given a TTL so they expire automatically.

Not everything seen during execution should become canonical memory immediately.

## Why explicit memory matters

Without explicit memory, project context tends to scatter across:

- chat history
- agent prompts
- personal notes
- unstated assumptions
- hidden tool memory

brainclaw makes this context visible and versionable.

## Readable vs canonical

brainclaw keeps:

- canonical structured JSON as the source of truth (`.brainclaw/store.json`)
- a generated readable view in each agent's native format (`CLAUDE.md`, `.cursor/rules/brainclaw.md`, etc.)

This balances machine reliability with human readability.

The generated files are **local-only** and should not be committed to Git — each developer regenerates them from their own `.brainclaw/` store. Add them to `.gitignore` (brainclaw does this automatically during `init`).

## Accessing memory

```bash
brainclaw context               # full context as text
brainclaw context --json        # full context as JSON (for agents)
brainclaw agent-board           # live plan + claim board
brainclaw claim list            # active claims
brainclaw plan list             # all plans
brainclaw audit                 # audit log
```

MCP tools expose the same data to agents that support the Model Context Protocol.

## Related pages

- [coordination.md](coordination.md)
- [runtime-notes.md](runtime-notes.md)
- [workspace-bootstrapping.md](workspace-bootstrapping.md)
- [plans-and-claims.md](plans-and-claims.md)
