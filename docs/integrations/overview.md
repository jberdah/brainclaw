# Integration Overview

Brainclaw works alongside your existing coding agents. It does not replace them — it gives them a shared memory and coordination layer they can all read from and write to.

## How agents connect to brainclaw

Brainclaw reaches each agent through multiple surfaces. Not every agent supports every surface, and that's fine — brainclaw adapts what it writes based on what the agent can handle.

| Surface | What it does | When it activates |
|---|---|---|
| **MCP tools** | The agent calls brainclaw directly to read context, create plans, claim files, and coordinate. This is the richest integration. | During every prompt, when the agent decides to call a tool |
| **Instruction file** | A markdown file in the agent's native format that explains how to use brainclaw and lists active project constraints. | Read once at session start |
| **Hooks** | Brainclaw injects fresh context into the agent's prompt automatically, without the agent asking. | Every prompt (where supported) |
| **Auto-approve** | MCP tool calls are pre-approved so the agent doesn't have to ask the developer for permission each time. | Every MCP call (where supported) |
| **Skills / Commands** | A shortcut the developer can trigger manually to refresh brainclaw context. | On demand |

## What goes where: core vs run

Instruction files contain **core** content — things that don't change between prompts:

- Why brainclaw matters for this project
- The session protocol (what to call and when)
- Active constraints
- Project instructions

Everything else is **run** content — it changes constantly and belongs in the dynamic context delivered through MCP or hooks:

- Active plans and their status
- Who is working where (claims)
- Known traps (scored by relevance to the current file)
- Handoffs between agents
- Runtime notes

This separation keeps instruction files clean and focused. The agent gets the stable rules from the file and the live state from MCP.

## Three levels of integration

Brainclaw adapts its instruction file content based on what each agent can do:

### Full integration (MCP + hooks)

The agent gets dynamic context injected at every prompt. The instruction file can be lightweight — just the protocol and constraints. Everything else comes through hooks and MCP calls.

**Today:** Claude Code

### Standard integration (MCP, no hooks)

The agent can call brainclaw tools but doesn't get automatic context injection. The instruction file is more directive — it tells the agent it MUST call specific tools before working, and includes the most critical traps statically. For agents without hooks, an opt-in `.live.md` companion (regenerated on session-end and handoff) carries plans, claims, traps, candidates, and handoffs as a parity backstop.

**Today:** Cursor, Windsurf, Cline, Roo, Continue, Kilocode, OpenCode, Codex, GitHub Copilot, Antigravity/Gemini CLI

### Limited integration (no MCP)

The agent cannot call brainclaw tools at all. The instruction file or SKILL.md becomes the only source of project context, so it includes everything: constraints, traps, active plans, recent decisions.

**Today:** Autonomous agents only (OpenClaw, NanoClaw, NemoClaw, PicoClaw, ZeroClaw — wired via `skills/<agent>/SKILL.md`).

## Agent integration matrix

| Agent | MCP | Instruction file | Hooks | Auto-approve | Skills |
|---|---|---|---|---|---|
| **Claude Code** | ✔ project + global | CLAUDE.md | ✔ pre-prompt + stop | ✔ permissions | ✔ /brainclaw |
| **Cursor** | ✔ global | .cursor/rules/ + MDC | ◐ alwaysApply MDC | — | — |
| **Windsurf** | ✔ global | .windsurfrules | ◐ session trigger | — | — |
| **Cline** | ✔ project | .clinerules/ | — | ✔ autoApprove | — |
| **Roo** | ✔ project | .roo/rules/ | — | ✔ alwaysAllow | — |
| **Continue** | ✔ both | .continue/rules/ | — | — | — |
| **Kilocode** | ✔ both | .kilo/rules/ + AGENTS.md | — | ✔ alwaysAllow | — |
| **OpenCode** | ✔ project | AGENTS.md | — | — | — |
| **Codex** | ✔ global | AGENTS.md | — | — | — |
| **Gemini CLI** | ✔ global | GEMINI.md | — | — | — |
| **GitHub Copilot** | ✔ global + project | .github/copilot-instructions.md | — | manual (per-call) | ✔ brainclaw-context |
| **OpenClaw** | — | — | — | — | ✔ brainclaw skill |

**Legend:** ✔ = fully supported, ◐ = partial (static trigger, not dynamic injection), — = not available

## Why maximum integration by default

Without active pressure, agents ignore brainclaw. This is a consistent finding from real usage: if brainclaw only declares an MCP server and doesn't push the agent to use it, the agent never calls it.

That's why brainclaw activates **all available surfaces** by default during setup:

- The MCP server and instruction file are always configured (non-negotiable)
- Auto-approve and hooks are enabled where supported (opt-out possible)
- The instruction file includes a "why this matters" section so the agent understands why it should care

The developer can dial back individual surfaces if needed, but the default is full integration because that's what works.

## Parallel and sequential collaboration

brainclaw's store mutations are serialized (MCP single-writer queue + file-based lock), so memory writes are safe even under contention.

For **parallel work**, dispatch a sequence with `bclaw_dispatch(intent="execute")` — each lane gets its own auto-worktree under `~/.brainclaw/worktrees/<project-hash>/`, and the coordinator integrates with an octopus merge. For **review-fix loops**, `bclaw_coordinate(intent="review", open_loop=true, review_mode="symmetric")` runs an alternating review-and-fix conversation across two slots without shared-checkout collisions. These are the supported parallel paths today.

For **sequential work** in the same project, let one agent claim at a time and rely on handoffs to keep continuity across sessions.

What is **still risky**: running two agents in the *same* working tree without per-claim worktrees. That path can still produce Git conflicts and confusing file-level state — use the dispatch path (auto-worktree per claim) instead.

See the README's "Current state" section for the full list of what works today and the residual sharp edges.

## Next reads

- [mcp.md](mcp.md) — the dynamic runtime path for capable agents
- [agents.md](agents.md) — integration principles and setup details
- [claude-code.md](claude-code.md)
- [cursor.md](cursor.md)
- [codex.md](codex.md)
- [copilot.md](copilot.md)
- [continue.md](continue.md)
- [roo.md](roo.md)
- [windsurf.md](windsurf.md)
- [cline.md](cline.md)
- [kilocode.md](kilocode.md)
- [opencode.md](opencode.md)
- [openclaw.md](openclaw.md)
