---
name: brainclaw
description: Structured project memory for PicoClaw — lightweight context for edge and IoT agent workflows
metadata:
  picoclaw:
    requires:
      bins: ["brainclaw"]
---

# brainclaw — structured project memory for PicoClaw

You have access to brainclaw, a structured memory system for projects.
It organizes knowledge so constraints, traps, and decisions persist across
scheduled runs and edge deployments.

brainclaw memory is shared with all agents working on the same repositories.
When you record something, every agent sees it.

## Before any scheduled task

Load minimal context (PicoClaw runs on constrained hardware):

```
brainclaw context --for <project-path> --profile compact
```

Only critical constraints and active plans are returned.

## During work

Record observations from monitoring, IoT data, or automated checks:

```
brainclaw trap "Sensor node 3 reporting intermittent connectivity" --severity medium
brainclaw decision "Switched to MQTT QoS 1 for reliability"
```

## Scheduled job pattern

For cron-triggered runs, use session start/end to track activity:

```
brainclaw session-start
# ... do work ...
brainclaw session-end --auto-release
```
