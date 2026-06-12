# Skills — agent-profile vs workflow-protocol

Brainclaw writes two orthogonal kinds of agent skill. The same agent can load
both; they answer different questions.

## Agent-profile skills

The agent's **landing page** for brainclaw — one per agent profile
(`openclaw`, `nanoclaw`, `nemoclaw`, `picoclaw`, `zeroclaw`) plus the universal
`.agents/skills/brainclaw/SKILL.md` discovered by every agent that honors the
shared `.agents/skills/` convention (Cursor, Copilot, Roo, OpenCode, Codex,
Kilo, Mistral…). It answers *"what is brainclaw and how do I load context here?"*
and points at `bclaw_work` as the entry verb.

Source: `src/core/agent-files.ts` (`ensureUniversalBrainclawSkill`, the per-profile
writers). These files are **generated, not committed** — they are gitignored and
materialized by `brainclaw export` / setup, so the source of truth is the code,
never a checked-in `SKILL.md`.

## Workflow-protocol skills (pln#519)

**Workflow-decomposed** skills that package a critical brainclaw protocol so the
agent loads *the right one at the right moment* instead of skimming a monolithic
AGENTS.md. Three ship today, namespaced `brainclaw-*`:

| Skill | Trigger |
|---|---|
| `brainclaw-session` | starting / resuming / closing a session; before claiming a scope |
| `brainclaw-memory-capture` | recording a decision / constraint / trap / handoff at the right type |
| `brainclaw-multi-agent` | delegating, reviewing, dispatching, driving a loop |

They carry `metadata.protocol: true` in frontmatter so skill-loader UIs can list
protocols separately from profile skills, and `metadata.brainclaw_version` (set
to `package.json:version` at write time) so a loader can detect a cached skill
that predates a brainclaw upgrade. Each follows the "process not prose" shape:
**When to use → Workflow → Anti-rationalizations → Red flags → Verification**.

Source: `src/core/protocol-skills.ts` (single source of truth; content is
embedded, not read from a repo file, so it installs identically from source or
an npm install). Written to `.agents/skills/<id>/SKILL.md` by
`ensureProtocolSkills`, wired into `writeDetectedAgentAutoConfig` for every agent
whose capability profile declares `hasSkills: true`. Generated + gitignored, like
the profile skills.

### Design invariants

- **No dynamic state.** A protocol-skill never embeds a concrete `claim_id` /
  `loop_id` / `plan_id` — it tells the agent *when* to call a facade and *how to
  read* live state, never *what the current state is*. (Enforced by a test.)
- **Facade-only.** Skills reference canonical-grammar / facade verbs by name;
  they never re-implement `mcp.ts` logic. A protocol change updates the skill,
  not the other way round.
- **Both MCP and CLI.** Each workflow shows the MCP call AND the `brainclaw …`
  CLI fallback, because MCP is not always wired (cold start; a dispatched worker
  in a worktree without `.brainclaw/`, trp#336).
- **Capped at 3.** Setup and troubleshooting protocols are deferred until an
  empirical friction shows the three are insufficient (design §E.2). A 4th
  protocol needs a runtime_note documenting the gap it closes.

## Namespace claim

Brainclaw owns the `brainclaw-*` prefix under `.agents/skills/`. Other tools that
install skills into the shared directory must avoid `brainclaw-` ids to prevent
collisions.

## Supply chain

Protocol-skills ship **inside the npm package**. Brainclaw does **not** currently
support installing external skills (no `brainclaw skill install <url>`, no loading
from arbitrary paths). If external installs are ever added they will require a
deliberate trust boundary (local-only or brainclaw-signed); that is out of scope
today.

## Staleness

If `brainclaw --version` reports newer than a skill's `brainclaw_version`,
re-run `brainclaw export --all --write` to regenerate. The version tag lets a
caching loader detect drift; it does not self-heal.
