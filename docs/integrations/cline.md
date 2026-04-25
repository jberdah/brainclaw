# Cline Integration

brainclaw integrates with Cline through MCP tools, instruction rules, and lifecycle hooks. Cline is a Tier A agent — full MCP access, hooks, auto-approve support, skills, and CLI spawn capability for parallel lanes.

## Auto-setup

`brainclaw init` detects Cline (the VS Code extension and/or the `cline` CLI) and writes:

- `.clinerules/brainclaw.md` — Cline-specific instruction rules (auto-discovered by Cline)
- `.cline/mcp.json` — project-level MCP config registering brainclaw

Manual regeneration:

```bash
brainclaw export --format cline --write
```

## MCP configuration

Cline reads MCP servers from `.cline/mcp.json` at the project root:

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

Cline supports per-server `alwaysAllow` for auto-approving specific tools:

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

## Instruction files

- `.clinerules/brainclaw.md` — Cline-specific rules (auto-discovered, project-scoped)
- Static content stays behavioural and lightweight; live state (plans, claims, traps) flows through MCP

## SKILL.md discovery

Cline auto-discovers skills from `.clinerules/`, `.claude/skills/`, and `.agents/skills/`. brainclaw writes a single `.agents/skills/brainclaw/SKILL.md` that Cline picks up automatically.

## Headless invocation

Cline is CLI-spawnable for parallel lanes and dispatched workflows. The canonical invoke template is:

```bash
cline -y "{prompt}"
```

The `-y` flag (YOLO mode) disables interactive approval prompts so the spawned worker runs autonomously.

## Capability profile

| Field | Value |
|-------|-------|
| Tier | A |
| MCP | yes |
| Hooks | yes |
| Auto-approve | yes (`alwaysAllow` per server, `-y` per session) |
| Skills | yes |
| CLI spawnable | yes |
| Max concurrent tasks | 3 |
| Workflow model | interactive |
| MCP config scope | project |
| Prompt delivery | `inline_arg` (preferred, max 8000 chars), `inbox_structured` (fallback) |

## Caveats

- **Hook support varies by platform**: Cline hooks are reliable on macOS/Linux but the Windows path is less exercised. brainclaw generates hooks that gracefully degrade when the runtime doesn't honour them — the templateTier stays A regardless.
- **Cline / Roo / Kilocode family**: Cline shares its config-pattern lineage with Roo Code and Kilocode. The directory names differ (`.clinerules/` vs `.roo/rules/` vs `.kilo/rules/`) but the auto-discovery model is the same.
- **Project-scoped MCP**: unlike machine-scoped agents (Cursor, Windsurf), Cline's MCP config lives in the repo. Each repo gets its own brainclaw registration.
- **Long prompts**: inline arg supports up to 8000 chars before falling back to inbox-structured delivery. Briefs longer than that should arrive via inbox.
