# Workspace Bootstrapping

brainclaw is workspace-aware.
Shared memory is not assumed to exist everywhere by default.

## Why bootstrap exists

A workspace may be:

- already initialized
- known to the agent integration layer but not initialized locally
- entirely new

Bootstrap is the process that turns a workspace into a brainclaw-aware workspace.

## What bootstrap does

Bootstrap is more than creating a folder.
It establishes the first shared memory foundation for the workspace:

- inspects the repository structure
- detects the AI coding agent environment
- seeds stable workspace identity (`project_id`, `agent_id`)
- creates the initial storage structure
- writes to the detected agent's native instruction file (Cursor, Claude Code, Windsurf, etc.)
- creates `AGENTS.md` and `.github/copilot-instructions.md`

## Empty memory: one rule

"Bootstrap" historically named three different systems (init scaffolding, the
`bclaw_bootstrap` brownfield extractor, and the bootstrap ideation loop). When
the memory store is empty, every surface — the `bclaw_work` hint, the
`bclaw_setup` quick-init preview, and the `brainclaw init` preflight — now
emits the same decision rule (`resolveEmptyMemoryRecommendation`):

- **Repo with existing content** → run `bclaw_bootstrap` (CLI: `brainclaw bootstrap`)
  to extract initial context from docs, manifests, native agent files, and git
  history.
- **Greenfield repo** (nothing to extract) → open a bootstrap loop to ideate
  the project vision: `bclaw_coordinate(intent='ideate', preset='bootstrap')`
  (CLI: `brainclaw bootstrap-loop`).

The two routes are chainable in either order: extract first, then open a loop
for whatever vision the docs could not provide — or ideate first, then extract
once content exists. On greenfield, the brownfield preflight scan is skipped
entirely (there is nothing to harvest yet).

## Good integration pattern

1. check whether the workspace is initialized
2. if yes, retrieve fresh memory
3. if not, bootstrap when allowed
4. then use shared memory normally

## Why this matters for agents

If shared memory is absent, that should not always be interpreted as "there is no relevant context".
It may simply mean the workspace has not been onboarded yet.

This lets a single machine support multiple very different workspaces without forcing one static instruction layer to fit all of them equally well.

## init = single project entry point

`brainclaw init` is the single code path for turning a project into a
brainclaw-aware workspace, whether invoked from a terminal, from the
`bclaw_setup` MCP tool's quick-init step, or from a multi-repo
`brainclaw setup`. After detecting the local AI agent, init runs the
per-agent slice of the machine prerequisites (the same writes `setup`
performs at machine scope, scoped to the detected agent) so an agent
landing in the carte-blanche / fresh-repo case does not need a separate
shell-out + session reload. The slice is idempotent — each `ensure*`
function returns "skipped" when the agent's user-scope config doesn't
exist, and the writes are short-circuited in `BRAINCLAW_TEST_MODE` or
when `--skip-agent-bootstrap` is passed. `setup` is rescoped to
multi-repo / machine-bootstrap; `setup-machine` is the explicit
machine-only path.

### `init --force`

`--force` rebuilds managed identity fields (project_id, current_agent,
storage_dir, topology) but **merges through the existing config** so
curator personalisations (redaction patterns, sensitive paths,
governance overrides, claim TTL, cross-project links, custom markdown
caps) survive the reset. Before any write, a sibling backup is taken at
`.brainclaw.bak-<timestamp>/` — the standard recovery-backups pattern
used by `brainclaw upgrade`. Recovery: `brainclaw upgrade --rollback`.

## Solo-agent fresh defaults

A fresh `brainclaw init` seeds `governance.curators` with the human
running init. Without this, the default `approval_policy: 'review'`
combined with `curators: []` trapped every reflective note in pending
forever — a surprise that doesn't show up until enough memory has
accumulated to notice. The merge logic preserves any explicit curator
list on an existing store, so this only takes effect on fresh installs.

On an empty store, `bclaw_work` carries an explicit
`bclaw_create(entity='plan')` hint in `next_actions` alongside the
bootstrap recommendation: the bootstrap covers *vision*, the plan
affordance covers *work* itself. The two are independent — both can
appear simultaneously.

## Multi-project workspaces

A workspace may contain multiple brainclaw-initialized child projects (each with its own `.brainclaw/` store). In this topology:

- The workspace root holds shared instructions, constraints, and coordination state
- Each child project holds project-specific memory (decisions, traps, plans)
- The store chain walks upward: child → repo → workspace → user

### Working with child projects

Agents and operators can address child projects without `cd`:

```bash
brainclaw switch apps/lodestar    # set active project
brainclaw plan list               # now targets lodestar's store
brainclaw switch --clear          # back to workspace root
```

Or use environment variables:

```bash
export BRAINCLAW_PROJECT=lodestar
brainclaw context                 # resolves lodestar's store
```

Or one-off overrides:

```bash
brainclaw --cwd apps/lodestar plan list
```

### Project discovery

`brainclaw switch --list` discovers child projects via:

1. Global project registry
2. Workspace config `projects.known`
3. Filesystem scan for subdirectories containing `.brainclaw/`

The bootstrap analysis (`analyzeRepository`) also detects brainclaw-native workspace complexity (child stores, folder strategy, known projects) alongside classic monorepo markers.
