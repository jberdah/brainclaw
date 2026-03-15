# CLI Reference

Commands grouped by purpose.

## Initialize and inspect

### `brainclaw init`
Initialize workspace state. Detects AI agent environment and writes to its native instruction file.

```bash
brainclaw init
brainclaw init -y                     # Non-interactive, use defaults
brainclaw init --force                # Overwrite existing
brainclaw init --topology sidecar     # Store outside the repo
brainclaw init --project-mode multi-project --project-strategy folder
```

### `brainclaw status`
Show the current state of project memory.

```bash
brainclaw status
brainclaw status --json
brainclaw status --markdown
```

### `brainclaw doctor`
Run health checks on config, state, and generated views.

```bash
brainclaw doctor
brainclaw doctor --json
```

### `brainclaw rebuild`
Regenerate `project.md` from canonical state.

### `brainclaw sync`
Summarize memory state and optionally create local Git commits.

```bash
brainclaw sync --commit --message "chore: sync memory"
```

## Memory commands

### `brainclaw decision <text>`
Record a durable decision.

```bash
brainclaw decision "OAuth goes through auth-gateway" --tag auth
brainclaw decision "New tests must use fixture v3" --tag tests --path tests/fixtures
```

### `brainclaw constraint <text>`
Record an active constraint.

```bash
brainclaw constraint "Payments module frozen until 2026-04-01" --tag payments
```

### `brainclaw trap <text>`
Record a known trap.

```bash
brainclaw trap "Checkout E2E tests are flaky on Windows" --severity high --tag tests
brainclaw trap "Local dev requires VPN for auth service" --severity medium
brainclaw trap "Node is not on PATH on this host" --visibility machine --tag windows
```

### `brainclaw handoff <text>`
Create an explicit handoff between humans or agents.

```bash
brainclaw handoff --from backend --to qa "Validate new refund endpoint"
brainclaw handoff --from copilot --to claude "Review auth patch" --plan pln_001
```

### `brainclaw instruction <text>`
Create a layered shared instruction.

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
```

## Planning and coordination

### `brainclaw plan <text>`
Create a shared work item.

```bash
brainclaw plan "Coordinate auth rollout" --priority high --assignee copilot
```

### `brainclaw list-plans`
List plan items.

```bash
brainclaw list-plans
brainclaw list-plans --status blocked --project auth
brainclaw list-plans --json --all
```

### `brainclaw update-plan <id>`
Update plan status or ownership.

```bash
brainclaw update-plan pln_001 --status done
brainclaw update-plan pln_001 --status in_progress --assignee alice
```

### `brainclaw claim <text>`
Claim ownership over a file, folder, or scope.

```bash
brainclaw claim "Taking auth rollout" --agent copilot --scope src/auth/ --plan pln_001
```

### `brainclaw release-claim <id>`
Release a claim and optionally advance the linked plan status.

```bash
brainclaw release-claim clm_001
brainclaw release-claim clm_001 --plan-status done
```

### `brainclaw agent-board`
Display a coordination snapshot.

```bash
brainclaw agent-board --agent copilot --project auth
brainclaw agent-board --for src/auth/routes.ts --json
```

## Export

### `brainclaw export`
Export memory as a native agent instruction file.

```bash
brainclaw export --detect                        # Auto-detect running agent, write to its native file
brainclaw export --format copilot-instructions --write   # .github/copilot-instructions.md
brainclaw export --format claude-md --write              # CLAUDE.md
brainclaw export --format cursor-rules --write           # .cursor/rules/brainclaw.md
brainclaw export --format windsurf --write               # .windsurfrules
brainclaw export --format cline --write                  # .clinerules/brainclaw.md
brainclaw export --format agents-md --write              # AGENTS.md
brainclaw export --format roo --write                    # .roo/rules/brainclaw.md
brainclaw export --format continue --write               # .continue/rules/brainclaw.md
brainclaw export --format claude-md                      # stdout
```

## Runtime and reflection

### `brainclaw runtime-note <text>`
Record an operational observation.

```bash
brainclaw runtime-note "Started auth rollout" --agent copilot
brainclaw runtime-note "Node not on PATH on this host" --visibility machine
brainclaw runtime-note "Use auth gateway for new routes" --auto-reflect
```

### `brainclaw runtime-status`
Inspect visible runtime notes.

```bash
brainclaw runtime-status
brainclaw runtime-status --visibility machine --all-hosts
```

### `brainclaw reflect-runtime-note <id>`
Turn a runtime note into a shared review candidate.

```bash
brainclaw reflect-runtime-note rtn_001
brainclaw reflect-runtime-note rtn_001 "Generalized description" --type trap
```

### `brainclaw review`
Review pending candidates.

```bash
brainclaw review --prioritized
brainclaw review --for-curator curator-a --take 10 --claim curator-a
```

### `brainclaw accept <id>` / `brainclaw reject <id>`
Accept or reject a candidate.

```bash
brainclaw accept cnd_001 --by curator-a
brainclaw reject cnd_002 --by curator-a --reason "Too host-specific"
```

## Identity and context

### `brainclaw register-agent <name>`
Register a durable human or agent identity.

```bash
brainclaw register-agent copilot --kind agent --set-current
```

### `brainclaw list-agents`
List registered identities.

```bash
brainclaw list-agents --json
```

### `brainclaw context`
Generate compact, prompt-ready context for agents.

```bash
brainclaw context --for src/auth/routes.ts --digest
brainclaw context --json --max-chars 1200
brainclaw context --explain
```

## Adapters

### `brainclaw adapter-openclaw-import`
Import OpenClaw runtime events into reflective candidates.

```bash
brainclaw adapter-openclaw-import ./openclaw-events.json --dry-run
brainclaw adapter-openclaw-import --session sess_42
```

See [adapters/openclaw.md](adapters/openclaw.md).
