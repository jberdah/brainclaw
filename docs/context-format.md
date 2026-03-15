# Context Format

`brainclaw context` and `bclaw_get_context` expose a versioned public contract for agent consumers.

Current version: `1.1`

## Stable top-level fields

- `context_schema`
- `digest`
- `memory_density`
- `bootstrap_available`
- `derived_signals`
- `execution_context`
- `agent_tooling`
- `scoped_activity`
- `selected`

## Compatibility policy

- Additive changes bump the minor version.
- Breaking changes bump the major version.
- Fields listed above are treated as public and stable for agent consumers.
- Future enrichments should prefer optional fields over reshaping existing ones.

## `1.1` additions over `1.0`

- `context_schema` is now explicitly surfaced in markdown and template renders.
- `agent_tooling` includes `agents_rules`.
- `agent_tooling.skills[]` includes bounded capability markers:
  - `scripts_present`
  - `references_present`
  - `assets_present`
- `agent_tooling.mcp_servers[]` includes:
  - `availability`
  - `source`

## Semantics

- `execution_context` and `agent_tooling` are opportunistic and may be omitted when not useful.
- `derived_signals` are non-canonical bootstrap hints, not accepted project memory.
- `agent_tooling` inventories local capabilities and constraints; it does not imply project decisions.
