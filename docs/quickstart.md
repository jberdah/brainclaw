# Quickstart

This guide walks through the shortest path to getting value from brainclaw.

## 1. Bootstrap and initialize the workspace

```bash
brainclaw setup --yes
brainclaw init
```

`setup` installs the machine-level prerequisites and agent integrations. `init` then creates the workspace state, seeds stable identity, and prepares the project memory structure.
If an AI coding agent is detected in the environment, brainclaw also writes to its native instruction file automatically.

## 2. Capture the first important facts

```bash
brainclaw memory create decision "OAuth migration now goes through auth-gateway" --tag auth
brainclaw memory create constraint "Payments module frozen until 2026-04-01" --tag payments
brainclaw memory create trap "Checkout E2E tests are flaky on Windows" --severity high --tag tests
```

These become part of the shared project memory.

## 3. Create a shared plan

```bash
brainclaw plan create "Coordinate auth rollout" --priority high
brainclaw plan list
```

## 4. Claim work before editing

```bash
brainclaw claim create "Taking auth rollout" --agent copilot --scope src/auth/ --plan pln_001
brainclaw claim list --plan pln_001
```

Claims reduce collisions when multiple agents or humans work in the same repo.

## 5. Create an explicit handoff

```bash
brainclaw memory create handoff "Review auth patch" --from copilot --to claude --plan pln_001
```

## 6. Generate context for an agent

```bash
brainclaw context --for src/auth/routes.ts --digest
brainclaw context --json --max-chars 1200
```

Use this to prepare compact context before edits or reviews.

## 7. Export to your agent's native instruction file

```bash
brainclaw export --detect          # auto-detects running agent, writes to its file
brainclaw export --format claude-md --write   # writes CLAUDE.md and gitignores it by default
brainclaw export --format cursor-rules --write  # writes .cursor/rules/brainclaw.md and gitignores it by default
brainclaw export --format claude-md --write --shared  # only if you intentionally want to commit it
```

## 8. Inspect the current board

```bash
brainclaw status
brainclaw agent-board --agent copilot
```

## Recommended first workflow

1. initialize the workspace
2. record 3–5 important decisions or traps
3. create one shared plan
4. use claims for touched folders
5. generate context before edits
6. hand off explicitly when switching between agents

## Next reads

- [cli.md](cli.md) — full command reference
- [concepts/memory.md](concepts/memory.md)
- [concepts/plans-and-claims.md](concepts/plans-and-claims.md)
- [integrations/overview.md](integrations/overview.md)
