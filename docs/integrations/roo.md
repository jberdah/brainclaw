# Roo Integration

brainclaw integrates with Roo through MCP tools and project-scoped rules, providing shared memory, plans, and multi-agent coordination.

## Auto-setup

`brainclaw init` detects Roo and writes `.roo/rules/brainclaw.md` automatically. Or manually:

```bash
brainclaw export --format roo --write
```

## MCP configuration

Roo reads MCP servers from `.roo/mcp.json` (project-scoped) or the global `mcp_settings.json`. Add brainclaw:

```json
{
  "mcpServers": {
    "brainclaw": {
      "command": "npx",
      "args": ["-y", "brainclaw@latest", "mcp"]
    }
  }
}
```

## Permissions

Roo supports per-server auto-approval via `alwaysAllow` array, plus a global toggle:

```json
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

brainclaw emits `alwaysAllow` with all known tool names during setup.

## Instruction files

- `.roo/instructions.md` — global instructions (Roo reads at session start)
- `.roo/rules/` — rule files, equivalent to `.clinerules/`
- `.rooignore` — file-level ignore patterns (respects `.gitignore` syntax)

Roo also supports mode-specific rules and skills (e.g., `skills-code/`, `skills-architect/`).

## SKILL.md discovery

Roo auto-discovers skills from `.roo/skills/`, `.agents/skills/`, and `.claude/skills/`. A single `.agents/skills/brainclaw/SKILL.md` is picked up automatically.

## Headless invocation

Roo headless is available via Cloud Agents only (no local CLI headless mode).

## Invoke template

```
# From within VS Code with Roo extension
# Use -y flag for auto-approve in supported contexts
```

## Caveats

- **No hooks**: Hook support is proposed but unreleased as of April 2026.
- **No local headless CLI**: Headless dispatch requires Roo Cloud Agents.
- **Cline family**: Roo is a Cline fork — config patterns are similar but paths differ (`.roo/` vs `.cline/`).
- **Windows/Linux**: Works via VS Code extension on all platforms.
