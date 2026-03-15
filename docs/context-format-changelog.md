# Context Format Changelog

## 1.2

- Added `context_diff` to expose compact memory deltas since a session started.
- Clarified the public contract for contradiction-aware session context refreshes.
- Kept the contract additive and backward-compatible with `1.1`.

## 1.1

- Added explicit `context_schema` rendering in markdown and template outputs.
- Added `agent_tooling.agents_rules`.
- Added skill metadata flags: `scripts_present`, `references_present`, `assets_present`.
- Added MCP inventory metadata: `availability`, `source`.
- Kept the contract additive and backward-compatible with `1.0`.

## 1.0

- Baseline contract introduced with:
  - `digest`
  - `memory_density`
  - `bootstrap_available`
  - `derived_signals`
  - `execution_context`
  - `agent_tooling`
  - `scoped_activity`
  - `selected`
