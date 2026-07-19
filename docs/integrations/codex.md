# Codex Integration

brainclaw integrates with OpenAI's Codex CLI through MCP tools, shared instruction files, and native lifecycle hooks. Codex has MCP access, universal skills support, headless CLI spawn capability, and a native lifecycle hook surface (added upstream in 2026 — [developers.openai.com/codex/hooks](https://developers.openai.com/codex/hooks)).

## Auto-setup

Codex setup is split across machine and project scope:

- `brainclaw setup-machine --agents codex --yes` writes the machine-level MCP config at `~/.codex/config.toml`
- `brainclaw init` creates or refreshes the current project's Brainclaw state, writes `AGENTS.md`, and writes project-level lifecycle hooks to `.codex/hooks.json` (git-ignored)

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

The `--sandbox workspace-write` setting is required, **not `read-only`** — the worker needs to write files in its own worktree (the edits it produces, plus its `LANE-RESULT.json`) so the coordinator has a harvestable diff. This is about the worker's *file* writes, not MCP: the brainclaw MCP server runs out-of-sandbox and is reachable under either sandbox mode (dec#133). What the sandbox does block is `git commit` (`.git` is outside the writable root), so the coordinator commits the worktree diff at harvest.

### Prompt delivery: stdin_pipe (preferred)

Since pln#475 (1.0.10+), Codex spawned as a child process receives its prompt via **stdin** rather than as an inline argument. The reason is Windows-specific: `codex.cmd` resolves through `cmd.exe`, where embedded backticks, `#`, or multi-line content can be mis-parsed and raise `unexpected argument`. Reading from stdin avoids that.

When you (or the dispatcher) calls Codex with no positional `[PROMPT]`, Codex reads stdin until EOF — that's where brainclaw pipes the brief. `inline_arg` remains a fallback for short prompts on POSIX.

### Brief-ack handshake

Since pln#476 (1.0.13+), spawned Codex workers are marked `delivered_and_started` once the wrapping shell touches a brief-ack sentinel at `.brainclaw/coordination/runtime/ack/<assignmentId>.ack`. This proves the spawn actually executed and decouples the handshake from whatever the worker does next — the spawn is confirmed even before the worker makes its first MCP call. (Note — dec#133: a sandboxed Codex run **does** reach brainclaw MCP; the server runs out-of-sandbox and `approval_policy=never` auto-approves. The sentinel is about confirming the spawn, not about MCP being unavailable.)

## Capability profile

| Field | Value |
|-------|-------|
| Tier | A |
| MCP | yes |
| Hooks | yes (`.codex/hooks.json`, project scope) |
| Auto-approve | manual (per-tool approval) |
| Skills | yes |
| CLI spawnable | yes |
| Max concurrent tasks | 5 |
| Workflow model | task-based (one-shot exec, not interactive) |
| MCP config scope | machine |
| Prompt delivery | `stdin_pipe` (preferred), `inline_arg` (fallback) |

## Lifecycle hooks

`brainclaw init` writes project-level hooks to `.codex/hooks.json` (git-ignored, machine-specific command paths). Codex reads hooks from `hooks.json` or an inline `[hooks]` table at user (`~/.codex/`) and project (`<repo>/.codex/`) scope ([Codex hooks docs](https://developers.openai.com/codex/hooks)). brainclaw wires three events:

| Event | brainclaw command | Purpose |
|-------|-------------------|---------|
| `SessionStart` | `brainclaw session-start --include-context` | Load shared context (constraints, decisions, traps, plans, handoffs) when a session begins |
| `UserPromptSubmit` | `brainclaw context-diff` | Surface what changed since the last turn |
| `Stop` | `brainclaw session-end --auto-release --reflect --reflect-handoff --dispatch-review` | Release claims, reflect, and dispatch review at turn end |

The file shape is `{ "hooks": { "<Event>": [ { "matcher": "", "hooks": [ { "type": "command", "command": "…" } ] } ] } }` (`matcher: ""` = match all occurrences). brainclaw **owns** these three event arrays: reruns overwrite them (idempotent, no cross-upgrade pile-up) — the same contract as the Cursor / Antigravity hook writers. A user's own hook placed on one of these three events is replaced on the next `init`; hooks on any **other** event are left untouched.

**Scope — interactive sessions, not headless dispatch.** These hooks serve an *interactive* Codex session. Non-managed command hooks require a one-time trust in Codex (`/hooks` — inspect and trust) before they run, so a fresh `.codex/hooks.json` is inert until the user trusts it. Headless dispatched workers (`codex exec`, used by `bclaw_dispatch` / `bclaw_coordinate`) do **not** rely on these hooks at all — they receive their context in the dispatch brief and report via `LANE-RESULT.json`; an untrusted project hook is simply skipped there, which is harmless. (A "managed" hook path via `requirements.toml`/MDM could bypass the trust step for fleets — a possible future enhancement.)

**Per-event output contract.** `SessionStart` and `UserPromptSubmit` emit their stdout as **model-visible context** — that is exactly the point (inject shared brainclaw state / the context diff). `Stop`, by contrast, expects a **JSON** response from Codex to shape turn-end behavior; brainclaw's `session-end` runs mainly for its side effects (release claims, reflect, dispatch review) and does not emit that JSON, so it does not gate the turn. Emitting a conformant per-event JSON response (notably for `Stop`) is a planned follow-up.

## Caveats

- **Sandbox blocks `git commit`, not MCP** (dec#133): a sandboxed Codex run reaches brainclaw MCP (the server is a separate out-of-sandbox process; `approval_policy=never` auto-approves). What the sandbox *does* block is direct writes to paths outside the worktree root — notably `.git`, so the worker cannot `git commit`. Leave fixes uncommitted; the coordinator integrates + commits the worktree diff at harvest. A LANE-RESULT.json / filesystem-direct candidate write remains a valid fallback for reporting.
- **Windows quoting**: long prompts containing backticks or `#` fail when passed as inline args through `cmd.exe`. The default stdin_pipe path avoids this.
- **Sandbox vs review parity**: review runs use the same `workspace-write` sandbox as execution runs (older templates forced `read-only` on reviews; that path blocked PowerShell exec on Windows).
- **No always-allow**: each MCP tool call still respects per-call approval policy unless explicitly set with `-c approval_policy="never"`.
