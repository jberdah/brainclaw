# Runtime Notes

Runtime notes capture operational observations made during work.

They help bridge the gap between live execution and durable project memory.

## Examples

- a local environment quirk
- a host-specific issue
- a temporary blocker
- a short-lived implementation observation
- a note worth later reflection

## Visibility modes

Depending on configuration and use, runtime notes may be:

- shared
- machine-local
- private

This lets teams keep transient or host-specific context available without polluting canonical project memory too early.

## Reflection workflow

A runtime note does not have to become durable memory immediately.
A useful pattern is:

1. capture the observation quickly
2. keep it visible in runtime state
3. reflect it into a candidate if it seems reusable
4. accept or reject it later through review

## Why this matters

This creates a safer bridge from ephemeral facts to durable memory.
Not every operational observation deserves instant promotion.
