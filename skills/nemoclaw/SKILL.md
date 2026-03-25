---
name: brainclaw
description: Structured project memory for NemoClaw — enterprise-grade context sharing across sandboxed agent environments
metadata:
  nemoclaw:
    requires:
      bins: ["brainclaw"]
---

# brainclaw — structured project memory for NemoClaw

You have access to brainclaw, a structured memory system for projects.
It organizes knowledge into constraints, traps, decisions, and plans so
nothing gets lost across sandboxed agent sessions or multi-agent workflows.

brainclaw memory is shared with all agents (Claude Code, Codex, Cursor,
NanoClaw, PicoClaw, etc.) working on the same repositories. When you
record something in brainclaw, every agent sees it.

## Before any task

Load project context:

```
brainclaw context --for <project-path> --profile dev
```

This gives you active constraints, recent decisions, known traps, open
plans, and active claims from other agents.

## During work

Record architectural decisions, security constraints, and operational traps:

```
brainclaw decision "Switched inference backend to TensorRT-LLM for latency SLA"
brainclaw constraint "All agent outputs must pass content safety filter before delivery" --category security
brainclaw trap "NemoClaw OpenShell policy rejects outbound HTTP unless explicitly allowlisted" --severity high
```

## Multi-agent coordination

Check what other agents are working on before claiming a scope:

```
brainclaw agent-board --json
brainclaw claim <scope> --description "NemoClaw: optimizing inference pipeline"
```

## After work

```
brainclaw session-end --auto-release
```
