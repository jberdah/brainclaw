# Server And Remote Operations

This guide is for complex operator environments such as DGX hosts, remote Linux servers, SSH-driven workflows, and multi-project workspaces where Brainclaw is not being used from a single local IDE.

## When this guide matters

Use this path when one or more of these are true:

- Brainclaw runs on a remote machine over SSH
- multiple repos or child projects live under one server workspace
- different agents resume each other over time on the same host
- the operator sometimes uses CLI directly instead of MCP

## Recommended baseline

Prefer a disciplined single-environment workflow on the server:

1. choose one canonical checkout per active task
2. initialize Brainclaw in the target project before starting coordination work
3. avoid mixing multiple shells, PATH setups, or Node installations during the same session
4. treat shared-checkout parallel editing as risky unless each session gets a dedicated worktree

## Multi-project targeting

If the server workspace contains several Brainclaw projects, resolve the target project first.

```bash
brainclaw switch --list
brainclaw switch apps/trainer
brainclaw status
```

You can also use:

- `BRAINCLAW_PROJECT` for a shell-scoped default
- `brainclaw --cwd <path> ...` for a one-off override

The goal is to avoid writing memory into the wrong store when the operator is launched from a workspace root.

## Recommended session flow

For MCP-capable agents:

1. `bclaw_work(intent="execute", scope=...)` — opens a session, loads context, and claims the scope (with a per-claim git worktree) in a single call. Returns a compact payload by default; pass `compact: false` for the full memory dump or call `bclaw_context(kind="memory")` after.
2. `bclaw_context(kind="execution")` — when local tooling / brainclaw version visibility is needed (already loaded implicitly by `bclaw_work`).
3. `bclaw_write_note` / `bclaw_create(entity=...)` / `bclaw_update(entity=...)` — record observations, plans, decisions, or traps via the canonical grammar.
4. `bclaw_session_end(narrative=..., auto_release: true)` — close cleanly; releases active claims and hands off the session record.

For direct CLI operation:

```bash
brainclaw session-start --agent codex
brainclaw plan list --all
brainclaw claim create "Investigate training config drift" --scope configs/training/
brainclaw runtime-note "Observed host-specific CUDA mismatch on dgx-a"
brainclaw session-end --auto-release
```

`brainclaw runtime-note` is the CLI equivalent of `bclaw_write_note`.
`brainclaw note create "..."` is accepted as a resource-style alias if that fits the operator workflow better.

## Isolation and worktrees

The safest default remains sequential collaboration: one active agent per checkout, then handoff.

If you need stronger isolation:

```bash
brainclaw worktree create feat/dgx-audit
brainclaw worktree list
```

In MCP flows, `bclaw_claim` can also create a dedicated worktree automatically when supported by the current Brainclaw version and configuration.

Use dedicated worktrees when:

- two sessions need to touch the same repo without sharing a checkout
- an operator wants to preserve a clean main checkout while an agent runs elsewhere
- a remote machine hosts long-lived or resumable agent sessions

## Plan and step semantics

Be explicit about the difference between plan items and plan steps:

- `brainclaw plan show <id>` reads a single plan item
- `brainclaw plan get <id>` is accepted as a read alias, but `brainclaw plan show <id>` remains the canonical form
- `brainclaw plan update <id>` expects a `pln_*` plan ID
- `brainclaw complete-step <planId> <stepId>` is the canonical way to complete a step

If you only have a step ID, inspect the parent plan first with `plan show` or `plan list --json`.

## Notes, decisions, and traps

Do not use `decision` as a workaround for a session observation.

Use:

- `brainclaw runtime-note` for in-session observations
- `brainclaw reflect-runtime-note` when the note may deserve promotion
- `brainclaw decision` only for a durable decision
- `brainclaw trap` only for a reusable pitfall

This keeps canonical memory cleaner on long-lived server projects.

## Common failure modes

- Wrong project selected: use `brainclaw switch --list` and verify `brainclaw status`
- Shared-checkout collisions: prefer a worktree per session when parallel activity is unavoidable
- Confusion between plan IDs and step IDs: use `plan show` before `plan update`
- Lost operator observations: record them with `runtime-note` instead of temporary shell notes

## Recommended reading

- [quickstart.md](quickstart.md)
- [cli.md](cli.md)
- [integrations/mcp.md](integrations/mcp.md)
- [concepts/plans-and-claims.md](concepts/plans-and-claims.md)
- [concepts/runtime-notes.md](concepts/runtime-notes.md)
