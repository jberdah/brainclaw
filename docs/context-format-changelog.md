# Context Format Changelog

## 1.3 (planned / not yet emitted as `context_schema`)

- Added `available_capabilities` field to structured context containing registered project capabilities with metadata (id, name, category)
- Added `available_tools` field to structured context containing registered project tools with metadata (id, name, type)
- Enhanced text output to include "Available Capabilities" and "Available Tools" sections when metadata is present
- Added discovery hints pointing users to `bclaw_get_capabilities`, `bclaw_list_tools`, and `bclaw_search_tools` MCP tools
- These fields are currently additive enrichments around the `1.2` contract; update `CONTEXT_SCHEMA_VERSION` before treating this section as the shipped schema version

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
