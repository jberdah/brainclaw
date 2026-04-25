# Continue Integration

brainclaw integrates with Continue through MCP tools and project-scoped rules, giving Continue access to shared memory, plans, claims, and coordination state.

## Auto-setup

`brainclaw init` detects Continue and writes `.continue/rules/brainclaw.md` automatically. Or manually:

```bash
brainclaw export --format continue-rules --write
```

## MCP configuration

Continue reads MCP server definitions from `.continue/config.json`. Add brainclaw:

```json
{
  "mcpServers": [
    {
      "name": "brainclaw",
      "command": "npx",
      "args": ["-y", "brainclaw@latest", "mcp"]
    }
  ]
}
```

Per-server YAML configs are also supported in `.continue/mcpServers/*.yaml`.

## Permissions

Continue uses a separate permissions file at `~/.continue/permissions.yaml`. Tool-level control uses `--allow`, `--ask`, and `--exclude` flags on the CLI.

brainclaw does not yet emit `permissions.yaml` automatically — configure manually if running headless.

## SKILL.md discovery

Continue discovers skills from `config.yaml` slashCommands. It does not auto-discover `.agents/skills/` — use explicit config if you need brainclaw skills.

## Headless invocation

```bash
cn --auto /path/to/project
```

Set `CONTINUE_API_KEY` for API-backed headless runs.

## Invoke template

```bash
cn /path/to/project
```

## Caveats

- **No hooks**: Continue delegates hook-like behavior to VS Code extensions. No native pre-prompt injection.
- **No auto-approve writer**: brainclaw does not emit `permissions.yaml` yet — tool approval must be configured manually.
- **No native subagents**: Continue does not expose subagent orchestration.
- **Windows**: Works via VS Code extension; CLI (`cn`) requires Node.js on PATH.
