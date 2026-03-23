# OpenClaw Integration

## Why brainclaw for OpenClaw users

OpenClaw's built-in memory (`MEMORY.md` + daily logs) is great for personal notes and preferences, but it doesn't distinguish between different types of project knowledge. After many conversations, constraints get buried, decisions lose their reasoning, and the agent drifts from its original instructions.

brainclaw adds a structured memory layer on top:

| Problem | OpenClaw alone | With brainclaw |
|---|---|---|
| "Don't deploy on Friday" gets forgotten | Buried in MEMORY.md after 50 conversations | Stored as a constraint, always visible |
| Agent repeats a known mistake | No trap system | Traps scored by relevance to current scope |
| Two agents work on same file | No coordination | Claims prevent collisions |
| Decision reasoning is lost | Mixed with daily notes | Preserved as typed decisions, searchable |

## How it works

brainclaw integrates as an OpenClaw **skill**. The skill instructs the agent to:

1. Load brainclaw project context before any coding work
2. Record constraints, traps, and decisions in brainclaw (not MEMORY.md)
3. Keep MEMORY.md for personal preferences and daily observations
4. Coordinate with other agents through plans and claims

## Installation

### Prerequisites

```bash
npm install -g brainclaw
```

### Install the skill

```bash
brainclaw enable-agent openclaw
```

This copies the brainclaw skill to `~/.openclaw/workspace/skills/brainclaw/`.

Or manually:

```bash
mkdir -p ~/.openclaw/workspace/skills/brainclaw
cp "$(npm root -g)/brainclaw/skills/openclaw/SKILL.md" ~/.openclaw/workspace/skills/brainclaw/
```

### Initialize a project

```bash
cd /path/to/your/project
brainclaw init
```

### Restart OpenClaw

```
/new
```

or restart the Gateway. The brainclaw skill will be loaded automatically.

## What the agent sees

After installation, your OpenClaw agent will:

- Run `brainclaw context` before project work to load constraints, traps, and plans
- Record rules you give it as brainclaw constraints (not just MEMORY.md entries)
- Record problems it discovers as traps (with severity)
- Log architectural decisions with their reasoning
- Clean up with `brainclaw session-end` when finished

## Memory split

The brainclaw skill establishes a clear split:

- **MEMORY.md** — your preferences, habits, personal context (OpenClaw manages this)
- **brainclaw** — project constraints, traps, decisions, plans (shared with all agents)

This means if you switch from OpenClaw to Claude Code or Codex for coding, the project memory follows — it's in `.brainclaw/`, not in `~/.openclaw/`.

## Multi-agent coordination

If you use both OpenClaw and a coding agent (Claude Code, Cursor, etc.) on the same project, brainclaw coordinates between them:

- OpenClaw records a constraint → Claude Code sees it at next session
- Claude Code claims a file scope → OpenClaw knows not to edit there
- Either agent creates a plan → both see it in their context

## Profile

When loading context for OpenClaw, use the `openclaw` profile for optimized scoring:

```bash
brainclaw context --profile openclaw
```

This boosts constraints, handoffs, and runtime notes — the items most relevant to an agent that might not be editing code directly but needs to understand the project state.
