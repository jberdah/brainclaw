# GitHub Copilot Integration

brainclaw integrates with GitHub Copilot through MCP tools, instruction files, and lifecycle hooks. Copilot is a Tier A agent — full MCP access, hooks, skills support, and headless CLI spawn capability since CLI 1.0.35.

## Auto-setup

`brainclaw init` detects Copilot (`gh copilot` or `copilot` CLI installed) and writes:

- `.github/copilot-instructions.md` — instruction file Copilot reads automatically on each prompt
- MCP registration at `~/.copilot/mcp-config.json` (machine-level fallback) and/or project-level `.github/copilot/mcp-config.json`

Manual regeneration:

```bash
brainclaw export --format copilot-instructions --write
brainclaw export --format copilot-instructions --write --include-live
```

## MCP configuration

Copilot reads MCP servers from `~/.copilot/mcp-config.json`:

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

For per-session overrides (typical when spawning Copilot from a dispatcher), pass `--additional-mcp-config @<path-to-config.json>` on the CLI invocation. This was validated end-to-end during pln#440.

## Instruction files

- `.github/copilot-instructions.md` — Copilot reads this automatically. Keep it lightweight and behavioural.
- `.github/copilot-instructions.live.md` — optional local live companion with current plans, claims, traps, candidates, and handoffs. Write it with `brainclaw export --format copilot-instructions --write --include-live`; it stays gitignored even when the main instruction file is shared/versioned.
- By default, live state flows through MCP. The live companion is parity/backstop context for native-file workflows.

## Headless invocation

Since Copilot CLI 1.0.35 (validated 2026-04-24), Copilot is CLI-spawnable in headless mode. The canonical invoke template is:

```bash
copilot -p "{prompt}" --allow-all --no-ask-user
```

- `--allow-all` (or equivalent `--yolo`) disables interactive approval prompts (combines `--allow-all-tools --allow-all-paths --allow-all-urls`).
- `--no-ask-user` runs autonomously without pausing for clarifying questions.
- `-p` (or `--prompt`) takes the prompt as the next positional argument. Output is silent unless `-s` is also passed.

For machine-readable output (JSONL events per line):

```bash
copilot -p "{prompt}" --allow-all --no-ask-user --output-format json
```

## Capability profile

| Field | Value |
|-------|-------|
| Tier | A |
| MCP | yes |
| Hooks | yes |
| Auto-approve | manual (per-call) |
| Skills | yes |
| CLI spawnable | yes (1.0.35+) |
| Max concurrent tasks | 1 |
| Workflow model | interactive |
| MCP config scope | project (project-level config + machine-level fallback) |
| Prompt delivery | `inline_arg` (preferred), `inbox_structured` (fallback) |

## Caveats

- **CLI version**: headless spawn requires Copilot CLI 1.0.35 or later. Earlier versions failed silently when invoked headless and were treated as inbox-only by brainclaw.
- **Quota awareness**: Copilot enforces a per-window credit budget visible in session metadata. The dispatcher uses `max_concurrent_tasks=1` to avoid exhausting it on parallel work.
- **Update cadence**: keep `copilot` updated (`copilot update`) — flags and behaviour have moved between releases (`--yolo` was added, `--additional-mcp-config` flag was renamed once).
- **Windows path resolution**: on Windows, `where copilot` may resolve to multiple paths (`.exe`, `.cmd`, npm shim). The brainclaw dispatcher resolves via `where` and prefers the `.exe` form when present.
