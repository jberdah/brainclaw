# brainclaw MCP Schema Changelog

This document tracks all breaking and notable changes to the brainclaw MCP server protocol.

---

## 0.3.0 (current)

**Added**
- `initialize` handshake support (MCP protocol conformance)
- `schema_version: "0.3.0"` field in all `structuredContent` responses
- Write tools: `bclaw_write_note`, `bclaw_create_candidate`, `bclaw_accept`, `bclaw_reject`, `bclaw_claim`, `bclaw_release_claim`, `bclaw_session_start`, `bclaw_session_end`
- `bclaw_search` tool — full-text BM25 search across all memory items
- Trust-level access control on write tools (contributor / trusted / curator)
- `context_schema` field in `bclaw_get_context` structured responses
- Explicit identity arguments on mutation tools:
  - `agentId` on `bclaw_write_note`, `bclaw_create_candidate`, `bclaw_claim`, `bclaw_session_start`, `bclaw_session_end`
  - `byId` on `bclaw_accept`, `bclaw_reject`
- Stable MCP tool errors:
  - `identity_error`
  - `trust_error`
  - `validation_error`

**Changed**
- All read tool responses now include `schema_version` in `structuredContent`
- `bclaw_get_context` `structuredContent` flattens the full `ContextResult` object
- `bclaw_get_context` now exposes `context_schema: "1.2"` and additive fields from the current public context contract
- Mutation tools now require a registered identity on write paths; `agent`/`agentId` and `by`/`byId` must resolve to the same registered identity when both are provided
- `bclaw_reject` is now restricted to `trusted` / `curator` agents, aligned with `bclaw_accept`

---

## 0.2.0

**Added**
- `bclaw_get_agent_board` read tool
- `bclaw_read_handoff` read tool
- Tool prefix renamed: `tmem_` → `bclaw_`

**Changed**
- Environment variables renamed: `TEAM_MEMORY_*` → `BRAINCLAW_*`
- Storage directory renamed: `.memory/` → `.brainclaw/`

---

## 0.1.0

**Initial**
- `bclaw_get_context` read tool (was `tmem_get_context`)
- Basic stdio NDJSON transport
