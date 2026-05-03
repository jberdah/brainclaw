# Brainclaw

Multi-agent coordination tool for AI coding agents.
CLI + MCP server providing shared memory, claims, plans, and handoffs
across Claude Code, Copilot, Codex, Cursor, Windsurf, Cline, Mistral Vibe, and others.

- **Stage:** v1.0 shipped, Phase 4 (operator maturity) complete. Private usage across a few machines; adoption-grade hardening in progress.
- **Audience:** AI coding agents + human dev supervisors.
- **Stack:** TypeScript, ESM (Node ≥20), zero runtime deps beyond commander/yaml/zod. MCP over stdio.
- **Architecture:** File-based store (`.brainclaw/`), canonical grammar (`bclaw_work`, `bclaw_context`, `bclaw_find/get/create/update/remove/transition`), per-agent surfaces generated from a single source of truth.
- **Current focus:** Cross-agent surface coherence (facade-first everywhere), onboarding for a fresh agent, federation groundwork.
