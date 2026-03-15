# Coordination

brainclaw is not only a memory layer.
It is also a coordination layer.

That distinction matters.

## Why coordination is needed

Multiple humans and coding agents working in the same repo can easily:

- duplicate work
- miss handoffs
- overwrite each other
- diverge on plan status
- act on stale assumptions

Traditional instruction files do not solve this well because they describe how to behave, but not what is currently happening.

## What brainclaw adds

brainclaw introduces shared operational state for a workspace, including:

- plans
- task status
- file claims
- handoffs
- runtime notes
- board views

## The key idea

A workspace should expose not only what the project knows, but also what is currently being done.

That includes:

- what matters
- what is active
- who is working where
- what is blocked
- what needs review or handoff

## Why this is different from another agent

brainclaw does not try to become the agent that does everything.
It helps many tools collaborate against the same workspace state.

## Related pages

- [plans-and-claims.md](plans-and-claims.md)
- [runtime-notes.md](runtime-notes.md)
- [../integrations/overview.md](../integrations/overview.md)
