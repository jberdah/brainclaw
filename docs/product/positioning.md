# Positioning

brainclaw is a **local-first coordination layer for humans and coding agents**.

It is not trying to become another coding agent, another hosted team platform, or another opaque memory service.

## The problem

Coding agents are good at local generation but weak at shared project state.

They often struggle with:

- remembering active constraints
- keeping track of recent decisions
- avoiding known traps
- coordinating shared plans
- handling handoffs cleanly
- avoiding collisions on files
- adapting instructions across different workspaces on the same machine

Traditional agent instruction files help, but they are relatively static.
They do not provide a living coordination layer for a workspace.

## What brainclaw does differently

brainclaw turns the workspace into a shared layer of:

- project memory
- implementation state
- coordination state
- prompt-ready context

Instead of relying only on fixed instruction files, brainclaw exposes fresh workspace state through files, CLI commands, and MCP tools.

It also writes directly to each agent's native instruction format — `CLAUDE.md`, `.cursor/rules/`, `.windsurfrules`, etc. — so the right context is always in the right place.

## What brainclaw is not

- a replacement for your coding agents
- a project management SaaS
- a black-box orchestration platform
- a cloud memory layer
- a replacement for Git

It sits next to existing tools and helps them collaborate more like a development team.

## Core product promise

brainclaw helps coding agents and humans work together around a shared workspace by making the important things explicit:

- what the project should remember
- what is currently being worked on
- who is touching which files
- what needs to be handed off
- what context is relevant right now

## Why local-first matters

Local-first gives teams:

- full control over data
- no network dependency
- no hidden storage
- plain text and JSON artifacts
- Git history for shared project state
- compatibility with enterprise or offline environments

## Licensing

brainclaw is published under the **Business Source License 1.1 (BSL 1.1)**.

### What this means in practice

| Use case | Status |
|----------|--------|
| Personal use, open-source projects | Free |
| Internal team or company use | Free |
| Embedding brainclaw in a product or service you sell | Requires a commercial license |
| Competitive products that replicate brainclaw's core value | Requires a commercial license |

### Why BSL instead of MIT

MIT gives users complete freedom, including the freedom to take the source, wrap it, and resell it as a competing product without contributing back. For a small independent project, that means large vendors can capture the market before the original author can sustain the work.

BSL 1.1 preserves all the practical freedoms of open source (inspect, use, modify, contribute) while protecting the economic viability of the project. It is used by projects like MariaDB, HashiCorp Vault, and Sentry.

### Conversion to MIT

The BSL includes an automatic conversion clause: the license converts to **MIT** after 4 years from each release date. Every version of brainclaw will eventually become fully open source.

### Commercial licensing

If your use case requires a commercial license, contact the project author. The intent is not to restrict legitimate internal use — it is to prevent competitive product embedding without a fair contribution back to the project.

## Positioning summary

> A local-first coordination layer for humans and coding agents.
