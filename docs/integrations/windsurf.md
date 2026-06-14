# Windsurf Integration

brainclaw integrates with Windsurf through MCP tools and instruction rules, providing shared memory, plans, and coordination state to Cascade.

## Auto-setup

`brainclaw init` detects Windsurf and writes `.windsurfrules` automatically. Or manually:

```bash
brainclaw export --format windsurf --write
```

## MCP configuration

Windsurf reads MCP servers from a **machine-scoped** config file:

```
~/.codeium/windsurf/mcp_config.json
```

Add brainclaw:

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

Note: this is a global config — it applies to all Windsurf projects on the machine.

## Permissions

Windsurf supports `alwaysAllow` as an array on each MCP server entry:

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

`brainclaw setup-machine` emits the Windsurf MCP config with `alwaysAllow` for the Brainclaw tool surface.

## Instruction files

- `.windsurf/rules/*.md` — modern format (recommended), multiple rule files
- `.windsurfrules` — legacy single-file format (still supported)

`brainclaw export --format windsurf --write` writes the legacy `.windsurfrules` instruction file. Project setup also writes `.windsurf/rules/brainclaw.md` when Windsurf is selected, so modern rule discovery is covered.

## SKILL.md discovery

Windsurf uses `.windsurf/workflows/*.md` for slash-command workflows (12k char max). It does not auto-discover `.agents/skills/`. Skills must be wired as workflows manually.

## Headless invocation

Windsurf does not offer a headless CLI. It runs as a Docker-based environment — no `-p` flag equivalent.

## Invoke template

```
# Windsurf is GUI-only — no CLI invoke
# Use within the Windsurf IDE (Cascade panel)
```

## Caveats

- **Machine-scoped MCP**: The config at `~/.codeium/windsurf/mcp_config.json` is global, not per-project. All projects share the same server list.
- **No hooks**: Cascade Hooks exist but are limited to logging — no pre-prompt injection.
- **Two rule paths**: `.windsurfrules` remains the portable export target; `.windsurf/rules/brainclaw.md` is written during project setup for modern Windsurf rule discovery.
- **No headless**: Cannot be used as a brainclaw dispatch target.
- **Plan Mode**: Windsurf's "megaplan" mode is separate from brainclaw plans — they don't conflict but don't interoperate.
- **Windows/Linux**: Works on all platforms via the Windsurf IDE.
