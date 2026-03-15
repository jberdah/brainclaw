# Team Memory

**Shared project memory for humans and coding agents.**

A lightweight, local-first CLI that gives your team and your coding agents a shared, structured view of your project's active constraints, recent decisions, known traps, and open handoffs — versioned in Git, readable in plain text, usable with any agent.

It also acts as an agent coordination layer: shared plans, explicit ownership claims, layered instructions, stable project and agent identity, reflective review workflows, and MCP-readable collaboration views.

## Installation

```bash
npm install
npm run build
```

## Quickstart

```bash
npx team-memory init
npx team-memory decision "OAuth migration now goes through auth-gateway" --tag auth
npx team-memory constraint "Payments module frozen until 2026-04-01" --tag payments
npx team-memory trap "Checkout E2E tests are flaky on Windows" --severity high
npx team-memory handoff --from backend --to qa "Validate refund endpoint" --tag refunds
npx team-memory status
```

## Commands

### `team-memory init`

Creates a project memory directory with `project.md`, `config.yaml`, and split state directories. The legacy default remains `.memory/`, and `.brainclaw/` is now available as an opt-in storage directory for sidecar-oriented setups.

```bash
team-memory init                                        # Initialize with interactive project-mode prompt
team-memory init -y                                     # Use defaults (project_mode=auto)
team-memory init -y --storage-dir .brainclaw            # Opt in to the new storage directory name
team-memory init -y --storage-dir .brainclaw --topology sidecar
team-memory init --project-mode multi-project           # Explicit project mode
team-memory init --project-mode multi-project --project-strategy folder
team-memory init --force                                # Overwrite existing
team-memory init --compact                              # Enable compact markdown mode
```

`init` can analyze the repository and recommend a project mode. The recommendation is advisory only.
When `--topology sidecar` or `--topology local-only` is used, `init` currently adds the chosen storage directory to the project `.gitignore` so the code repository does not start tracking memory files by default.
It also seeds a stable `project_id` and a default current-agent identity so later operational commands can preserve provenance consistently.

### `team-memory decision <text>`

Record a recent architecture, convention, or workflow decision.

```bash
team-memory decision "New tests must use fixture v3" --tag tests --path tests/fixtures
team-memory decision "OAuth goes through gateway" --author juan --tag auth --tag migration
```

### `team-memory constraint <text>`

Declare an active constraint on the project.

```bash
team-memory constraint "Payments module frozen until 2026-04-01" --tag payments --tag freeze
```

### `team-memory trap <text>`

Document a known trap that wastes time.

```bash
team-memory trap "Checkout E2E tests are flaky on Windows" --severity high --tag tests
team-memory trap "Local dev requires VPN for auth service" --severity medium
team-memory trap "Node is not on PATH on this Windows host" --visibility machine --tag windows --tag npm
```

Use `--visibility machine` for operational traps that are only valid on one host. These stay out of canonical shared memory until they are deliberately reflected and accepted.

### `team-memory handoff <text>`

Create a passage de relais between people or agents.

```bash
team-memory handoff --from backend --to qa "Validate new refund endpoint behavior"
team-memory handoff --from juan --to codex-reviewer "Review migration patch" --tag review
team-memory handoff --from copilot --to claude "Review auth patch" --plan pln_001
```

### `team-memory status`

View the current state of project memory.

```bash
team-memory status             # Human-readable summary
team-memory status --json      # Machine-readable JSON
team-memory status --markdown  # Full markdown output
```

`status` now reports visible runtime notes as `shared` plus `machine-local` for the current host.
It also reports the configured storage directory and topology mode.
When reputation is enabled, `status --json` also includes the current internal reputation snapshot.

### `team-memory plan <text>`

Create a shared work item for collaborative execution.

```bash
team-memory plan "Ship shared plan MVP"
team-memory plan "Coordinate auth rollout" --priority high --assignee copilot --project auth
```

### `team-memory list-plans`

List shared plan items.

```bash
team-memory list-plans
team-memory list-plans --status blocked --project auth
team-memory list-plans --json --all
```

Plans become much more useful when paired with claims:

```bash
team-memory claim "Taking auth rollout" --agent copilot --scope src/auth/ --plan pln_001
team-memory list-claims --plan pln_001
```

### `team-memory update-plan <id>`

Update the status or ownership of a shared plan item.

```bash
team-memory update-plan pln_001 --status in_progress --assignee alice
team-memory update-plan pln_001 --status done
```

### `team-memory instruction <text>`

Create a layered shared instruction for all agents, one project, or one agent profile.

```bash
team-memory instruction "Read project memory before edits"
team-memory instruction "Use auth gateway conventions" --layer project --project auth
team-memory instruction "Summarize blockers explicitly" --layer agent --agent openclaw
```

### `team-memory list-instructions`

List raw instruction entries or the resolved instruction stack.

```bash
team-memory list-instructions --active
team-memory list-instructions --resolved --for auth/routes.ts --agent openclaw
team-memory list-instructions --json --layer project --project auth
```

### `team-memory register-agent <name>`

Register a durable human or agent identity in project memory.

```bash
team-memory register-agent copilot --kind agent --set-current
team-memory register-agent alice --kind human
```

Use `--set-current` to make future operational commands default to that identity when `--agent` is omitted.

### `team-memory list-agents`

List registered identities and optionally include bounded trust summaries.

```bash
team-memory list-agents
team-memory list-agents --json
team-memory list-agents --with-reputation
```

### `team-memory doctor`

Health check: validates config, state, markdown sync, and scans for sensitive content.

```bash
team-memory doctor
team-memory doctor --json   # Machine-readable dashboard
```

`doctor` also warns when the last saved context marker is stale for the currently visible memory scope and reports machine-local trap counts.
When reputation is enabled, `doctor --json` also exposes high-level reputation metrics for automation and dashboards.

### `team-memory rebuild`

Regenerate `project.md` from canonical memory state.

```bash
team-memory rebuild
```

### `team-memory review`

Review pending candidates with queue controls.

```bash
team-memory review --prioritized
team-memory review --for-curator curator-a --take 10
team-memory review --for-curator curator-a --take 10 --claim curator-a
team-memory review --only-overdue --json
```

When reputation is enabled, prioritized review can use author trust as a late tie-breaker only. Semantic relevance, freshness, and adoption signals still dominate queue ordering.

### `team-memory star-candidate <id>`

Add an adoption signal to a pending candidate, similar to a lightweight star system.

```bash
team-memory star-candidate cnd_001 --by copilot
team-memory star-candidate cnd_001 --by claude
team-memory review --prioritized
```

When a pending candidate reaches the configured star threshold, `review` and `doctor` mark it as promotion-worthy.

### `team-memory use-candidate <id>`

Record that a candidate was actually reused in a concrete work context.

```bash
team-memory use-candidate cnd_001 --by copilot --context "auth rollout plan"
team-memory use-candidate cnd_001 --by claude --context "refund handoff"
```

Repeated usage is treated as a stronger promotion signal than passive interest alone.

### `team-memory accept <id>`

Accept a candidate into canonical memory.

```bash
team-memory accept cnd_001 --by curator-a
```

Accepted entries preserve reflective provenance so downstream context and MCP consumers can see where they came from.

### `team-memory reject <id>`

Reject a candidate with explicit reviewer attribution.

```bash
team-memory reject cnd_002 --by curator-a --reason "Too host-specific to promote"
```

Rejected candidates store the reviewer in `resolved_by` and the human rationale in `resolution_reason`.

### `team-memory context`

Generate compact, prompt-ready context for agents.

```bash
team-memory context --for auth
team-memory context --for auth --explain
team-memory context --for npm --host ci-runner-a
team-memory context --for npm --all-hosts
team-memory context --profile openclaw --template
team-memory context --profile openclaw --template --compact-template
team-memory context --agent copilot --json
team-memory context --json
team-memory context --json --max-chars 1200
```

`context --json` includes selection scores and reasons so agents can inspect why an item was ranked.
`context --explain` surfaces those reasons in human-readable markdown output.
`context --max-chars` applies an approximate character budget after ranking, which is useful when preparing prompt-sized context.
When `--include-pending` is used, starred candidates get a small adoption boost in ranking.
Visible runtime notes are included in context retrieval. By default this means `shared` runtime notes plus `machine-local` notes from the current host only.
When reputation is enabled, context can include a compact `resume_summary` for the current agent and may add a small explainable `reputation signal` bonus to provenance-backed items.

### `team-memory runtime-note <text>`

Record an operational observation for an agent.

```bash
team-memory runtime-note "Started auth rollout" --agent copilot
team-memory runtime-note "Node is not on PATH on this host" --agent copilot --visibility machine --tag windows --tag npm
team-memory runtime-note "Scratch note for this agent only" --agent copilot --visibility private
```

Use `--visibility machine` for host-specific facts that should be shared with agents on the same machine but not synchronized by default.

### `team-memory runtime-status`

Inspect visible runtime notes.

```bash
team-memory runtime-status
team-memory runtime-status --visibility machine
team-memory runtime-status --visibility machine --all-hosts
team-memory runtime-status --agent copilot --json
```

### `team-memory reflect-runtime-note <id> [text]`

Turn a visible runtime note into a shared review candidate.

```bash
team-memory reflect-runtime-note rtn_001
team-memory reflect-runtime-note rtn_001 --suggest --json
team-memory reflect-runtime-note rtn_001 --type trap
team-memory reflect-runtime-note rtn_001 "On some Windows environments, validation should use the absolute Node binary when PATH is missing Node." --type trap --tag validation
team-memory reflect-runtime-note rtn_001 --type decision --all-hosts
```

This is the intended bridge from machine-local operational memory to shared reflective review. Use the optional `[text]` override when you want to generalize a host-specific observation before sending it to the shared candidate queue.
When `--type` is omitted, the command returns ranked candidate-type suggestions instead of creating anything.

### `team-memory adapter-openclaw-import`

Import OpenClaw runtime events into reflective candidates.

```bash
team-memory adapter-openclaw-import ./openclaw-events.json
team-memory adapter-openclaw-import --session sess_42
team-memory adapter-openclaw-import ./openclaw-events.json --dry-run
```

More details: `docs/adapters/openclaw.md`.

### `team-memory sync`

Summarize memory state and optionally create local Git commits.

```bash
team-memory sync
team-memory sync --summary-only
team-memory sync --scope runtime --summary-only
team-memory sync --scope runtime-local --summary-only
team-memory sync --include-machine-runtime --commit
team-memory sync --commit --message "chore: sync memory"
```

By default, `sync` includes shared runtime memory but excludes machine-local runtime storage. Use `--include-machine-runtime` or `--scope runtime-local` only when you explicitly want to move host-specific runtime memory.

### MCP collaboration board

The MCP server exposes both ranked memory context and an agent collaboration board.

Tool names:

- `tmem_get_context`
- `tmem_read_handoff`
- `tmem_get_agent_board`

Board consumers can explicitly request bounded trust summaries with `includeReputation` when reputation is enabled and MCP exposure is allowed.

### `team-memory agent-board`

Show the same coordination snapshot locally without going through MCP.

```bash
team-memory agent-board --agent copilot --project auth
team-memory agent-board --agent copilot --host ci-runner-a
team-memory agent-board --agent copilot --all-hosts
team-memory agent-board --agent copilot --with-reputation
team-memory agent-board --for auth/routes.ts --json
```

`agent-board --with-reputation` adds an aggregate summary plus the selected agent's bounded public trust summary.

### `team-memory release-claim <id>`

Release a claim and optionally advance the linked plan status.

```bash
team-memory release-claim clm_001
team-memory release-claim clm_001 --plan-status done
team-memory release-claim clm_001 --plan-status blocked
```

## Reputation and trust signals

Team Memory does not implement a vanity leaderboard or a mutable points ledger. Reputation is a recomputable, bounded trust signal intended to help with review routing, context ranking, and mono-agent continuity.

- Quality matters more than volume.
- Review participation matters, but does not overrule semantic relevance.
- Scores are derived from recent observable behavior inside the configured window.
- Public surfaces stay summary-oriented and opt-in.

The current model tracks three subscores:

- `contribution_quality`
- `review_reliability`
- `continuity_hygiene`

These feed an internal bounded score named `internal_trust`.

Minimal configuration example:

```yaml
reputation:
  enabled: true
  visibility: summary
  decay_days: 30
  ranking_weight: 0.15
  resume_weight: 0.35
  mcp_exposure: true
```

Operational notes:

- `status --json` exposes the internal snapshot for local tooling when reputation is enabled.
- `context` can emit a current-agent `resume_summary` and a small explainable ranking bonus.
- `list-agents --with-reputation` and `agent-board --with-reputation` expose bounded summaries rather than raw internal ledgers.
- `doctor --json` exposes only high-level reputation metrics.
- MCP board consumers must opt in with `includeReputation`. Teams that want an explicit policy marker for this can also set `reputation.mcp_exposure: true` in `config.yaml`.

## Philosophy

- **Local-first** — everything lives in your configured storage directory inside the project, typically `.memory/` or `.brainclaw/`. No server, no cloud.
- **No telemetry** — zero network calls, zero data collection. Ever.
- **Git-friendly** — plain text files that diff, merge, and commit cleanly.
- **Agent-agnostic** — works with Codex, Claude Code, Cursor, Copilot, or any tool that reads files.
- **Readable-first** — `project.md` is human-readable, machine-readable, and the canonical context for agents.
- **Reversible** — delete the configured storage directory and the system is fully removed. No traces left.

## How it works

```
<storage_dir>/
  project.md     ← Human & agent readable view (auto-generated)
  config.yaml    ← Project configuration
  instructions/  ← Layered shared instructions
  plans/         ← Shared plan items
  constraints/   ← Canonical constraint entries
  decisions/     ← Canonical decision entries
  traps/         ← Canonical trap entries
  handoffs/      ← Canonical handoff entries
```

- `<storage_dir>` is usually `.memory/`, but can also be `.brainclaw/` or another configured path.
- Canonical memory is stored as one JSON file per entity inside the split state directories.
- `project.md` is auto-generated from canonical memory on every write. Include it in your agent context.
- `config.yaml` controls storage topology, identity defaults, redaction patterns, reputation settings, and display behavior.

## Security

Team Memory is designed to be safe by default:

- **No network access** — the CLI never connects to the internet.
- **No telemetry** — nothing is collected or sent anywhere.
- **No secret management** — this is not a vault. Don't store secrets.
- **Redaction warnings** — adding text that matches patterns like `api_key`, `secret`, `token`, or `password` triggers a warning.
- **Sensitive path warnings** — mentioning paths like `.env` or `secrets/` triggers a warning.
- **Your responsibility** — review what gets committed. The tool warns, your team decides.

Redaction behavior is configurable in `config.yaml`:

```yaml
security:
  mode: warn              # 'warn' or 'strict'
  strict_redaction: false  # if true, blocks entries with sensitive content
  block_sensitive_paths: true
```

## Integration with coding agents

### AGENTS.md

Add this section to your `AGENTS.md`:

```markdown
## Shared project memory
Read `<storage_dir>/project.md` before making significant changes or handing off work.
```

Replace `<storage_dir>` with the directory chosen at `init` time.

### GitHub Custom Agents

Reference `<storage_dir>/project.md` in your custom agent prompts stored in `.github/agents/` or at org/enterprise level.

### Claude Code

Add to your project instructions (`.claude/settings.json` or project hook):

```
Before starting work, read .memory/project.md for active constraints, recent decisions, and open handoffs.
```

If you initialized the project with `.brainclaw/` or another storage directory, update the path accordingly.

### Copilot Memory vs Team Memory

| | Copilot Memory | Team Memory |
|---|---|---|
| Control | Implicit, managed by GitHub | Explicit, managed by your team |
| Storage | GitHub cloud, repo-specific | Local configured storage dir in your project |
| Expiration | Auto-expires after 28 days | Persists until you remove it |
| Visibility | Via GitHub policy/settings | Plain text in Git |
| Versioning | No | Full Git history |

They're complementary: Copilot Memory captures implicit patterns; Team Memory captures explicit team decisions, constraints, and handoffs.

## Running tests

```bash
npm test
```

## Alias

The CLI is also available as `tmem`:

```bash
tmem init
tmem status
```

## License

MIT
