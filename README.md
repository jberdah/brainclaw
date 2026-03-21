<p align="center">
  <img src="https://brainclaw.dev/logo.png" alt="brainclaw" width="140" />
</p>

<h1 align="center">brainclaw</h1>

<p align="center"><strong>Local-first coordination for coding agents, with human-readable local control.</strong></p>

---

brainclaw gives a workspace a shared coordination layer for coding agents: project memory, explicit plans, file claims, handoffs, layered instructions, and prompt-ready context, all stored locally, versioned in Git, and readable in plain text.

For capable agents, the nominal path is:

1. read dynamic state through MCP
2. use native agent files such as `AGENTS.md`, `CLAUDE.md`, or Cursor rules as local guidance
3. leave the CLI to operators, scripts, setup, release, and fallback workflows

The best setup is usually not "open a terminal and run Brainclaw yourself".
The best setup is to tell your agent, in natural language, to install and initialize Brainclaw in the repo so it can bootstrap its own working context correctly.

It sits alongside Copilot, Claude Code, Cursor, Codex, Windsurf, OpenCode, Antigravity/Gemini CLI and other coding agents. It does not replace them. It gives them a shared state layer they can resume from reliably across sessions.

---

## Why brainclaw exists

Coding agents are getting better at local code generation, but they still struggle with shared project state.
Across real projects, agents often miss active constraints, forget known traps, duplicate work, step on the same files, and lose context between sessions or tool surfaces.

brainclaw solves this by making the repo itself agent-readable and agent-writeable through MCP, local memory files, and explicit coordination primitives.

---

## What it provides

| | |
|---|---|
| **Project memory** | constraints, decisions, traps, handoffs, and layered instructions agents can resume from |
| **Coordination state** | shared plans, file claims, runtime notes, and board views for active work |
| **Agent-ready context** | compact, prompt-sized context built from real workspace state instead of stale instructions |
| **Native agent files** | auto-writes `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules/`, `.windsurfrules`, and similar local guidance |
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

| Logo | Agent | Brainclaw fit | Best use today |
|---|---|---|---|
| [![Claude Code](https://img.shields.io/badge/Claude_Code-111111?logo=anthropic&logoColor=white)](https://github.com/anthropics/claude-code) | **[Claude Code](https://github.com/anthropics/claude-code)** | Best fit | full agent workflow with MCP, instructions, commands, and session hooks |
| [![Codex](https://img.shields.io/badge/Codex-111111?logo=openai&logoColor=white)](https://openai.com/codex/) | **[Codex](https://openai.com/codex/)** | Strong fit | agent-first repo coordination with explicit plans, claims, and handoffs |
| [![Cursor](https://img.shields.io/badge/Cursor-1F2430?logo=cursor&logoColor=white)](https://cursor.com/en-US) | **[Cursor](https://cursor.com/en-US)** | Strong fit | repo-native agent workflows with rules plus MCP |
| [![OpenCode](https://img.shields.io/badge/OpenCode-0F172A?logoColor=white)](https://github.com/opencode-ai/opencode) | **[OpenCode](https://github.com/opencode-ai/opencode)** | Strong fit | simple agent bootstrap with `AGENTS.md` plus workspace MCP |
| [![Windsurf](https://img.shields.io/badge/Windsurf-0B1220?logo=codeium&logoColor=white)](https://windsurf.com/) | **[Windsurf](https://windsurf.com/)** | Good fit | guided agent workflows with instructions, hooks, and MCP |
| [![Roo](https://img.shields.io/badge/Roo-7C3AED?logoColor=white)](https://github.com/RooCodeInc/Roo-Code) | **[Roo](https://github.com/RooCodeInc/Roo-Code)** | Good fit | workspace agent coordination with rules plus MCP |
| [![Continue](https://img.shields.io/badge/Continue-2563EB?logoColor=white)](https://github.com/continuedev/continue) | **[Continue](https://github.com/continuedev/continue)** | Good fit | editor-based agent workflows with MCP context access |
| [![Gemini CLI](https://img.shields.io/badge/Gemini_CLI-1A73E8?logo=googlegemini&logoColor=white)](https://github.com/google-gemini/gemini-cli) | **[Antigravity / Gemini CLI](https://github.com/google-gemini/gemini-cli)** | Promising fit | local agent workflows with `GEMINI.md` plus MCP |
| [![Cline](https://img.shields.io/badge/Cline-0F766E?logoColor=white)](https://github.com/cline/cline) | **[Cline](https://github.com/cline/cline)** | Functional fit | lightweight agent use through rules plus MCP |
| [![GitHub Copilot](https://img.shields.io/badge/GitHub_Copilot-181717?logo=githubcopilot&logoColor=white)](https://github.com/features/copilot) | **[GitHub Copilot](https://github.com/features/copilot)** | Supported fit | project awareness and shared local instructions with lighter workflow control |

brainclaw is most effective today when one agent works at a time in a given checkout and the next agent resumes from shared context, claims, and handoffs.

---

## Platform Support

brainclaw targets Node.js 20+ across major developer operating systems, but real-world support is not perfectly even yet.

| Logo | Platform | Status today | Notes |
|---|---|---|---|
| [![Linux](https://img.shields.io/badge/Linux-111111?logo=linux&logoColor=white)](https://www.kernel.org/) | **[Linux](https://www.kernel.org/)** | Recommended | best-supported environment today; GitHub CI runs on Ubuntu with Node 20 and 22 |
| [![macOS](https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white)](https://www.apple.com/macos/) | **[macOS](https://www.apple.com/macos/)** | Likely supported | Unix-like path and shell model should map well, but it is less exercised than Linux |
| [![Windows](https://img.shields.io/badge/Windows-0078D4?logo=windows&logoColor=white)](https://www.microsoft.com/windows/) | **[Windows](https://www.microsoft.com/windows/)** | Supported with caveats | native support exists, but PATH, npm, SSH, and PowerShell quoting still create more friction than on Unix systems |
| [![Windows + WSL2](https://img.shields.io/badge/Windows%20%2B%20WSL2-0078D4?logo=windows&logoColor=white)](https://learn.microsoft.com/windows/wsl/) | **[Windows + WSL2](https://learn.microsoft.com/windows/wsl/)** | Important, still maturing | Brainclaw detects this setup explicitly, but setup/install/store parity across Windows and WSL is not fully seamless yet |

If you want the least surprising setup today, use Linux first. If you are on Windows, prefer a disciplined single-environment workflow and expect a few extra machine-specific fixes.

---

## Best Setup

If you want the cleanest Brainclaw onboarding, ask your agent to do it.

Example:

```text
Install Brainclaw in this repo, initialize it, configure the agent integration if needed,
and then use Brainclaw for shared context, plans, claims, and handoffs while you work.
```

That is the product's intended entry path.
The human expresses the intent in plain language. The agent installs Brainclaw, bootstraps the repo, and then keeps using it through MCP and local agent files.

If the agent supports MCP well, this produces a better bootstrap than a human manually running setup commands first, because the agent can immediately:

- set up the workspace in the right environment
- write the local agent-facing files it will actually use
- configure MCP where supported
- start from shared context instead of ad hoc instructions

---

## Quick Example

```bash
# behind the scenes, the agent will typically bootstrap Brainclaw in the repo
npx brainclaw setup --yes
npx brainclaw init
```

After that, the agent should stay on Brainclaw's MCP path for live state:

```text
bclaw_session_start      -> open session + return board/context
bclaw_get_context        -> fetch fresh prompt-ready context for a path
bclaw_list_plans         -> inspect shared work
bclaw_claim              -> claim scope before editing
bclaw_write_note         -> record runtime observations
bclaw_session_end        -> close session and hand work off cleanly
```

Humans can still use the CLI directly for inspection, scripting, and fallback workflows:

```bash
brainclaw plan create "Coordinate auth rollout" --priority high
brainclaw claim create "Take auth rollout" --scope src/auth/
brainclaw context --for src/auth/routes.ts --digest
brainclaw status
```

---

## Installation

The intended path is agent-driven bootstrap inside the target repo, not a human doing a manual install flow first.

In practice, that means:

1. tell the agent to install and initialize Brainclaw in the repo
2. let the agent bootstrap MCP and native agent files
3. let the agent keep using Brainclaw for shared context and coordination while it works

If you need the underlying commands, the agent will usually do something close to:

```bash
npx brainclaw setup --yes
npx brainclaw init
```

That gives the agent a better bootstrap path because Brainclaw can immediately:

- detect the workspace
- write native agent files
- configure MCP where supported
- seed local project memory and coordination state

If you want a machine-level CLI for operator workflows, debugging, or repeated local use, a global install is still available, but it is not the primary onboarding path:

```bash
npm install -g brainclaw
```

If you are working from source while developing Brainclaw itself:

```bash
npm install
npm run build
```

Also available as `bclaw`:

```bash
bclaw init
bclaw status
```

---

## Quickstart

Start here conceptually:

1. ask the agent to install and initialize Brainclaw in the repo
2. let the agent use MCP for dynamic state
3. use the CLI yourself only when you need operator-level inspection or fallback access

Then choose the entry path that matches your surface:

- agent-first runtime: start with `docs/integrations/overview.md` and `docs/integrations/mcp.md`
- operator CLI: use `docs/quickstart.md` and `docs/cli.md`
- brownfield onboarding: use `brainclaw bootstrap` and the onboarding guides in `docs/`

If you are evaluating Brainclaw as a product, start with the agent-first runtime path, not the CLI reference.

Detailed Markdown guides are bundled in the npm package under `docs/`.

---

## Current Limitation

For now, avoid having multiple coding agents edit the same project in parallel in the same checkout.

brainclaw already helps one agent resume or review another agent's work with better shared context, plans, claims, and handoffs. But until dedicated Git worktrees per agent or session are implemented, concurrent edits in the same checkout can still create conflicts, overwritten local state, or confusing Git transitions.

Recommended use today:

1. let one agent work at a time in a given checkout
2. use handoffs when switching from one agent to another
3. use shared plans, claims, and context to preserve continuity

---

## How it fits into agent workflows

brainclaw sits *alongside* Copilot, Claude Code, Cursor, Codex, Windsurf, Cline, Roo, Continue, OpenCode, and Antigravity/Gemini CLI.

Typical agent-first flow:

1. a human asks the agent to install and initialize Brainclaw in the repo
2. the agent bootstraps Brainclaw in the right environment for that workspace
3. the agent connects through MCP for fresh context, board views, plans, claims, and runtime writes
4. native agent files provide local guidance and workflow reminders in the surface the agent already uses
5. humans use the CLI for inspection, scripting, release, and fallback operations
6. shared plans, claims, handoffs, and runtime notes keep the next agent resumeable

brainclaw exposes collaboration views through MCP-readable tools, including context, board views, and structured lists for plans, claims, agents, instructions, and candidates. Readable local files still matter, but MCP is the stronger path for dynamic state and write operations.

---

## Documentation

The npm package includes the Markdown docs below under `docs/`. Public web docs on `brainclaw.dev` are still being rolled out, so the npm README does not depend on private GitHub links.

If you are integrating Brainclaw into an agent workflow, start with the agent-facing docs first:

| | |
|---|---|
| `docs/integrations/overview.md` | Start here for agent integrations |
| `docs/integrations/mcp.md` | MCP runtime path for capable agents |
| `docs/quickstart.md` | Setup paths, including operator and brownfield flows |
| `docs/cli.md` | CLI reference for operators, scripts, and fallback use |
| `docs/concepts/memory.md` | What "memory" means in brainclaw |
| `docs/concepts/plans-and-claims.md` | Coordination layer |
| `docs/concepts/runtime-notes.md` | Ephemeral observations |
| `docs/integrations/cursor.md` | Cursor |
| `docs/integrations/claude-code.md` | Claude Code |
| `docs/integrations/copilot.md` | GitHub Copilot |
| `docs/integrations/codex.md` | Codex |
| `docs/storage.md` | Storage model |
| `docs/security.md` | Security model |
| `docs/review.md` | Reflective review |
| `docs/reputation.md` | Reputation signals |

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

### v0.9.10

- **OpenCode** : détection et auto-config MCP workspace via `opencode.json`; l'export réutilise `AGENTS.md`
- **Antigravity / Gemini CLI** : détection et export `gemini-md` vers `GEMINI.md`, avec MCP machine-level sous `.gemini/antigravity/mcp_config.json`
- **Workflow export** : la doc export couvre désormais explicitement les nouveaux formats et fichiers générés

### v0.7.2

- **UserPromptSubmit hook** : correction du format — `brainclaw context` (texte markdown) au lieu de `--json` pour injection correcte dans le contexte Claude Code

### v0.7.1

- **Cross-platform `npx` fix** : `brainclaw init` et `brainclaw export` ajoutent désormais brainclaw en `devDependency` du projet cible — `npx brainclaw` fonctionne dans les hooks Claude Code sans dépendre du PATH global (résout Windows WSL/Git Bash)

### v0.7.0

- **Claude Code** : intégration native complète — MCP (`.mcp.json`), slash command (`.claude/commands/brainclaw.md`), hooks de session (`UserPromptSubmit` + `Stop`) dans `.claude/settings.local.json`
- **Cursor** : config MCP machine-level (`~/.cursor/mcp.json`) ajoutée à l'auto-config
- **Roo Code** : config MCP workspace (`.roo/mcp.json`)
- **Continue** : config MCP workspace (`.continue/config.json`, format array)
- **Hygiene section** renforcée : workflow plan/claim/session-end inclus dans toutes les instructions générées
- **Canal de mise à jour local** (`brainclaw version --publish-local`) : tarball + manifeste `.releases/`

---

## License

Current releases of brainclaw are published under the [Business Source License 1.1](LICENSE) — © 2024-2026 Juan Berdah.

The long-term direction is simpler than the current wording might suggest:

- the local-first brainclaw core is intended to move to MIT after the closed beta
- cloud shared-memory, remote collaboration services, advanced dashboards, and related hosted add-ons will live in separate commercial products

The intended MIT core covers what makes brainclaw useful inside a repo today: local project memory, local MCP and CLI coordination, onboarding and bootstrap, plans, claims, handoffs, runtime notes, and local agent integrations.

The goal is not to close brainclaw down. The goal is to keep the local-first core open and genuinely useful on its own, while keeping hosted collaboration features separate.
