# brainclaw

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
npx brainclaw init
npx brainclaw decision "OAuth migration now goes through auth-gateway" --tag auth
npx brainclaw constraint "Payments module frozen until 2026-04-01" --tag payments
npx brainclaw trap "Checkout E2E tests are flaky on Windows" --severity high
npx brainclaw handoff --from backend --to qa "Validate refund endpoint" --tag refunds
npx brainclaw status
```

## Commands

### `brainclaw init`

Creates the `.brainclaw/` project memory directory with `project.md`, `config.yaml`, and split state directories.

```bash
brainclaw init                                        # Initialize with interactive project-mode prompt
brainclaw init -y                                     # Use defaults (project_mode=auto)
brainclaw init -y --topology sidecar
brainclaw init --project-mode multi-project           # Explicit project mode
brainclaw init --project-mode multi-project --project-strategy folder
brainclaw init --force                                # Overwrite existing
brainclaw init --compact                              # Enable compact markdown mode
```

`init` can analyze the repository and recommend a project mode. The recommendation is advisory only.
When `--topology sidecar` or `--topology local-only` is used, `init` adds `.brainclaw/` to the project `.gitignore` so the code repository does not start tracking memory files by default.
It also seeds a stable `project_id` and a default current-agent identity so later operational commands can preserve provenance consistently.

### `brainclaw decision <text>`

Record a recent architecture, convention, or workflow decision.

```bash
brainclaw decision "New tests must use fixture v3" --tag tests --path tests/fixtures
brainclaw decision "OAuth goes through gateway" --author juan --tag auth --tag migration
```

### `brainclaw constraint <text>`

Declare an active constraint on the project.

```bash
brainclaw constraint "Payments module frozen until 2026-04-01" --tag payments --tag freeze
```

### `brainclaw trap <text>`

Document a known trap that wastes time.

```bash
brainclaw trap "Checkout E2E tests are flaky on Windows" --severity high --tag tests
brainclaw trap "Local dev requires VPN for auth service" --severity medium
brainclaw trap "Node is not on PATH on this Windows host" --visibility machine --tag windows --tag npm
```

Use `--visibility machine` for operational traps that are only valid on one host. These stay out of canonical shared memory until they are deliberately reflected and accepted.

### `brainclaw handoff <text>`

Create a passage de relais between people or agents.

```bash
brainclaw handoff --from backend --to qa "Validate new refund endpoint behavior"
brainclaw handoff --from juan --to codex-reviewer "Review migration patch" --tag review
brainclaw handoff --from copilot --to claude "Review auth patch" --plan pln_001
```

### `brainclaw status`

View the current state of project memory.

```bash
brainclaw status             # Human-readable summary
brainclaw status --json      # Machine-readable JSON
brainclaw status --markdown  # Full markdown output
```

`status` now reports visible runtime notes as `shared` plus `machine-local` for the current host.
It also reports the configured storage directory and topology mode.
When reputation is enabled, `status --json` also includes the current internal reputation snapshot.

### `brainclaw plan <text>`

Create a shared work item for collaborative execution.

```bash
brainclaw plan "Ship shared plan MVP"
brainclaw plan "Coordinate auth rollout" --priority high --assignee copilot --project auth
```

### `brainclaw list-plans`

List shared plan items.

```bash
brainclaw list-plans
brainclaw list-plans --status blocked --project auth
brainclaw list-plans --json --all
```

Plans become much more useful when paired with claims:

```bash
brainclaw claim "Taking auth rollout" --agent copilot --scope src/auth/ --plan pln_001
brainclaw list-claims --plan pln_001
```

### `brainclaw update-plan <id>`

Update the status or ownership of a shared plan item.

```bash
brainclaw update-plan pln_001 --status in_progress --assignee alice
brainclaw update-plan pln_001 --status done
```

### `brainclaw instruction <text>`

Create a layered shared instruction for all agents, one project, or one agent profile.

```bash
brainclaw instruction "Read project memory before edits"
brainclaw instruction "Use auth gateway conventions" --layer project --project auth
brainclaw instruction "Summarize blockers explicitly" --layer agent --agent openclaw
```

### `brainclaw list-instructions`

List raw instruction entries or the resolved instruction stack.

```bash
brainclaw list-instructions --active
brainclaw list-instructions --resolved --for auth/routes.ts --agent openclaw
brainclaw list-instructions --json --layer project --project auth
```

### `brainclaw register-agent <name>`

Register a durable human or agent identity in project memory.

```bash
brainclaw register-agent copilot --kind agent --set-current
brainclaw register-agent alice --kind human
```

Use `--set-current` to make future operational commands default to that identity when `--agent` is omitted.

### `brainclaw list-agents`

List registered identities and optionally include bounded trust summaries.

```bash
brainclaw list-agents
brainclaw list-agents --json
brainclaw list-agents --with-reputation
```

### `brainclaw doctor`

Health check: validates config, state, markdown sync, and scans for sensitive content.

```bash
brainclaw doctor
brainclaw doctor --json   # Machine-readable dashboard
```

`doctor` also warns when the last saved context marker is stale for the currently visible memory scope and reports machine-local trap counts.
When reputation is enabled, `doctor --json` also exposes high-level reputation metrics for automation and dashboards.

### `brainclaw rebuild`

Regenerate `project.md` from canonical memory state.

```bash
brainclaw rebuild
```

### `brainclaw review`

Review pending candidates with queue controls.

```bash
brainclaw review --prioritized
brainclaw review --for-curator curator-a --take 10
brainclaw review --for-curator curator-a --take 10 --claim curator-a
brainclaw review --only-overdue --json
```

When reputation is enabled, prioritized review can use author trust as a late tie-breaker only. Semantic relevance, freshness, and adoption signals still dominate queue ordering.

### `brainclaw star-candidate <id>`

Add an adoption signal to a pending candidate, similar to a lightweight star system.

```bash
brainclaw star-candidate cnd_001 --by copilot
brainclaw star-candidate cnd_001 --by claude
brainclaw review --prioritized
```

When a pending candidate reaches the configured star threshold, `review` and `doctor` mark it as promotion-worthy.

### `brainclaw use-candidate <id>`

Record that a candidate was actually reused in a concrete work context.

```bash
brainclaw use-candidate cnd_001 --by copilot --context "auth rollout plan"
brainclaw use-candidate cnd_001 --by claude --context "refund handoff"
```

Repeated usage is treated as a stronger promotion signal than passive interest alone.

### `brainclaw accept <id>`

Accept a candidate into canonical memory.

```bash
brainclaw accept cnd_001 --by curator-a
```

Accepted entries preserve reflective provenance so downstream context and MCP consumers can see where they came from.

### `brainclaw reject <id>`

Reject a candidate with explicit reviewer attribution.

```bash
brainclaw reject cnd_002 --by curator-a --reason "Too host-specific to promote"
```

Rejected candidates store the reviewer in `resolved_by` and the human rationale in `resolution_reason`.

### `brainclaw context`

Generate compact, prompt-ready context for agents.

```bash
brainclaw context --for auth
brainclaw context --for auth --digest
brainclaw context --for auth --explain
brainclaw context --for npm --host ci-runner-a
brainclaw context --for npm --all-hosts
brainclaw context --profile openclaw --template
brainclaw context --profile openclaw --template --compact-template
brainclaw context --agent copilot --json
brainclaw context --json
brainclaw context --json --max-chars 1200
```

`context --json` includes selection scores and reasons so agents can inspect why an item was ranked.
`context --digest` prepends a short deterministic summary with the highest-signal traps, constraints, decisions, and scoped runtime activity for the requested target.
`context --explain` surfaces those reasons in human-readable markdown output.
`context --max-chars` applies an approximate character budget after ranking, which is useful when preparing prompt-sized context.
When `--include-pending` is used, starred candidates get a small adoption boost in ranking.
Visible runtime notes are included in context retrieval. By default this means `shared` runtime notes plus `machine-local` notes from the current host only.
When a target path is provided, `context` also computes `scoped_activity` so agents can see the latest decision, latest trap, recent runtime notes, and pending candidates for that scope in both JSON and MCP responses.
When reputation is enabled, context can include a compact `resume_summary` for the current agent and may add a small explainable `reputation signal` bonus to provenance-backed items.

### `brainclaw runtime-note <text>`

Record an operational observation for an agent.

```bash
brainclaw runtime-note "Started auth rollout" --agent copilot
brainclaw runtime-note "Use auth gateway convention for new routes" --agent copilot --auto-reflect
brainclaw runtime-note "Node is not on PATH on this host" --agent copilot --visibility machine --tag windows --tag npm
brainclaw runtime-note "Scratch note for this agent only" --agent copilot --visibility private
```

Use `--visibility machine` for host-specific facts that should be shared with agents on the same machine but not synchronized by default.
`--auto-reflect` attempts to promote the note into durable memory immediately:
- `contributor` agents create a pending candidate
- `trusted` and `curator` agents can promote directly
- low-confidence notes stay as runtime-only observations with a skip reason

When no explicit `BRAINCLAW_SESSION_ID` is provided, brainclaw now creates and reuses an implicit local session in `.brainclaw/.current-session`. This lets CLI and MCP write flows preserve session continuity without extra setup.

### `brainclaw runtime-status`

Inspect visible runtime notes.

```bash
brainclaw runtime-status
brainclaw runtime-status --visibility machine
brainclaw runtime-status --visibility machine --all-hosts
brainclaw runtime-status --agent copilot --json
```

### `brainclaw reflect-runtime-note <id> [text]`

Turn a visible runtime note into a shared review candidate.

```bash
brainclaw reflect-runtime-note rtn_001
brainclaw reflect-runtime-note rtn_001 --suggest --json
brainclaw reflect-runtime-note rtn_001 --type trap
brainclaw reflect-runtime-note rtn_001 "On some Windows environments, validation should use the absolute Node binary when PATH is missing Node." --type trap --tag validation
brainclaw reflect-runtime-note rtn_001 --type decision --all-hosts
```

This is the intended bridge from machine-local operational memory to shared reflective review. Use the optional `[text]` override when you want to generalize a host-specific observation before sending it to the shared candidate queue.
When `--type` is omitted, the command returns ranked candidate-type suggestions instead of creating anything.

### `brainclaw adapter-openclaw-import`

Import OpenClaw runtime events into reflective candidates.

```bash
brainclaw adapter-openclaw-import ./openclaw-events.json
brainclaw adapter-openclaw-import --session sess_42
brainclaw adapter-openclaw-import ./openclaw-events.json --dry-run
```

More details: `docs/adapters/openclaw.md`.

### `brainclaw sync`

Summarize memory state and optionally create local Git commits.

```bash
brainclaw sync
brainclaw sync --summary-only
brainclaw sync --scope runtime --summary-only
brainclaw sync --scope runtime-local --summary-only
brainclaw sync --include-machine-runtime --commit
brainclaw sync --commit --message "chore: sync memory"
```

By default, `sync` includes shared runtime memory but excludes machine-local runtime storage. Use `--include-machine-runtime` or `--scope runtime-local` only when you explicitly want to move host-specific runtime memory.

### MCP collaboration board

The MCP server exposes both ranked memory context and an agent collaboration board.

Tool names:

- `bclaw_get_context`
- `bclaw_write_note`
- `bclaw_read_handoff`
- `bclaw_get_agent_board`

`bclaw_get_context` accepts `digest: true` and returns both `digest` and `scoped_activity` in `structuredContent`.
`bclaw_write_note` accepts `autoReflect: true` and returns `session_id`, `auto_reflect_attempted`, `candidate_id`, `promoted_item_id`, and `skip_reason` when relevant.
When no explicit session is supplied through the environment, the MCP server reuses one implicit session per stdio connection for write operations.

Board consumers can explicitly request bounded trust summaries with `includeReputation` when reputation is enabled and MCP exposure is allowed.

### `brainclaw agent-board`

Show the same coordination snapshot locally without going through MCP.

```bash
brainclaw agent-board --agent copilot --project auth
brainclaw agent-board --agent copilot --host ci-runner-a
brainclaw agent-board --agent copilot --all-hosts
brainclaw agent-board --agent copilot --with-reputation
brainclaw agent-board --for auth/routes.ts --json
```

`agent-board --with-reputation` adds an aggregate summary plus the selected agent's bounded public trust summary.

### `brainclaw release-claim <id>`

Release a claim and optionally advance the linked plan status.

```bash
brainclaw release-claim clm_001
brainclaw release-claim clm_001 --plan-status done
brainclaw release-claim clm_001 --plan-status blocked
```

## Reputation and trust signals

brainclaw does not implement a vanity leaderboard or a mutable points ledger. Reputation is a recomputable, bounded trust signal intended to help with review routing, context ranking, and mono-agent continuity.

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

- **Local-first** — everything lives in `.brainclaw/` inside the project. No server, no cloud.
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

- `<storage_dir>` is `.brainclaw/`.
- Canonical memory is stored as one JSON file per entity inside the split state directories.
- `project.md` is auto-generated from canonical memory on every write. Include it in your agent context.
- `config.yaml` controls storage topology, identity defaults, redaction patterns, reputation settings, and display behavior.

## Security

brainclaw is designed to be safe by default:

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

Replace `<storage_dir>` with `.brainclaw`.

### GitHub Custom Agents

Reference `.brainclaw/project.md` in your custom agent prompts stored in `.github/agents/` or at org/enterprise level.

### Claude Code

Add to your project instructions (`.claude/settings.json` or project hook):

```
Before starting work, read .brainclaw/project.md for active constraints, recent decisions, and open handoffs.
```

The path is always `.brainclaw/project.md`.

### Copilot Memory vs brainclaw

| | Copilot Memory | brainclaw |
|---|---|---|
| Control | Implicit, managed by GitHub | Explicit, managed by your team |
| Storage | GitHub cloud, repo-specific | Local configured storage dir in your project |
| Expiration | Auto-expires after 28 days | Persists until you remove it |
| Visibility | Via GitHub policy/settings | Plain text in Git |
| Versioning | No | Full Git history |

They're complementary: Copilot Memory captures implicit patterns; brainclaw captures explicit team decisions, constraints, and handoffs.

## Running tests

```bash
npm test
npm run test:unit
npm run test:smoke
npm run test:e2e
npm run test:all
npm run test:coverage
npm run test:coverage:check
```

`npm test` runs the fast path only: unit tests plus a small CLI smoke test.
The heavier spawn/MCP suites are kept behind `test:e2e` so routine validation stays quick and bounded.
`test:coverage` runs the same fast path under `c8` and emits a text summary plus an `lcov` report.
`test:coverage:check` enforces the current minimum global floor on that fast path.

## Alias

The CLI is also available as `bclaw`:

```bash
bclaw init
bclaw status
```

## License

MIT
