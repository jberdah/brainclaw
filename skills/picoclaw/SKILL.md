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

<!-- brainclaw:start -->
> Managed by brainclaw v1.0.0 — do not edit manually.
> Regenerate: brainclaw export --format agents-md --write

## brainclaw — this project

# Brainclaw

Multi-agent coordination tool for AI coding agents.
CLI + MCP server providing shared memory, claims, plans, and handoffs
across Claude Code, Copilot, Codex, Cursor, Windsurf, Cline, and others.

- **Stage:** v1.0 shipped, Phase 4 (operator maturity) complete. Private usage across a few machines; adoption-grade hardening in progress.
- **Audience:** AI coding agents + human dev supervisors.
- **Stack:** TypeScript, ESM (Node ≥18), zero runtime deps beyond commander/yaml/zod. MCP over stdio.
- **Architecture:** File-based store (`.brainclaw/`), canonical grammar (`bclaw_work`, `bclaw_context`, `bclaw_find/get/create/update/remove/transition`), per-agent surfaces generated from a single source of truth.
- **Current focus:** Cross-agent surface coherence (facade-first everywhere), onboarding for a fresh agent, federation groundwork.

## brainclaw — session protocol

1. Call `bclaw_work(intent)` to start working — it handles session, context, and claims automatically.
2. Use the canonical grammar (`bclaw_find` / `bclaw_get` / `bclaw_create` / `bclaw_update` / `bclaw_remove` / `bclaw_transition`) to work with memory objects (plans, decisions, constraints, traps, handoffs, claims, candidates, runtime_notes, …). Read `## brainclaw — working with memory` below for the full map.
3. Do not assume project state without reading brainclaw context first.

_Escalation path (only when you orchestrate other agents):_ `bclaw_coordinate(intent)` to assign/consult/review, `bclaw_dispatch(intent)` for sequence lanes, `bclaw_loop` for multi-turn review/ideation loops.

## brainclaw — working rules

- Ship-per-feature workflow: claim -> branch -> implement -> test -> commit -> merge -> bump -> publish -> export --all -> release claim -> push. One feature = one branch = one merge commit.
- Tests that need a brainclaw store must use direct API calls (ensureMemoryDir + saveConfig) instead of shelling out to CLI. If test MUST test CLI behavior, ensure dist/ is built in CI.
- Enforcement > Documentation — traps documented but not enforced must move toward pre-merge/pre-push checks. Agent ergonomics > Minimalism.
- Release hygiene: after a version bump and before push, run brainclaw export --all so generated instruction files stay aligned with memory changes.
- DECISION: Sequence items should support stepId reference in addition to planId, enabling fine-grained step-level dispatching across lanes. Current limitation forces plan-level granularity only.
- Dispatch retro (2026-04-08) — actionable fixes for brainclaw dispatch system:

1. WORKTREE BRANCH ORIGIN: worktree creation must fork from coordinator's current HEAD, not repo default. When coordinator is on feat/X, dispatched agents must start from feat/X tip. File: src/core/worktree.ts
2. BRIEF AUTO-CONTEXT: bclaw_dispatch should auto-include git log of recent commits on target branch in the generated brief, so agents know what was already changed. File: src/core/dispatcher.ts
3. REVIEW LANE TYPE: sequence schema should support lane_type:"review" with implicit hard_after on all execution lanes. Review agents read diffs + validate against source. File: src/core/schema.ts
4. DISPATCH→EXECUTION BRIDGE: pln_65eab326 is validated as critical. bclaw_dispatch must return bash commands the coordinator can run_in_background, not just metadata.
5. WORKTREE AUTO-CLEANUP: merge success should auto-delete the worktree dir + prune git refs. File: src/core/worktree.ts, src/commands/worktree.ts
- Audience playbook audit — Teams & Ops gaps to address:
1. No merge conflict resolution tooling (worktrees created, merges left to git)
2. No push notifications / webhooks (event-log.ts = polling only, no real-time alerts)
3. Claim expiry has no background enforcement (logic exists in claims.ts but needs trigger)
4. No path-level access restrictions (trust levels are all-or-nothing, no scope-based permissions)
5. No web dashboard / visualization (CLI text + JSON only, no HTML/graphs)
6. No pre-built CI GitHub Action (works manually but no reusable template)
7. Plan dependencies lack cycle/deadlock detection (hard_after/soft_after exist, no DAG validation)
8. No team onboarding walkthrough (new members get greenfield init, not project tour)
- Audience playbook audit — AI Builders gaps to address:
1. No plugin/extension system (bclaw_add_tool = metadata only, not executable MCP extensions)
2. No tool-level API versioning or deprecation lifecycle (protocol version exists, tools are unversioned)
3. No real-time event streaming (event-log.ts = cursor polling, no WebSocket/SSE/pub-sub)
4. No rate limiting / quota enforcement (circuit-breaker.ts exists but unused, LLM tools unlimited)
5. Memory type system is closed (hardcoded enum in schema.ts, no custom types)
6. No multi-tenant isolation beyond project boundaries (no team/dept within a project)
7. Token/cost tracking has no enforcement (usage.ts tracks but no quotas/alerts)
8. Tool discovery lacks trust/dependency introspection (57 tools flat, no categorization)
9. No metrics MCP endpoint (CLI metrics exist but not exposed as MCP tools)
- Dispatch retro (2026-04-08) — actionable fixes for brainclaw dispatch system:

1. WORKTREE BRANCH ORIGIN: worktree creation must fork from coordinator's current HEAD, not repo default. When coordinator is on feat/X, dispatched agents must start from feat/X tip. File: src/core/worktree.ts
2. BRIEF AUTO-CONTEXT: bclaw_dispatch should auto-include git log of recent commits on target branch in the generated brief, so agents know what was already changed. File: src/core/dispatcher.ts
3. REVIEW LANE TYPE: sequence schema should support lane_type:"review" with implicit hard_after on all execution lanes. Review agents read diffs + validate against source. File: src/core/schema.ts
4. DISPATCH→EXECUTION BRIDGE: pln_65eab326 is validated as critical. bclaw_dispatch must return bash commands the coordinator can run_in_background, not just metadata.
5. WORKTREE AUTO-CLEANUP: merge success should auto-delete the worktree dir + prune git refs. File: src/core/worktree.ts, src/commands/worktree.ts
- AGENT WORKTREE PERMISSIONS MODEL (2026-04-09): Each agent has its own config pattern for worktree isolation. The invoke template must include auto-approve flags AND cd into worktree.

Pattern: cd /worktree && [agent-specific config write] && [agent -y "task"]

Key findings per agent:
- Cline: -y flag (YOLO) + .clinerules per worktree
- OpenCode: opencode.json with external_directory deny + opencode /path
- Continue: cn --auto or --allow Write --allow Edit
- Kilo Code: kilo.jsonc with permission.external_directory deny
- Roo Code: roo -y + .rooignore
- Aider: --yes --no-auto-commits --subtree-only
- Codex: --sandbox workspace-write (via config.toml profiles)

Action: update invoke_template in agent-capability.ts to include auto-approve flags. Consider writing per-worktree config files (opencode.json, .clinerules) as part of dispatch pre-flight.
- When Brainclaw Cloud seeds or provisions the default platform super admin account, the canonical email must be support@brainclaw.dev.

## brainclaw — architecture

- Auto-worktree must be default-on for multi-agent to be reliable. Git-level isolation (worktrees) is required — brainclaw coordination alone is not sufficient.
- Federation business logic must go through the Transport abstraction. Direct HTTP belongs only inside transport implementations, not in higher-level coordination logic. Phase 0 targets local-fs; later phases can add a Cloudflare transport.

## brainclaw — active instructions

- Use "dev" script: npm run clean:dist && tsc && node scripts/copy-default-profiles.mjs && node dist/cli.js
<!-- brainclaw:end -->
