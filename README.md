<p align="center">
  <img src="https://brainclaw.dev/logo.png" alt="brainclaw" width="140" />
</p>

<h1 align="center">brainclaw</h1>

<p align="center"><strong>Local-first coordination and shared memory for coding agents.</strong></p>

---

If you've ever:
- **lost your conversation** when your agent hit credit limits mid-task,
- returned to a project **after a week** with no idea where you left off,
- watched two coworkers (or two agents) **edit the same files** without knowing it,
- or **gave up running multiple agents in parallel** because keeping them in sync was a pain,

brainclaw gives you durable shared state across sessions, agents, and teammates. Plans, claims, handoffs, decisions, and traps live in `.brainclaw/`, work identically across any compatible agent (Claude Code, Codex, Copilot, Cline, OpenCode, Cursor, Windsurf, Kilocode, Roo Code, Continue, Mistral Vibe, Antigravity/Gemini CLI, …), and stay accessible whether you orchestrate them in parallel or pick them up one after another.

Use it two ways — **together or separately**:

- **Active orchestration** — dispatch work in parallel across multiple agent instances. Claims prevent conflicts, sequences manage lane dependencies, the dispatcher routes by capacity.
- **Async shared state** — when an agent runs out of credits, when you return to a project after weeks, or when teammates work in parallel: the next agent (or you) resumes cleanly with the same context, plans, and constraints.

The same primitives — plans, claims, handoffs, decisions, traps — serve both modes. That's the design point. brainclaw stores everything locally as plain text + JSON, versions it in Git, and asks no opinion about which agent you should use for what.

It sits alongside your coding agents and gives them a shared state layer they can resume from reliably. brainclaw is also starting to model other local AI work surfaces on the same machine, such as ChatGPT Desktop, Claude Desktop, Claude Cowork, and Gemini web or CLI, to keep a project-level queue of non-code work for those surfaces.

---

## What it provides

| | |
|---|---|
| **Project memory** | constraints, decisions, traps, handoffs, and layered instructions agents can resume from |
| **Coordination state** | shared plans, file claims, runtime notes, and board views for active work |
| **Agent-ready context** | compact, prompt-sized context built from real workspace state instead of stale instructions |
| **Native agent files** | auto-writes `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules/`, `.windsurfrules`, and similar local guidance |
| **Machine AI surface discovery** | detects local coding agents plus desktop AI work surfaces such as ChatGPT Desktop and Gemini CLI |
| **Queued surface tasks** | stores project-scoped requests for other local AI surfaces, such as visual generation, drafting, summaries, or research |
| **Local-first storage** | plain text + JSON, Git-friendly, no mandatory cloud, no telemetry by default |

---

## Agent Surfaces

brainclaw exposes the same collaboration state through three surfaces, but they do not have the same role in an agent-first workflow.

| Surface | Primary use |
|---|---|
| **MCP** | default path for capable agents that need fresh context, board state, plans, claims, and write operations |
| **Native agent files** | local guidance and bootstrap hints for a specific agent surface (`AGENTS.md`, `CLAUDE.md`, Cursor rules, etc.) |
| **CLI** | operator workflows, scripting, setup, debugging, release, and fallback access when MCP is not the integration path |

If you are documenting or integrating an agent workflow, treat MCP as the primary runtime path.

---

## Works With

brainclaw is designed to sit alongside the coding agents teams are already using, not behind a separate hosted control plane.

### Code Agents

| Logo | Agent | Tier | What brainclaw configures |
|---|---|---|---|
| [![Claude Code](https://img.shields.io/badge/Claude_Code-111111?logo=anthropic&logoColor=white)](https://github.com/anthropics/claude-code) | **[Claude Code](https://github.com/anthropics/claude-code)** | A | MCP + CLAUDE.md + hooks + auto-approve + permissions + /brainclaw skill |
| [![Codex](https://img.shields.io/badge/Codex-111111?logo=openai&logoColor=white)](https://openai.com/codex/) | **[Codex](https://openai.com/codex/)** | A | MCP + AGENTS.md + hooks + skills |
| [![Cursor](https://img.shields.io/badge/Cursor-1F2430?logo=cursor&logoColor=white)](https://cursor.com/en-US) | **[Cursor](https://cursor.com/en-US)** | A | MCP (machine) + .cursor/rules/ + hooks + skills |
| [![Windsurf](https://img.shields.io/badge/Windsurf-0B1220?logo=codeium&logoColor=white)](https://windsurf.com/) | **[Windsurf](https://windsurf.com/)** | A | MCP (machine) + .windsurfrules + hooks + skills |
| [![Cline](https://img.shields.io/badge/Cline-0F766E?logoColor=white)](https://github.com/cline/cline) | **[Cline](https://github.com/cline/cline)** | A | MCP + auto-approve + .clinerules/ + hooks + skills |
| [![GitHub Copilot](https://img.shields.io/badge/GitHub_Copilot-181717?logo=githubcopilot&logoColor=white)](https://github.com/features/copilot) | **[GitHub Copilot](https://github.com/features/copilot)** | A | MCP + copilot-instructions.md + hooks + skills |
| [![Roo](https://img.shields.io/badge/Roo-7C3AED?logoColor=white)](https://github.com/RooCodeInc/Roo-Code) | **[Roo](https://github.com/RooCodeInc/Roo-Code)** | B | MCP + auto-approve + .roo/rules/ |
| [![Continue](https://img.shields.io/badge/Continue-2563EB?logoColor=white)](https://github.com/continuedev/continue) | **[Continue](https://github.com/continuedev/continue)** | B | MCP + .continue/rules/ |
| [![OpenCode](https://img.shields.io/badge/OpenCode-0F172A?logoColor=white)](https://github.com/opencode-ai/opencode) | **[OpenCode](https://github.com/opencode-ai/opencode)** | B | MCP + AGENTS.md |
| [![Gemini CLI](https://img.shields.io/badge/Gemini_CLI-1A73E8?logo=googlegemini&logoColor=white)](https://github.com/google-gemini/gemini-cli) | **[Antigravity / Gemini CLI](https://github.com/google-gemini/gemini-cli)** | B | MCP + GEMINI.md |

**Tier A** = MCP + hooks + skills (context injected dynamically, lightweight instruction files). **Tier B** = MCP only, no hooks (richer static instruction files with architecture + top traps). Tier can degrade at runtime if integration surfaces are missing.

### Autonomous Agents

| Logo | Agent | Tier | What brainclaw configures |
|---|---|---|---|
| [![OpenClaw](https://img.shields.io/badge/OpenClaw-FF6B35?logoColor=white)](https://github.com/openclaw/openclaw) | **[OpenClaw](https://github.com/openclaw/openclaw)** | B | MCP + brainclaw skill (SKILL.md) for structured project memory |
| [![NanoClaw](https://img.shields.io/badge/NanoClaw-4A90D9?logoColor=white)](https://github.com/qwibitai/nanoclaw) | **[NanoClaw](https://github.com/qwibitai/nanoclaw)** | C | brainclaw skill — messaging agent (WhatsApp, Telegram, Slack) |
| [![NemoClaw](https://img.shields.io/badge/NemoClaw-76B900?logo=nvidia&logoColor=white)](https://github.com/NVIDIA/NemoClaw) | **[NemoClaw](https://github.com/NVIDIA/NemoClaw)** | C | brainclaw skill — NVIDIA enterprise agent stack |
| [![PicoClaw](https://img.shields.io/badge/PicoClaw-00ADD8?logo=go&logoColor=white)](https://github.com/sipeed/picoclaw) | **[PicoClaw](https://github.com/sipeed/picoclaw)** | C | brainclaw skill — edge/IoT agent (Go, <10MB RAM) |
| [![ZeroClaw](https://img.shields.io/badge/ZeroClaw-B7410E?logoColor=white)](https://github.com/zeroclaw-labs/zeroclaw) | **[ZeroClaw](https://github.com/zeroclaw-labs/zeroclaw)** | C | brainclaw skill — ultra-lightweight Rust agent (20+ channels) |

**Tier C** = no MCP, no hooks — skill-based only with inline context and constrained resources. Autonomous agents use `--profile compact` for short sessions.

brainclaw is most effective today when one agent works at a time in a given checkout and the next agent resumes from shared context, claims, and handoffs.

---

## Platform Support

brainclaw declares support for Node.js 20+ in `package.json`, and CI actively exercises Node 20, 22, and 24 across the main Linux path (Windows runs on Node 24). Real-world support is still not perfectly even yet.

| Logo | Platform | Status today | Notes |
|---|---|---|---|
| [![Linux](https://img.shields.io/badge/Linux-111111?logo=linux&logoColor=white)](https://www.kernel.org/) | **[Linux](https://www.kernel.org/)** | Recommended | best-supported environment today; GitHub CI runs on Ubuntu with Node 20, 22, and 24 |
| [![macOS](https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white)](https://www.apple.com/macos/) | **[macOS](https://www.apple.com/macos/)** | Likely supported | Unix-like path and shell model should map well, but it is less exercised than Linux |
| [![Windows](https://img.shields.io/badge/Windows-0078D4?logo=windows&logoColor=white)](https://www.microsoft.com/windows/) | **[Windows](https://www.microsoft.com/windows/)** | Supported with caveats | native support exists, but PATH, npm, SSH, and PowerShell quoting still create more friction than on Unix systems |
| [![Windows + WSL2](https://img.shields.io/badge/Windows%20%2B%20WSL2-0078D4?logo=windows&logoColor=white)](https://learn.microsoft.com/windows/wsl/) | **[Windows + WSL2](https://learn.microsoft.com/windows/wsl/)** | Important, still maturing | Brainclaw detects this setup explicitly, but setup/install/store parity across Windows and WSL is not fully seamless yet |

If you want the least surprising setup today, use Linux first. If you are on Windows, prefer a disciplined single-environment workflow and expect a few extra machine-specific fixes.

---

## Get Started

### 1. Install

```bash
npm install -g brainclaw
```

### 2. Initialize a project

```bash
cd your-project
brainclaw init
```

This creates `.brainclaw/` in your repo, detects your coding agent, writes MCP config and instruction files, and sets up session hooks. It takes about 10 seconds.

### 3. Restart your agent

Restart your coding agent (or reload MCP servers) so it picks up the new configuration. After that, brainclaw tools are available.

### 4. Start working

Pick one of the canonical entry points depending on what you're doing:

```text
# Solo work — start a session, load context, claim a scope:
bclaw_work(intent="execute", scope="src/feature")

# Multi-agent — assign work, consult, or open a review:
bclaw_coordinate(intent="assign|consult|review", task="...", targetAgents=[...])

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

### 5. Verify it works

```bash
brainclaw status          # see active sessions, claims, plans
brainclaw agent-board     # see what each agent is doing
```

### Multi-agent setup

To configure brainclaw for all your repos and agents at once:

```bash
brainclaw setup --yes
```

This scans your projects, detects installed agents (Claude Code, Codex, Cursor, Copilot, Cline, Mistral Vibe, etc.), and writes MCP configs for each.

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
4. **Live state for hook-less agents** — Tier B/C agents without lifecycle hooks (Cursor, Cline, Windsurf, Copilot, Continue, Kilocode, Mistral Vibe) get live context via `.live.md` companions regenerated on session-end and handoff, not via real-time push.

Recommended use today:

1. for parallel work, dispatch a sequence with `bclaw_dispatch(intent="execute")` — each lane gets its own worktree
2. for sequential work in the same project, let one agent claim at a time and rely on handoffs
3. when reviewing or fixing across agents, prefer symmetric review loops over manual ping-pong
4. keep multi-machine workflows on a single source of truth until federation lands

---

## Multi-stack worktree

When brainclaw creates an agent worktree, it auto-detects which dependency directories to symlink from the main worktree based on stack markers present in the project root:

| Stack marker | Symlinked directories |
|---|---|
| `package.json` | `node_modules` |
| `requirements.txt` / `pyproject.toml` / `Pipfile` | `venv`, `.venv` |
| `Gemfile` | `vendor/bundle` |
| `go.mod` | `vendor` |
| `composer.json` | `vendor` |
| `mix.exs` | `deps` |

Maven, Gradle, and Cargo are intentionally excluded — their dependency caches are machine-global (`~/.m2`, `~/.gradle/caches`, `~/.cargo/registry`) and found automatically by the toolchain.

Build outputs like `dist` are **not** symlinked — they must be per-worktree to avoid EBUSY errors when other processes hold handles on the output directory.

Override detection in `.brainclaw/config.yaml`:

```yaml
worktree:
  shared_paths: [".cache"]        # additive to auto-detected
  exclude_shared: ["node_modules"] # opt-out a detected entry
```

---

## Documentation

The npm package includes the Markdown docs below under `docs/`. Public web docs on `brainclaw.dev` are still being rolled out, so the npm README does not depend on private GitHub links.

If you are integrating Brainclaw into an agent workflow, start with the agent-facing docs first:

| | |
|---|---|
| `docs/index.md` | Documentation index grouped by getting started, guides, reference, and design |
| `docs/integrations/overview.md` | Start here for agent integrations |
| `docs/integrations/mcp.md` | MCP runtime path for capable agents |
| `docs/quickstart.md` | First-time setup on a new project (greenfield) |
| `docs/quickstart-existing-project.md` | Joining a project that already has `.brainclaw/` |
| `docs/server-operations.md` | Operator and remote-server workflow guide |
| `docs/cli.md` | CLI reference for operators, scripts, and fallback use |
| `docs/concepts/memory.md` | What "memory" means in brainclaw |
| `docs/concepts/plans-and-claims.md` | Coordination layer |
| `docs/concepts/runtime-notes.md` | Ephemeral observations |
| `docs/concepts/multi-agent-workflows.md` | The four common scenarios — orchestration, agent switching, project recovery, team async |
| `docs/concepts/troubleshooting.md` | Runbook for degraded coordination state — stale claims, missing dist, octopus failures, etc. |
| `docs/integrations/cursor.md` | Cursor |
| `docs/integrations/claude-code.md` | Claude Code |
| `docs/integrations/copilot.md` | GitHub Copilot |
| `docs/integrations/codex.md` | Codex |
| `docs/storage.md` | Storage model |
| `docs/security.md` | Security model |
| `docs/review.md` | Reflective review |
| `docs/reputation.md` | Reputation signals |
| `docs/playbooks/` | Audience design constraints for brainclaw development |

---

## Running tests

Contributor note: the commands below are for developing Brainclaw itself, not for normal agent usage inside a target repo.

```bash
npm test                   # unit + smoke (fast path)
npm run test:e2e           # full suite
npm run test:coverage      # with coverage report
```

---

## Changelog

For older releases (v0.x and the early v1.0 launch series), `git log` on `master` is the source of truth — every release commit follows the `chore(release): bump version to <semver>` convention, and the matching feature/fix commits reference their plan id (e.g. `feat(mcp): self-heal ... (pln#478)`).

### v1.2.0

- **zod 3 → 4 migration** (pln#486) — schemas are semantically equivalent but the JSON Schema emitted by `tools/list` shifted shape; downstream MCP clients that snapshot schemas should re-pin. See `docs/mcp-schema-changelog.md` for the public surface fingerprint.

### v1.1.0

- **Node 20+ baseline** (pln#485) — `engines.node` is now `>=20.0.0` (Node 18 reached EOL in April 2025). CI matrix runs Node 20, 22, and 24 on Linux; Windows on Node 24.
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

Current releases of brainclaw are published under the [Business Source License 1.1](LICENSE) — (c) 2024-2026 Juan Berdah.

The long-term direction is simpler than the current wording might suggest:

- the local-first brainclaw core is intended to move to MIT after the closed beta
- cloud shared-memory, remote collaboration services, advanced dashboards, and related hosted add-ons will live in separate commercial products

The intended MIT core covers what makes brainclaw useful inside a repo today: local project memory, local MCP and CLI coordination, onboarding and bootstrap, plans, claims, handoffs, runtime notes, and local agent integrations.

The goal is not to close brainclaw down. The goal is to keep the local-first core open and genuinely useful on its own, while keeping hosted collaboration features separate.
