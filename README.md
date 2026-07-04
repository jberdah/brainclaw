<p align="center">
  <img src="https://brainclaw.dev/logo.png" alt="brainclaw" width="140" />
</p>

<h1 align="center">brainclaw</h1>

<p align="center"><strong>Local-first coordination and shared memory for coding agents.</strong></p>

<p align="center">
  <a href="https://github.com/jberdah/brainclaw/actions/workflows/ci.yml"><img src="https://github.com/jberdah/brainclaw/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/brainclaw"><img src="https://img.shields.io/npm/v/brainclaw?logo=npm" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/brainclaw"><img src="https://img.shields.io/npm/dm/brainclaw" alt="npm downloads"></a>
  <img src="https://img.shields.io/node/v/brainclaw" alt="node version">
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/brainclaw" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/MCP-stdio-blue" alt="MCP">
</p>

---

If you've ever:

- **lost your conversation** when your agent hit credit limits mid-task,
- returned to a project **after a week** with no idea where you left off,
- watched two coworkers (or two agents) **edit the same files** without knowing it,
- or **gave up running multiple agents in parallel** because keeping them in sync was a pain,

brainclaw gives you durable shared state across sessions, agents, and teammates. Plans, claims, handoffs, decisions, and traps live in `.brainclaw/`, work identically across any compatible agent (Claude Code, Codex, Copilot, Cline, OpenCode, Cursor, Windsurf, Kilocode, Roo Code, Continue, Mistral Vibe, Hermes, Antigravity/Gemini CLI, …), and stay accessible whether you orchestrate them in parallel or pick them up one after another.

Use it two ways — **together or separately**:

- **Active orchestration** — dispatch work in parallel across multiple agent instances. Dispatched work runs in isolated Git Worktrees to prevent conflicts, sequences manage lane dependencies, the dispatcher routes by capacity.
- **Async shared state** — when an agent runs out of credits, when you return to a project after weeks, or when teammates work in parallel: the next agent (or you) resumes cleanly with the same context, plans, and constraints.

The same primitives — plans, claims, handoffs, decisions, traps — serve both modes. That's the design point. brainclaw stores everything locally as plain text + JSON, versions it in Git, and asks no opinion about which agent you should use for what.

It sits alongside your coding agents and gives them a shared state layer they can resume from reliably. brainclaw is also starting to model other local AI work surfaces on the same machine, such as ChatGPT Desktop, Claude Desktop, Claude Cowork, and Gemini web or CLI, to keep a project-level queue of non-code work for those surfaces.

---

## What it provides

|                                        |                                                                                                                                                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Project memory**               | constraints, decisions, traps, handoffs, and layered instructions agents can resume from                                                                                                            |
| **Coordination state**           | shared plans, file claims (dispatched work isolated in Git Worktrees), runtime notes, and board views for active work                                                                                                 |
| **Agent-ready context**          | compact, prompt-sized context built from real workspace state instead of stale instructions                                                                                                         |
| **Code Map**                     | a Tree-sitter symbol + import index (JS/TS, Python, PHP, Java) so agents ask "where is X / what should I read first" before editing, with related decisions/traps attached — `bclaw_code_find` / `bclaw_code_brief`, see [code map](docs/code-map.md) |
| **Native agent files**           | auto-writes `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules/`, `.windsurfrules`, and similar local guidance                                                                         |
| **Multi-turn loops**             | review and ideation loops with structured phases, iteration semantics, and per-phase memory filters — see[loop engine](docs/concepts/loop-engine.md) and [ideation loop](docs/concepts/ideation-loop.md) |
| **Machine AI surface discovery** | detects local coding agents plus desktop AI work surfaces such as ChatGPT Desktop and Gemini CLI                                                                                                    |
| **Queued surface tasks**         | stores project-scoped requests for other local AI surfaces, such as visual generation, drafting, summaries, or research                                                                             |
| **Local-first storage**          | plain text + JSON, Git-friendly, no mandatory cloud, no telemetry by default                                                                                                                        |

---

## Code Map

When an agent (or you) is about to edit unfamiliar code, the first question is *"where is this, and what should I read first?"* Code Map answers it without grepping: a per-project [Tree-sitter](https://tree-sitter.github.io/) index of the symbols each file defines (functions, classes, types, React components/hooks), what it imports/exports, and how files relate — across **JS / TS / TSX, Python, PHP, and Java**.

```bash
brainclaw code-map find useAuth        # locate a symbol / component / hook by name
brainclaw code-map brief src/App.tsx   # ranked "read these first" list + related decisions/traps
```

Capable agents use the MCP equivalents `bclaw_code_find` / `bclaw_code_brief`, each carrying a freshness badge. Code Map is a **discovery aid, not a build artifact**: it never changes your code, never blocks `bclaw_work`, and degrades gracefully — a stale or missing index says so instead of answering wrong. Pull-based (no daemon) and monorepo-aware. Full guide: **[Code Map](docs/code-map.md)**.

---

## Measured agent experience

The onboarding path a fresh agent takes — init, first `bclaw_work`, first `code_find` — is exercised on every CI run by a reproducible bench (`scripts/bench.mjs`) against a synthetic store calibrated on the shape of a real production project (~200 plans, ~500 handoffs, ~450 claims). Budgets (`bench-budgets.json`) live in the repo alongside the coverage gate; a regression beyond a per-scenario tolerance fails the build. The latest report ships as `dist/facts.json` under `facts.bench` so the site can render current numbers.

The bench covers three scenarios:

- **Cold onboard** — fresh machine → init → first useful context. Measures the baseline time-to-first-value.
- **Warm work** — `bclaw_work` consult over a real-shaped store. Tracks the cost of building context when the store is non-empty (the surface `pln#578`/`pln#566` optimise).
- **First edit** — `code_find` + `code_brief` on the fresh-agent path. Tracks payload compactness (`pln#598`) and match relevance (`pln#601`).

Reproduce locally with `npm run bench` (writes `dist/bench-report.json`); check budgets with `npm run bench:check`. The bench runs in-process against synthetic fixtures, so it is deterministic per seed and safe to run on any machine.

---

## Agent Surfaces

brainclaw exposes the same collaboration state through three surfaces, but they do not have the same role in an agent-first workflow.

| Surface                      | Primary use                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **MCP**                | default path for capable agents that need fresh context, board state, plans, claims, and write operations          |
| **Native agent files** | local guidance and bootstrap hints for a specific agent surface (`AGENTS.md`, `CLAUDE.md`, Cursor rules, etc.) |
| **CLI**                | operator workflows, scripting, setup, debugging, release, and fallback access when MCP is not the integration path |

If you are documenting or integrating an agent workflow, treat MCP as the primary runtime path.

---

## Works With

brainclaw is designed to sit alongside the coding agents teams are already using, not behind a separate hosted control plane.

### Code Agents

| Logo                                                                                                                                       | Agent                                                                          | Tier | What brainclaw configures                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ---- | ----------------------------------------------------------------------- |
| [![Claude Code](https://img.shields.io/badge/Claude_Code-111111?logo=anthropic&logoColor=white)](https://github.com/anthropics/claude-code)     | **[Claude Code](https://github.com/anthropics/claude-code)**                | A    | MCP + CLAUDE.md + hooks + auto-approve + permissions + /brainclaw skill |
| [![Codex](https://img.shields.io/badge/Codex-111111?logo=openai&logoColor=white)](https://openai.com/codex/)                                    | **[Codex](https://openai.com/codex/)**                                      | A    | MCP + AGENTS.md + skills                                                |
| [![Cursor](https://img.shields.io/badge/Cursor-1F2430?logo=cursor&logoColor=white)](https://cursor.com/en-US)                                   | **[Cursor](https://cursor.com/en-US)**                                      | A    | MCP (machine) + .cursor/rules/ + hooks + skills                         |
| [![Windsurf](https://img.shields.io/badge/Windsurf-0B1220?logo=codeium&logoColor=white)](https://windsurf.com/)                                 | **[Windsurf](https://windsurf.com/)**                                       | A    | MCP (machine) + .windsurfrules + .windsurf/rules/                       |
| [![Cline](https://img.shields.io/badge/Cline-0F766E?logoColor=white)](https://github.com/cline/cline)                                           | **[Cline](https://github.com/cline/cline)**                                 | A    | MCP + auto-approve + .clinerules/                                       |
| [![GitHub Copilot](https://img.shields.io/badge/GitHub_Copilot-181717?logo=githubcopilot&logoColor=white)](https://github.com/features/copilot) | **[GitHub Copilot](https://github.com/features/copilot)**                   | A    | MCP + copilot-instructions.md + hooks + skills                          |
| [![Roo](https://img.shields.io/badge/Roo-7C3AED?logoColor=white)](https://github.com/RooCodeInc/Roo-Code)                                       | **[Roo](https://github.com/RooCodeInc/Roo-Code)**                           | B    | MCP + auto-approve + .roo/rules/                                        |
| [![Continue](https://img.shields.io/badge/Continue-2563EB?logoColor=white)](https://github.com/continuedev/continue)                            | **[Continue](https://github.com/continuedev/continue)**                     | B    | MCP + .continue/rules/                                                  |
| [![OpenCode](https://img.shields.io/badge/OpenCode-0F172A?logoColor=white)](https://github.com/opencode-ai/opencode)                            | **[OpenCode](https://github.com/opencode-ai/opencode)**                     | B    | MCP + AGENTS.md                                                         |
| [![Gemini CLI](https://img.shields.io/badge/Gemini_CLI-1A73E8?logo=googlegemini&logoColor=white)](https://github.com/google-gemini/gemini-cli)  | **[Antigravity / Gemini CLI](https://github.com/google-gemini/gemini-cli)** | B    | MCP + GEMINI.md                                                         |

**Tier A** = strongest supported integration for that agent family (usually MCP plus native files, and hooks/skills where the agent exposes them). **Tier B** = MCP/native-file integration with fewer automation surfaces. Tier can degrade at runtime if integration surfaces are missing.

### Autonomous Agents

| Logo                                                                                                                   | Agent                                                               | Tier | What brainclaw configures                                      |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---- | -------------------------------------------------------------- |
| [![OpenClaw](https://img.shields.io/badge/OpenClaw-FF6B35?logoColor=white)](https://github.com/openclaw/openclaw)           | **[OpenClaw](https://github.com/openclaw/openclaw)**             | B    | MCP + brainclaw skill (SKILL.md) for structured project memory |
| [![Hermes](https://img.shields.io/badge/Hermes-111111?logoColor=white)](https://github.com/NousResearch/hermes-agent)       | **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** | B    | MCP + universal `.agents/skills/brainclaw/SKILL.md`          |
| [![NanoClaw](https://img.shields.io/badge/NanoClaw-4A90D9?logoColor=white)](https://github.com/qwibitai/nanoclaw)           | **[NanoClaw](https://github.com/qwibitai/nanoclaw)**             | C    | brainclaw skill — messaging agent (WhatsApp, Telegram, Slack) |
| [![NemoClaw](https://img.shields.io/badge/NemoClaw-76B900?logo=nvidia&logoColor=white)](https://github.com/NVIDIA/NemoClaw) | **[NemoClaw](https://github.com/NVIDIA/NemoClaw)**               | C    | brainclaw skill — NVIDIA enterprise agent stack               |
| [![PicoClaw](https://img.shields.io/badge/PicoClaw-00ADD8?logo=go&logoColor=white)](https://github.com/sipeed/picoclaw)     | **[PicoClaw](https://github.com/sipeed/picoclaw)**               | C    | brainclaw skill — edge/IoT agent (Go, <10MB RAM)              |
| [![ZeroClaw](https://img.shields.io/badge/ZeroClaw-B7410E?logoColor=white)](https://github.com/zeroclaw-labs/zeroclaw)      | **[ZeroClaw](https://github.com/zeroclaw-labs/zeroclaw)**        | C    | brainclaw skill — ultra-lightweight Rust agent (20+ channels) |

**Tier C** = no MCP, no hooks — skill-based only with inline context and constrained resources. Autonomous agents use `--profile compact` for short sessions.

brainclaw is most effective today when one agent works at a time in a given checkout and the next agent resumes from shared context, claims, and handoffs.

---

## Platform Support

brainclaw requires Node.js 22.12+ (`engines.node = ">=22.12.0"`). CI exercises Node 22 (Active LTS) and Node 24 (current LTS) on Linux; Windows runs on Node 24. Node 20 reached EOL in April 2026 and is no longer supported — the commander 15 upgrade requires Node ≥22.12. The recommended runtime is Node 22 LTS or Node 24 LTS.

| Logo                                                                                                                                            | Platform                                                          | Status today              | Notes                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [![Linux](https://img.shields.io/badge/Linux-111111?logo=linux&logoColor=white)](https://www.kernel.org/)                                            | **[Linux](https://www.kernel.org/)**                           | Recommended               | best-supported environment today; GitHub CI runs on Ubuntu with Node 22 and 24                                           |
| [![macOS](https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white)](https://www.apple.com/macos/)                                       | **[macOS](https://www.apple.com/macos/)**                      | Likely supported          | Unix-like path and shell model should map well, but it is less exercised than Linux                                      |
| [![Windows](https://img.shields.io/badge/Windows-0078D4?logo=windows&logoColor=white)](https://www.microsoft.com/windows/)                           | **[Windows](https://www.microsoft.com/windows/)**              | Supported with caveats    | native support exists, but PATH, npm, SSH, and PowerShell quoting still create more friction than on Unix systems        |
| [![Windows + WSL2](https://img.shields.io/badge/Windows%20%2B%20WSL2-0078D4?logo=windows&logoColor=white)](https://learn.microsoft.com/windows/wsl/) | **[Windows + WSL2](https://learn.microsoft.com/windows/wsl/)** | Important, still maturing | Brainclaw detects this setup explicitly, but setup/install/store parity across Windows and WSL is not fully seamless yet |

If you want the least surprising setup today, use Linux first. If you are on Windows, prefer a disciplined single-environment workflow and expect a few extra machine-specific fixes.

---

## Get Started

### 1. Let your coding agent lead

The smoothest first-run path is agent-first:

1. ask your coding agent to inspect the package and explain what brainclaw does
2. ask it to install brainclaw and initialize or join the project you're working on
3. use the CLI yourself when you need an explicit operator or fallback path

If you want to drive setup manually, use the steps below.

### 2. Install

```bash
npm install -g brainclaw
```

### 3. Bootstrap this machine

```bash
brainclaw setup-machine --yes
```

This detects the installed coding agents on the current machine, writes the machine-level MCP and user config Brainclaw manages for that detected set, and does **not** scan or initialize repositories.

### 4. Initialize or refresh the current project

```bash
cd your-project
brainclaw init
```

`brainclaw init` is now safe to rerun. It creates `.brainclaw/` when the project is new, or refreshes the managed Brainclaw and agent integration files when the project already has memory.

If you are explicitly adding another agent to an existing Brainclaw project, use:

```bash
brainclaw enable-agent <agent-name>
```

### 5. Restart your agent

Restart your coding agent (or reload MCP servers) so it picks up the new configuration. After that, brainclaw tools are available.

### 6. Start working

Pick one of the canonical entry points depending on what you're doing:

```text
# Solo work — start a session, load context, claim a scope:
bclaw_work(intent="execute", scope="src/feature")

# Multi-agent — assign work, consult, open a review, or open an ideation loop:
bclaw_coordinate(intent="assign|consult|review|ideate", task="...", targetAgents=[...])

# Parallel lanes — dispatch a sequence across several agent instances:
bclaw_dispatch(intent="execute", agents=[...])
```

Common follow-ups during work — all use the canonical CRUD grammar:

```text
bclaw_context(kind="memory", path=...)        → narrow project memory to a scope
bclaw_find(entity="...", filter=...)          → list plans, claims, handoffs, candidates, …
bclaw_get(entity="...", id=...)               → read one item
bclaw_create(entity="runtime_note", data=…)   → record an observation, decision, or trap
bclaw_read_inbox()                            → pick up assigned work or review requests
bclaw_session_end(narrative=…)                → close cleanly, hand off context to the next agent
```

For agents without MCP (e.g. Copilot reads `.github/copilot-instructions.md`), regenerate the instruction file when project memory changes:

```bash
brainclaw export --detect --write
```

### 7. Verify it works

```bash
brainclaw status          # see active sessions, claims, plans
brainclaw agent-board     # see what each agent is doing
```

## A Day in the Life of a Brainclaw Agent

Here's how a typical autonomous task progresses using Brainclaw:

```javascript
// 1. Session start & Context setup
bclaw_work({ intent: "execute", scope: "src/feature-auth" });
// (Brainclaw starts/resumes the session, builds context, and claims the scope.
//  Isolated Git Worktrees are provisioned when work is dispatched to other agents
//  via bclaw_dispatch / bclaw_coordinate(intent="assign"|"review").)

// 2. The agent writes code, tests it, and completes the step...
// write code, test code
bclaw_complete_step({ planId: "pln_123", stepId: "stp_456" });

// 3. The agent releases the claim and requests a review from a peer agent
bclaw_release_claim({ id: "clm_789", planStatus: "done" });
bclaw_coordinate({ 
  intent: "review", 
  open_loop: true, 
  review_mode: "symmetric", 
  targetAgents: ["claude-code"] 
});

// 4. The loop progresses as agents interact and resolve findings
bclaw_loop({ intent: "advance", loop_id: "lop_abc" });
```

## The Loop Engine (Multi-Turn Workflows)

Brainclaw's Loop Engine moves beyond manual ping-pong by formalizing multi-turn workflows (review, ideation, testing). It features two distinct review modes:

- **Asymmetric Mode**: The classic author→reviewer handoff. The reviewer creates findings, and the original author must apply the fixes.
- **Symmetric Mode**: Eliminates unnecessary round-trips. Both the author and reviewer slots can apply fixes directly, drastically speeding up spec and documentation reviews.

Each loop maintains a structured lifecycle, explicit phases, iteration bounds, and per-phase memory filters, executed seamlessly via `bclaw_loop`.

## Enterprise Ready: Mono-repo & Micro-services

Brainclaw is designed to scale across complex environments. Using the **`project_mode`** setting, Brainclaw seamlessly auto-detects folder boundaries for mono-repos and applies proper environment bootstrapping.

Additionally, **`cross_project_links`** enables inter-project communication:

- **Signals**: Candidates, handoffs, and runtime notes gracefully flow between sibling or micro-service projects.
- **Inbox**: Agents can dispatch review/assign tasks to agents operating in completely different projects using unified inbox routing.

### Multi-agent setup

To configure brainclaw for all your repos and agents at once:

```bash
brainclaw setup --yes
```

This is the broader multi-repo wizard. It bootstraps the machine, scans your project roots, and initializes selected repositories in one pass.

### Existing projects

For repos that already have code, brainclaw can extract context automatically:

```bash
brainclaw bootstrap --json     # preview what brainclaw detected
brainclaw bootstrap --apply    # import into memory
```

See `docs/quickstart.md` for the full walkthrough, `docs/integrations/overview.md` for agent-specific details.

---

## Current state

Recent releases have moved a lot of multi-agent parallel work from "risky" to "supported":

- **Per-claim auto-worktree** — each dispatched lane gets its own isolated git worktree; the coordinator integrates with an octopus merge.
- **Sequenced parallel execute** — `bclaw_dispatch(intent="execute")` fans out independent lanes across several agent instances and integrates the result.
- **Symmetric review-fix loops** — `bclaw_coordinate(intent="review", open_loop=true, review_mode="symmetric")` runs an alternating review-and-fix conversation across two slots without shared-checkout collisions.
- **Cross-platform spawn** — OS-aware prompt delivery (stdin pipe / inline arg) plus a brief-ack file handshake, so spawned workers can be detected and timed out reliably on Windows and Unix.
- **Worktree GC is scope-bounded** — symlinks and junctions are no longer followed during cleanup, so post-merge sweeps can't wipe `node_modules` or other neighboring directories.
- **MCP runtime self-heal** — when the runtime is corrupted, the server logs an actionable repair pointer; `brainclaw doctor --repair` rebuilds dist in one step.

Still sharp:

1. **Same-checkout concurrent edits** — running two agents in the *same* working tree (no per-claim worktree) is still the wrong answer. Use the dispatch path (auto-worktree per claim) instead of raw concurrent CLI sessions.
2. **Cross-machine sync** — federation across machines is on the roadmap, not in v1.x. Today brainclaw's store is local and one-machine-per-project.
3. **Spawn-and-forget assumptions** — spawned workers don't always commit their work cleanly. The brief-ack file confirms the spawn started; in the worst case the coordinator harvests open changes.
4. **Live state for hook-less agents** — supported hook-less file surfaces such as Cline, Windsurf, Continue, Antigravity/Gemini CLI, and Mistral Vibe can get live context via `.live.md` companions regenerated on session-end and handoff, not via real-time push.

Recommended use today:

1. for parallel work, dispatch a sequence with `bclaw_dispatch(intent="execute")` — each lane gets its own worktree
2. for sequential work in the same project, let one agent claim at a time and rely on handoffs
3. when reviewing or fixing across agents, prefer symmetric review loops over manual ping-pong
4. keep multi-machine workflows on a single source of truth until federation lands

---

## Multi-stack worktree

When brainclaw creates an agent worktree, it auto-detects which dependency directories to symlink from the main worktree based on stack markers present in the project root:

| Stack marker                                            | Symlinked directories |
| ------------------------------------------------------- | --------------------- |
| `package.json`                                        | `node_modules`      |
| `requirements.txt` / `pyproject.toml` / `Pipfile` | `venv`, `.venv`   |
| `Gemfile`                                             | `vendor/bundle`     |
| `go.mod`                                              | `vendor`            |
| `composer.json`                                       | `vendor`            |
| `mix.exs`                                             | `deps`              |

Maven, Gradle, and Cargo are intentionally excluded — their dependency caches are machine-global (`~/.m2`, `~/.gradle/caches`, `~/.cargo/registry`) and found automatically by the toolchain.

Build outputs like `dist` are **not** symlinked — they must be per-worktree to avoid EBUSY errors when other processes hold handles on the output directory.

Override detection in `.brainclaw/config.yaml`:

```yaml
worktree:
  shared_paths: [".cache"]        # additive to auto-detected
  exclude_shared: ["node_modules"] # opt-out a detected entry
```

---

## Cross-project links

Link a sibling brainclaw project so that signals (candidates, handoffs, runtime notes) can flow between them. Stored under `cross_project_links` in `.brainclaw/config.yaml`.

```bash
# Subscribe to incoming signals from a peer (default role)
brainclaw link add ../brainclaw-cloud

# Publish candidates only to a peer
brainclaw link add ../brainclaw-site --role publisher --channels candidate

# Replace an existing entry of the same name/path
brainclaw link add ../brainclaw-cloud --role publisher --force

# Inspect what's wired
brainclaw link list

# Drop a link by name, path, or basename
brainclaw link remove brainclaw-cloud
```

`role: publisher` is required to push signals out (`bclaw_write_note --crossProject`, `bclaw_create(entity='handoff', targetProject=…)`, etc.). `role: subscriber` (the default) marks the link as readable only.

The same surface is available through the canonical grammar for agents: `bclaw_create/find/get/update/remove(entity='cross_project_link')`.

---

## Documentation

The Markdown docs below ship in the npm package under `docs/` and are versioned in the repo. The links resolve on GitHub and are rewritten to the package repo on the npm page.

If you are integrating Brainclaw into an agent workflow, start with the agent-facing docs first:

| Doc | What it covers |
| --- | --- |
| [docs/index.md](docs/index.md) | Documentation index grouped by getting started, guides, reference, and design |
| [docs/integrations/overview.md](docs/integrations/overview.md) | Start here for agent integrations |
| [docs/integrations/mcp.md](docs/integrations/mcp.md) | MCP runtime path for capable agents |
| [docs/quickstart.md](docs/quickstart.md) | First-time setup on a new project (greenfield) |
| [docs/quickstart-existing-project.md](docs/quickstart-existing-project.md) | Joining a project that already has `.brainclaw/` |
| [docs/server-operations.md](docs/server-operations.md) | Operator and remote-server workflow guide |
| [docs/cli.md](docs/cli.md) | CLI reference for operators, scripts, and fallback use |
| [docs/code-map.md](docs/code-map.md) | Code Map — symbol/import index, freshness model, monorepo behavior |
| [docs/concepts/memory.md](docs/concepts/memory.md) | What "memory" means in brainclaw |
| [docs/concepts/plans-and-claims.md](docs/concepts/plans-and-claims.md) | Coordination layer |
| [docs/concepts/runtime-notes.md](docs/concepts/runtime-notes.md) | Ephemeral observations |
| [docs/concepts/multi-agent-workflows.md](docs/concepts/multi-agent-workflows.md) | The four common scenarios — orchestration, agent switching, project recovery, team async |
| [docs/concepts/troubleshooting.md](docs/concepts/troubleshooting.md) | Runbook for degraded coordination state — stale claims, missing dist, octopus failures, etc. |
| [docs/integrations/cursor.md](docs/integrations/cursor.md) | Cursor |
| [docs/integrations/claude-code.md](docs/integrations/claude-code.md) | Claude Code |
| [docs/integrations/copilot.md](docs/integrations/copilot.md) | GitHub Copilot |
| [docs/integrations/codex.md](docs/integrations/codex.md) | Codex |
| [docs/storage.md](docs/storage.md) | Storage model |
| [docs/security.md](docs/security.md) | Security model |
| [docs/review.md](docs/review.md) | Reflective review |
| [docs/reputation.md](docs/reputation.md) | Reputation signals |
| [docs/playbooks/](docs/playbooks/) | Audience design constraints for brainclaw development |

---

## Running tests

Contributor note: the commands below are for developing Brainclaw itself, not for normal agent usage inside a target repo.

```bash
npm test                   # unit + smoke (fast path)
npm run test:e2e           # end-to-end suite
npm run test:all           # full suite
npm run test:coverage      # with coverage report
```

---

## Changelog

For older releases (v0.x and the early v1.0 launch series), `git log` on `master` is the source of truth — every release commit follows the `chore(release): bump version to <semver>` convention, and the matching feature/fix commits reference their plan id (e.g. `feat(mcp): self-heal ... (pln#478)`).

### v1.11.1

Agent-identity & session-hook resilience, from a fresh-CLI dogfood on a monorepo:

- **Session hooks no longer spam `UserPromptSubmit hook error` on every prompt.** Root cause was an agent-identity error whose own remediation (`register-agent --set-current`) the resolver ignored, swallowed by `2>/dev/null`. Now: the error hint points at what actually works (`--agent` / `$BRAINCLAW_AGENT_NAME`), a **single registered agent auto-resolves** with no env signal, and `session-start`/`context-diff`/`session-end` run with `--hook` so they degrade to exit 0 + `~/.brainclaw/hook.log` instead of erroring the prompt loop. Multi-agent safety (pln#562) is unchanged.
- **`brainclaw doctor --fix-hooks`** purges stale/broken/duplicate brainclaw hooks across all Claude Code settings scopes (user + cwd) and rewrites the canonical ones — for the broken hooks that accumulate where `setup`'s git-repo discovery never reached.
- **`setup` repo discovery recurses** (bounded, skipping `node_modules`/build dirs) so repos nested deep in a workspace are found instead of silently missed, and it registers the detected agent so the hooks it installs can resolve an identity.

### v1.11.0

Monorepo project-resolution + Code Map, cross-project relocation, and dispatch-worktree hygiene — from a multi-project (monorepo) dogfood:

- **`bclaw_switch` to the monorepo root now works, and a switch is honored everywhere.** An agent inside a child project could not switch *up* to the workspace-root project, and a session-scoped switch was silently lost (sessions are stored per-cwd, but the resolver read them only at the workspace anchor). The resolver now matches the root project by `project_name`/`project_id` and probes the anchor / physical cwd / workspace root for the session, so `bclaw_switch` is authoritative for every subsequent call — including Code Map — without `--cwd`.
- **`code-map refresh --cascade`** — monorepo-native, per-project indexing: one command at the root refreshes **every** nested project into its own store plus a child-scoped root store, with **zero double-indexing** (even under nesting). `code-map status --cascade` adds a per-child recap. Opt-in; single-project repos are unchanged.
- **`brainclaw move <entity> <id> --to <project>` / `bclaw_move`** — id-preserving cross-project relocation, closing the gap the switch bug exposed (items created in the wrong store). Execution-local entities (claim/assignment/agent_run/session) stay put; refuses id collisions and active-claim moves; audits both stores.
- **Sub-agent worktrees auto-clean on loop close** — a completed review/dispatch loop garbage-collects its worktrees (junction-safe; keeps any that are alive, un-harvested, or carry unmerged commits). Opt out with `BRAINCLAW_NO_WORKTREE_GC=1`.

### v1.10.2

Dispatch worktree-creation hardening (parallel-lane dispatch on a large repo): the claim-scope branch slug is length-capped *before* its trailing-dot strip (a scope ending in `…Page.astro` no longer truncates to an invalid `feat/…Page.` ref), and `git worktree add` gets a dedicated timeout (120s default; override `BRAINCLAW_WORKTREE_ADD_TIMEOUT_MS`) so a several-hundred-file checkout isn't SIGTERM-killed mid-materialize.

### v1.10.1

Code Map fast-follows from the 1.10.0 dogfood, plus a lint cleanup:

- A git branch switch now flags the index stale (new `stale_git_head` freshness reason); `refresh` honors `.gitignore` (gitignored output dirs no longer indexed); `brief("<path>")` resolves the exact file instead of token-flooding; and the freshness badge distinguishes index freshness from a call's spot-check (`index_status`).
- The `brainclaw-session` skill + agent instruction surface now point agents at `bclaw_code_find` / `bclaw_code_brief` before grep. Lint baseline cleared to zero (stylistic rules ratcheted to `error`); README doc links clickable; `docs/code-map.md` lists JS / TS / JSX / TSX · Python · PHP · Java.

### v1.10.0

- **Code Map** — a new per-project [Tree-sitter](docs/code-map.md) symbol + import
  index for **JS / TS / TSX, Python, PHP, and Java**. Ask *"where is X / what should I
  read first"* before editing: `bclaw_code_find`, `bclaw_code_brief`,
  `bclaw_code_status`, `bclaw_code_refresh` (CLI: `brainclaw code-map …`). Pull-based
  freshness with a per-response badge; never blocks `bclaw_work`; monorepo-aware. See
  [code map](docs/code-map.md).
- **Monorepo multi-project safety** — agents working in different child projects of a
  monorepo are now genuinely independent:
  - an anchored agent working *inside* a child project resolves **that** child, not the
    repo root — no more "plans / index target the repo root";
  - CLI `brainclaw switch` is **session-scoped by default** (two agents no longer clobber
    a shared pointer); the new `--global` flag is the only path that sets the shared
    workspace default; `switch --list` / show are session-aware;
  - a session-less agent physically inside a child project beats a stale shared global
    pointer (resolves the child it is in);
  - dispatched / CoDev workers spawn with a **clean identity** — the coordinator's
    session / project / agent env no longer leaks into a worker.
- Internal — MCP public surface fingerprint re-pinned for the Code Map tools (additive;
  no tool removed or renamed).

### v1.9.1

- **Multi-project scoping fixes for monorepos** — MCP reads/writes resolve the
  effective project from an explicit arg, the MCP session, `BRAINCLAW_CWD`, or
  the global active project (in that order), so commands target the right store
  inside a monorepo; `bclaw_find` legacy-filter diagnostics report how many
  `provenance.kind="legacy"` records the default filter excluded.
- **Case-insensitive agent names** — `targetAgents=["Codex"]` (any casing) now
  resolves like `codex`; dispatch/coordinate no longer silently drop a reviewer
  over a capital letter, and an unresolved name reports a distinct `unknown_agent`
  reason instead of the misleading "no CLI spawn template (IDE-only?)".
- **Docs** — revamped Loop Engine, Git Worktrees, Cross-Project Signals, and the
  Orchestration Playbook, corrected against actual behavior (`bclaw_work` =
  session + context + claim, not worktree provisioning; worktrees come from
  dispatch/coordinate; plans via `bclaw_create(entity="plan")`).

### v1.9.0

- **Release hardening for npm publishing + agent-surface coherence** (pln#571).
  A dedicated CI **Release Package Check** builds the CLI, builds the optional
  VS Code extension, runs the extension tests, and verifies the published tarball
  contents; `version --publish-local`/`prepublishOnly` now run `build:release` +
  `pack:check` before `npm pack`. The `.vsix` ships as an *optional* IDE
  companion (local CLI builds skip it; release builds stay strict). Generated
  agent surfaces no longer pin the npm semver (stable `Managed by brainclaw`
  banner), and `.brainclaw/project.md` is documented as a legacy derived view —
  root `PROJECT.md` is the durable project vision; live claims/plans/handoffs
  live in `agent-board` / MCP context.
- **Coordination & safety fixes** — strict claim isolation (a duplicate active
  claim on the same scope now fails inside the mutation lock instead of warning),
  `JsonStore` entity-id validation to prevent path traversal (pln#571), and
  `reflect --batch` no longer swallows identity/security errors so a strict
  import can never silently skip sensitive content (pln#572).
- **Concurrency & CI robustness** — the journal append waits fairly under
  contention so a multi-process kill-9 storm converges without seq reuse
  (pln#573/#574), and `merge-risk` reconciles Windows 8.3 short-name worktree
  paths so a claim matches its lane on Windows runners (pln#576).
- **Docs** — Roo, Continue, Windsurf, Copilot, OpenClaw, quickstart, and the
  agent-integration docs now match the current export formats and setup behavior
  (pln#571/#575).

### v1.8.0

- **Multi-agent dispatch convergence — "worktree-as-contract"** (from a real
  cross-project field session where a sandboxed worker could neither commit nor
  reach MCP). The worker's contract shrinks to "edit files in this worktree +
  drop `LANE-RESULT.json`": `brainclaw harvest --integrate` commits the worktree
  diff on behalf of a worker that can't self-commit (hard-guarded to the linked
  worktree, never the main repo), then completes the assignment and releases the
  claim with plan cascade. A `LANE-RESULT.json` is now the #1 verdict signal in
  `bclaw_dispatch_status` (worker FINISHED, even without self-update); the
  dispatcher refuses to spawn without an isolated worktree; `open_loop` reviews
  pre-flight each reviewer agent with a trivial validation spawn (clear
  boot-failure reason instead of a generic loop timeout); and decisions/traps
  gain `verified_at`/`verify_cmd` so perishable facts can be flagged stale.
  Additive + opt-in throughout. (pln#530, pln#531, pln#532, pln#533, pln#534, trp#468)

### v1.7.5

- **Security patch (recommended upgrade)** — fixes a git command-injection / RCE
  vector flagged by Socket AI: several commands interpolated a git ref (notably
  one derived from the persisted session `git_sha`) into `execSync` shell
  strings. All git calls now use `execFileSync` (no shell) and `git_sha` is
  validated as a hex SHA. No functional change. (session-end, release-claims,
  release-notes, sync)

### v1.7.4

- **Dispatch observability + worker DX hardening** (from a real cross-project
  field session) — `bclaw_dispatch_status` and the reconciler now derive liveness
  from filesystem activity (log + worktree mtime), so a worker actively editing
  files is no longer falsely flagged `stalled`, and known codex boot-failure
  stderr signatures get a targeted diagnosis; briefs are transport-aware (a
  sandboxed agent without MCP/commit gets the file protocol, not instructions it
  can't follow), backed by a derived capability matrix
  (`dispatchHasMcp`/`dispatchCanCommit`); `bclaw_claim` gains an advisory
  (no-worktree) mode; `bclaw_find` payloads are size-bounded with pagination
  metadata; an opt-in per-worktree `tsc --noEmit` pre-commit gate; gated ready
  lanes carry a code-propagation advisory; the reconciler auto-releases the claim
  of a run it infers failed; and `plan.related_paths` is now updatable.
  (pln#479, pln#491, pln#527, pln#528, pln#529, trp#291, trp#431, trp#433, trp#434)

### v1.7.3

- **Multi-agent dispatch hardening for JS/TS monorepos** — dispatched worktrees
  junction-link per-package `node_modules` (npm / yarn / pnpm workspaces), not
  just the root, and surface failed links instead of swallowing them; `brainclaw worktree clean` now garbage-collects merged worktrees past birth-noise instead
  of skipping them all; the agent inventory reports an agent `spawnable` when its
  binary is on PATH even if `--version` is slow to start; dispatch-verification
  guidance leads with `bclaw_dispatch_status` (not the untrustworthy Windows
  wrapper pid); and a new `LANE-RESULT.json` convention + `brainclaw harvest <assignment_id>` give workers a standard, MCP-free result channel. The dispatch
  dirty-guard also ignores `.claude/`, `.cursor/`, and `.codex/` agent-local
  config. (pln#523, pln#524, pln#525, pln#526, trp#371, trp#427, trp#428)

### v1.7.2

- **Sequence MCP tools are agent-first by default** — sequence creation,
  listing, update, and deletion tools are now in the default MCP catalog, with
  explicit lane item schemas (`planId`, optional `stepId`, `rank`,
  dependencies, lane metadata) and matching canonical CRUD validation for
  `entity="sequence"`.

### v1.7.1

- **MCP project context isolation fix** — `bclaw_switch` now keeps MCP switches
  session-scoped even when the agent session has to be resolved or created on
  the fly. Session lookup honors explicit session IDs, avoids adopting another
  live process's session, detects Codex via native `CODEX_*` runtime variables,
  and `bclaw_switch(list=true)` reports the session active project with
  `active_source`.

### v1.7.0

- **Dispatch reliability + scope-aware dirty guard** — evidence-first
  `agent_run` reconciliation avoids false terminal states, `bclaw_coordinate`
  accepts pinned refs and a scope-aware `allow_dirty` guard, and the Hermes
  agent integration joins the supported surfaces.

### v1.6.0

- **Bootstrap loop + cross-project agent workflow** — the bootstrap ideation
  preset can materialize `PROJECT.md`, `bclaw_init_project` initializes and links
  arbitrary project paths, and `project=` routing reaches `bclaw_work` /
  `bclaw_loop` for linked-project operations.

### v1.5.3

- **Cross-project canonical grammar + CLI parity** (pln#359, all phases) — the canonical grammar (`bclaw_find / get / create / update / remove / transition`), `bclaw_context`, and `bclaw_coordinate` now accept an optional `project: <name>` argument that routes the operation to a linked project. Two link kinds are recognised: `cross_project_links` (sibling/peer projects in `config.yaml`, `brainclaw link list`) and workspace store-chain children. Arbitrary directory paths are rejected — adoption requires an explicit link, which gives the user a single point of control over what an agent can reach. Identity is sourced from the caller's home registry; entity writes + audit log entries land in the target. Unknown project names throw `validation_error` with a hint listing the configured links — no silent fallback. Cross-project `bclaw_coordinate` is **inbox-only**: claim/assignment/message all land in the target, the target agent picks the brief up async via its own `bclaw_work`, and auto-spawn from the source process is force-disabled because the spawn cwd / worktree are tied to the target's git repo (a warning surfaces in `FacadeResponse.warnings`). The CLI exposes the same as a global `--project <name>` flag, mutually exclusive with `--cwd`. Refs: helper `resolveProjectCwd` in `src/core/cross-project.ts`, MCP write/read handler dispatch in `src/commands/mcp.ts` and `src/commands/mcp-read-handlers.ts`, `--project` plumbing in `src/cli.ts` preAction, surface advertisement in `src/core/instruction-templates.ts`, plus tests in `tests/unit/cross-project.test.ts` (10 unit cases on the helper), `tests/unit/bclaw-coordinate.test.ts` (4 cross-project routing cases), and `tests/cli-cross-project.test.ts` (5 e2e cases). Closes the `--cwd` workaround pattern that had been the day-to-day shape of multi-project sessions.
- **Site facts contract** (umbrella `pln_7fdfd70d` sprint 0) — new `scripts/emit-site-facts.mjs` emits `dist/facts.{js,json}` from `MCP_TOOL_NAMES` + `ENTITY_NAMES` so the brainclaw-site (and any consumer) can pull live tool/entity counts at build time without forking the values into a hand-maintained config. The package `files` list ships `dist/facts.json`; build:cli runs the emitter as part of the chain.

### v1.5.2

- **Grammar fix: `bclaw_update` no longer silently drops patches** (trp#187, pln#500) — the canonical CRUD surface promised that `EntityRegistry.updatable` listed every patchable field, but the legacy impls behind the dispatch (`updatePlan`, `updateMemoryItem`) only handled a typed subset. A `as UpdatePlanInput` cast in `entity-operations.ts` masked the gap from TypeScript: callers passed `{text, tags, severity, …}`, validation accepted them, and the function bodies never read them. Empirically reproduced this session on `pln#359` (text+tags drop) and `trp#187` itself (severity drop). Fix adds a generic-patch escape-hatch (`patch?: Partial<…>`) on `UpdatePlanInput` and `UpdateMemoryInput`, applied via `Object.assign` after the typed fields so legacy CLI callers keep their behaviour. The dispatch in `entity-operations.ts` now passes the full patch through that escape-hatch for plan/decision/constraint/trap. `runtime_note`, `candidate`, and `cross_project_link` were already correct. New `tests/unit/entity-update-coverage.test.ts` is parametric: for every `(entity, field)` pair in `EntityRegistry.updatable`, create + patch + get + assert the field actually persisted (29 cases). Adding a new updatable field will require adding a coverage row, so the contract stays honest.

### v1.5.1

- **Cross-project link CLI + grammar parity** (pln#454 step 2) — new `brainclaw link add/list/remove` subcommands and a stateless `cross_project_link` entity wired into the canonical CRUD verbs (`bclaw_create / find / get / update / remove`). The pain point was small (config.yaml is hand-editable) but the asymmetry — runtime cross-project signaling shipped, management UX did not — meant federation peers had no first-class affordance. Storage stays in `config.cross_project_links`; the entity is intentionally stateless (no transitions). Refs: `src/commands/link.ts`, `src/core/cross-project.ts` (new `addCrossProjectLink` / `removeCrossProjectLink`), `src/core/entity-registry.ts` (new `xpl` prefix), `src/core/entity-operations.ts` dispatch cases, `tests/unit/link.test.ts` + `tests/unit/cross-project-link-grammar.test.ts` (26 new cases).
- **Agent registry pruned** (pln#454 step 1) — 8 synthetic profiles (antigravity, copilot-vscode, claude-opus, copilot-identity, copilot, claude-sonnet, visionnaire, copilot-codev) and 11 abandoned sessions archived under `.brainclaw/archive/agents/2026-05-07/`. The whitelist that survives matches `feedback_allowed_dispatch_agents.md`: `claude-code`, `codex`, `github-copilot`, plus `jberdah` (curator). Auto-re-registration in `detectAiAgent` is intentionally preserved — if a real surface starts a session, the registry auto-rebuilds for it. Pure store cleanup, no code change.
- **Inbox + assignment lifecycle reconciliation** (housekeeping) — 89 stale inbox messages and 7 orphan offered-assignments closed with retroactive lifecycle updates. The plans they backed (pln#478 mcp self-heal, pln#480 multi-stack worktree, pln#483 bclaw_work compact, pln#471 tier-B live companions) had all merged weeks earlier without the dispatch path calling `bclaw_assignment_update`. Captured as `feedback_dispatch_test_inbox_debris` so future drift is mass-acked instead of triaged per-message.

### v1.5.0

- **Ideation loop MVP** (pln#492) — new `bclaw_coordinate(intent='ideate')` opens a memory-confrontation loop: critic reads only adversarial categories (traps + feedback + runtime_notes + critique_history) and gets a BM25-ranked, context-filtered, 12k-token-capped brief assembled from project memory. Single-agent (champion drives manually) or multi-agent (auto-dispatch a turn per critic). Iteration block (cycle, max_iterations, exit_when), phase-advance gate (≥3 critique artifacts before leaving critique), system events (`phase_advance_blocked`, `max_iterations_reached`). Full design: [docs/concepts/ideation-loop.md](docs/concepts/ideation-loop.md).
- **Reliable dispatch + autonomy contract** (pln#496) — codex / sandboxed task-based agents now emit the full lifecycle (accepted → started → progress → completed). `briefMode` resolution corrected: `task-based && hasMcp → 'full'` (not 'compact', which silently dropped the protocol section). Lazy reconciliation pattern: `agentrun-reconciler` runs at every read path (`bclaw_assignment_events`, `bclaw_loop intent='get'`, `doctor --dispatch`) instead of a daemon; first run auto-recovered 9 historical orphan agent_runs in <1s. New autonomy contract section in instruction surfaces — agents execute protocol-defined transitions instead of pausing to ask. New `buildClaimEnvPrefix` consolidates cross-shell env injection (Windows defaults to cmd, POSIX uses unquoted bytes per PATH conventions). New `brainclaw doctor --dispatch` for operator-facing dispatch health.
- **Worktree junction wipe fix** (pln#498) — `detachWorktreeJunctions` runs before `git worktree remove` on Windows so git's recursive rm cannot follow the `node_modules` junction back into the main repo. Closes the recurring post-merge wipe trap; validated empirically on multiple back-to-back merges in the v1.5.0 session.
- **Methodological lessons** captured as user auto-memory feedback memos: bisect historical state before bisecting code (regression vs. always-broken-but-hidden), lazy reconcile at read paths beats daemon polling, codex briefs MUST include the Protocol section (implicit instructions don't propagate to sandboxed CLIs).

### v1.2.0

- **zod 3 → 4 migration** (pln#486) — schemas are semantically equivalent but the JSON Schema emitted by `tools/list` shifted shape; downstream MCP clients that snapshot schemas should re-pin. See `docs/mcp-schema-changelog.md` for the public surface fingerprint.

### v1.1.0

- **Node 20+ baseline** (pln#485) — `engines.node` is now `>=20.0.0` (Node 18 reached EOL in April 2025). CI matrix runs Node 22 and 24 on Linux; Windows on Node 24. Node 20 remains the minimum installable runtime but is no longer CI-verified.
- **commander 13 → 14** (requires Node 20+).
- **@types/node 22 → 24** (LTS-aligned).

### v1.0.15

- **TypeScript 5.8 → 6.0** (pln#484) — migration to `module: "nodenext"` (`Node16` is deprecated in TS 6, scheduled for removal in TS 7); explicit `types: ["node"]` since TS 6 changed the default to `[]`.

### v1.0.14

- **`bclaw_work` compact payload by default** (pln#483) — avoids exceeding the ~25k MCP token cap on projects with substantial memory. Pass `compact: false` for the full payload, or call `bclaw_context(kind="memory")` after.
- **MCP runtime self-heal + `doctor --repair`** (pln#478) — when `dist/mcp-worker.js` is missing, the server logs an actionable repair pointer and read-only handlers keep serving in-process. `brainclaw doctor --repair` rebuilds dist in one step.
- **Tier B/C native live companions** (pln#471) — `.cursor/live.md`, `.clinerules/live.md`, `.windsurf/rules/live.md`, `.github/copilot-instructions.live.md`, `.continue/live.md`, `GEMINI.live.md` regenerated on session-end and handoff. Opt-in via `brainclaw export --include-live --write`.

### v1.0.13

- **Worktree GC scope hardening** (pln#477) — `safeRemoveWorktreeDir` no longer follows symlinks/junctions during cleanup. Closes a class of post-merge wipes that previously destroyed `node_modules` and other neighboring directories on Windows.

### v1.0.10–v1.0.12

- **GitHub Copilot CLI is spawnable** (pln#440) — Copilot CLI 1.0.35+ supports `-p "<prompt>" --allow-all --no-ask-user`; tier promoted to A.
- **Codex spawn on Windows: stdin pipe + 30s handshake TTL** (pln#475) — fixes embedded backticks/`#`/multi-line content getting mis-parsed by `cmd.exe` when a prompt is passed as an inline argument.
- **Brief-ack file handshake** (pln#476) — `.brainclaw/coordination/runtime/ack/<assignmentId>.ack` proves a spawned worker started, decoupling the handshake from MCP availability inside the worker (important for Codex in `--sandbox workspace-write`).
- **`bclaw_loop(intent="open")` orphan-gate** (pln#461) — refuses to open a loop without dispatch unless `allow_orphan: true` is explicit. Use `bclaw_coordinate(intent="review", open_loop: true)` instead.
- **Kilocode** — Tier B integration with native MCP config and live companion (pln#464).

### v1.0.0

- **Canonical grammar promoted to standard tier** — `bclaw_find` / `bclaw_get` / `bclaw_create` / `bclaw_update` / `bclaw_remove` / `bclaw_transition`, plus the entry facades `bclaw_work` and `bclaw_context`, the multi-agent facades `bclaw_coordinate` and `bclaw_dispatch`, and the loop facade `bclaw_loop`. Legacy per-entity tools removed from the discoverable surface (still callable as a migration escape hatch). See `docs/concepts/mcp-governance.md` for tier rules and the deprecation policy.

---

## License

brainclaw core is published under the [MIT License](LICENSE) — (c) 2024-2026 Juan Berdah.

The licensing split is simple:

- the local-first brainclaw core is MIT
- cloud shared-memory, remote collaboration services, advanced dashboards, and related hosted add-ons will live in separate commercial products

The MIT core covers what makes brainclaw useful inside a repo today: local project memory, local MCP and CLI coordination, onboarding and bootstrap, plans, claims, handoffs, runtime notes, and local agent integrations.

The goal is not to close brainclaw down. The goal is to keep the local-first core open and genuinely useful on its own, while keeping hosted collaboration features separate.
