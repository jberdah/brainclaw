# Codex Integration

brainclaw integrates with OpenAI's Codex CLI through MCP tools and shared instruction files. Codex has MCP access, universal skills support, and headless CLI spawn capability, but no native lifecycle hook surface.

## Auto-setup

Codex setup is split across machine and project scope:

- `brainclaw setup-machine --agents codex --yes` writes the machine-level MCP config at `~/.codex/config.toml`
- `brainclaw init` creates or refreshes the current project's Brainclaw state and writes `AGENTS.md`

If the project already has `.brainclaw/`, rerunning `brainclaw init` is safe and refreshes the managed Brainclaw/Codex files for the current machine.

To regenerate project instructions manually:

```bash
brainclaw export --format agents-md --write
```

## MCP configuration

Codex reads MCP servers from a machine-level config (`~/.codex/config.toml` on most installs). brainclaw is registered as:

```toml
[mcp_servers.brainclaw]
command = "npx"
args = ["-y", "brainclaw@latest", "mcp"]
startup_timeout_ms = 20000
```

Per-session MCP config can also be passed via `--additional-mcp-config @<file>` when invoking Codex.

## Instruction files

- `AGENTS.md` — shared instruction file (also read by OpenCode)
- Static content stays behavioural and lightweight; live state (plans, claims, traps) flows through MCP

## Headless invocation

Codex is CLI-spawnable for parallel lanes and dispatched workflows. The canonical invoke template is:

```bash
codex exec -c approval_policy="never" --sandbox workspace-write "{prompt}"
```

The `--sandbox workspace-write` setting is required, **not `read-only`** — the read-only sandbox blocks the MCP filesystem writes that brainclaw needs (worktree handoffs, session files, etc.) and forces fallback to GitHub connectors which fail for local-only commits.

### Prompt delivery: stdin_pipe (preferred)

Since pln#475 (1.0.10+), Codex spawned as a child process receives its prompt via **stdin** rather than as an inline argument. The reason is Windows-specific: `codex.cmd` resolves through `cmd.exe`, where embedded backticks, `#`, or multi-line content can be mis-parsed and raise `unexpected argument`. Reading from stdin avoids that.

When you (or the dispatcher) calls Codex with no positional `[PROMPT]`, Codex reads stdin until EOF — that's where brainclaw pipes the brief. `inline_arg` remains a fallback for short prompts on POSIX.

### Brief-ack handshake

Since pln#476 (1.0.13+), spawned Codex workers are marked `delivered_and_started` once the wrapping shell touches a brief-ack sentinel at `.brainclaw/coordination/runtime/ack/<assignmentId>.ack`. This proves the spawn actually executed and decouples the handshake from MCP availability inside the worker — important because Codex spawned in `--sandbox workspace-write` may not have brainclaw MCP wired in its session.

## Capability profile

| Field | Value |
|-------|-------|
| Tier | A |
| MCP | yes |
| Hooks | no |
| Auto-approve | manual (per-tool approval) |
| Skills | yes |
| CLI spawnable | yes |
| Max concurrent tasks | 5 |
| Workflow model | task-based (one-shot exec, not interactive) |
| MCP config scope | machine |
| Prompt delivery | `stdin_pipe` (preferred), `inline_arg` (fallback) |

## Caveats

- **Sandbox blocks MCP writes**: when running with strict sandbox, the spawned Codex cannot write to `.brainclaw/` directly. Use the brief-ack file plus filesystem-direct candidate writes (the dispatcher harvests them).
- **Windows quoting**: long prompts containing backticks or `#` fail when passed as inline args through `cmd.exe`. The default stdin_pipe path avoids this.
- **Sandbox vs review parity**: review runs use the same `workspace-write` sandbox as execution runs (older templates forced `read-only` on reviews; that path blocked PowerShell exec on Windows).
- **No always-allow**: each MCP tool call still respects per-call approval policy unless explicitly set with `-c approval_policy="never"`.
