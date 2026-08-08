# CLI Reference

The CLI is Brainclaw's explicit operator, scripting, release, and fallback surface. All commands are available as `brainclaw` or its alias `bclaw`.

For capable coding agents, prefer MCP for dynamic runtime state:

- `bclaw_work(intent)` to start working — handles session, context, and claim creation in one call
- `bclaw_context(kind)` for memory / execution / board reads instead of repeated raw CLI context calls
- `bclaw_find(entity, filter?)` / `bclaw_get(entity, id)` for plans, claims, candidates, handoffs, and other entities (legacy `bclaw_list_*` / `bclaw_get_context` still work via a redirect warning)
- `bclaw_claim`, `bclaw_write_note`, and `bclaw_session_end` for session continuity

Use the CLI when a human operator is driving the workflow, when you are scripting setup or release operations, or when MCP is not the integration path.

## Global Options

All commands support these global options:

| Option | Description |
|---|---|
| `--cwd <path>` | Override working directory for this invocation. Bypasses active project and env var resolution. |
| `--verbose` | Show info-level log messages on stderr |
| `--debug` | Show debug-level log messages on stderr |

**Effective cwd resolution priority** (highest wins):

1. `--cwd` flag
2. `BRAINCLAW_PROJECT` environment variable (project name or path)
3. Active project set via `brainclaw switch`
4. `process.cwd()` (shell working directory)

---

## Multi-Project Navigation

### `brainclaw switch [project]`

Set the active project for subsequent CLI and MCP commands. This eliminates the need to `cd` into a subproject directory in multi-project workspaces.

**Session-scoped by default (v1.10.0).** A plain `switch <project>` only affects the **calling agent's session** — it auto-creates a session if needed and never touches the shared pointer. This is what keeps two agents working in the same monorepo independent: neither clobbers the other.

**What the read paths report (v1.21.0).** `switch --list` and the no-argument "show current" both derive from the *same* resolver that routes an actual write, and echo the selector that won as `scope` (show) / `active_source` (`--list`): `session`, `global`, `cwd_child` (you are standing inside a child project), `env_project` / `explicit` (named by `$BRAINCLAW_PROJECT` or `--cwd`), or `cwd` (nothing points anywhere — commands use the current directory). Before v1.21.0 these two read paths walked their own session-then-global ladder, so an agent inside a child project was shown the *shared* pointer while its writes went to the child. Reporting a project a write would not reach is the defect that behaviour existed to hide, so the reported project and the written project are now the same one by construction.

`--global` is the **only** path that writes (or, with `--clear`, removes) the shared, per-workspace `.brainclaw/active-project.json` that every agent on the host sees. Use it for an operator setting a workspace-wide default — not for per-agent work.

| Option | Description |
|---|---|
| `--list` | List all available projects in the workspace (marks the session's active project) |
| `--clear` | Clear the **session's** active project (revert to cwd); add `--global` to clear the shared pointer |
| `--global` | Write/clear the **shared** workspace default for all agents (the only path that mutates `active-project.json`); bypasses the session |
| `--json` | Output as JSON (includes `scope: "session" \| "global"`) |

The `<project>` argument accepts:
- **Project name** — matched against the global registry, workspace config, and cross-project links
- **Relative path** — resolved from the workspace root (e.g. `apps/lodestar`)
- **Absolute path** — used directly

```bash
brainclaw switch --list              # discover available projects
brainclaw switch lodestar            # session-scoped switch (isolated to this agent)
brainclaw switch apps/lodestar       # switch by relative path
brainclaw switch                     # show current active project (session-aware)
brainclaw switch --clear             # clear THIS session's active project
brainclaw switch lodestar --global   # set the shared workspace default for everyone
brainclaw switch --clear --global    # clear the shared workspace default
brainclaw --cwd /other/path status   # one-off override without switching
```

**MCP usage:** The active project also affects MCP tools. When `bclaw_context(kind="memory")` is called without an explicit path, it resolves context from the active project's store. Agents can also use the `BRAINCLAW_PROJECT=<name>` environment variable for the same effect.

### `brainclaw move <entity> <id> --to <project>`

Relocate a brainclaw item to another project in a multi-project workspace, **preserving its id** — so `pln#`/`dec#` references stay stable. Useful when an item was created in the wrong store (e.g. before a project switch took effect). MCP equivalent: `bclaw_move(entity, id, to_project, …)`.

| Option | Description |
|---|---|
| `--to <project>` | Target project (name, path, or basename) — required |
| `--from <project>` | Source project (defaults to the current project) |
| `--force` | Move even if an active claim references the item |
| `--json` | Output as JSON |

Relocatable entities: `plan`, `decision`, `constraint`, `trap`, `handoff`, `sequence`. **Execution-local entities** (`claim`, `assignment`, `agent_run`, `session`) are rejected — they belong to the project where the work ran. The move refuses an id collision in the target or a plan under an active claim (unless `--force`), audits both stores, and warns about sequences that still reference a moved plan.

```bash
brainclaw move plan pln_a1b2c3d4 --to global          # move a misplaced plan to the root project
brainclaw move decision dec_99 --from app_a --to app_b
```

---

## Initialize and Inspect

### `brainclaw setup`

Global onboarding wizard — bootstraps the machine, detects AI agents, installs global Brainclaw prerequisites, writes agent/MCP config, gitignores generated workspace-local integration files, and initialises multiple repositories in one pass. It scans each root itself plus its direct child repositories, and ignores internal Brainclaw memory repos such as `.brainclaw/`.

| Option | Description |
|---|---|
| `--roots <paths>` | Comma-separated root directories to scan for git repos (skips interactive prompt) |
| `--agents <agents>` | Agents to configure: `all`, `detected`, or comma-separated names (e.g. `claude-code,cursor`) |
| `--repos <mode>` | Repo selection: `all`, `current`, or comma-separated numbers (e.g. `1,3`) |
| `-y, --yes` | Accept all defaults non-interactively |

```bash
brainclaw setup                                         # interactive wizard
brainclaw setup --yes                                   # non-interactive, detected agent, current dir
brainclaw setup --roots ~/Projects --agents detected    # scan ~/Projects, configure detected agent only
brainclaw setup --roots ~/Projects,~/work --agents all  # all agents, multiple roots
```

**MCP usage (agent-driven):** Use `bclaw_setup` with the resume pattern — call without `step` to start, then pass `step` + `choice` to advance through each stage (`project_roots` → `repo_selection` → `agent_selection`).

---

### `brainclaw setup-machine`

Machine-only onboarding. Detects available agents, writes the machine-level MCP/user config Brainclaw manages, refreshes machine inventory, and stops there — no repository scan, no `.brainclaw/` init in the current working tree.

| Option | Description |
|---|---|
| `--agents <agents>` | Agents to configure: `all`, `detected`/`installed`, comma-separated names, or numeric choices from the prompt |
| `-y, --yes` | Accept all defaults non-interactively |

```bash
brainclaw setup-machine
brainclaw setup-machine --yes
brainclaw setup-machine --agents codex,cursor
```

Use this when Brainclaw is new on the current machine and you want to make the MCP surface visible to your coding agent before touching any project. The usual follow-up is `brainclaw init` inside the project you want to create or refresh.

By default, `detected` means the current agent plus every installed coding agent Brainclaw can detect on the machine. In non-interactive `--yes` mode, Brainclaw configures that detected install set when it is non-empty; explicit `--agents ...` always wins.

---

### `brainclaw init`

Create or refresh Brainclaw state for the current project root. Detects the AI agent environment, writes or refreshes its native instruction file, and installs a git post-merge hook for automatic claim release. `init` is now safe to rerun on an already initialized project: it preserves canonical memory and refreshes the managed Brainclaw and detected-agent files. Do not run `init` from inside `.brainclaw/`; that directory is Brainclaw's own memory store, not a project root.

| Option | Description |
|---|---|
| `-y, --yes` | Non-interactive, accept all defaults |
| `--force` | Rebuild managed initialization from Brainclaw defaults while preserving canonical memory data |
| `--compact` | Generate a compact instruction file |
| `--topology <value>` | Storage topology (e.g. `sidecar` to store outside the repo) |
| `--project-mode <value>` | Project mode (e.g. `multi-project`) |
| `--project-strategy <value>` | Project strategy (e.g. `folder`) |
| `--no-analyze-repo` | Skip automatic repository analysis |
| `--scan` | Scan repository for existing conventions |

```bash
brainclaw init
brainclaw init -y
brainclaw init --force
brainclaw init --topology sidecar
brainclaw init --project-mode multi-project --project-strategy folder
```

Common onboarding split:

- new machine → `brainclaw setup-machine --yes` configures detected installed agents
- current project (new or already using Brainclaw) → `brainclaw init`
- explicit second agent on an existing Brainclaw project → `brainclaw enable-agent <agent-name>`

### `brainclaw machine-profile`

Detect and persist machine-level capabilities, including other local AI work surfaces on the same machine.

This is the inventory Brainclaw uses to distinguish coding agents from desktop AI apps or adjacent surfaces such as:

- `ChatGPT Desktop`
- `Claude Desktop`
- `Claude Cowork`
- `Gemini Web`
- `Gemini CLI / Antigravity`

| Option | Description |
|---|---|
| `--refresh` | Force regeneration even if a cached profile already exists |
| `--json` | Output as JSON |

```bash
brainclaw machine-profile
brainclaw machine-profile --refresh
brainclaw machine-profile --refresh --json
```

Use this when you want Brainclaw to detect what AI work surfaces are actually available on the current machine before choosing an onboarding path or queueing work for another surface.

### `brainclaw upgrade`

Upgrade the local Brainclaw store layout and refresh managed agent files when a release changes persisted schema or generated workspace integrations.

| Option | Description |
|---|---|
| `--json` | Output as JSON |
| `--dry-run` | Preview what would be upgraded without writing |

```bash
brainclaw upgrade
brainclaw upgrade --dry-run
brainclaw upgrade --dry-run --json
```

`upgrade` only covers store and generated-file migrations. On complex workspaces, it does not refresh machine detection, agent inventory, or brownfield bootstrap state by itself.

### `brainclaw reconcile`

Refresh machine, agent, and bootstrap state after a package update or when onboarding an already-initialized multi-store workspace.

This is the command to use when `brainclaw upgrade` reports no schema migration, but the installed release still introduces new workspace-centric behavior that depends on:

- a refreshed `machine-profile`
- a refreshed `agent-inventory`
- refreshed bootstrap state for the current store and any nested Brainclaw stores discovered under a `multi-project` + `folder` workspace

| Option | Description |
|---|---|
| `--json` | Output as JSON |
| `--dry-run` | Preview the reconciliation plan without writing |
| `--apply-bootstrap` | Apply bootstrap suggestions across all selected stores after refresh |
| `-y, --yes` | Skip confirmation prompts for multi-store bootstrap apply |
| `--skip-machine-profile` | Skip machine profile refresh |
| `--skip-agent-inventory` | Skip agent inventory refresh |

```bash
brainclaw reconcile --dry-run --json
brainclaw reconcile
brainclaw reconcile --apply-bootstrap -y
```

Recommended post-update flow for an existing complex workspace:

```bash
brainclaw upgrade --dry-run --json
brainclaw reconcile --dry-run --json
brainclaw reconcile --apply-bootstrap -y
brainclaw context --json
brainclaw doctor --json
```

For a `multi-project` workspace using `projects.strategy: folder`, `reconcile` treats the current store as the workspace root and plans refreshes for nested child stores that already contain their own `.brainclaw/` directories.

### `brainclaw status`

Show the current state of project memory.

| Option | Description |
|---|---|
| `--json` | Output as JSON |
| `--markdown` | Output as Markdown |

```bash
brainclaw status
brainclaw status --json
brainclaw status --markdown
```

In `multi-project` mode, status now reports the effective project count resolved for the workspace. With `projects.strategy: folder`, that includes child stores discovered from nested `.brainclaw/` directories even when `config.projects.known` is still empty.

### `brainclaw doctor`

Run health checks on config, state, and generated views.

| Option | Description |
|---|---|
| `--json` | Output as JSON |
| `--migration-check` | Check for pending migrations |
| `--fix-agent-ignore` | Add missing `.gitignore` entries for generated local Brainclaw agent files |
| `--fix-hooks` | Purge stale/broken/duplicate brainclaw session hooks across all Claude Code settings scopes (user + cwd) and rewrite the canonical ones |

```bash
brainclaw doctor
brainclaw doctor --json
brainclaw doctor --migration-check
brainclaw doctor --fix-agent-ignore
brainclaw doctor --fix-hooks
```

`--fix-hooks` collapses every recognized brainclaw session hook (across `UserPromptSubmit` / `Stop` / `PostToolUse`) in `~/.claude/settings.json`, `~/.claude/settings.local.json`, `<cwd>/.claude/settings.json`, and `<cwd>/.claude/settings.local.json` down to a single canonical entry, repairing legacy/broken forms. It only touches files (and events) that already contain a brainclaw hook, so user-authored hooks and hook-less scopes are left untouched. Use it when you see repeated `UserPromptSubmit hook error` warnings.

When Brainclaw detects generated local agent files such as `.mcp.json` or `.claude/settings.local.json` inside a Git repo, `doctor` warns if they are not ignored or are still tracked. `--fix-agent-ignore` only updates `.gitignore`; if a file is already tracked you still need to untrack it with `git rm --cached <path>`.

In `multi-project` mode with `projects.strategy: folder`, `doctor` now checks the effective workspace project set, not just `config.projects.known`. That avoids false positives on workspaces that resolve child stores from the filesystem or global project registry.

#### Repair candidates (pln#397)

`doctor --json` also emits a `repair_candidates[]` array listing machine-readable remediation actions. Each entry has `{ action, target, description, safe, related_check }`. Safe candidates are pure-creation or idempotent; unsafe candidates relocate existing files and require explicit confirmation. Consume them with `brainclaw repair`.

### `brainclaw repair`

Apply the structured `repair_candidates[]` surfaced by `doctor`. By default only `safe: true` candidates run; unsafe candidates stay deferred with a clear reason.

| Option | Description |
|---|---|
| `--dry-run` | Print the plan without executing anything |
| `--include-unsafe` | Also apply candidates flagged unsafe (files are **relocated**, never deleted) |
| `--json` | Output as JSON |

```bash
brainclaw repair --dry-run          # preview
brainclaw repair                    # execute safe actions
brainclaw repair --include-unsafe   # include quarantine etc.
brainclaw repair --json             # structured output
```

Preservation guarantees: the repair module never calls `unlink`/`rm`/`rmdir`. Unsafe actions (e.g. malformed inbox messages) are relocated to labelled parking directories such as `coordination/inbox/.quarantine/` so operators can recover them manually. A preservation banner lists exactly what moves and where before execution.

Today the flow covers missing entity subdirectories (`mkdir` action) and inbox hygiene (`move_inbox_message`, `quarantine_inbox_message`). More actions — orphaned agent references, mixed-version drift — land as additional repair candidates emitted by `doctor`.

### `brainclaw rebuild`

Regenerate the legacy `.brainclaw/project.md` readable summary from canonical state. No options. This file is derived and does not replace the root `PROJECT.md` project vision or live coordination surfaces such as `agent-board`.

```bash
brainclaw rebuild
```

### `brainclaw bootstrap`

Bootstrap shared memory for a new agent or project context.

For capable agents, the MCP equivalent is `bclaw_bootstrap`. Use the CLI when a human is driving onboarding, reviewing the import proposal, or operating in fallback mode.

| Option | Description |
|---|---|
| `--for <agent>` | Target agent name |
| `--json` | Output as JSON |
| `--refresh` | Force refresh even if bootstrap data is recent |
| `--interview` | Render adaptive interview prompts instead of the bootstrap summary |
| `--audience <audience>` | Filter interview prompts for `cli`, `ide_chat`, or `any` |
| `--answers-file <path>` | Load structured interview answers from JSON and enrich the import proposal before preview/apply |
| `--apply` | Import the current bootstrap proposal into canonical memory |
| `--uninstall` | Deactivate the last bootstrap-managed import |
| `-y, --yes` | Skip confirmation prompts for apply/uninstall |

```bash
brainclaw bootstrap --for copilot
brainclaw bootstrap --for claude --refresh --json
brainclaw bootstrap --interview --audience cli
brainclaw bootstrap --answers-file ./bootstrap-answers.json --json
brainclaw bootstrap --answers-file ./bootstrap-answers.json --apply -y
brainclaw bootstrap --apply -y
```

`--answers-file` expects a JSON array keyed by interview question IDs. Each entry can provide free-form answers (`response_text`, `response_items`, `response_boolean`) and optional explicit `suggestions` to confirm durable imports such as `decision`, `constraint`, `instruction`, or `trap`.

### `brainclaw env`

Display environment, tooling detection, and installable Brainclaw update information.

| Option | Description |
|---|---|
| `--json` | Output as JSON |
| `--agent-tooling` | Show detected agent tooling details |

```bash
brainclaw env
brainclaw env --json
brainclaw env --agent-tooling
```

When the project does not pin a local release channel, `brainclaw env` checks the public npm `latest` channel for installable updates. Projects can override that with `brainclaw_update_source`, for example to use `prelaunch` or a local-pack manifest.

### `brainclaw surface-task <subcommand>`

Manage queued tasks for non-editing AI work surfaces such as `ChatGPT Desktop`, `Claude Desktop`, or `Gemini Web`.

This command is useful when the active coding agent should keep building in the repo, but another local AI surface would be a better fit for a related task such as:

- generating a visual asset
- drafting polished copy
- writing a release summary
- doing side research or structured analysis

Supported subcommands:

- `create`
- `list`
- `update`

| Option | Description |
|---|---|
| `--target <surface>` | Target surface such as `chatgpt`, `claude`, or `gemini` |
| `--kind <kind>` | `visual_asset`, `draft`, `summary`, `analysis`, `research`, or `custom` |
| `--instructions <text>` | Detailed task instructions |
| `--output <paths...>` | Expected output files or deliverables |
| `--tag <tags...>` | Optional tags |
| `--path <paths...>` | Related repo paths |
| `--status <status>` | For `list` filtering or `update`: `queued`, `in_progress`, `completed`, `cancelled`, `failed` |
| `--result <text>` | Result note when updating a task |
| `--all` | Include completed, cancelled, and failed tasks in `list` |
| `--json` | Output as JSON for `list` |

```bash
brainclaw surface-task create "Generate homepage hero visual" \
  --target chatgpt \
  --kind visual_asset \
  --instructions "Create a lightweight SaaS hero visual in PNG format." \
  --output assets/hero-home.png \
  --path src/pages/Home.tsx

brainclaw surface-task list

brainclaw surface-task update ast_12345678 \
  --status completed \
  --result "Saved the visual to assets/hero-home.png" \
  --output assets/hero-home.png
```

These tasks are local project coordination state. They do not execute automatically yet. The intended model is that Brainclaw can queue work for another local AI surface so that the next session on that surface can pick it up cleanly.

---

## Memory Management

### `brainclaw memory create <type> <text>`

Create a canonical memory item. Supported types are `decision`, `constraint`, `trap`, and `handoff`.

| Option | Description |
|---|---|
| `--tag <tag>` | Tag for categorization (repeatable) |
| `--path <path>` | Scope to a file or folder path |
| `--author <name>` | Author name |
| `--outcome <outcome>` | Decision outcome: `approved`, `rejected`, `deferred`, `pending` |
| `--category <category>` | Constraint category: `architecture`, `performance`, `security`, `reliability`, `compatibility`, `process`, `other` |
| `--status <status>` | Trap status: `active`, `resolved`, `expired` |
| `--severity <severity>` | Trap severity: `low`, `medium`, `high` |
| `--visibility <visibility>` | Trap visibility: `shared`, `machine`, `private` |
| `--host <host>` | Optional host identifier override for machine/private traps |
| `--project <name>` | Optional project namespace |
| `--plan <id>` | Optional linked plan item ID |
| `--from <name>` | Required for `handoff` |
| `--to <name>` | Required for `handoff` |
| `--ttl <duration>` | Time-to-live for expiring traps |
| `--store <target>` | Store level: `local` (default), `repo`, `workspace`, `user` |

```bash
brainclaw memory create decision "OAuth goes through auth-gateway" --tag auth
brainclaw memory create decision "Use async/await instead of callbacks" --outcome approved --plan pln_001
brainclaw memory create constraint "Payments module frozen until 2026-04-01" --tag payments
brainclaw memory create trap "Checkout E2E tests are flaky on Windows" --severity high --tag tests
brainclaw memory create trap "Windows SSH is misconfigured" --status resolved --severity medium --tag windows
brainclaw memory create handoff "Validate new refund endpoint" --from backend --to qa --project payments
```

### `brainclaw memory list`

List canonical memory items across decisions, constraints, traps, and handoffs.

| Option | Description |
|---|---|
| `--type <type>` | Filter by `decision`, `constraint`, `trap`, or `handoff` |
| `--json` | Output as JSON |

```bash
brainclaw memory list
brainclaw memory list --type constraint
brainclaw memory list --type handoff --json
```

### `brainclaw memory update <id>`

Update an existing canonical memory item by `id` or short label.

| Option | Description |
|---|---|
| `--text <text>` | Replace the main text |
| `--tag <tag>` | Replace tags |
| `--path <path>` | Replace related paths |
| `--outcome <outcome>` | Decision outcome |
| `--category <category>` | Constraint category |
| `--status <status>` | Constraint, trap, or handoff status |
| `--severity <severity>` | Trap severity |
| `--project <name>` | Handoff project namespace |
| `--plan <id>` | Linked plan item ID |
| `--from <name>` | Handoff source |
| `--to <name>` | Handoff destination |

```bash
brainclaw memory update dec_001 --text "Use JWT everywhere" --outcome approved
brainclaw memory update cnd_001 --status resolved --category process
brainclaw memory update trp_001 --status resolved
brainclaw memory update hnd_001 --status accepted --to alice
```

### `brainclaw memory delete <id>`

Delete a canonical memory item by `id` or short label.

```bash
brainclaw memory delete dec_001
brainclaw memory delete hnd_001
```

Legacy aliases `decision`, `constraint`, `trap`, and `handoff` remain available for compatibility, but `brainclaw memory ...` is now the primary CLI surface.

---

## Project Metadata

### `brainclaw capability add <name> <description>`

Register a project capability.

| Option | Description |
|---|---|
| `--tag <tag>` | Tag for categorization as category (repeatable) |
| `--author <name>` | Author name |
| `--store <target>` | Store level: `local` (default), `repo`, `workspace`, `user` |

```bash
brainclaw capability add "API Rate Limiting" "Manages request rate limiting for external APIs" --tag architecture
brainclaw capability add "Database Migrations" "Handles schema migrations safely" --tag reliability
```

### `brainclaw capability list`

List all registered project capabilities.

### `brainclaw capability describe <id>`

Show full details of a capability.

---

### `brainclaw tool add <name> <description>`

Register a project tool.

| Option | Description |
|---|---|
| `--type <type>` | Tool type: `workflow`, `validator`, `generator`, `utility`, `explorer` |
| `--tag <tag>` | Tag for categorization (repeatable) |
| `--author <name>` | Author name |
| `--store <target>` | Store level: `local` (default), `repo`, `workspace`, `user` |

```bash
brainclaw tool add "npm-test" "Runs npm test suite" --type validator
brainclaw tool add "docker-build" "Builds Docker image" --type generator --tag containers
```

### `brainclaw tool list`

List all registered project tools.

### `brainclaw tool describe <id>`

Show full details of a tool.

### `brainclaw tool search <query>`

Search tools by name, description, or tags.

```bash
brainclaw tool search "docker"
brainclaw tool search "test" --type validator
```

---

### `brainclaw explore`

Browse all registered project capabilities and tools in a unified view.

```bash
brainclaw explore
brainclaw explore --query "validation"
```

### Legacy memory aliases

The legacy top-level commands `brainclaw decision`, `brainclaw constraint`, `brainclaw trap`, and `brainclaw handoff` are still available for compatibility. New scripts and docs should prefer `brainclaw memory create ...`.

### `brainclaw instruction <text>`

Create a layered shared instruction.

| Option | Description |
|---|---|
| `--layer <layer>` | Layer: `global`, `project`, or `agent` |
| `--project <name>` | Project scope |
| `--agent <name>` | Agent scope |
| `--tag <tag>` | Tag for categorization (repeatable) |
| `--author <name>` | Author name |
| `--supersedes <id>` | ID of the instruction this replaces |
| `--store <target>` | Store level: `local` (default), `repo`, `workspace`, `user` |

```bash
brainclaw instruction "Read project memory before edits"
brainclaw instruction "Use auth gateway conventions" --layer project --project auth
brainclaw instruction "Summarize blockers explicitly" --layer agent --agent openclaw
```

### `brainclaw runtime-note <text>`

Record an operational observation during a session.

This is the CLI counterpart of the MCP tool `bclaw_write_note`.
Use it for session observations, host-specific operator notes, and in-progress findings that are not yet durable decisions or traps.
For operators who expect a resource-style verb, `brainclaw note create <text>` is accepted as an alias.

| Option | Description |
|---|---|
| `--agent <name>` | Authoring agent; defaults to the configured current agent |
| `--project <name>` | Associated project |
| `--plan <id>` | Associated plan ID |
| `--visibility <scope>` | Visibility scope: `shared`, `machine`, `private` |
| `--host <name>` | Pin to a specific host |
| `--tag <tag>` | Tag for categorization (repeatable) |
| `--ttl <duration>` | Time-to-live (e.g. `7d`, `24h`) |
| `--auto-reflect` | Automatically promote to a review candidate |

```bash
brainclaw runtime-note "Started auth rollout" --agent copilot
brainclaw runtime-note "Node not on PATH on this host" --visibility machine
brainclaw runtime-note "Use auth gateway for new routes" --auto-reflect
```

### `brainclaw note create <text>`

Resource-style alias for `brainclaw runtime-note <text>`.

Use the same options as `runtime-note` when an operator workflow or wrapper expects `create` semantics.

```bash
brainclaw note create "Observed host-specific CUDA mismatch on dgx-a"
brainclaw note create "Need follow-up on launcher script" --plan pln_abc123
```

---

## Code Map

A per-project Tree-sitter symbol + import index (JS/TS, Python, PHP, Java) so agents
can ask "where is X / what should I read first" before editing. The MCP equivalents
are `bclaw_code_status` / `bclaw_code_find` / `bclaw_code_brief` / `bclaw_code_refresh`.
Full reference (freshness model, supported languages, WASM bundling): [docs/code-map.md](code-map.md).

### `brainclaw code-map status [--cascade]`

Store presence, freshness badge (`fresh` / `stale_changed_files` / `stale_extractor` / `stale_grammar` / `partial` / `missing_index`), and index stats (files, nodes, edges). Read-only. In a multi-project workspace, `--cascade` adds a per-child recap (which nested projects have a built index vs `missing_index`, plus an aggregate count).

### `brainclaw code-map refresh [--all|--changed] [--cascade]`

Build or update the index. `--changed` (default) re-parses only touched files; `--all` does a full re-index. Run this when status shows `missing_index` or a stale badge. Fails fast (never blocks) if another writer holds the project lock. In a multi-project workspace, `--cascade` refreshes **every nested project** into its own store plus a root store scoped to the files no child owns (zero double-indexing) — one command at the root indexes the whole monorepo per-project. See [docs/code-map.md](code-map.md#cascading-a-multi-project-workspace---cascade).

### `brainclaw code-map find <query> [--limit <n>]`

Search the symbol index by name (function / class / component / hook / type). Returns ranked matches with path + score. Note: this is a symbol/structure index, not a full-text search — use it to locate definitions, not arbitrary strings.

### `brainclaw code-map brief <target> [--limit <n>]`

Given a symbol or path, return a ranked reading list (`suggested_files_to_read`) plus related memory (decisions/traps/constraints) — what to read before editing.

```bash
brainclaw code-map refresh --all
brainclaw code-map find RouteCollector
brainclaw code-map brief src/core/code-map/work-section.ts
```

---

## Memory Review

### `brainclaw reflect [text]`

Promote a memory item or free-form text into a review candidate.

| Option | Description |
|---|---|
| `--type <type>` | Candidate type (e.g. `trap`, `decision`, `constraint`) |
| `--batch` | Process multiple items in batch mode |
| `--session <id>` | Restrict to a specific session |
| `--tag <tag>` | Tag for categorization (repeatable) |
| `--author <name>` | Author name |
| `--source <source>` | Source identifier |
| `--severity <level>` | Severity: `low`, `medium`, or `high` |
| `--from <date>` | Start date filter |
| `--to <date>` | End date filter |
| `--path <path>` | Scope to a file or folder path |

```bash
brainclaw reflect "Always validate TTL before use" --type trap --severity medium
brainclaw reflect --batch --session sess_42
```

### `brainclaw reflect-runtime-note <id>`

Turn a runtime note into a shared review candidate.

| Option | Description |
|---|---|
| `--type <type>` | Override candidate type |
| `--host <name>` | Pin to a specific host |
| `--all-hosts` | Make visible on all hosts |
| `--suggest` | Show suggested type without writing |
| `--json` | Output as JSON |
| `--tag <tag>` | Tag for categorization (repeatable) |

```bash
brainclaw reflect-runtime-note rtn_001
brainclaw reflect-runtime-note rtn_001 --type trap --tag windows
brainclaw reflect-runtime-note rtn_001 --suggest
```

### `brainclaw review`

Review pending candidates for promotion or rejection.

| Option | Description |
|---|---|
| `--json` | Output as JSON |
| `--type <type>` | Filter by candidate type |
| `--prioritized` | Sort by priority |
| `--only-overdue` | Show only overdue items |
| `--assignee <name>` | Filter by assignee |
| `--for-curator <name>` | Show items for a specific curator |
| `--take <n>` | Limit to N items |
| `--claim <name>` | Claim items for a curator |
| `--auto` | Auto-accept high-confidence candidates |
| `--auto-by <name>` | Set author for auto-accepted items |

```bash
brainclaw review --prioritized
brainclaw review --for-curator curator-a --take 10 --claim curator-a
brainclaw review --auto --auto-by curator-bot
```

### `brainclaw show-candidate <id>`

Show details of a specific candidate.

| Option | Description |
|---|---|
| `--related` | Show related items |

```bash
brainclaw show-candidate cnd_001
brainclaw show-candidate cnd_001 --related
```

### `brainclaw star-candidate <id>`

Star a candidate to mark it as noteworthy without accepting it yet.

| Option | Description |
|---|---|
| `--by <name>` | Name of the reviewer |

```bash
brainclaw star-candidate cnd_001 --by curator-a
```

### `brainclaw use-candidate <id>`

Mark a candidate as used (applied in practice) without formally accepting it.

| Option | Description |
|---|---|
| `--by <name>` | Name of the reviewer |
| `--context <text>` | Context or note about how it was used |

```bash
brainclaw use-candidate cnd_001 --by copilot --context "Applied in auth refactor"
```

### `brainclaw accept <id>`

Accept a candidate and promote it to shared memory.

| Option | Description |
|---|---|
| `--by <name>` | Name of the accepting curator |

```bash
brainclaw accept cnd_001 --by curator-a
```

### `brainclaw reject <id>`

Reject a candidate.

| Option | Description |
|---|---|
| `--by <name>` | Name of the rejecting curator |
| `--reason <text>` | Reason for rejection |

```bash
brainclaw reject cnd_002 --by curator-a --reason "Too host-specific"
```

### `brainclaw prune-candidates`

Remove old, stale candidates.

| Option | Description |
|---|---|
| `--days <n>` | Age threshold in days |
| `--dry-run` | Preview without deleting |

```bash
brainclaw prune-candidates --days 30
brainclaw prune-candidates --days 14 --dry-run
```

---

## Listing and Querying

### `brainclaw plan list`

List plan items.

| Option | Description |
|---|---|
| `--json` | Output as JSON |
| `--status <status>` | Filter by status |
| `--type <type>` | Filter by type: `feat`, `fix`, `chore`, `spike`, `doc` |
| `--assignee <name>` | Filter by assignee |
| `--project <name>` | Filter by project |
| `--all` | Include completed and dropped plans |

```bash
brainclaw plan list
brainclaw plan list --status blocked --project auth
brainclaw plan list --json --all
```

Legacy alias: `brainclaw list-plans`

### `brainclaw claim list`

List active claims. Displays the short `session_id` to distinguish concurrent agent instances.

| Option | Description |
|---|---|
| `--json` | Output as JSON |
| `--all` | Include released claims |
| `--project <name>` | Filter by project |
| `--plan <id>` | Filter by plan ID |
| `--agent <name>` | Filter by agent |

```bash
brainclaw claim list
brainclaw claim list --agent copilot --project auth
brainclaw claim list --all --json
```

Legacy alias: `brainclaw list-claims`

### `brainclaw assignment list`

List assignments. By default this shows only non-terminal assignments; use `--all` to include `completed`, `cancelled`, `expired`, and `rerouted`.

| Option | Description |
|---|---|
| `--json` | Output as JSON |
| `--all` | Include terminal assignments |
| `--status <status>` | Filter by assignment status |
| `--agent <name>` | Filter by agent |
| `--claim <id>` | Filter by claim ID |
| `--plan <id>` | Filter by plan ID |
| `--sequence <id>` | Filter by sequence ID |

```bash
brainclaw assignment list
brainclaw assignment list --status blocked
brainclaw assignment list --all --json
```

### `brainclaw list-agents`

List registered agent and human identities.

| Option | Description |
|---|---|
| `--json` | Output as JSON |
| `--with-reputation` | Include reputation scores |

```bash
brainclaw list-agents
brainclaw list-agents --json --with-reputation
```

### `brainclaw list-instructions`

List raw instruction entries or the resolved instruction stack.

| Option | Description |
|---|---|
| `--json` | Output as JSON |
| `--layer <layer>` | Filter by layer: `global`, `project`, or `agent` |
| `--project <name>` | Filter by project |
| `--agent <name>` | Filter by agent |
| `--active` | Show only active instructions |
| `--resolved` | Show the resolved stack for a given context |
| `--for <path>` | Resolve instructions for a specific file or path |

```bash
brainclaw list-instructions --active
brainclaw list-instructions --resolved --for auth/routes.ts --agent openclaw
brainclaw list-instructions --layer project --project auth
```

### `brainclaw search <query>`

Search across shared memory.

| Option | Description |
|---|---|
| `--section <name>` | Restrict search to a memory section |
| `--since <date>` | Filter by creation date |
| `--tag <tag>` | Filter by tag |
| `--pending` | Include pending/unreviewed items |
| `--max-results <n>` | Maximum number of results |
| `--json` | Output as JSON |

```bash
brainclaw search "auth gateway"
brainclaw search "flaky" --section traps --tag tests --max-results 10
brainclaw search "rollout" --since 2026-01-01 --json
```

---

## Planning and Coordination

For capable agents, prefer the MCP plan and claim tools for live runtime interactions. The CLI remains the operator and scripting form of the same coordination model.

### `brainclaw codev [topic]`

Experimental legacy command. Hidden from the default CLI surface and only registered when `BRAINCLAW_ENABLE_CODEV=1` is set.

Multi-perspective ideation session using persona-based group discussion.

| Option | Description |
|---|---|
| `--personas <tier>` | Persona tier: `tier1` (default), `tier2`, or `list` |
| `--checkpoint` | Pause after clarification for human input (v2 mode only) |
| `--spawn` | Spawn agent CLI instances for autonomous group discussion (v3 mode) |
| `--agents <list>` | Comma-separated agent names for spawn (e.g. `claude-code,codex,antigravity`). Default: auto-detect available agents |
| `--rounds <N>` | Number of discussion rounds in v3 mode (default: 3, minimum: 2) |
| `--target-duration <seconds>` | Target response duration indicated to agents (default: 120) |
| `--json` | Output as JSON |

**v3 mode** (`--spawn`): Spawns agents that discuss iteratively in rounds:
- Round 0 (position): Each agent states their initial position
- Rounds 1-N (reaction): Agents react to each other's positions
- Final round (convergence): Identify agreements and remaining tensions

Agents are distributed round-robin across available CLI agents. Each round produces an ideation artifact stored in `.brainclaw/coordination/ideation/`.

**v2 mode** (without `--spawn`): Generates a coordinator prompt for manual facilitation.

Examples:
```bash
# Auto-detect agents, 3 rounds
brainclaw codev "API redesign" --spawn

# Specific agents, 5 rounds, faster target
brainclaw codev "Migration strategy" --spawn --agents claude-code,codex --rounds 5 --target-duration 90

# List available personas
brainclaw codev --personas list
```

### `brainclaw codev-metrics <thread>`

Experimental legacy command. Hidden from the default CLI surface and only registered when `BRAINCLAW_ENABLE_CODEV=1` is set.

Show per-agent average and p95 response time metrics for a CoDev thread. Useful for diagnosing slow agents or comparing model performance across a multi-agent discussion.

| Option | Description |
|---|---|
| `--json` | Output as JSON |

```bash
brainclaw codev-metrics thr_abc123
brainclaw codev-metrics thr_abc123 --json
```

### `brainclaw run [profile-name]`

Run an agent profile, or list all available profiles if no name is given. Profiles are named invoke templates that describe how to launch a specific agent CLI for dispatch purposes.

| Option | Description |
|---|---|
| `--dry` | Print the resolved command without executing |
| `--agent <name>` | Override the invoke template with a known agent |

```bash
brainclaw run                    # list available profiles
brainclaw run claude-code        # run the claude-code profile
brainclaw run claude-code --dry  # preview the resolved command
```

### `brainclaw plan create <text>`

Create a shared work item.

| Option | Description |
|---|---|
| `--priority <level>` | Priority: `low`, `medium`, or `high` |
| `--assignee <name>` | Assign to an agent or person |
| `--project <name>` | Associated project |
| `--tag <tag>` | Tag for categorization (repeatable) |
| `--path <path>` | Scope to a file or folder path |
| `--depends-on <id>` | ID of a plan this depends on |
| `--author <name>` | Author name |
| `--estimate <minutes>` | Estimated effort in integer minutes (e.g. `--estimate 30`) |
| `--store <target>` | Store level: `local` (default), `repo`, `workspace`, `user` |

```bash
brainclaw plan create "Coordinate auth rollout" --priority high --assignee copilot
brainclaw plan create "Refactor payments module" --project payments --estimate 90 --author alice
```

Legacy compatibility: `brainclaw plan "Coordinate auth rollout"`

### `brainclaw plan show <id>`

Display details of a specific plan item.

Use `plan show` for the canonical syntax. `plan get` is accepted as a read alias for operator convenience.

| Option | Description |
|---|---|
| `--json` | Output as JSON |

```bash
brainclaw plan show pln_abc123
brainclaw plan show pln_abc123 --json
brainclaw plan get pln_abc123
```

### `brainclaw add-step <planId> <text>`

Add a step to an existing plan.

| Option | Description |
|---|---|
| `--assign <name>` | Assign the step to an agent or person |

```bash
brainclaw add-step pln_001 "Write unit tests for new endpoint"
brainclaw add-step pln_001 "Deploy to staging" --assign devops-bot
```

### `brainclaw complete-step <planId> <stepId>`

Mark a step in a plan as completed. No options.

Use the plan item ID plus the step ID returned by `plan show` or `plan list --json`.
`brainclaw plan update` updates plan items only; it does not operate on `stp_*` step IDs.

```bash
brainclaw complete-step pln_001 stp_001
```

### `brainclaw plan update <id>`

Update plan status or ownership.

This command expects a plan ID (`pln_*`), not a step ID. To complete a step, use `brainclaw complete-step <planId> <stepId>`.

| Option | Description |
|---|---|
| `--status <status>` | Status: `todo`, `in_progress`, `blocked`, `done`, or `dropped` |
| `--assignee <name>` | Reassign the plan |
| `--project <name>` | Change associated project |
| `--priority <level>` | Change priority |
| `--actual-effort <effort>` | Record actual effort (e.g. `20min`, `1h30m`) |

```bash
brainclaw plan update pln_001 --status done
brainclaw plan update pln_001 --status in_progress --assignee alice --actual-effort 45
```

Legacy alias: `brainclaw update-plan <id>`

### `brainclaw plan delete <id>`

Delete a shared plan item by `id` or short label.

```bash
brainclaw plan delete pln_001
```

Legacy alias: `brainclaw delete-plan <id>`

### `brainclaw estimation-report`

Display an ASCII chart of estimated vs. actual effort ratios across plans.

| Option | Description |
|---|---|
| `--agent <name>` | Filter by agent |
| `--json` | Output as JSON |

```bash
brainclaw estimation-report
brainclaw estimation-report --agent copilot --json
```

### `brainclaw update-handoff <id>`

Update an existing handoff.

| Option | Description |
|---|---|
| `--status <status>` | New status |
| `--to <name>` | Change recipient |
| `--narrative <text>` | Replace the handoff narrative |
| `--reviewer <name>` | Set or override the assigned reviewer |
| `--review-verdict <verdict>` | Capture a structured review verdict: `approve` or `request_changes` |
| `--reviewed-by <name>` | Record who produced the verdict |
| `--review-summary <text>` | Attach a short review summary |
| `--blocking-issue <text>` | Add a blocking issue (repeatable) |
| `--suggestion <text>` | Add a non-blocking suggestion (repeatable) |

```bash
brainclaw update-handoff hnd_001 --status closed
brainclaw update-handoff hnd_001 --to alice
brainclaw update-handoff hnd_001 --review-verdict request_changes --reviewed-by codex --blocking-issue "Null guard missing"
```

---

## Dispatch

The `dispatch` command group manages the local agent dispatcher: it analyzes the active sequence for lane readiness and assigns work to available agents.

### `brainclaw dispatch analysis`

Analyze the active sequence and show lane status: ready, active, blocked, and done lanes.

| Option | Description |
|---|---|
| `--json` | Output as JSON |

```bash
brainclaw dispatch analysis
brainclaw dispatch analysis --json
```

### `brainclaw dispatch run`

Run a dispatch cycle: assign ready lanes to available agents. Optionally preview assignments or spawn CLI agents autonomously.

| Option | Description |
|---|---|
| `--agents <names>` | Comma-separated list of agents to dispatch to |
| `--lanes <names>` | Comma-separated list of lanes to dispatch |
| `--max <n>` | Maximum number of assignments |
| `--dry` | Preview assignments without sending messages |
| `--spawn` | Autonomously launch CLI agents with invoke templates |
| `--agent <name>` | Dispatcher agent name |
| `--json` | Output as JSON |

```bash
brainclaw dispatch run
brainclaw dispatch run --dry
brainclaw dispatch run --spawn --agents claude-code,codex
brainclaw dispatch run --lanes docs,tests --max 2 --json
```

### `brainclaw dispatch review`

Dispatch code reviews for completed handoffs. Finds handoffs ready for review and sends review assignments to available agents.

| Option | Description |
|---|---|
| `--handoff <id>` | Specific handoff ID to review |
| `--reviewer <name>` | Specific reviewer agent |
| `--spawn` | Launch the reviewer CLI agent |
| `--dry` | Preview without sending |
| `--agent <name>` | Dispatcher agent name |
| `--json` | Output as JSON |

```bash
brainclaw dispatch review
brainclaw dispatch review --handoff hnd_001 --reviewer codex
brainclaw dispatch review --dry
brainclaw dispatch review --spawn --json
```

---

## Claims and Coordination

### `brainclaw claim create <description>`

Claim ownership over a file, folder, or scope.

| Option | Description |
|---|---|
| `--agent <name>` | Claiming agent |
| `--scope <path>` | File or folder being claimed |
| `--project <name>` | Associated project |
| `--plan <id>` | Associated plan ID |
| `--ttl <duration>` | Time-to-live for the claim |
| `--store <target>` | Store level: `local` (default), `repo`, `workspace` |

```bash
brainclaw claim create "Taking auth rollout" --agent copilot --scope src/auth/ --plan pln_001
brainclaw claim create "Editing payments module" --scope src/payments/ --ttl 2h
```

Legacy compatibility: `brainclaw claim "Taking auth rollout" --scope src/auth/`

### `brainclaw claim release <id>`

Release a claim and optionally advance the linked plan status.

| Option | Description |
|---|---|
| `--plan-status <status>` | Set the linked plan status on release |

```bash
brainclaw claim release clm_001
brainclaw claim release clm_001 --plan-status done
```

Legacy alias: `brainclaw release-claim <id>`

### `brainclaw assignment get <id>`

Show one assignment with its lifecycle timestamps and links.

| Option | Description |
|---|---|
| `--json` | Output as JSON |

```bash
brainclaw assignment get asgn_001
brainclaw assignment get asgn_001 --json
```

### `brainclaw assignment update <id>`

Advance an assignment to a supported lifecycle status through the canonical assignment FSM.

| Option | Description |
|---|---|
| `--status <status>` | Target assignment status |
| `--reason <text>` | Optional status reason recorded on the assignment |

```bash
brainclaw assignment update asgn_001 --status started
brainclaw assignment update asgn_001 --status cancelled --reason "Supervisor aborted the lane"
```

### `brainclaw assignment cancel <id>`

Supervisor/admin shortcut for `brainclaw assignment update <id> --status cancelled`.

| Option | Description |
|---|---|
| `--reason <text>` | Optional cancellation reason recorded on the assignment |

```bash
brainclaw assignment cancel asgn_001
brainclaw assignment cancel asgn_001 --reason "Superseded by reroute"
```

### `brainclaw release-claims`

Release multiple claims derived from a Git diff.

| Option | Description |
|---|---|
| `--from-git-diff` | Derive scopes from a Git diff |
| `--ref1 <ref>` | First Git ref for the diff |
| `--ref2 <ref>` | Second Git ref for the diff |

```bash
brainclaw release-claims --from-git-diff --ref1 main --ref2 HEAD
```

### `brainclaw agent-board`

Display a coordination snapshot showing agent activity and file ownership.

| Option | Description |
|---|---|
| `--agent <name>` | Focus on a specific agent |
| `--project <name>` | Filter by project |
| `--for <path>` | Show board for a specific file or path |
| `--host <name>` | Filter by host |
| `--all-hosts` | Show data across all hosts |
| `--json` | Output as JSON |
| `--with-reputation` | Include reputation scores |
| `--capabilities` | Show agent capabilities |
| `--suggest` | Suggest the best agent for unclaimed work |

```bash
brainclaw agent-board --agent copilot --project auth
brainclaw agent-board --for src/auth/routes.ts --json
brainclaw agent-board --suggest --capabilities
```

---

## Inbox

The `inbox` command group manages inter-agent messaging. Agents use inbox messages to assign work, request reviews, share information, and carry on structured conversations.

### `brainclaw inbox list`

List inbox messages. Defaults to pending messages only for the current agent.

| Option | Description |
|---|---|
| `--agent <name>` | Agent name |
| `--status <status>` | Filter by status: `pending`, `read`, `acknowledged`, `archived` |
| `--type <type>` | Filter by type: `assign`, `review`, `rfc`, `info`, `reply` |
| `--thread <id>` | Filter by thread ID |
| `--all` | Show all messages, not just pending |
| `--json` | Output as JSON |

```bash
brainclaw inbox list
brainclaw inbox list --all
brainclaw inbox list --status acknowledged --agent copilot
brainclaw inbox list --type assign --json
```

### `brainclaw inbox ack <id>`

Acknowledge a message to confirm receipt.

| Option | Description |
|---|---|
| `--agent <name>` | Agent name |
| `--json` | Output as JSON |

```bash
brainclaw inbox ack msg_abc123
brainclaw inbox ack msg_abc123 --agent copilot
```

### `brainclaw inbox archive <id>`

Archive a message to remove it from the active inbox.

| Option | Description |
|---|---|
| `--agent <name>` | Agent name |
| `--json` | Output as JSON |

```bash
brainclaw inbox archive msg_abc123
brainclaw inbox archive msg_abc123 --json
```

### `brainclaw inbox send <to> <text>`

Send a message to another agent.

| Option | Description |
|---|---|
| `--type <type>` | Message type: `assign`, `review`, `rfc`, `info`, `reply` (default: `info`) |
| `--ref <id>` | Reference to a plan, sequence, or other entity |
| `--scope <path>` | File scope |
| `--thread <id>` | Thread ID for conversations |
| `--ack` | Require acknowledgment from the recipient |
| `--agent <name>` | Sender agent name |
| `--json` | Output as JSON |

```bash
brainclaw inbox send copilot "Please review the auth module changes"
brainclaw inbox send codex "Ready for review" --type review --ref hnd_001
brainclaw inbox send alice "Blocked on payments integration" --type rfc --ack
brainclaw inbox send copilot "Reply on thread" --type reply --thread thr_001
```

### `brainclaw inbox thread <id>`

Show all messages in a thread, in chronological order.

| Option | Description |
|---|---|
| `--json` | Output as JSON |

```bash
brainclaw inbox thread thr_001
brainclaw inbox thread thr_001 --json
```

---

## Context and Agents

### `brainclaw context`

Generate compact, prompt-ready context for agents.

| Option | Description |
|---|---|
| `--for <path>` | Scope context to a file or path; in folder-mode workspaces, child project paths resolve the matching nested store automatically |
| `--project <name>` | Filter by project |
| `--agent <name>` | Filter by agent |
| `--host <name>` | Filter by host |
| `--all-hosts` | Include items from all hosts |
| `--profile <name>` | Use a named context profile |
| `--include-pending` | Include unreviewed candidates |
| `--max-items <n>` | Maximum number of items to include |
| `--max-chars <n>` | Maximum total characters |
| `--digest` | Output a condensed digest |
| `--since-session` | Only include items since the last session start |
| `--no-bootstrap` | Skip bootstrap data |
| `--refresh-bootstrap` | Force refresh of bootstrap data |
| `--template <name>` | Use a named output template |
| `--compact-template` | Use the compact template variant |
| `--explain` | Show scoring and selection rationale |
| `--json` | Output as JSON |

```bash
brainclaw context --for src/auth/routes.ts --digest
brainclaw context --for applications/lodestar/src/app.ts --json
brainclaw context --json --max-chars 1200
brainclaw context --explain
brainclaw context --since-session --max-items 20
```

### `brainclaw context-diff`

Hybrid context view for subsequent prompts: always includes **critical anchors** (active claims, resolved instructions, top 5 traps) plus the memory delta since a reference point. Used by the Claude Code UserPromptSubmit hook after the first prompt.

| Option | Description |
|---|---|
| `--since <date>` | Start date for the diff |
| `--session <id>` | Compare against a specific session start |
| `--json` | Output as JSON (includes anchors + changed items) |

```bash
brainclaw context-diff --session sess_42
brainclaw context-diff --since 2026-03-10 --json
```

### `brainclaw register-agent <name>`

Register a durable human or agent identity.

| Option | Description |
|---|---|
| `--kind <kind>` | Identity kind (e.g. `agent`, `human`) |
| `--capability <cap>` | Add a capability (repeatable) |
| `--replace-capabilities` | Replace all existing capabilities |
| `--generate-fingerprint` | Generate a unique fingerprint |
| `--set-current` | Set as the current active agent |
| `--curator` | Mark as a memory curator |
| `--json` | Output as JSON |

```bash
brainclaw register-agent copilot --kind agent --set-current
brainclaw register-agent alice --kind human --curator
brainclaw register-agent my-bot --capability code-review --capability testing --generate-fingerprint
```

### `brainclaw enable-agent <name>`

Enable an existing agent and optionally update its capabilities.
Built-in integration names include `claude-code`, `cursor`, `windsurf`, `cline`, `codex`, `opencode`, `antigravity`, `continue`, `roo`, `kilocode`, `mistral-vibe`, `hermes`, and `github-copilot`.

| Option | Description |
|---|---|
| `--kind <kind>` | Identity kind |
| `--capability <cap>` | Add a capability (repeatable) |
| `--generate-fingerprint` | Regenerate fingerprint |
| `--set-current` | Set as the current active agent |
| `--json` | Output as JSON |

```bash
brainclaw enable-agent github-copilot --set-current
brainclaw enable-agent opencode
brainclaw enable-agent antigravity
brainclaw enable-agent hermes
brainclaw enable-agent my-bot --capability refactor --json
```

### `brainclaw whoami`

Show the current agent identity.

| Option | Description |
|---|---|
| `--json` | Output as JSON |

```bash
brainclaw whoami
brainclaw whoami --json
```

### `brainclaw set-trust <agent>`

Set the trust level for an agent.

| Option | Description |
|---|---|
| `--level <level>` | Trust level |
| `--reset-breaker` | Reset the circuit breaker for this agent |
| `--json` | Output as JSON |

```bash
brainclaw set-trust copilot --level high
brainclaw set-trust flaky-bot --reset-breaker --json
```

---

## Sessions

### `brainclaw session-start`

Mark the start of an agent work session.

| Option | Description |
|---|---|
| `--agent <name>` | Agent starting the session |
| `--context <text>` | Context note for the session |
| `--model <id>` | AI model identifier (e.g. `claude-sonnet-4-6`) |
| `--json` | Output as JSON |

```bash
brainclaw session-start --agent copilot
brainclaw session-start --agent claude --model claude-sonnet-4-6 --json
```

At session start, Brainclaw also warns when generated local agent files in the current Git repo are missing from `.gitignore` or are still tracked. Use `brainclaw doctor --fix-agent-ignore` to repair missing ignore entries.

### `brainclaw session-end`

Mark the end of an agent work session.

| Option | Description |
|---|---|
| `--session <id>` | Session ID to close |
| `--agent <name>` | Agent ending the session |
| `--summary <text>` | Summary of work done |
| `--auto-reflect` | Automatically reflect runtime notes from the session |
| `--auto-release` | Automatically release all claims held during the session |
| `--reflect-handoff` | Materialize an open handoff from git commits since session start |
| `--dispatch-review` | When used with `--reflect-handoff`, auto-dispatch a code review if the handoff is reviewable |
| `--reviewer <name>` | Explicit reviewer for the reflected handoff review |
| `--json` | Output as JSON |

```bash
brainclaw session-end --auto-release
brainclaw session-end --session sess_42 --summary "Completed auth refactor" --auto-reflect --auto-release
brainclaw session-end --auto-release --reflect-handoff --dispatch-review --reviewer codex
```

---

## Export and Integrations

### `brainclaw export`

Export memory as a native agent instruction file.

| Option | Description |
|---|---|
| `--format <format>` | Target format: `copilot-instructions`, `cursor-rules`, `agents-md`, `claude-md`, `gemini-md`, `windsurf`, `cline`, `roo`, `continue`, `openclaw`, `nanoclaw`, `nemoclaw`, `picoclaw`, or `zeroclaw` |
| `--detect` | Auto-detect the running agent and write to its native file |
| `--all` | Write all known agent instruction files at once (deduplicates by format) |
| `--write` | Write output to the native file path (instead of stdout); generated workspace files are treated as local and added to `.gitignore` |
| `--shared` | Keep the main exported instruction file versionable when used with `--write`; companion MCP/settings files stay local |
| `--output <path>` | Write to a custom output path |
| `--project <name>` | Filter by project |
| `--agent <name>` | Filter by agent |

```bash
brainclaw export --detect
brainclaw export --format copilot-instructions --write   # .github/copilot-instructions.md
brainclaw export --format claude-md --write              # CLAUDE.md
brainclaw export --format gemini-md --write             # GEMINI.md
brainclaw export --format cursor-rules --write           # .cursor/rules/brainclaw.md
brainclaw export --format windsurf --write               # .windsurfrules
brainclaw export --format cline --write                  # .clinerules/brainclaw.md
brainclaw export --format agents-md --write              # AGENTS.md (Codex, OpenCode)
brainclaw export --format roo --write                    # .roo/rules/brainclaw.md
brainclaw export --format continue --write               # .continue/rules/brainclaw.md
brainclaw export --format openclaw --write               # skills/openclaw/SKILL.md
brainclaw export --format claude-md --write --shared     # publish CLAUDE.md intentionally
brainclaw export --format claude-md                      # stdout
brainclaw export --all                                   # all known agent files at once
```

`brainclaw export --write` is local-first by default: the generated workspace file and any companion MCP/settings files are added to `.gitignore`. Use `--shared` only when you intentionally want the main instruction file to be committed. `brainclaw export --detect` also writes companion MCP config where relevant, including `opencode.json` for OpenCode and `.gemini/antigravity/mcp_config.json` for Antigravity/Gemini when the local environment is available.

### `brainclaw adapter-openclaw-import [file]`

Import OpenClaw runtime events into reflective candidates.

| Option | Description |
|---|---|
| `--session <id>` | Restrict import to a specific session |
| `--dry-run` | Preview without writing |
| `--source <name>` | Override source identifier |
| `--author <name>` | Author name for imported items |

```bash
brainclaw adapter-openclaw-import ./openclaw-events.json --dry-run
brainclaw adapter-openclaw-import --session sess_42
```

See [adapters/openclaw.md](adapters/openclaw.md).

---

## Hooks and Git

### `brainclaw install-hooks`

Install Git hooks: pre-commit (constraint checking, sensitive content detection) and post-merge (auto-release of claims whose scope overlaps merged files).

| Option | Description |
|---|---|
| `--force` | Overwrite existing hooks |

```bash
brainclaw install-hooks
brainclaw install-hooks --force
```

### `brainclaw hooks`

Show or manage installed hooks.

| Option | Description |
|---|---|
| `--target <path>` | Target directory for hooks |

```bash
brainclaw hooks
brainclaw hooks --target .git/hooks
```

### `brainclaw diff`

Show a diff of memory changes.

| Option | Description |
|---|---|
| `--since <date>` | Start date for the diff |
| `--json` | Output as JSON |

```bash
brainclaw diff --since 2026-03-01
brainclaw diff --json
```

### `brainclaw check-constraints`

Check active constraints against staged or specified files.

| Option | Description |
|---|---|
| `--staged` | Check files currently staged in Git |
| `--files <paths>` | Comma-separated list of files to check |
| `--json` | Output as JSON |

```bash
brainclaw check-constraints --staged
brainclaw check-constraints --files src/payments/index.ts --json
```

### `brainclaw check-policy`

Pre-execution policy check. Verifies claims, constraints, traps, and governance instructions for a given scope. Returns blocks (hard stops) and warnings (context to consider).

| Option | Description |
|---|---|
| `--scope <path>` | **(required)** File or directory scope to check |
| `--agent <name>` | Agent name to check claims for |
| `--agent-id <id>` | Agent ID to check claims for |
| `--action <type>` | Intended action: edit, create, delete (informational) |
| `--json` | Output as JSON |

**Checks performed (deterministic, no AI):**
- **Claim check** — Does the agent have an active claim on the scope? (BLOCK if not)
- **Claim conflict** — Is the scope claimed by another agent? (BLOCK)
- **Constraint check** — Do active constraints with matching `related_paths` apply? (WARN)
- **Trap check** — Are there active traps with matching `related_paths`? (WARN)
- **Governance context** — Active global/project instructions are displayed for reference.

```bash
brainclaw check-policy --scope src/core/auth.ts --agent claude-code
brainclaw check-policy --scope src/commands --json
```

Exit code: 0 if allowed, 1 if blocked. Also available as MCP tool `bclaw_check_policy`.

---

## Sync and Distribution

### `brainclaw sync`

Summarize memory state and optionally create local Git commits.

| Option | Description |
|---|---|
| `--commit` | Create a Git commit |
| `--message <text>` | Commit message |
| `--summary-only` | Print summary without writing |
| `--scope <path>` | Limit sync to a path |
| `--include-machine-runtime` | Include machine-local runtime notes |
| `--remote <name>` | Remote name for push |

```bash
brainclaw sync --commit --message "chore: sync memory"
brainclaw sync --summary-only
brainclaw sync --commit --include-machine-runtime --remote origin
```

### `brainclaw pull`

Pull shared memory from a remote.

| Option | Description |
|---|---|
| `--remote <name>` | Remote name |
| `--json` | Output as JSON |

```bash
brainclaw pull
brainclaw pull --remote origin --json
```

### `brainclaw push`

Push shared memory to a remote.

| Option | Description |
|---|---|
| `--remote <name>` | Remote name |
| `--message <text>` | Commit message for the push |
| `--json` | Output as JSON |

```bash
brainclaw push --remote origin
brainclaw push --remote origin --message "chore: push memory state" --json
```

---

## Federation

The v1 `brainclaw federation` command group and the whole cloud egress path (`app.brainclaw.dev` push/pull, `cloud_sync` config, `BRAINCLAW_CLOUD_*` env vars) were removed in wave 1 of dec#156 / pln#651. There is no migration: the v1 format is abandoned, not deprecated. The v2 federation surface will be introduced by pln#651 wave 3 alongside the pairing CLI (`brainclaw cloud connect`).

Local cross-project federation (see below) is unaffected.

---

## Cross-project links

The `link` command group manages local cross-project federation peers — entries stored under `cross_project_links` in `.brainclaw/config.yaml`. These are the targets used by `bclaw_write_note --crossProject`, `bclaw_create(entity='handoff', targetProject=…)`, and the runtime cross-project signal writers in `src/core/cross-project.ts`.

The same entity surface is available through the canonical grammar: `bclaw_create / find / get / update / remove(entity='cross_project_link')`.

### `brainclaw link add <path>`

Register a sibling project as a federation peer. The path is validated to point at an existing brainclaw-initialised directory; the link `name` is auto-derived from the linked project's `project_name` (or its basename) unless `--name` is passed.

| Option | Description |
|---|---|
| `--name <slug>` | Override the auto-derived name |
| `--role <role>` | `publisher` (push signals out) or `subscriber` (default, read-only) |
| `--channels <list>` | Comma-separated allow-list: `candidate,handoff,runtime_note` |
| `--force` | Replace an existing link of the same name/path |
| `--json` | Emit the resulting link entry as JSON |

```bash
brainclaw link add ../brainclaw-cloud
brainclaw link add ../brainclaw-site --role publisher --channels candidate,handoff
brainclaw link add ../brainclaw-cloud --role publisher --force
```

### `brainclaw link list`

Show every configured cross-project link with its resolved absolute path, role, and availability marker (`✓` if the target directory exists and is brainclaw-initialised).

```bash
brainclaw link list
brainclaw link list --json
```

### `brainclaw link remove <name|path>`

Drop a link from the config. Matches by name, exact `path`, resolved absolute path, or basename of the resolved path — the same matcher used by `resolveCrossProjectTarget`.

```bash
brainclaw link remove brainclaw-cloud
brainclaw link remove ../brainclaw-site
```

---

## Monitoring and Maintenance

### `brainclaw watch`

Watch for memory changes in real time.

| Option | Description |
|---|---|
| `--interval <ms>` | Polling interval in milliseconds |
| `--auto-claim` | Automatically claim files touched by the agent |
| `--agent <name>` | Agent name for auto-claim |

```bash
brainclaw watch
brainclaw watch --interval 5000 --auto-claim --agent copilot
```

### `brainclaw metrics`

Show memory usage and activity metrics.

| Option | Description |
|---|---|
| `--json` | Output as JSON |
| `--since <date>` | Start date for metrics |

```bash
brainclaw metrics
brainclaw metrics --since 2026-01-01 --json
```

### `brainclaw prune`

Remove expired memory items.

| Option | Description |
|---|---|
| `--expired` | Prune only TTL-expired items |

```bash
brainclaw prune --expired
```

### `brainclaw compact`

LLM-driven semantic memory compaction. Archives old items that are superseded or low-signal and provides a summary template for review. Use `--assess` to see what would be compacted before committing.

| Option | Description |
|---|---|
| `--assess` | Show pressure assessment and compaction template without archiving |
| `--dry-run` | Preview eligible items without archiving |
| `--max-items <n>` | Maximum items to compact (default: 20) |
| `--min-age <days>` | Minimum age in days for eligibility (default: 7) |

```bash
brainclaw compact --assess
brainclaw compact --dry-run
brainclaw compact --max-items 10 --min-age 14
```

### `brainclaw refresh`

Refresh live companion files with current state (plans, claims, traps, sequences). These files are gitignored and safe to run frequently. Use this after a bulk memory operation or when an agent's companion view may be stale.

```bash
brainclaw refresh
```

### `brainclaw patch-configs`

Patch all MCP config files to use the current brainclaw binary path. Run this after reinstalling or moving the brainclaw binary to ensure all agent MCP integrations point to the correct executable.

| Option | Description |
|---|---|
| `--json` | Output as JSON |

```bash
brainclaw patch-configs
brainclaw patch-configs --json
```

### `brainclaw rollback`

Roll back a memory item to a previous state.

| Option | Description |
|---|---|
| `--audit-id <id>` | Audit event ID to roll back to |
| `--item-id <id>` | Specific item ID to roll back |
| `--dry-run` | Preview without writing |
| `--json` | Output as JSON |

```bash
brainclaw rollback --item-id dec_001 --dry-run
brainclaw rollback --audit-id aud_042 --json
```

### `brainclaw audit`

Show the audit log of memory changes, or generate a governance posture report.

| Option | Description |
|---|---|
| `--since <date>` | Start date filter |
| `--actor <name>` | Filter by actor |
| `--action <type>` | Filter by action type |
| `--limit <n>` | Maximum number of entries |
| `--governance` | Generate an aggregated governance posture report instead of chronological log |
| `--scope <path>` | Filter governance report by scope (used with `--governance`) |
| `--json` | Output as JSON |

**Chronological mode (default):** Shows individual audit entries with timestamp, actor, action, and scope.

**Governance mode (`--governance`):** Produces an aggregated posture report:
- Active global instructions ("constitution vivante")
- Constraints by category ("red lines")
- Claims by agent, expired claims needing release
- Open traps by severity
- Mutations without claim (last 24h)
- Actionable recommendations

```bash
brainclaw audit --since 2026-03-01 --actor copilot
brainclaw audit --action accept --limit 20 --json
brainclaw audit --governance
brainclaw audit --governance --json
```

### `brainclaw history <id>`

Show the change history for a specific memory item. No options.

```bash
brainclaw history dec_001
brainclaw history cnd_042
```

---

## Server and MCP

### `brainclaw mcp`

Start the MCP (Model Context Protocol) server over stdio. Used by AI agents that support MCP tooling. No options.

```bash
brainclaw mcp
```

#### Available MCP tools

The default catalog is intentionally small and centred on the canonical grammar. The full live tool list is the source of truth — see [`docs/integrations/mcp.md`](integrations/mcp.md) and [`docs/concepts/mcp-governance.md`](concepts/mcp-governance.md) for the complete catalog, tier rules, and stability contract.

**Entry facades** — start here:

| Tool | Purpose |
|---|---|
| `bclaw_work(intent)` | Start a session, load context, and (for `intent="execute"`) claim a scope in one call. Returns a compact payload by default (pass `compact: false` for the full context). |
| `bclaw_context(kind)` | Unified context read: `kind` is one of `memory`, `execution`, `board`, `board_summary`, or `delta`. |

**Canonical grammar** — your main tool for working with memory entities (plan, decision, constraint, trap, handoff, runtime_note, candidate, sequence, claim, action, assignment, agent_run):

| Tool | Purpose |
|---|---|
| `bclaw_find(entity, filter?)` | List entities of a given type with optional filters and pagination. |
| `bclaw_get(entity, id)` | Read a single entity by id. |
| `bclaw_create(entity, data)` | Create a new entity (plan, decision, constraint, trap, handoff, candidate, runtime_note, …). |
| `bclaw_update(entity, id, patch)` | Edit an entity in place. |
| `bclaw_remove(entity, id, purge?)` | Soft-delete (or purge) an entity. |
| `bclaw_transition(entity, id, to)` | Change an entity's status (e.g. plan `todo` → `in_progress` → `done`, candidate `pending` → `accepted`). |

**Multi-agent coordination** (escalation path when delegating to other agents):

| Tool | Purpose |
|---|---|
| `bclaw_coordinate(intent)` | Assign, consult, review, reroute, or summarize across agents. Pass `open_loop: true` on `intent="review"` to also dispatch the reviewer turn. |
| `bclaw_dispatch(intent)` | Parallelize execute across a sequence's lanes (analysis / execute / review). |
| `bclaw_loop(intent)` | Drive a turn in an existing multi-turn loop (`turn`, `complete_turn`, `advance`, `close`; implementation loops add `bind` to dispatch the linked sequence and `verify` to run the opener-configured `command_green` check). Do not call `bclaw_loop(intent="open")` directly without dispatch — use `bclaw_coordinate(intent="review", open_loop: true)` instead. |

**Sequences**:

`bclaw_list_sequences`, `bclaw_create_sequence`, `bclaw_update_sequence`, `bclaw_delete_sequence`. Sequence items use `{ planId, stepId?, rank, hard_after?, soft_after?, lane?, scope_hint?, rationale? }`. Create/update a sequence to `active`, inspect readiness with `bclaw_dispatch(intent="analysis")`, then dispatch ready lanes with `bclaw_dispatch(intent="execute")`.

**Session, claims, plans, handoffs**:

`bclaw_session_start`, `bclaw_session_end`, `bclaw_claim`, `bclaw_release_claim`, `bclaw_add_step`, `bclaw_complete_step`, `bclaw_update_step`, `bclaw_delete_step`, `bclaw_read_inbox`, `bclaw_ack_message`, `bclaw_send_message`, `bclaw_correct_handoff`.

**Notes, search, setup, navigation**:

`bclaw_write_note`, `bclaw_quick_capture`, `bclaw_search`, `bclaw_setup`, `bclaw_bootstrap`, `bclaw_switch`, `bclaw_release_notes`, `bclaw_doctor`.

**Legacy per-entity tools** (`bclaw_list_plans` / `bclaw_list_claims` / `bclaw_list_candidates`, `bclaw_get_context` / `bclaw_get_execution_context` / `bclaw_get_agent_board`, `bclaw_create_plan` / `bclaw_create_candidate`, `bclaw_update_plan` / `bclaw_update_handoff` / `bclaw_update_memory`, `bclaw_read_handoff` / `bclaw_delete_memory`, `bclaw_accept` / `bclaw_reject`, `bclaw_dispatch_analysis` / `bclaw_dispatch_review`, and others) were removed from the discoverable catalog at v1.0. Direct calls still succeed as a migration escape hatch but emit a redirect warning pointing at the canonical grammar. The full removal list and replacement map lives in [`docs/mcp-schema-changelog.md`](mcp-schema-changelog.md) under the v1.0 "Removed" section. Raw MCP clients can request the full advanced catalog with `tools/list` params `{ catalog: "all" }`.

---

## Version Management

### `brainclaw version`

Show or manage the brainclaw version.

| Option | Description |
|---|---|
| `--check` | Check for a newer version |
| `--publish-local` | Pack and publish locally (uses `npm pack`) |
| `--release-notes <text>` | Release notes for `--publish-local` |
| `--json` | Output as JSON |

```bash
brainclaw version
brainclaw version --check
brainclaw version --publish-local --release-notes "Add estimation-report command"
```

`brainclaw version --check` now follows this order:

- if `brainclaw_update_source` is configured, use it
- otherwise, fall back to the public npm channel `brainclaw@latest`

If the release changes CLI, MCP, or context-schema behavior, run the release checklist in [release-maintenance.md](release-maintenance.md) before `--publish-local`.

### `brainclaw release-notes`

Generate agent-first release notes from git history.

| Option | Description |
|---|---|
| `--from <ref>` | Base git ref (default: latest tag) |
| `--json` | Output as JSON |

---

## Additional Operational Commands

### `brainclaw uninstall`

Remove brainclaw from a project and/or machine. Cleans up generated agent files, hooks, and MCP configurations.

| Option | Description |
|---|---|
| `--global` | Also uninstall the global npm package |
| `--keep-memory` | Remove agent files but preserve `.brainclaw/` memory |
| `--json` | Output as JSON |

### `brainclaw discover`

Scan the workspace for MCP configs, instruction files, skills, hooks, and agent integrations. Produces a structured discovery profile saved to `.brainclaw/discovery/`.

| Option | Description |
|---|---|
| `--refresh` | Force a fresh scan even if a cached profile exists |
| `--no-save` | Do not persist the discovery profile |
| `--json` | Output as JSON |

### `brainclaw migrate`

Migrate memory items between stores (e.g. promote machine-scoped items to user store).

| Option | Description |
|---|---|
| `--dry-run` | Show what would be migrated without making changes |
| `--json` | Output as JSON |

### `brainclaw runtime-status`

Show runtime notes.

| Option | Description |
|---|---|
| `--agent <agent>` | Filter by agent |
| `--plan <id>` | Filter by linked plan item |
| `--visibility <visibility>` | Visibility filter: `shared`, `machine`, `private`, `all` |
| `--host <host>` | Include machine-local notes for a specific host |
| `--all-hosts` | Include machine-local notes from all hosts |
| `--json` | Output as JSON |

### `brainclaw check-security`

Check supply chain security scores for packages via Socket.dev.

| Option | Description |
|---|---|
| `--packages <names>` | Comma-separated package names such as `axios,express` or `axios@1.14.1` |
| `--ecosystem <type>` | Package ecosystem: `npm` or `pypi` |
| `--json` | Output as JSON |

### `brainclaw setup-security`

Enable the supply chain security gate by generating wrapper scripts and configuring preinstall checks.

| Option | Description |
|---|---|
| `--mode <mode>` | Security mode: `advisory` or `enforced` |

### `brainclaw worktree`

Manage Git worktrees for stronger agent isolation.

Subcommands:

- `brainclaw worktree create <branch>` — create a linked worktree for a branch
- `brainclaw worktree list` — list known worktrees for the current project
- `brainclaw worktree remove <path>` — remove a linked worktree
- `brainclaw worktree prune` — prune stale Git worktree administrative files
- `brainclaw worktree clean` — remove merged worktrees and orphan directories
- `brainclaw worktree merge <branch>` — merge a worktree branch with auto-restoration

`create` options:

| Option | Description |
|---|---|
| `--session-id <id>` | Associate the worktree with a brainclaw session |
| `--agent <name>` | Associate the worktree with an agent name |

`remove` options:

| Option | Description |
|---|---|
| `--force` | Force removal even with uncommitted changes |

`clean` options:

| Option | Description |
|---|---|
| `--force` | Force removal even with uncommitted changes |
| `--dry-run` | Show what would be removed without actually removing |

`merge` options:

| Option | Description |
|---|---|
| `-m, --message <message>` | Merge commit message |
| `--dry-run` | Show what would be merged without committing |

```bash
brainclaw worktree clean --dry-run
brainclaw worktree clean --force
brainclaw worktree merge feat/my-feature
brainclaw worktree merge feat/my-feature --dry-run
```

### `brainclaw memory-log`

Show recent memory change history from the internal git repo.

| Option | Description |
|---|---|
| `-n, --limit <count>` | Number of entries to show |

### `brainclaw memory-rollback <ref>`

Restore only the current project's live Brainclaw memory to a previous git snapshot. This command is reserved to registered human identities and preserves durable audit logs, archives, compaction outputs, and backups instead of performing a full destructive reset. Use `memory-log` to find valid refs.

| Option | Description |
|---|---|
| `--actor <name>` | Explicit registered human identity to authorize the rollback |

If no human identity is registered yet:

```bash
brainclaw register-agent <name> --kind human --set-current
```

### `brainclaw agent-inventory`

Detect all installed AI coding agents and their capabilities on this machine.

| Option | Description |
|---|---|
| `--refresh` | Force regeneration even if an inventory already exists |
| `--json` | Output as JSON |

### `brainclaw projects`

List all brainclaw-initialized projects on this machine from the global registry.

| Option | Description |
|---|---|
| `--scan <roots>` | Comma-separated directories to scan for projects |
| `--register` | Register the current project in the global registry |
| `--json` | Output as JSON |

### `brainclaw check-events`

Show unseen events from the event bus (`events.jsonl`) for the current agent.

| Option | Description |
|---|---|
| `--agent <name>` | Agent to check events for |
| `--json` | Output as JSON |

### `brainclaw who`

List active agent sessions on this workspace. Shows agent, user, project, claims count, and last activity.

| Option | Description |
|---|---|
| `--all` | Include stale sessions |
| `--gc` | Remove stale sessions |

### `brainclaw usage`

Show brainclaw context volume stats — tokens injected per agent and per MCP tool call.

| Option | Description |
|---|---|
| `--json` | Output as JSON |

This keeps end-user installs aware of published npm releases without requiring a local tarball channel. To keep beta testers on a different channel, set `brainclaw_update_source` to `type: npm` with a different `dist_tag`, such as `prelaunch`.
