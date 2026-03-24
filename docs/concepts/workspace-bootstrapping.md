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

## Good integration pattern

1. check whether the workspace is initialized
2. if yes, retrieve fresh memory
3. if not, bootstrap when allowed
4. then use shared memory normally

## Why this matters for agents

If shared memory is absent, that should not always be interpreted as "there is no relevant context".
It may simply mean the workspace has not been onboarded yet.

This lets a single machine support multiple very different workspaces without forcing one static instruction layer to fit all of them equally well.

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
