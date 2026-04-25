# Kilo Code Integration

brainclaw integrates with Kilo Code through MCP tools and instruction files, providing shared memory, plans, and coordination. Kilo Code is a fork of the Cline/Roo family with its own config paths.

## Auto-setup

`brainclaw init` detects Kilo Code and writes `.kilo/rules/brainclaw.md` automatically (per the writer in `src/core/agent-files.ts`). The MCP config at `.kilo/mcp.json` is also generated when applicable.

## MCP configuration

Kilo Code reads MCP servers from `~/.config/kilo/kilo.jsonc` (global) or `kilo.jsonc` (project-scoped):

```jsonc
{
  "mcpServers": {
    "brainclaw": {
      "command": "npx",
      "args": ["-y", "brainclaw@latest", "mcp"]
    }
  }
}
```

Note: Kilo uses JSONC (JSON with comments), not plain JSON.

## Permissions

Kilo Code supports per-tool permission control and per-server `alwaysAllow`:

```jsonc
{
  "mcpServers": {
    "brainclaw": {
      "command": "npx",
      "args": ["-y", "brainclaw@latest", "mcp"],
      "alwaysAllow": ["bclaw_context", "bclaw_work", "bclaw_find", "bclaw_get"]
    }
  }
}
```

Individual tools can also use `permission: { tool: "allow" | "ask" | "deny" }` syntax.

## Instruction files

- `AGENTS.md` — standard instruction file (shared with Codex, OpenCode)
- `.kilo/rules/brainclaw.md` — Kilo-specific brainclaw rules (auto-written)

## SKILL.md discovery

Kilo Code auto-discovers skills from `.kilocode/skills/`, `.claude/skills/`, and `.agents/skills/`. A single `.agents/skills/brainclaw/SKILL.md` is picked up automatically.

## Headless invocation

```bash
kilo --auto --json /path/to/project
```

The `--auto` flag enables YOLO mode (no approval prompts). `--json` provides structured output.

## Invoke template

```bash
kilo /path/to/project
```

## Caveats

- **Cline/Roo family fork**: Config patterns are similar to Cline and Roo but paths differ (`.kilo/` vs `.cline/` vs `.roo/`).
- **JSONC format**: Config files use JSONC (comments allowed), not plain JSON. Parsers must handle this.
- **No hooks**: Hook support is tracked in issue #5827 but not yet public.
- **Windows/Linux**: Works via VS Code extension on all platforms.
