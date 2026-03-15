# Storage Model

brainclaw is local-first and workspace-centric.

## Default structure

```text
.brainclaw/
  project.md        ← Human & agent readable view (auto-generated)
  config.yaml       ← Project configuration
  instructions/     ← Layered shared instructions
  plans/            ← Shared plan items
  constraints/      ← Canonical constraint entries
  decisions/        ← Canonical decision entries
  traps/            ← Canonical trap entries
  handoffs/         ← Canonical handoff entries
```

## Design principles

### Canonical state is split
Each entity is stored as its own JSON file.

Benefits:

- readable diffs
- easier merges
- clear provenance
- straightforward automation
- no giant monolithic memory blob

### Human-readable view is generated
`project.md` is regenerated from canonical state on every write.

Benefits:

- agents can read a simple file
- humans get an inspectable summary
- the source of truth remains structured

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

## What may stay more operational

- machine-local runtime notes
- private notes
- short-lived observations
- reflective candidates awaiting review

## Why this model matters

The storage model is part of the product value:

- local-first
- inspectable
- Git-friendly
- reversible
- suitable for both humans and agents

## Related pages

- [concepts/memory.md](concepts/memory.md)
- [concepts/runtime-notes.md](concepts/runtime-notes.md)
- [security.md](security.md)
