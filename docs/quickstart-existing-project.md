# Joining a project that already uses brainclaw

You cloned a repo and noticed `.brainclaw/` already exists — someone (or something) has set it up before you. This page walks through the read-then-register path for arriving on a configured project, which is **different** from creating a new one.

If the repo is brand new and `.brainclaw/` is absent, see [quickstart.md](quickstart.md) instead.

## When to use this page

| Situation | Use |
|---|---|
| Repo has no `.brainclaw/` | [quickstart.md](quickstart.md) (`brainclaw init`) |
| Repo has `.brainclaw/`, you've never worked here | **this page** (`brainclaw init` upsert + discovery) |
| Repo has memory but it was scraped from docs/git, not curated | [bootstrap](concepts/workspace-bootstrapping.md) (`brainclaw bootstrap --apply`) |

The three commands now target different lifecycle stages:
- `setup-machine` bootstraps the current machine
- `init` creates or refreshes project setup safely
- `bootstrap` extracts project context into memory
- `enable-agent` explicitly joins another agent to the same project

## Step 0 — verify your install is compatible

```bash
brainclaw --version
```

Compare with what the project expects. If `.brainclaw/config.yaml` has a `version_policy` block, it tells you the minimum version the project requires. If your local version is older, `brainclaw doctor --json` will surface a `version_policy` failure.

To upgrade:

```bash
npm install -g brainclaw@latest
```

(or pull the team's local-pack tarball from `.releases/` if the project doesn't publish to npm.)

## Step 1 — bootstrap this machine if needed

```bash
brainclaw setup-machine --yes
```

Run this once on a fresh machine so Brainclaw can configure the agents it detects before you touch any project-level state.

## Step 2 — refresh project setup for the current agent

```bash
brainclaw init
```

On a project that already has `.brainclaw/`, `brainclaw init` acts as a safe upsert. It preserves the existing memory and refreshes the managed Brainclaw and detected-agent files for the machine you're using now.

If you want the explicit path for a different or additional agent, run:

```bash
brainclaw enable-agent <agent-name>
```

`<agent-name>` is one of `claude-code`, `codex`, `copilot`, `cursor`, `cline`, `windsurf`, `continue`, `kilocode`, `mistral-vibe`, `hermes`, `roo`, `opencode`, `antigravity`, etc. (see [docs/integrations/overview.md](integrations/overview.md) for the full list).

These commands:
- Detect the agent in your environment (env vars, installed CLIs, IDE)
- Writes the agent's native instruction file (`CLAUDE.md`, `.cursor/rules/`, `AGENTS.md`, etc.) from the project's current memory
- Wires the MCP server config so the agent can call brainclaw at runtime
- Adds the generated files to `.gitignore` (they're regenerated locally per developer)

If you use multiple agents on the same project, run `enable-agent` once per agent.

## Step 3 — read what already exists

Before touching code, load the project's accumulated knowledge so you don't re-discover what others already learned.

### Via the CLI (you, the human)

```bash
brainclaw context           # full project memory as text (constraints, decisions, traps, plans)
brainclaw agent-board       # current state of plans, claims, and open handoffs
brainclaw stale list        # what looks abandoned and might need attention
```

### Via your agent (recommended day-to-day)

Tell the agent to call:

```text
bclaw_work(intent="resume")
```

This single MCP call returns: open plans, recent decisions, active constraints, known traps, latest handoff narrative, plus a context-diff hint. Your agent reads that *before* writing any code.

For a narrower view focused on the area you're about to touch:

```text
bclaw_context(kind="memory", path="src/<area>/")
```

## Step 4 — discover in-flight work

Several things may be already underway when you arrive:

```bash
# Plans that other agents/humans started
brainclaw plan list --status in_progress

# Scopes someone else has claimed (don't touch those without coordination)
brainclaw claim list

# Sequences with parallel lanes still active
brainclaw sequence list --status active

# Open handoffs waiting for a reviewer
brainclaw inbox list
```

Or one-shot via MCP:

```text
bclaw_context(kind="board")
```

The board surfaces all four (plans, claims, sequences, handoffs) in one structured response.

## Step 5 — pick what to work on

You have a few honest options:

1. **Pick up an open handoff** — `brainclaw inbox list` shows handoffs targeted at you (or unassigned). Read the handoff narrative, then claim its scope and start.
2. **Take a `todo` plan** — `brainclaw plan list --status todo` returns work nobody has started yet.
3. **Start something new** — create a fresh plan with `bclaw_create(entity="plan", data={…})`, then claim its scope. Make sure you're not duplicating an existing plan first.

In all three cases, the workflow is then the same: `bclaw_work(intent="execute", scope=…, planId=…)` opens a session, claims the scope (with an isolated git worktree), and loads the relevant context.

## Step 6 — verify your setup is healthy before commiting changes

Once you've started working, sanity-check:

```bash
brainclaw doctor
```

This runs a series of checks: state validity, MCP runtime health (post-pln#478), agent-integration declarations, claim hygiene, freshness markers. If anything is amber or red, see [docs/concepts/troubleshooting.md](concepts/troubleshooting.md) for the runbook.

## What this page does *not* cover

- **Creating a new project** → [quickstart.md](quickstart.md)
- **Extracting context from an existing repo without `.brainclaw/`** → [bootstrap](concepts/workspace-bootstrapping.md)
- **Setting up brainclaw on your machine for the first time** → [docs/integrations/overview.md](integrations/overview.md) (`brainclaw setup-machine` or the broader `brainclaw setup` flow)
- **Recovering from a degraded state** → [docs/concepts/troubleshooting.md](concepts/troubleshooting.md)

## See also

- [docs/quickstart.md](quickstart.md) — full first-time setup (greenfield)
- [docs/concepts/plans-and-claims.md](concepts/plans-and-claims.md) — claim/plan model
- [docs/concepts/multi-agent-workflows.md](concepts/multi-agent-workflows.md) — coordination patterns once you're settled in
- [docs/concepts/troubleshooting.md](concepts/troubleshooting.md) — when things go wrong
