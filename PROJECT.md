# Brainclaw

Multi-agent coordination tool for AI coding agents.
CLI + MCP server providing shared memory, claims, plans, and handoffs
across Claude Code, Copilot, Codex, Cursor, Windsurf, Cline, Mistral Vibe, and others.

- **Stage:** v1.25 shipped — the Code Map is now an analysis surface (symbol index, briefs, proven usages, impact). Phase 4 (operator maturity) complete; adoption-grade hardening in progress. Private usage across a few machines.
- **Audience:** AI coding agents + human dev supervisors.
- **Stack:** TypeScript, ESM (Node ≥22.12), zero runtime deps beyond commander/yaml/zod. MCP over stdio.
- **Architecture:** File-based store (`.brainclaw/`), canonical grammar (`bclaw_work`, `bclaw_context`, `bclaw_find/get/create/update/remove/transition`), per-agent surfaces generated from a single source of truth.
- **Current focus:** Federation v2 (breaking core redesign, dec#156), Code Map as an analysis surface, Loop Engine (ideation/review/implementation loops), cross-agent surface coherence and fresh-agent onboarding.
