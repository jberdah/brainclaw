# Brainclaw

Multi-agent coordination tool for AI coding agents.
CLI + MCP server providing shared memory, claims, plans, and handoffs
across Claude Code, Copilot, Codex, Cursor, Windsurf, Cline, and others.

- **Stage:** Active development, v0.50.x
- **Audience:** AI coding agents + human dev supervisors
- **Stack:** TypeScript, Node16 ESM, zero runtime deps beyond commander/yaml/zod
- **Architecture:** File-based store (.brainclaw/), MCP over stdio, hooks for 6+ agents
- **Current focus:** Export quality, runtime integration, multi-agent coordination DX
