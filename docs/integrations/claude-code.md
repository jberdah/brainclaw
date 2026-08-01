# Claude Code Integration

brainclaw is a good fit for Claude Code because Claude Code can work with files, instructions, MCP, and hook-like workflow mechanisms.

## Auto-setup

`brainclaw init` detects Claude Code (`CLAUDE_CODE_VERSION`) and writes `CLAUDE.md` automatically. Or manually:

```bash
brainclaw export --format claude-md --write
```

## Recommended approach

- use MCP as the default runtime path for dynamic retrieval and writes
- keep `CLAUDE.md` lightweight and behavioral: it should tell Claude Code when to call Brainclaw, not carry all mutable workspace state
- use `.brainclaw/project.md` as a readable fallback (it is a derived view, regenerated best-effort — run `brainclaw rebuild` if stale)
- use hooks or workflow checks when a stronger reminder is needed

## The advisory PreToolUse hook (v1.19.0+)

`brainclaw install-hooks` generates `.git/hooks/claude-pre-tool.sh` **and activates
it** by merging a `PreToolUse` entry into `.claude/settings.json`. Before v1.19.0 it
only printed instructions, so the hook was dead even for operators who ran the
command.

It nudges an agent that is editing files without holding a claim of its own. It is
**advisory and can never block**: `permissionDecision` is always `allow` and the
exit code is always 0 (trp_5f342186 — a hook cascade once destroyed work).

### The channel matters, and it is not stderr

Per the Claude Code hook contract:

| Exit | stderr goes to | Tool |
|---|---|---|
| 0 | **nobody** — not the model | proceeds |
| 2 | the model | **BLOCKED** |
| other non-zero | the user only | proceeds |

So "advisory = exit 0 + write to stderr" is **structurally mute**, and that is
exactly what brainclaw's generated hook did for an unknown number of releases: even
once its other defects were fixed, it would still have spoken into the void. The
only non-blocking channel that reaches the model is JSON on **stdout** at exit 0:

```json
{ "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "additionalContext": "[brainclaw] Editing without an active claim of your own…" } }
```

If you write hooks of your own, this is the shape to copy.

### What it matches, and what it deliberately does not

The matcher is `Edit|Write|MultiEdit|NotebookEdit` — the tools whose `tool_input`
exposes a concrete file path. **`Bash` is excluded on purpose**: a shell command's
file footprint is not statically knowable, so it is `unverifiable`, never guessed.
Matching it was one source of the noise that made the pre-v1.19 hook worth ignoring.

Activation is non-destructive: unknown settings keys are preserved, a pre-existing
`PreToolUse` array is appended to rather than replaced, and a `settings.json` that
cannot be parsed is left **byte-identical** with a manual instruction printed —
that file holds your permission allow-list, and clobbering it would be far worse
than an unactivated advisory.

> **Spawned workers get no hooks.** `.claude/` is gitignored, so a dispatched
> worker's worktree never receives this hook (nor Codex's `.codex/hooks.json`).
> Lifecycle parity for dispatched lanes runs through the brief today — see
> trp#1277.

## Key idea

Claude Code should not carry all workspace state in static instructions.
brainclaw provides the living workspace layer through MCP plus local workflow guidance.
