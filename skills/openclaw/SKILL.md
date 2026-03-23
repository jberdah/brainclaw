---
name: brainclaw
description: Structured project memory that prevents instruction drift and coordinates with other AI agents working on the same codebase
metadata:
  openclaw:
    requires:
      bins: ["brainclaw"]
---

# brainclaw — structured project memory

You have access to brainclaw, a structured memory system for coding projects.
It organizes project knowledge into distinct types so constraints, traps, and
decisions don't get lost after context compaction.

brainclaw memory is shared with other coding agents (Claude Code, Codex, Cursor,
Windsurf, etc.) working on the same repositories. When you record something in
brainclaw, every agent sees it.

## IMPORTANT: Before any project work

Before working on any coding project, ALWAYS load the project context:

```
brainclaw context --for <project-path> --profile openclaw
```

This gives you:
- Active constraints you MUST respect (e.g., "no deployments on Friday")
- Known traps to avoid (e.g., "e2e tests flaky in payment module")
- Plans in progress — don't duplicate work another agent started
- Handoffs from other agents with context for you

Do NOT skip this step. Without it, you will miss rules and repeat known mistakes.

## When the user gives you a rule or constraint

Do NOT just write it to MEMORY.md. Constraints must survive context compaction.
Record it in brainclaw:

```
brainclaw memory create constraint "<text>" --tag <topic>
```

Examples:
- "Never deploy on Fridays after 2pm" → constraint
- "All API routes must use auth middleware" → constraint
- "TypeScript strict mode, do not disable" → constraint

## When you discover a problem or pitfall

Record it as a trap so other agents don't fall into the same hole:

```
brainclaw memory create trap "<text>" --severity <low|medium|high>
```

Examples:
- "Checkout e2e tests are flaky on Windows" → trap, severity high
- "Rate limiter breaks in test environment" → trap, severity medium

## When you make or learn about a decision

Record it so the reasoning is preserved:

```
brainclaw memory create decision "<text>" --tag <topic>
```

Examples:
- "OAuth migration goes through auth-gateway" → decision
- "Using PostgreSQL 16 instead of 15 for JSONB performance" → decision

## When you start significant work

Create a plan with an estimated duration:

```
brainclaw plan create "<description>" --estimate <minutes>
```

When you finish, report actual duration:

```
brainclaw plan update <id> --status done --actual-effort <duration>
```

This builds a calibration history that improves future estimates.

## When you finish a task

Clean up so the next agent starts with a clear board:

```
brainclaw session-end --auto-release
```

## What stays in MEMORY.md vs brainclaw

| Type | Where | Why |
|------|-------|-----|
| User preferences | MEMORY.md | Personal, not project-scoped |
| Daily observations | memory/YYYY-MM-DD.md | Ephemeral, session-specific |
| Project constraints | brainclaw | Must survive compaction, shared with all agents |
| Known traps/pitfalls | brainclaw | Scored by relevance, visible to all agents |
| Architectural decisions | brainclaw | Preserved with reasoning, searchable |
| Work plans | brainclaw | Coordination with other agents |

## Checking for updates

Periodically check if brainclaw has been updated:

```
brainclaw version --check
```

## Searching memory

Find specific information across all project memory:

```
brainclaw search "<query>"
```
