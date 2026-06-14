# Storage Model

brainclaw is local-first and workspace-centric.

## Default structure

```text
.brainclaw/
  config.yaml                    ← Project configuration
  project.md                     ← Legacy derived readable view (best-effort, regenerable)
  events.jsonl                   ← Append-only event log (agent notifications)
  audit.log                      ← Append-only audit trail (before/after snapshots)
  memory/
    constraints/                 ← Canonical constraint entries (one JSON per entity)
    decisions/                   ← Canonical decision entries
    traps/                       ← Canonical trap entries
    instructions/                ← Layered shared instructions
  coordination/
    plans/                       ← Shared plan items
    claims/                      ← Active scope claims
    handoffs/                    ← Handoff records
    sessions/                    ← Session state
    runtime/                     ← Runtime notes (shared, machine, private)
    inbox/                       ← Candidate review queue
  discovery/
    bootstrap/                   ← Bootstrap profiles and seeds
  agents/                        ← Agent registration and identity
```

## Design principles

### Canonical state is split
Each entity is stored as its own JSON file (e.g. `memory/decisions/dec_abc123.json`).

Benefits:

- readable diffs in `.brainclaw/.git`
- easier merges
- clear provenance per entity
- O(1) lookup by ID (direct file access)
- no giant monolithic memory blob
- isolated corruption (one bad file does not affect others)

### Derived views are best-effort
`.brainclaw/project.md` is a **legacy derived view** regenerated from canonical state via `rebuildProjectMd()`. It is not a write target and no longer carries live claims, plans, handoffs, or runtime state — use `brainclaw agent-board`, `brainclaw context`, or MCP board/context tools for that operational data.

Root `PROJECT.md` is different: it is the durable project vision and should contain stable product, architecture, and contribution guidance that does not expire every session.

Failures to regenerate `project.md` are logged but never block mutations. If it gets stale, `brainclaw doctor` detects the drift.

### All mutations go through a single pipeline
Every write to `.brainclaw/` is serialized through `mutate()` (`src/core/mutation-pipeline.ts`):

1. **Store-wide lock** — advisory file lock at `.brainclaw/.store-mutation` (5s timeout, 10s expiry)
2. **Reentrant** — nested mutations within the same process are safe
3. **Atomic writes** — individual files use temp-file + rename pattern
4. **Git versioned** — `.brainclaw/.git` tracks all changes for rollback

For agents using MCP (the recommended path), mutations are additionally serialized by the MCP server's `McpTaskRunner` — a FIFO queue that runs one task at a time. This provides two layers of write safety:

| Layer | Scope | Mechanism |
|---|---|---|
| **McpTaskRunner** | Single MCP server process | FIFO queue, one active Worker thread |
| **mutate() file lock** | Cross-process (CLI + MCP) | Advisory `.store-mutation` lock file |

Agents should always use MCP tools for mutations. The CLI is for human operators, scripting, and fallback workflows.

### Topology can vary

Depending on configuration, storage may be:

| Topology | Behavior |
|---|---|
| `embedded` (default) | `.brainclaw/` inside the repo, tracked by Git |
| `sidecar` | `.brainclaw/` inside the repo but gitignored |
| `local-only` | Outside the repo, never tracked |

## What belongs in canonical memory

- decisions
- constraints
- traps
- layered instructions
- handoffs
- plans

## What stays operational

- machine-local runtime notes
- private notes
- short-lived observations (with optional TTL)
- reflective candidates awaiting review
- event log and audit trail

## Why this model matters

The storage model is part of the product value:

- local-first — no cloud dependency
- inspectable — plain text + JSON
- Git-friendly — entity-per-file, readable diffs
- reversible — `.brainclaw/.git` history + rollback
- mutation-safe — serialized writes, atomic file operations
- suitable for both humans and agents

## Related pages

- [concepts/memory.md](concepts/memory.md)
- [concepts/runtime-notes.md](concepts/runtime-notes.md)
- [security.md](security.md)
