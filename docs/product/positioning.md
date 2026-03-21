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

## License direction

Today, brainclaw is published under the **Business Source License 1.1 (BSL 1.1)**.

The direction after the closed beta is simpler:

- the local-first brainclaw core is intended to move to MIT
- remote shared-memory, hosted collaboration, advanced dashboards, and related private add-ons will stay separate commercial products

The intended MIT core covers the local coordination layer:

- local project memory
- local MCP and CLI workflows
- onboarding and bootstrap
- plans, claims, handoffs, and runtime notes
- local agent integrations

The commercial side is meant to cover capabilities that go beyond the local-first core:

- shared memory through the cloud for agents working across machines
- hosted sync and collaboration services
- advanced dashboards
- private add-ons around those hosted features

The goal is not to ship a stripped-down teaser. The goal is to keep the public core complete and useful on its own, while keeping remote and hosted features in a separate product line.

## Positioning summary

> A local-first coordination layer for humans and coding agents.
