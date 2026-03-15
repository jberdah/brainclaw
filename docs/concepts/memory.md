# Memory

brainclaw uses the term **memory** in an explicit, workspace-oriented sense.

This is not an opaque cloud memory feature.
It is shared project state stored locally in a structured, inspectable form.

## What memory includes

Durable memory can include:

- instructions
- constraints
- decisions
- traps
- handoffs

These are the pieces of context that should survive across sessions and be readable by both humans and agents.

## Durable vs runtime

A useful mental model is to separate:

### Durable memory
Shared project knowledge worth keeping.

### Runtime memory
Operational observations that may be short-lived, host-specific, or private.

Not everything seen during execution should become canonical memory immediately.

## Why explicit memory matters

Without explicit memory, project context tends to scatter across:

- chat history
- agent prompts
- personal notes
- unstated assumptions
- hidden tool memory

brainclaw makes this context visible and versionable.

## Readable vs canonical

brainclaw keeps:

- canonical structured JSON as the source of truth
- a generated readable view in `project.md`

This balances machine reliability with human readability.

## Related pages

- [coordination.md](coordination.md)
- [runtime-notes.md](runtime-notes.md)
- [workspace-bootstrapping.md](workspace-bootstrapping.md)
