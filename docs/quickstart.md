# Quickstart

This guide is organized by entry path, because Brainclaw serves different surfaces with different roles.

Use this rule first:

- capable agent with MCP support: prefer MCP for dynamic state
- agent surface driven mainly by local instruction files: use generated native files plus CLI fallback
- human operator or maintainer: use the CLI directly

## Important limitation for now

Do not run multiple coding agents in parallel on the same project checkout yet.

Brainclaw is already useful for sequential collaboration: one agent can pick up where another stopped, inspect shared context, and continue from explicit plans, claims, traps, and handoffs. But until Brainclaw supports dedicated Git worktrees per agent/session, parallel edits in the same checkout are still likely to create more Git and workspace problems than they solve.

For now, prefer:

1. one active editing agent per checkout
2. explicit handoffs between agents
3. claims and context to keep continuity between sessions

## Path 1: Agent-First With MCP

Use this path when the agent can call Brainclaw through MCP.

### Operator bootstrap

```bash
brainclaw setup --yes
brainclaw init
```

`setup` installs machine-level prerequisites and agent integrations. `init` creates the workspace state, seeds stable identity, and prepares the project memory structure.

### Agent runtime pattern

After the workspace is initialized, the nominal flow is:

```text
bclaw_session_start   -> open a session and return current board/context
bclaw_get_context     -> fetch fresh prompt-ready context for the target path
bclaw_list_plans      -> inspect active work
bclaw_claim           -> claim scope before editing
bclaw_write_note      -> record runtime observations
bclaw_session_end     -> close session cleanly and hand work off
```

Use native agent files such as `AGENTS.md`, `CLAUDE.md`, or Cursor rules as local workflow guidance, not as the only source of live state.

## Path 2: CLI-Oriented Agent Or Fallback Workflow

Use this path when the agent does not have a good MCP integration yet, or when a human needs to drive the workflow directly.

### Bootstrap and inspect

```bash
brainclaw setup --yes
brainclaw init
brainclaw export --detect --write
```

### Record the first important facts

```bash
brainclaw memory create decision "OAuth migration now goes through auth-gateway" --tag auth
brainclaw memory create constraint "Payments module frozen until 2026-04-01" --tag payments
brainclaw memory create trap "Checkout E2E tests are flaky on Windows" --severity high --tag tests
```

### Create and claim work

```bash
brainclaw plan create "Coordinate auth rollout" --priority high
brainclaw claim create "Take auth rollout" --scope src/auth/
```

### Refresh context before edits

```bash
brainclaw context --for src/auth/routes.ts --digest
brainclaw status
```

Claims reduce collisions, but they are not a substitute for isolated worktrees yet. Use them mainly to coordinate sequential work or human/agent awareness in the same repo.

## Path 3: Brownfield Onboarding

Use this path when you are adopting Brainclaw into an existing workspace and do not want to hand-author all memory from scratch.

### Build the initial bootstrap view

```bash
brainclaw setup --yes
brainclaw init
brainclaw bootstrap --json
```

### Fill the gaps

```bash
brainclaw bootstrap --interview --audience cli
brainclaw bootstrap --interview --audience ide_chat
```

Use the returned question IDs to prepare a small JSON answers file when the interview needs to confirm durable memory:

```json
[
  {
    "question_id": "biq_example",
    "response_items": ["Use agents sequentially in one checkout."],
    "suggestions": []
  }
]
```

Preview the enriched import proposal:

```bash
brainclaw bootstrap --answers-file ./bootstrap-answers.json --json
```

### Apply or rollback managed imports

```bash
brainclaw bootstrap --answers-file ./bootstrap-answers.json --apply
brainclaw bootstrap --uninstall
```

Use this path when the repo already has native instruction files, partial docs, or conventions that Brainclaw should adopt selectively instead of replacing blindly.

## Recommended First Workflow

1. initialize the workspace
2. choose the correct entry path for your surface
3. record or import 3-5 high-signal facts
4. create one shared plan
5. claim scope before editing
6. refresh context before significant edits
7. hand off explicitly when switching between agents

## Next Reads

- [integrations/overview.md](integrations/overview.md) — integration model by surface
- [integrations/mcp.md](integrations/mcp.md) — nominal dynamic path for capable agents
- [cli.md](cli.md) — operator and fallback reference
- [concepts/memory.md](concepts/memory.md)
- [concepts/plans-and-claims.md](concepts/plans-and-claims.md)
