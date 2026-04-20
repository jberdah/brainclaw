---
name: brainclaw
description: 'Load and act on Brainclaw project memory, active claims, plans, traps, and handoffs before code changes. Trigger: refresh brainclaw context, check active claims, load coordination state.'
allowed-tools: 'Read Bash(npx brainclaw:*)'
---

# Brainclaw

Load the shared coordination state before any significant code change. Prefer the Brainclaw MCP facade; the CLI is a fallback when MCP is not reachable.

## Steps

1. Call `bclaw_work(intent)` — `resume` to continue existing work, `execute` to claim a new scope, or `consult` for read-only context. The response gives you memory, active claims, plans, traps, and handoffs.
2. Respect active claims from other agents reported in the response; do not edit a claimed scope unless you own the claim.
3. Use `bclaw_coordinate(intent)` to assign, consult, or review other agents when needed.
4. When done, call `bclaw_session_end` (auto-releases your remaining claims).

CLI fallback only: `brainclaw context --json` / `brainclaw claim create` / `brainclaw session-end --auto-release` if the MCP server is unavailable.
