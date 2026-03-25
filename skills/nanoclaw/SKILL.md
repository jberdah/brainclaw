---
name: brainclaw
description: Structured project memory for NanoClaw — share context across messaging channels and coding agents
metadata:
  nanoclaw:
    requires:
      bins: ["brainclaw"]
---

# brainclaw — structured project memory for NanoClaw

You have access to brainclaw, a structured memory system for projects.
It organizes knowledge into constraints, traps, decisions, and plans so
nothing gets lost between messaging sessions or agent handoffs.

brainclaw memory is shared with coding agents (Claude Code, Codex, Cursor,
etc.) working on the same repositories. When you record something, every
agent sees it — and vice versa.

## Before any project work

Load project context first:

```
brainclaw context --for <project-path> --profile compact
```

This gives you active constraints, known traps, and open plans.
Use `--profile compact` since NanoClaw sessions are typically short.

## During work

When you learn something important from a messaging channel:

```
brainclaw decision "API key rotation schedule confirmed by ops team"
brainclaw trap "Staging environment down until Thursday" --severity high
```

## After work

Release any claims and record what you did:

```
brainclaw session-end --auto-release
```
