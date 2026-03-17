<p align="center">
  <img src="docs/assets/logo.png" alt="brainclaw" width="140" />
</p>

<h1 align="center">brainclaw</h1>

<p align="center"><strong>Local-first coordination for humans and coding agents.</strong></p>

<p align="center">
  <a href="../../actions/workflows/ci.yml"><img src="../../actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
</p>

---

brainclaw gives a workspace a shared coordination layer: project memory, explicit plans, file claims, handoffs, layered instructions, and prompt-ready context — stored locally, versioned in Git, readable in plain text.

It sits alongside Copilot, Claude Code, Cursor, Codex, Windsurf, OpenCode, Antigravity/Gemini CLI and any other coding agent. It does not replace them. It helps them work together.

---

## Why brainclaw exists

Coding agents are getting better at local code generation, but they still struggle with shared project state.
Across real projects, agents often miss active constraints, forget known traps, duplicate work, step on the same files, and lose context between sessions.

brainclaw solves this by giving the workspace a shared coordination layer that both humans and agents can read and update.

---

## What it provides

| | |
|---|---|
| **Project memory** | constraints, decisions, traps, handoffs, layered instructions |
| **Coordination state** | shared plans, file claims, handoffs, runtime notes, board views |
| **Agent-ready context** | compact, prompt-sized context generated from real workspace state |
| **Native agent files** | auto-writes `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules/`, `.windsurfrules`, etc. |
| **Local-first storage** | plain text + JSON, Git-friendly, no cloud, no telemetry |

---

## Quick example

```bash
npx brainclaw init

npx brainclaw decision "OAuth migration now goes through auth-gateway" --tag auth
npx brainclaw constraint "Payments module frozen until 2026-04-01" --tag payments
npx brainclaw trap "Checkout E2E tests are flaky on Windows" --severity high
npx brainclaw plan "Coordinate auth rollout" --priority high
npx brainclaw handoff --from backend --to qa "Validate refund endpoint"

npx brainclaw context --json
npx brainclaw status
```

---

## Installation

```bash
npm install -g brainclaw   # global
# or
npm install && npm run build  # from source
```

Also available as `bclaw`:

```bash
bclaw init
bclaw status
```

---

## Quickstart

```bash
brainclaw init
brainclaw decision "OAuth migration now goes through auth-gateway" --tag auth
brainclaw constraint "Payments module frozen until 2026-04-01" --tag payments
brainclaw trap "Checkout E2E tests are flaky on Windows" --severity high
brainclaw plan "Coordinate auth rollout" --priority high
brainclaw context --json
```

→ [Full quickstart guide](docs/quickstart.md)

---

## How it fits into agent workflows

brainclaw sits *alongside* Copilot, Claude Code, Cursor, Codex, Windsurf, Cline, Roo, Continue, OpenCode, and Antigravity/Gemini CLI.

Typical flow:

1. `brainclaw init` — seeds workspace memory, writes to the detected agent's native instruction file
2. record constraints, decisions, traps, and plans
3. let agents read brainclaw context before editing
4. use claims to reduce collisions
5. hand work off explicitly when needed
6. keep shared state visible across sessions

brainclaw can also expose collaboration views through MCP-readable tools.

---

## Documentation

| | |
|---|---|
| [docs/quickstart.md](docs/quickstart.md) | Get started in 5 minutes |
| [docs/cli.md](docs/cli.md) | Full command reference |
| [docs/concepts/memory.md](docs/concepts/memory.md) | What "memory" means in brainclaw |
| [docs/concepts/plans-and-claims.md](docs/concepts/plans-and-claims.md) | Coordination layer |
| [docs/concepts/runtime-notes.md](docs/concepts/runtime-notes.md) | Ephemeral observations |
| [docs/integrations/overview.md](docs/integrations/overview.md) | How to integrate with any agent |
| [docs/integrations/cursor.md](docs/integrations/cursor.md) | Cursor |
| [docs/integrations/claude-code.md](docs/integrations/claude-code.md) | Claude Code |
| [docs/integrations/copilot.md](docs/integrations/copilot.md) | GitHub Copilot |
| [docs/integrations/codex.md](docs/integrations/codex.md) | Codex |
| [docs/integrations/mcp.md](docs/integrations/mcp.md) | MCP tools |
| [docs/storage.md](docs/storage.md) | Storage model |
| [docs/security.md](docs/security.md) | Security model |
| [docs/review.md](docs/review.md) | Reflective review |
| [docs/reputation.md](docs/reputation.md) | Reputation signals |

---

## Running tests

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

[Business Source License 1.1](LICENSE) — © 2024-2026 Juan Berdah

Free for non-production and internal use. Production use is permitted provided you do not build or offer a competing product or service (shared agent memory / coordination / context management for coding agents or development teams). Each version converts to MIT four years after its release date.

For commercial licensing inquiries, contact the licensor.
