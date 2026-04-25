# OpenCode Integration

brainclaw integrates with OpenCode through MCP tools and AGENTS.md, providing shared memory, plans, claims, and multi-agent coordination.

## Auto-setup

`brainclaw init` detects OpenCode and writes `AGENTS.md` automatically. Or manually:

```bash
brainclaw export --format agents-md --write
```

## MCP configuration

OpenCode reads MCP servers from `opencode.json` at the project root, or `~/.config/opencode/opencode.json` globally:

```json
{
  "mcp": {
    "brainclaw": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "brainclaw@latest", "mcp"]
    }
  }
}
```

## Permissions

OpenCode uses a per-tool permission map with `allow`, `ask`, or `deny` values:

```json
{
  "mcp": {
    "brainclaw": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "brainclaw@latest", "mcp"],
      "permissions": {
        "bclaw_context": "allow",
        "bclaw_work": "allow",
        "bclaw_find": "allow",
        "bclaw_get": "allow"
      }
    }
  }
}
```

brainclaw does not yet emit OpenCode permissions automatically.

## Instruction files

OpenCode reads `AGENTS.md` at the project root — the same file used by Codex. brainclaw writes this during `init` or `export`.

## SKILL.md discovery

OpenCode auto-discovers skills from `.opencode/skills/`, `.claude/skills/`, and `.agents/skills/`. A single `.agents/skills/brainclaw/SKILL.md` is picked up automatically.

## Headless invocation

```bash
opencode run /path/to/project
```

OpenCode also supports `serve` (HTTP API) and `web` (browser UI) modes.

## Invoke template

```bash
opencode /path/to/project
```

## Subagents

OpenCode supports native subagents via `mode: subagent` and `@mention` syntax, with per-agent permissions. These are separate from brainclaw's coordination — brainclaw operates above them.

## Caveats

- **No hooks**: OpenCode has a plugin system (JS/TS) but it is not compatible with Claude Code hook format. No pre-prompt injection.
- **No auto-approve writer**: brainclaw does not emit OpenCode `permissions` blocks yet — configure manually for headless.
- **`external_directory` deny**: OpenCode may deny file access outside the project root by default. Ensure brainclaw's store path (`.brainclaw/`) is within the project.
- **Windows**: Requires Node.js on PATH. Works on Windows, Linux, and macOS.
