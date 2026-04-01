# Project Refs for Multi-Project Navigation

> Proposal / design note: this document describes a target navigation model, not the currently shipped CLI or MCP surface. For implemented multi-project commands today, use `brainclaw switch` and `brainclaw projects`.

## Goal

In a multi-project workspace, agents should be able to address any known project from anywhere in the workspace without depending on the current working directory.

The core primitive for this is a stable `project_ref`.

Examples:

- `dev/repos/global`
- `applications/lodestar`
- `core_services/postgres`

This lets Brainclaw support direct project navigation commands such as:

- `brainclaw projects`
- `brainclaw project applications/lodestar`
- `brainclaw context --project applications/lodestar`
- `brainclaw children dev/repos/global`
- `brainclaw ancestors applications/lodestar`
- `brainclaw dependencies applications/lodestar`
- `brainclaw locate dev/repos/global/applications/lodestar/src/app.ts`

The same addressing model must exist over MCP.

## Why

Current workspace-centric behavior is still too dependent on `cwd` and path heuristics:

- `brainclaw context --for <path>` can help rerank context
- in folder-mode workspaces it can now resolve a child store for some path-shaped targets
- but the mental model is still "where am I on disk?"

For agents, this is weaker than "which project am I addressing?"

`project_ref` should become the natural addressing unit for:

- context lookup
- workspace navigation
- parent/child traversal
- dependency traversal
- future project-scoped MCP tools

## Core Model

Each known project keeps its internal `project_id`.

Each project also gets a stable human-readable `project_ref`:

- derived from the workspace-relative path
- normalized with forward slashes
- unique within the workspace

Examples:

- workspace root: `.`
- child repo: `dev/repos/global`
- nested project: `dev/repos/global/applications/lodestar`

The registry for a workspace project should expose at least:

- `project_id`
- `project_ref`
- `project_name`
- `relative_path`
- `absolute_path`
- `workspace_root`
- `parent_ref`
- `aliases`
- `store_present`
- `source`
- `dependencies`

## Naming Rules

Canonical rule:

- `project_ref` is the workspace-relative path to the project root

Short aliases:

- the final path segment may be used as an alias
- only when unique within the workspace
- ambiguous aliases must fail with a disambiguation error

Examples:

- `applications/lodestar` may have alias `lodestar`
- if two projects end with `api`, `brainclaw project api` must fail and suggest full refs

This keeps the model simple:

- canonical ref is always deterministic
- short names are optional ergonomics, not identity

## Project Resolution

Resolution should work from anywhere in the workspace.

The resolver accepts:

- exact `project_ref`
- exact `project_id`
- unique short alias
- absolute path to a project root
- absolute or relative path inside a project

The resolver returns:

- the matched project record
- the resolved project root
- the matched method: `ref`, `id`, `alias`, or `path`

Resolution priority:

1. exact `project_ref`
2. exact `project_id`
3. unique alias
4. path-to-project containment

If multiple matches remain, Brainclaw must stop and return a clear ambiguity error.

## CLI Surface

The minimal agent-first CLI surface should be:

### `brainclaw projects`

List known projects in the current workspace.

Fields:

- `project_ref`
- `project_name`
- `relative_path`
- `parent_ref`
- `store_present`

### `brainclaw project <ref>`

Show a compact project card.

Fields:

- `project_id`
- `project_ref`
- `aliases`
- `absolute_path`
- `parent_ref`
- `children`
- `dependencies`
- store health summary

### `brainclaw context --project <ref>`

Resolve the target project first, then build context from that store.

Notes:

- this is stronger than `context --for`
- `--for` still helps ranking within the resolved project

Example:

```bash
brainclaw context --project applications/lodestar --for src/app.ts
```

### `brainclaw children <ref>`

Return direct child projects.

### `brainclaw ancestors <ref>`

Return the project chain from parent to workspace root.

### `brainclaw dependencies <ref>`

Return declared or detected project dependencies.

### `brainclaw locate <path>`

Resolve any path to the owning project.

This is especially useful for agents:

- start from a changed file
- ask Brainclaw which project owns it
- then request context for that project

## MCP Surface

The MCP equivalents should mirror the CLI rather than invent a second addressing model.

Suggested tools:

- `bclaw_list_projects`
- `bclaw_get_project`
- `bclaw_get_project_context`
- `bclaw_list_project_children`
- `bclaw_list_project_ancestors`
- `bclaw_list_project_dependencies`
- `bclaw_locate_project`

All of them should accept `project_ref` as the primary selector.

`bclaw_get_context` may continue to exist, but multi-project agents should prefer `bclaw_get_project_context`.

## Hierarchy Semantics

Hierarchy comes from project roots on disk.

Definitions:

- parent: nearest known project root above the current project
- child: known project whose nearest known parent is the current project
- ancestor: repeated parent chain

This is path-derived and deterministic.

## Dependency Semantics

Dependencies are different from hierarchy.

Dependencies should support two sources:

- declared links in Brainclaw metadata
- detected links from repo/workspace tooling when reliable

Examples:

- monorepo package dependencies
- service depends on shared database project
- app depends on auth service

The first iteration should allow declared dependencies first.

Auto-detection can remain additive.

## Storage Direction

This does not require replacing current project ids or store layout.

It requires a workspace project registry that can be rebuilt or refreshed non-destructively.

Likely location:

- workspace-level discovery inventory

Likely persisted fields:

- stable `project_ref`
- alias set
- hierarchy links
- declared dependency links

This should stay clearly separate from canonical memory items such as decisions and constraints.

## Current Implementation (v0.23.0)

`brainclaw switch` provides the first layer of project navigation:

- `brainclaw switch <name-or-path>` — set active project by name or relative path
- `brainclaw switch --list` — discover available projects in workspace
- `resolveProjectRef()` — shared resolver for CLI and MCP (name, path, registry lookup)
- `resolveEffectiveCwd()` — single source of truth: `--cwd` > `BRAINCLAW_PROJECT` env > active-project > cwd
- MCP tools automatically resolve the active project

This covers the most common agent friction (cwd-dependent resolution) without requiring the full `project_ref` model yet.

## Migration Strategy

The migration should be low-risk and incremental.

Phase 0 (done):

- `brainclaw switch` with name/path resolution
- global `--cwd` option
- `BRAINCLAW_PROJECT` environment variable
- `resolveEffectiveCwd()` used by CLI and MCP

Phase 1:

- introduce `project_ref` in workspace discovery/registry
- expose `brainclaw projects`
- expose `brainclaw locate`

Phase 2:

- add `context --project <ref>`
- keep current `context --for <path>` behavior
- when `--project` is present, it wins over cwd heuristics

Phase 3:

- add `children` and `ancestors`
- add MCP equivalents

Phase 4:

- add declared dependencies
- optionally add auto-detection

## Non-Goals

This design does not require:

- replacing `project_id`
- removing cwd-based commands
- making aliases mandatory
- making dependency inference perfect in the first release

## Recommendation

The first implementation slice should be:

1. add `project_ref` to workspace project discovery
2. add a project resolver shared by CLI and MCP
3. add `brainclaw projects`
4. add `brainclaw context --project <ref>`
5. add `brainclaw locate <path>`

That is enough to give agents a stable and simple project-addressing model without a risky refactor.
