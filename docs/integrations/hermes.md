# Hermes Agent

brainclaw integrates with **Hermes Agent** through its native MCP client and
skill system. Hermes is treated as a Tier B autonomous agent today: MCP + the
universal `.agents/skills/brainclaw/SKILL.md` skill, without Brainclaw-managed
session hooks until a dedicated Hermes plugin is implemented and validated.

## Surfaces

- `~/.hermes/config.yaml` — machine-level Hermes config with the Brainclaw MCP
  server under `mcp_servers.brainclaw`.
- `.agents/skills/brainclaw/SKILL.md` — universal Brainclaw skill. Hermes can
  use this alongside its own `~/.hermes/skills/` skills.
- `AGENTS.md` — stable project instructions for shared coding-agent workflows.

## Setup

```bash
brainclaw setup-machine --agents hermes --yes
brainclaw enable-agent hermes
```

The machine setup writes `~/.hermes/config.yaml`. The project enable step writes
the universal Brainclaw skill into `.agents/skills/brainclaw/SKILL.md` and
adds the project `.agents/skills` directory to Hermes `skills.external_dirs`.

The generated MCP entry is intentionally filtered to the facade and canonical
grammar tools:

```yaml
skills:
  external_dirs:
    - /path/to/project/.agents/skills

mcp_servers:
  brainclaw:
    command: node
    args: [/path/to/brainclaw/dist/cli.js, mcp]
    env:
      BRAINCLAW_AGENT: hermes
    tools:
      include:
        - bclaw_work
        - bclaw_context
        - bclaw_find
        - bclaw_get
        - bclaw_create
        - bclaw_update
        - bclaw_transition
      prompts: false
      resources: false
```

## Memory Boundary

Hermes skills are procedural memory: reusable ways to perform work. Brainclaw
memory is coordination memory: plans, claims, decisions, constraints, traps,
handoffs, candidates, and runtime notes.

When Hermes learns a reusable technique, it can create or update a Hermes skill.
When Hermes discovers project state that affects other agents, it should write
to Brainclaw through `bclaw_create` or `bclaw_update`.

## Caveats

- Hermes plugin hooks are not configured by Brainclaw yet. Session start still
  depends on the skill/instruction contract: call `bclaw_work(intent=...)`
  before significant work.
- Hermes should not be added to high-trust dispatch allowlists until its
  lifecycle behavior is validated: brief acknowledgement, MCP write reliability,
  and `bclaw_assignment_update(status="completed")`.
- The machine-level config does not set `BRAINCLAW_CWD`; Hermes should run from
  the project directory or rely on Brainclaw project switching.

## References

- [Hermes Agent documentation](https://hermes-agent.nousresearch.com/docs/)
- [Hermes Agent GitHub repository](https://github.com/NousResearch/hermes-agent)
