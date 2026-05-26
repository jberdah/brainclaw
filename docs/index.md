# Documentation Index

Use this page as the entry point into the packaged Markdown documentation.

## Getting Started

- [quickstart.md](quickstart.md) — fastest onboarding path for a new project (greenfield)
- [quickstart-existing-project.md](quickstart-existing-project.md) — joining a project that already has `.brainclaw/`
- [server-operations.md](server-operations.md) — remote server, DGX, SSH, and multi-project operator workflow
- [integrations/overview.md](integrations/overview.md) — integration model by agent surface

## Guides

- [integrations/mcp.md](integrations/mcp.md) — recommended runtime path for MCP-capable agents
- [integrations/agents.md](integrations/agents.md) — agent integration principles and setup details
- [release-maintenance.md](release-maintenance.md) — release checklist for CLI/MCP/context-schema changes
- [review.md](review.md) — reflective workflow and candidate promotion
- [storage.md](storage.md) — storage model and canonical vs derived state
- [security.md](security.md) — security model and guardrails

## Concepts

- [concepts/memory.md](concepts/memory.md)
- [concepts/plans-and-claims.md](concepts/plans-and-claims.md)
- [concepts/runtime-notes.md](concepts/runtime-notes.md)
- [concepts/coordination.md](concepts/coordination.md)
- [concepts/multi-agent-workflows.md](concepts/multi-agent-workflows.md)
- [concepts/workspace-bootstrapping.md](concepts/workspace-bootstrapping.md)
- [concepts/troubleshooting.md](concepts/troubleshooting.md) — runbook for degraded coordination state
- [concepts/memory-staleness.md](concepts/memory-staleness.md)
- [concepts/loop-engine.md](concepts/loop-engine.md)
- [concepts/ideation-loop.md](concepts/ideation-loop.md) — memory-confrontation ideation loop (v1.5.0+)
- [concepts/mcp-governance.md](concepts/mcp-governance.md)

## Reference

- [cli.md](cli.md) — CLI reference
- [context-format.md](context-format.md) — public context contract
- [context-format-changelog.md](context-format-changelog.md)
- [mcp-schema-changelog.md](mcp-schema-changelog.md)

## Agent-Specific Notes

- [integrations/claude-code.md](integrations/claude-code.md)
- [integrations/codex.md](integrations/codex.md)
- [integrations/cursor.md](integrations/cursor.md)
- [integrations/copilot.md](integrations/copilot.md)
- [integrations/continue.md](integrations/continue.md)
- [integrations/roo.md](integrations/roo.md)
- [integrations/windsurf.md](integrations/windsurf.md)
- [integrations/opencode.md](integrations/opencode.md)
- [integrations/kilocode.md](integrations/kilocode.md)
- [integrations/mistral-vibe.md](integrations/mistral-vibe.md)
- [integrations/hermes.md](integrations/hermes.md)
- [integrations/openclaw.md](integrations/openclaw.md)

## Audience Design Constraints

Internal design reference — constraints that guide brainclaw development per target audience.

- [playbooks/productivity/](playbooks/productivity/index.md) — end-users & solo devs
- [playbooks/team/](playbooks/team/index.md) — teams & ops
- [playbooks/integration/](playbooks/integration/index.md) — AI builders

## Design And Proposals

- [architecture/project-refs.md](architecture/project-refs.md) — target navigation model, not the fully shipped surface
- [product/positioning.md](product/positioning.md)
- [adapters/openclaw.md](adapters/openclaw.md)
