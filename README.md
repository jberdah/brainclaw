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

// 4. The reviewer's verdict is harvested from its LANE-RESULT.json and the loop
//    auto-closes on approve — no manual advance needed for the approve path.
//    (bclaw_loop remains available to drive the request_changes fix cycle by hand.)
bclaw_loop({ intent: "get", loop_id: "lop_abc" }); // inspect status any time
```

## The Loop Engine (Multi-Turn Workflows)

Brainclaw's Loop Engine moves beyond manual ping-pong by formalizing multi-turn workflows (review, ideation, testing). It features two distinct review modes:

- **Asymmetric Mode**: The classic author→reviewer handoff. The reviewer creates findings, and the original author must apply the fixes.
- **Symmetric Mode**: Eliminates unnecessary round-trips. Both the author and reviewer slots can apply fixes directly, drastically speeding up spec and documentation reviews.

Each loop maintains a structured lifecycle, explicit phases, iteration bounds, and per-phase memory filters, executed seamlessly via `bclaw_loop`.

**Autonomous convergence (pln#628 Focus 4B):** a dispatched reviewer doesn't need to be driven by hand. It writes its verdict (`review_verdict: approve | request_changes`) into its `LANE-RESULT.json`; when the coordinator harvests the lane, brainclaw records the verdict on the loop and **auto-closes it on approve** — the review loop reaches `reviewer_green` with no human ping-pong. `request_changes` advances to the author phase (the automated fix→re-review cycle is a planned follow-up).

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
- **Symmetric review-fix loops** — `bclaw_coordinate(intent="review", open_loop=true, review_mode="symmetric")` runs an alternating review-and-fix conversation across two slots without shared-checkout collisions. The reviewer's verdict is harvested from `LANE-RESULT.json` and the loop **auto-closes on approve** — no manual round-trip to converge the approve path.
- **Cross-platform spawn** — OS-aware prompt delivery (stdin pipe / inline arg) plus a brief-ack file handshake, so spawned workers can be detected and timed out reliably on Windows and Unix.
- **Worktree GC is scope-bounded** — symlinks and junctions are no longer followed during cleanup, so post-merge sweeps can't wipe `node_modules` or other neighboring directories.
- **MCP runtime self-heal** — when the runtime is corrupted, the server logs an actionable repair pointer; `brainclaw doctor --repair` rebuilds dist in one step.

Still sharp:

1. **Same-checkout concurrent edits** — running two agents in the *same* working tree (no per-claim worktree) is still the wrong answer. Use the dispatch path (auto-worktree per claim) instead of raw concurrent CLI sessions.
2. **Cross-machine sync** — federation across machines is on the roadmap, not in v1.x. Today brainclaw's store is local and one-machine-per-project.
3. **Next.js / Turbopack dev server in a worktree** — the provisioned `node_modules` symlink points outside the worktree root, which `next dev` (Turbopack) rejects (build/tsc/vitest are fine). brainclaw warns; `npm install` in the worktree or smoke-test on the merged branch. A Turbopack-compatible dependency mode is a planned follow-up.
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

> **Next.js / Turbopack caveat.** The `node_modules` link is a symlink to the main worktree, i.e. it points **outside** the agent worktree's root. `tsc`, `vitest`, and production `build` follow it fine, but `next dev` (Turbopack) panics on a `node_modules` link outside the worktree root. brainclaw detects Next.js projects and surfaces a `symlink_warnings` note at worktree creation. Workaround for dev-server work: run `npm install` inside the worktree (optionally with `BRAINCLAW_NO_LINK_DEPS=1`), or smoke-test on the merged branch. A Turbopack-compatible per-worktree dependency mode is a planned follow-up.

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

Full version history lives in **[CHANGELOG.md](CHANGELOG.md)** (Keep a Changelog
format, Semantic Versioning). MCP protocol / schema changes and the public surface
fingerprint are tracked separately in
**[docs/mcp-schema-changelog.md](docs/mcp-schema-changelog.md)**. For releases
predating the changelog file, `git log` on `master` is the source of truth — each
release commit follows the `chore(release): bump version to <semver>` convention.

---

## License

brainclaw core is published under the [MIT License](LICENSE) — (c) 2024-2026 Juan Berdah.

The licensing split is simple:

- the local-first brainclaw core is MIT
- cloud shared-memory, remote collaboration services, advanced dashboards, and related hosted add-ons will live in separate commercial products

The MIT core covers what makes brainclaw useful inside a repo today: local project memory, local MCP and CLI coordination, onboarding and bootstrap, plans, claims, handoffs, runtime notes, and local agent integrations.

The goal is not to close brainclaw down. The goal is to keep the local-first core open and genuinely useful on its own, while keeping hosted collaboration features separate.
