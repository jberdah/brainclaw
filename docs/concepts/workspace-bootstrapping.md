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
