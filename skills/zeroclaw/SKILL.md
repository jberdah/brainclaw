---
name: brainclaw
description: Structured project memory for ZeroClaw — share context across 20+ messaging channels and coding agents
metadata:
  zeroclaw:
    requires:
      bins: ["brainclaw"]
---

# brainclaw — structured project memory for ZeroClaw

You have access to brainclaw, a structured memory system for projects.
It organizes knowledge into constraints, traps, decisions, and plans so
nothing gets lost between messaging sessions or cross-agent handoffs.

brainclaw memory is shared with all agents (Claude Code, Codex, Cursor,
NanoClaw, NemoClaw, PicoClaw, etc.) working on the same repositories.
When you record something, every agent sees it.

## Before any task

Load project context:

```
brainclaw context --for <project-path> --profile compact
```

ZeroClaw's low memory footprint makes `--profile compact` ideal.

## During work

Record information gathered from messaging channels:

```
brainclaw decision "User confirmed deployment window: Saturday 2am-6am UTC"
brainclaw trap "WhatsApp rate limit hit at 200 msg/min — throttle notifications" --severity medium
brainclaw constraint "All automated messages must include opt-out footer" --category process
```

## Cross-agent handoff

Hand off work to a coding agent:

```
brainclaw handoff "ZeroClaw gathered requirements from Slack — ready for implementation"
```

## After work

```
brainclaw session-end --auto-release
```
