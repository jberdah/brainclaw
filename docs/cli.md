# CLI Reference

Commands grouped by purpose. All commands are available as `brainclaw` or its alias `bclaw`.

---

## Initialize and Inspect

### `brainclaw setup`

Global onboarding wizard — detects AI agents, installs global Brainclaw prerequisites, installs agent/MCP config, gitignores generated workspace-local integration files, and initialises multiple repositories in one pass. This is the required machine-level bootstrap before `brainclaw init`. It scans each root itself plus its direct child repositories, and ignores internal Brainclaw memory repos such as `.brainclaw/`.

| Option | Description |
|---|---|
| `--roots <paths>` | Comma-separated root directories to scan for git repos (skips interactive prompt) |
| `--agents <agents>` | Agents to configure: `all`, `detected`, or comma-separated names (e.g. `claude-code,cursor`) |
| `--repos <mode>` | Repo selection: `all`, `current`, or comma-separated numbers (e.g. `1,3`) |
| `-y, --yes` | Accept all defaults non-interactively |

```bash
brainclaw setup                                         # interactive wizard
brainclaw setup --yes                                   # non-interactive, detected agent, current dir
brainclaw setup --roots ~/Projects --agents detected    # scan ~/Projects, configure detected agent only
brainclaw setup --roots ~/Projects,~/work --agents all  # all agents, multiple roots
```

**MCP usage (agent-driven):** Use `bclaw_setup` with the resume pattern — call without `step` to start, then pass `step` + `choice` to advance through each stage (`project_roots` → `repo_selection` → `agent_selection`).

---

### `brainclaw init`

Initialize workspace state for the current project root. Detects the AI agent environment and writes to its native instruction file. `brainclaw setup` must have been run first on this machine. Do not run `init` from inside `.brainclaw/`; that directory is Brainclaw's own memory store, not a project root.

| Option | Description |
|---|---|
| `-y, --yes` | Non-interactive, accept all defaults |
| `--force` | Overwrite existing initialization |
| `--compact` | Generate a compact instruction file |
| `--topology <value>` | Storage topology (e.g. `sidecar` to store outside the repo) |
| `--project-mode <value>` | Project mode (e.g. `multi-project`) |
| `--project-strategy <value>` | Project strategy (e.g. `folder`) |
| `--no-analyze-repo` | Skip automatic repository analysis |
| `--scan` | Scan repository for existing conventions |

```bash
brainclaw init
brainclaw init -y
brainclaw init --force
brainclaw init --topology sidecar
brainclaw init --project-mode multi-project --project-strategy folder
```

### `brainclaw status`

Show the current state of project memory.

| Option | Description |
|---|---|
| `--json` | Output as JSON |
| `--markdown` | Output as Markdown |

```bash
brainclaw status
brainclaw status --json
brainclaw status --markdown
```

### `brainclaw doctor`

Run health checks on config, state, and generated views.

| Option | Description |
|---|---|
| `--json` | Output as JSON |
| `--migration-check` | Check for pending migrations |

```bash
brainclaw doctor
brainclaw doctor --json
brainclaw doctor --migration-check
```

### `brainclaw rebuild`

Regenerate `project.md` from canonical state. No options.

```bash
brainclaw rebuild
```

### `brainclaw bootstrap`

Bootstrap shared memory for a new agent or project context.

| Option | Description |
|---|---|
| `--for <agent>` | Target agent name |
| `--json` | Output as JSON |
| `--refresh` | Force refresh even if bootstrap data is recent |

```bash
brainclaw bootstrap --for copilot
brainclaw bootstrap --for claude --refresh --json
```

### `brainclaw env`

Display environment and tooling detection information.

| Option | Description |
|---|---|
| `--json` | Output as JSON |
| `--agent-tooling` | Show detected agent tooling details |

```bash
brainclaw env
brainclaw env --json
brainclaw env --agent-tooling
```

---

## Memory Management

### `brainclaw memory create <type> <text>`

Create a canonical memory item. Supported types are `decision`, `constraint`, `trap`, and `handoff`.

| Option | Description |
|---|---|
| `--tag <tag>` | Tag for categorization (repeatable) |
| `--path <path>` | Scope to a file or folder path |
| `--author <name>` | Author name |
| `--outcome <outcome>` | Decision outcome: `approved`, `rejected`, `deferred`, `pending` |
| `--category <category>` | Constraint category: `architecture`, `performance`, `security`, `reliability`, `compatibility`, `process`, `other` |
| `--status <status>` | Trap status: `active`, `resolved`, `expired` |
| `--severity <severity>` | Trap severity: `low`, `medium`, `high` |
| `--visibility <visibility>` | Trap visibility: `shared`, `machine`, `private` |
| `--host <host>` | Optional host identifier override for machine/private traps |
| `--project <name>` | Optional project namespace |
| `--plan <id>` | Optional linked plan item ID |
| `--from <name>` | Required for `handoff` |
| `--to <name>` | Required for `handoff` |
| `--ttl <duration>` | Time-to-live for expiring traps |
| `--store <target>` | Store level: `local` (default), `repo`, `workspace`, `user` |

```bash
brainclaw memory create decision "OAuth goes through auth-gateway" --tag auth
brainclaw memory create decision "Use async/await instead of callbacks" --outcome approved --plan pln_001
brainclaw memory create constraint "Payments module frozen until 2026-04-01" --tag payments
brainclaw memory create trap "Checkout E2E tests are flaky on Windows" --severity high --tag tests
brainclaw memory create trap "Windows SSH is misconfigured" --status resolved --severity medium --tag windows
brainclaw memory create handoff "Validate new refund endpoint" --from backend --to qa --project payments
```

### `brainclaw memory list`

List canonical memory items across decisions, constraints, traps, and handoffs.

| Option | Description |
|---|---|
| `--type <type>` | Filter by `decision`, `constraint`, `trap`, or `handoff` |
| `--json` | Output as JSON |

```bash
brainclaw memory list
brainclaw memory list --type constraint
brainclaw memory list --type handoff --json
```

### `brainclaw memory update <id>`

Update an existing canonical memory item by `id` or short label.

| Option | Description |
|---|---|
| `--text <text>` | Replace the main text |
| `--tag <tag>` | Replace tags |
| `--path <path>` | Replace related paths |
| `--outcome <outcome>` | Decision outcome |
| `--category <category>` | Constraint category |
| `--status <status>` | Constraint, trap, or handoff status |
| `--severity <severity>` | Trap severity |
| `--project <name>` | Handoff project namespace |
| `--plan <id>` | Linked plan item ID |
| `--from <name>` | Handoff source |
| `--to <name>` | Handoff destination |

```bash
brainclaw memory update dec_001 --text "Use JWT everywhere" --outcome approved
brainclaw memory update cnd_001 --status resolved --category process
brainclaw memory update trp_001 --status resolved
brainclaw memory update hnd_001 --status accepted --to alice
```

### `brainclaw memory delete <id>`

Delete a canonical memory item by `id` or short label.

```bash
brainclaw memory delete dec_001
brainclaw memory delete hnd_001
```

Legacy aliases `decision`, `constraint`, `trap`, and `handoff` remain available for compatibility, but `brainclaw memory ...` is now the primary CLI surface.

---

## Project Metadata

### `brainclaw capability add <name> <description>`

Register a project capability.

| Option | Description |
|---|---|
| `--tag <tag>` | Tag for categorization as category (repeatable) |
| `--author <name>` | Author name |
| `--store <target>` | Store level: `local` (default), `repo`, `workspace`, `user` |

```bash
brainclaw capability add "API Rate Limiting" "Manages request rate limiting for external APIs" --tag architecture
brainclaw capability add "Database Migrations" "Handles schema migrations safely" --tag reliability
```

### `brainclaw capability list`

List all registered project capabilities.

### `brainclaw capability describe <id>`

Show full details of a capability.

---

### `brainclaw tool add <name> <description>`

Register a project tool.

| Option | Description |
|---|---|
| `--type <type>` | Tool type: `workflow`, `validator`, `generator`, `utility`, `explorer` |
| `--tag <tag>` | Tag for categorization (repeatable) |
| `--author <name>` | Author name |
| `--store <target>` | Store level: `local` (default), `repo`, `workspace`, `user` |

```bash
brainclaw tool add "npm-test" "Runs npm test suite" --type validator
brainclaw tool add "docker-build" "Builds Docker image" --type generator --tag containers
```

### `brainclaw tool list`

List all registered project tools.

### `brainclaw tool describe <id>`

Show full details of a tool.

### `brainclaw tool search <query>`

Search tools by name, description, or tags.

```bash
brainclaw tool search "docker"
brainclaw tool search "test" --type validator
```

---

### `brainclaw explore`

Browse all registered project capabilities and tools in a unified view.

```bash
brainclaw explore
brainclaw explore --query "validation"
```

### Legacy memory aliases

The legacy top-level commands `brainclaw decision`, `brainclaw constraint`, `brainclaw trap`, and `brainclaw handoff` are still available for compatibility. New scripts and docs should prefer `brainclaw memory create ...`.

### `brainclaw instruction <text>`

Create a layered shared instruction.

| Option | Description |
|---|---|
| `--layer <layer>` | Layer: `global`, `project`, or `agent` |
| `--project <name>` | Project scope |
| `--agent <name>` | Agent scope |
| `--tag <tag>` | Tag for categorization (repeatable) |
| `--author <name>` | Author name |
| `--supersedes <id>` | ID of the instruction this replaces |
| `--store <target>` | Store level: `local` (default), `repo`, `workspace`, `user` |

```bash
brainclaw instruction "Read project memory before edits"
brainclaw instruction "Use auth gateway conventions" --layer project --project auth
brainclaw instruction "Summarize blockers explicitly" --layer agent --agent openclaw
```

### `brainclaw runtime-note <text>`

Record an operational observation during a session.

| Option | Description |
|---|---|
| `--agent <name>` | Authoring agent |
| `--project <name>` | Associated project |
| `--plan <id>` | Associated plan ID |
| `--visibility <scope>` | Visibility scope (e.g. `machine`) |
| `--host <name>` | Pin to a specific host |
| `--tag <tag>` | Tag for categorization (repeatable) |
| `--ttl <duration>` | Time-to-live (e.g. `7d`, `24h`) |
| `--auto-reflect` | Automatically promote to a review candidate |

```bash
brainclaw runtime-note "Started auth rollout" --agent copilot
brainclaw runtime-note "Node not on PATH on this host" --visibility machine
brainclaw runtime-note "Use auth gateway for new routes" --auto-reflect
```

---

## Memory Review

### `brainclaw reflect [text]`

Promote a memory item or free-form text into a review candidate.

| Option | Description |
|---|---|
| `--type <type>` | Candidate type (e.g. `trap`, `decision`, `constraint`) |
| `--batch` | Process multiple items in batch mode |
| `--session <id>` | Restrict to a specific session |
| `--tag <tag>` | Tag for categorization (repeatable) |
| `--author <name>` | Author name |
| `--source <source>` | Source identifier |
| `--severity <level>` | Severity: `low`, `medium`, or `high` |
| `--from <date>` | Start date filter |
| `--to <date>` | End date filter |
| `--path <path>` | Scope to a file or folder path |

```bash
brainclaw reflect "Always validate TTL before use" --type trap --severity medium
brainclaw reflect --batch --session sess_42
```

### `brainclaw reflect-runtime-note <id>`

Turn a runtime note into a shared review candidate.

| Option | Description |
|---|---|
| `--type <type>` | Override candidate type |
| `--host <name>` | Pin to a specific host |
| `--all-hosts` | Make visible on all hosts |
| `--suggest` | Show suggested type without writing |
| `--json` | Output as JSON |
| `--tag <tag>` | Tag for categorization (repeatable) |

```bash
brainclaw reflect-runtime-note rtn_001
brainclaw reflect-runtime-note rtn_001 --type trap --tag windows
brainclaw reflect-runtime-note rtn_001 --suggest
```

### `brainclaw review`

Review pending candidates for promotion or rejection.

| Option | Description |
|---|---|
| `--json` | Output as JSON |
| `--type <type>` | Filter by candidate type |
| `--prioritized` | Sort by priority |
| `--only-overdue` | Show only overdue items |
| `--assignee <name>` | Filter by assignee |
| `--for-curator <name>` | Show items for a specific curator |
| `--take <n>` | Limit to N items |
| `--claim <name>` | Claim items for a curator |
| `--auto` | Auto-accept high-confidence candidates |
| `--auto-by <name>` | Set author for auto-accepted items |

```bash
brainclaw review --prioritized
brainclaw review --for-curator curator-a --take 10 --claim curator-a
brainclaw review --auto --auto-by curator-bot
```

### `brainclaw show-candidate <id>`

Show details of a specific candidate.

| Option | Description |
|---|---|
| `--related` | Show related items |

```bash
brainclaw show-candidate cnd_001
brainclaw show-candidate cnd_001 --related
```

### `brainclaw star-candidate <id>`

Star a candidate to mark it as noteworthy without accepting it yet.

| Option | Description |
|---|---|
| `--by <name>` | Name of the reviewer |

```bash
brainclaw star-candidate cnd_001 --by curator-a
```

### `brainclaw use-candidate <id>`

Mark a candidate as used (applied in practice) without formally accepting it.

| Option | Description |
|---|---|
| `--by <name>` | Name of the reviewer |
| `--context <text>` | Context or note about how it was used |

```bash
brainclaw use-candidate cnd_001 --by copilot --context "Applied in auth refactor"
```

### `brainclaw accept <id>`

Accept a candidate and promote it to shared memory.

| Option | Description |
|---|---|
| `--by <name>` | Name of the accepting curator |

```bash
brainclaw accept cnd_001 --by curator-a
```

### `brainclaw reject <id>`

Reject a candidate.

| Option | Description |
|---|---|
| `--by <name>` | Name of the rejecting curator |
| `--reason <text>` | Reason for rejection |

```bash
brainclaw reject cnd_002 --by curator-a --reason "Too host-specific"
```

### `brainclaw prune-candidates`

Remove old, stale candidates.

| Option | Description |
|---|---|
| `--days <n>` | Age threshold in days |
| `--dry-run` | Preview without deleting |

```bash
brainclaw prune-candidates --days 30
brainclaw prune-candidates --days 14 --dry-run
```

---

## Listing and Querying

### `brainclaw plan list`

List plan items.

| Option | Description |
|---|---|
| `--json` | Output as JSON |
| `--status <status>` | Filter by status |
| `--type <type>` | Filter by type: `feat`, `fix`, `chore`, `spike`, `doc` |
| `--assignee <name>` | Filter by assignee |
| `--project <name>` | Filter by project |
| `--all` | Include completed and dropped plans |

```bash
brainclaw plan list
brainclaw plan list --status blocked --project auth
brainclaw plan list --json --all
```

Legacy alias: `brainclaw list-plans`

### `brainclaw claim list`

List active claims. Displays the short `session_id` to distinguish concurrent agent instances.

| Option | Description |
|---|---|
| `--json` | Output as JSON |
| `--all` | Include released claims |
| `--project <name>` | Filter by project |
| `--plan <id>` | Filter by plan ID |
| `--agent <name>` | Filter by agent |

```bash
brainclaw claim list
brainclaw claim list --agent copilot --project auth
brainclaw claim list --all --json
```

Legacy alias: `brainclaw list-claims`

### `brainclaw list-agents`

List registered agent and human identities.

| Option | Description |
|---|---|
| `--json` | Output as JSON |
| `--with-reputation` | Include reputation scores |

```bash
brainclaw list-agents
brainclaw list-agents --json --with-reputation
```

### `brainclaw list-instructions`

List raw instruction entries or the resolved instruction stack.

| Option | Description |
|---|---|
| `--json` | Output as JSON |
| `--layer <layer>` | Filter by layer: `global`, `project`, or `agent` |
| `--project <name>` | Filter by project |
| `--agent <name>` | Filter by agent |
| `--active` | Show only active instructions |
| `--resolved` | Show the resolved stack for a given context |
| `--for <path>` | Resolve instructions for a specific file or path |

```bash
brainclaw list-instructions --active
brainclaw list-instructions --resolved --for auth/routes.ts --agent openclaw
brainclaw list-instructions --layer project --project auth
```

### `brainclaw search <query>`

Search across shared memory.

| Option | Description |
|---|---|
| `--section <name>` | Restrict search to a memory section |
| `--since <date>` | Filter by creation date |
| `--tag <tag>` | Filter by tag |
| `--pending` | Include pending/unreviewed items |
| `--max-results <n>` | Maximum number of results |
| `--json` | Output as JSON |

```bash
brainclaw search "auth gateway"
brainclaw search "flaky" --section traps --tag tests --max-results 10
brainclaw search "rollout" --since 2026-01-01 --json
```

---

## Planning and Coordination

### `brainclaw plan create <text>`

Create a shared work item.

| Option | Description |
|---|---|
| `--priority <level>` | Priority: `low`, `medium`, or `high` |
| `--assignee <name>` | Assign to an agent or person |
| `--project <name>` | Associated project |
| `--tag <tag>` | Tag for categorization (repeatable) |
| `--path <path>` | Scope to a file or folder path |
| `--depends-on <id>` | ID of a plan this depends on |
| `--author <name>` | Author name |
| `--estimate <minutes>` | Estimated effort in integer minutes (e.g. `--estimate 30`) |
| `--store <target>` | Store level: `local` (default), `repo`, `workspace`, `user` |

```bash
brainclaw plan create "Coordinate auth rollout" --priority high --assignee copilot
brainclaw plan create "Refactor payments module" --project payments --estimate 90 --author alice
```

Legacy compatibility: `brainclaw plan "Coordinate auth rollout"`

### `brainclaw add-step <planId> <text>`

Add a step to an existing plan.

| Option | Description |
|---|---|
| `--assign <name>` | Assign the step to an agent or person |

```bash
brainclaw add-step pln_001 "Write unit tests for new endpoint"
brainclaw add-step pln_001 "Deploy to staging" --assign devops-bot
```

### `brainclaw complete-step <planId> <stepId>`

Mark a step in a plan as completed. No options.

```bash
brainclaw complete-step pln_001 step_001
```

### `brainclaw plan update <id>`

Update plan status or ownership.

| Option | Description |
|---|---|
| `--status <status>` | Status: `todo`, `in_progress`, `blocked`, `done`, or `dropped` |
| `--assignee <name>` | Reassign the plan |
| `--project <name>` | Change associated project |
| `--priority <level>` | Change priority |
| `--actual-effort <effort>` | Record actual effort (e.g. `20min`, `1h30m`) |

```bash
brainclaw plan update pln_001 --status done
brainclaw plan update pln_001 --status in_progress --assignee alice --actual-effort 45
```

Legacy alias: `brainclaw update-plan <id>`

### `brainclaw plan delete <id>`

Delete a shared plan item by `id` or short label.

```bash
brainclaw plan delete pln_001
```

Legacy alias: `brainclaw delete-plan <id>`

### `brainclaw estimation-report`

Display an ASCII chart of estimated vs. actual effort ratios across plans.

| Option | Description |
|---|---|
| `--agent <name>` | Filter by agent |
| `--json` | Output as JSON |

```bash
brainclaw estimation-report
brainclaw estimation-report --agent copilot --json
```

### `brainclaw update-handoff <id>`

Update an existing handoff.

| Option | Description |
|---|---|
| `--status <status>` | New status |
| `--to <name>` | Change recipient |

```bash
brainclaw update-handoff hnd_001 --status done
brainclaw update-handoff hnd_001 --to alice
```

---

## Claims and Coordination

### `brainclaw claim create <description>`

Claim ownership over a file, folder, or scope.

| Option | Description |
|---|---|
| `--agent <name>` | Claiming agent |
| `--scope <path>` | File or folder being claimed |
| `--project <name>` | Associated project |
| `--plan <id>` | Associated plan ID |
| `--ttl <duration>` | Time-to-live for the claim |
| `--store <target>` | Store level: `local` (default), `repo`, `workspace` |

```bash
brainclaw claim create "Taking auth rollout" --agent copilot --scope src/auth/ --plan pln_001
brainclaw claim create "Editing payments module" --scope src/payments/ --ttl 2h
```

Legacy compatibility: `brainclaw claim "Taking auth rollout" --scope src/auth/`

### `brainclaw claim release <id>`

Release a claim and optionally advance the linked plan status.

| Option | Description |
|---|---|
| `--plan-status <status>` | Set the linked plan status on release |

```bash
brainclaw claim release clm_001
brainclaw claim release clm_001 --plan-status done
```

Legacy alias: `brainclaw release-claim <id>`

### `brainclaw release-claims`

Release multiple claims derived from a Git diff.

| Option | Description |
|---|---|
| `--from-git-diff` | Derive scopes from a Git diff |
| `--ref1 <ref>` | First Git ref for the diff |
| `--ref2 <ref>` | Second Git ref for the diff |

```bash
brainclaw release-claims --from-git-diff --ref1 main --ref2 HEAD
```

### `brainclaw agent-board`

Display a coordination snapshot showing agent activity and file ownership.

| Option | Description |
|---|---|
| `--agent <name>` | Focus on a specific agent |
| `--project <name>` | Filter by project |
| `--for <path>` | Show board for a specific file or path |
| `--host <name>` | Filter by host |
| `--all-hosts` | Show data across all hosts |
| `--json` | Output as JSON |
| `--with-reputation` | Include reputation scores |
| `--capabilities` | Show agent capabilities |
| `--suggest` | Suggest the best agent for unclaimed work |

```bash
brainclaw agent-board --agent copilot --project auth
brainclaw agent-board --for src/auth/routes.ts --json
brainclaw agent-board --suggest --capabilities
```

---

## Context and Agents

### `brainclaw context`

Generate compact, prompt-ready context for agents.

| Option | Description |
|---|---|
| `--for <path>` | Scope context to a file or path |
| `--project <name>` | Filter by project |
| `--agent <name>` | Filter by agent |
| `--host <name>` | Filter by host |
| `--all-hosts` | Include items from all hosts |
| `--profile <name>` | Use a named context profile |
| `--include-pending` | Include unreviewed candidates |
| `--max-items <n>` | Maximum number of items to include |
| `--max-chars <n>` | Maximum total characters |
| `--digest` | Output a condensed digest |
| `--since-session` | Only include items since the last session start |
| `--no-bootstrap` | Skip bootstrap data |
| `--refresh-bootstrap` | Force refresh of bootstrap data |
| `--template <name>` | Use a named output template |
| `--compact-template` | Use the compact template variant |
| `--explain` | Show scoring and selection rationale |
| `--json` | Output as JSON |

```bash
brainclaw context --for src/auth/routes.ts --digest
brainclaw context --json --max-chars 1200
brainclaw context --explain
brainclaw context --since-session --max-items 20
```

### `brainclaw context-diff`

Show what has changed in shared memory since a reference point.

| Option | Description |
|---|---|
| `--since <date>` | Start date for the diff |
| `--session <id>` | Compare against a specific session start |
| `--json` | Output as JSON |

```bash
brainclaw context-diff --session sess_42
brainclaw context-diff --since 2026-03-10 --json
```

### `brainclaw register-agent <name>`

Register a durable human or agent identity.

| Option | Description |
|---|---|
| `--kind <kind>` | Identity kind (e.g. `agent`, `human`) |
| `--capability <cap>` | Add a capability (repeatable) |
| `--replace-capabilities` | Replace all existing capabilities |
| `--generate-fingerprint` | Generate a unique fingerprint |
| `--set-current` | Set as the current active agent |
| `--curator` | Mark as a memory curator |
| `--json` | Output as JSON |

```bash
brainclaw register-agent copilot --kind agent --set-current
brainclaw register-agent alice --kind human --curator
brainclaw register-agent my-bot --capability code-review --capability testing --generate-fingerprint
```

### `brainclaw enable-agent <name>`

Enable an existing agent and optionally update its capabilities.
Built-in integration names include `claude-code`, `cursor`, `windsurf`, `cline`, `codex`, `opencode`, `antigravity`, `continue`, `roo`, and `github-copilot`.

| Option | Description |
|---|---|
| `--kind <kind>` | Identity kind |
| `--capability <cap>` | Add a capability (repeatable) |
| `--generate-fingerprint` | Regenerate fingerprint |
| `--set-current` | Set as the current active agent |
| `--json` | Output as JSON |

```bash
brainclaw enable-agent github-copilot --set-current
brainclaw enable-agent opencode
brainclaw enable-agent antigravity
brainclaw enable-agent my-bot --capability refactor --json
```

### `brainclaw whoami`

Show the current agent identity.

| Option | Description |
|---|---|
| `--json` | Output as JSON |

```bash
brainclaw whoami
brainclaw whoami --json
```

### `brainclaw set-trust <agent>`

Set the trust level for an agent.

| Option | Description |
|---|---|
| `--level <level>` | Trust level |
| `--reset-breaker` | Reset the circuit breaker for this agent |
| `--json` | Output as JSON |

```bash
brainclaw set-trust copilot --level high
brainclaw set-trust flaky-bot --reset-breaker --json
```

---

## Sessions

### `brainclaw session-start`

Mark the start of an agent work session.

| Option | Description |
|---|---|
| `--agent <name>` | Agent starting the session |
| `--context <text>` | Context note for the session |
| `--model <id>` | AI model identifier (e.g. `claude-sonnet-4-6`) |
| `--json` | Output as JSON |

```bash
brainclaw session-start --agent copilot
brainclaw session-start --agent claude --model claude-sonnet-4-6 --json
```

### `brainclaw session-end`

Mark the end of an agent work session.

| Option | Description |
|---|---|
| `--session <id>` | Session ID to close |
| `--agent <name>` | Agent ending the session |
| `--summary <text>` | Summary of work done |
| `--auto-reflect` | Automatically reflect runtime notes from the session |
| `--auto-release` | Automatically release all claims held during the session |
| `--reflect-handoff` | Reflect any open handoffs as candidates |
| `--json` | Output as JSON |

```bash
brainclaw session-end --auto-release
brainclaw session-end --session sess_42 --summary "Completed auth refactor" --auto-reflect --auto-release
```

---

## Export and Integrations

### `brainclaw export`

Export memory as a native agent instruction file.

| Option | Description |
|---|---|
| `--format <format>` | Target format: `copilot-instructions`, `cursor-rules`, `agents-md`, `claude-md`, `gemini-md`, `windsurf`, `cline`, `roo`, or `continue` |
| `--detect` | Auto-detect the running agent and write to its native file |
| `--write` | Write output to the native file path (instead of stdout) |
| `--output <path>` | Write to a custom output path |
| `--project <name>` | Filter by project |
| `--agent <name>` | Filter by agent |

```bash
brainclaw export --detect
brainclaw export --format copilot-instructions --write   # .github/copilot-instructions.md
brainclaw export --format claude-md --write              # CLAUDE.md
brainclaw export --format gemini-md --write             # GEMINI.md
brainclaw export --format cursor-rules --write           # .cursor/rules/brainclaw.md
brainclaw export --format windsurf --write               # .windsurfrules
brainclaw export --format cline --write                  # .clinerules/brainclaw.md
brainclaw export --format agents-md --write              # AGENTS.md (Codex, OpenCode)
brainclaw export --format roo --write                    # .roo/rules/brainclaw.md
brainclaw export --format continue --write               # .continue/rules/brainclaw.md
brainclaw export --format claude-md                      # stdout
```

`brainclaw export --detect --write` also writes companion MCP config where relevant, including `opencode.json` for OpenCode and `.gemini/antigravity/mcp_config.json` for Antigravity/Gemini when the local environment is available.

### `brainclaw adapter-openclaw-import [file]`

Import OpenClaw runtime events into reflective candidates.

| Option | Description |
|---|---|
| `--session <id>` | Restrict import to a specific session |
| `--dry-run` | Preview without writing |
| `--source <name>` | Override source identifier |
| `--author <name>` | Author name for imported items |

```bash
brainclaw adapter-openclaw-import ./openclaw-events.json --dry-run
brainclaw adapter-openclaw-import --session sess_42
```

See [adapters/openclaw.md](adapters/openclaw.md).

---

## Hooks and Git

### `brainclaw install-hooks`

Install Git hooks for constraint checking.

| Option | Description |
|---|---|
| `--force` | Overwrite existing hooks |

```bash
brainclaw install-hooks
brainclaw install-hooks --force
```

### `brainclaw hooks`

Show or manage installed hooks.

| Option | Description |
|---|---|
| `--target <path>` | Target directory for hooks |

```bash
brainclaw hooks
brainclaw hooks --target .git/hooks
```

### `brainclaw diff`

Show a diff of memory changes.

| Option | Description |
|---|---|
| `--since <date>` | Start date for the diff |
| `--json` | Output as JSON |

```bash
brainclaw diff --since 2026-03-01
brainclaw diff --json
```

### `brainclaw check-constraints`

Check active constraints against staged or specified files.

| Option | Description |
|---|---|
| `--staged` | Check files currently staged in Git |
| `--files <paths>` | Comma-separated list of files to check |
| `--json` | Output as JSON |

```bash
brainclaw check-constraints --staged
brainclaw check-constraints --files src/payments/index.ts --json
```

---

## Sync and Distribution

### `brainclaw sync`

Summarize memory state and optionally create local Git commits.

| Option | Description |
|---|---|
| `--commit` | Create a Git commit |
| `--message <text>` | Commit message |
| `--summary-only` | Print summary without writing |
| `--scope <path>` | Limit sync to a path |
| `--include-machine-runtime` | Include machine-local runtime notes |
| `--remote <name>` | Remote name for push |

```bash
brainclaw sync --commit --message "chore: sync memory"
brainclaw sync --summary-only
brainclaw sync --commit --include-machine-runtime --remote origin
```

### `brainclaw pull`

Pull shared memory from a remote.

| Option | Description |
|---|---|
| `--remote <name>` | Remote name |
| `--json` | Output as JSON |

```bash
brainclaw pull
brainclaw pull --remote origin --json
```

### `brainclaw push`

Push shared memory to a remote.

| Option | Description |
|---|---|
| `--remote <name>` | Remote name |
| `--message <text>` | Commit message for the push |
| `--json` | Output as JSON |

```bash
brainclaw push --remote origin
brainclaw push --remote origin --message "chore: push memory state" --json
```

---

## Monitoring and Maintenance

### `brainclaw watch`

Watch for memory changes in real time.

| Option | Description |
|---|---|
| `--interval <ms>` | Polling interval in milliseconds |
| `--auto-claim` | Automatically claim files touched by the agent |
| `--agent <name>` | Agent name for auto-claim |

```bash
brainclaw watch
brainclaw watch --interval 5000 --auto-claim --agent copilot
```

### `brainclaw metrics`

Show memory usage and activity metrics.

| Option | Description |
|---|---|
| `--json` | Output as JSON |
| `--since <date>` | Start date for metrics |

```bash
brainclaw metrics
brainclaw metrics --since 2026-01-01 --json
```

### `brainclaw prune`

Remove expired memory items.

| Option | Description |
|---|---|
| `--expired` | Prune only TTL-expired items |

```bash
brainclaw prune --expired
```

### `brainclaw rollback`

Roll back a memory item to a previous state.

| Option | Description |
|---|---|
| `--audit-id <id>` | Audit event ID to roll back to |
| `--item-id <id>` | Specific item ID to roll back |
| `--dry-run` | Preview without writing |
| `--json` | Output as JSON |

```bash
brainclaw rollback --item-id dec_001 --dry-run
brainclaw rollback --audit-id aud_042 --json
```

### `brainclaw audit`

Show the audit log of memory changes.

| Option | Description |
|---|---|
| `--since <date>` | Start date filter |
| `--actor <name>` | Filter by actor |
| `--action <type>` | Filter by action type |
| `--limit <n>` | Maximum number of entries |
| `--json` | Output as JSON |

```bash
brainclaw audit --since 2026-03-01 --actor copilot
brainclaw audit --action accept --limit 20 --json
```

### `brainclaw history <id>`

Show the change history for a specific memory item. No options.

```bash
brainclaw history dec_001
brainclaw history cnd_042
```

---

## Server and MCP

### `brainclaw mcp`

Start the MCP (Model Context Protocol) server over stdio. Used by AI agents that support MCP tooling. No options.

```bash
brainclaw mcp
```

#### Available MCP tools

**Read tools** (no trust requirement):

| Tool | Description |
|---|---|
| `bclaw_get_context` | Full workspace context (constraints, decisions, traps, plans, handoffs) |
| `bclaw_bootstrap` | Derive brownfield bootstrap signals from repo docs and git history |
| `bclaw_get_execution_context` | Inspect local execution environment and agent tooling signals |
| `bclaw_read_handoff` | Read an open handoff ticket with git diff and state snapshot |
| `bclaw_get_agent_board` | Live plan + claim board with active sessions |
| `bclaw_search` | Full-text BM25 search across all memory items |
| `bclaw_estimation_report` | Estimation accuracy report for completed plans |
| `bclaw_list_plans` | List plan items with the same filters as `brainclaw plan list` |
| `bclaw_list_claims` | List claims with the same filters as `brainclaw claim list` |
| `bclaw_list_agents` | List registered agents, optionally with bounded reputation summaries |
| `bclaw_list_instructions` | List raw or resolved shared instructions |
| `bclaw_list_candidates` | List pending or archived review candidates |

**Write tools** (contributor trust or above):

| Tool | Description |
|---|---|
| `bclaw_write_note` | Add a runtime note (supports TTL and auto-reflect) |
| `bclaw_create_candidate` | Create a memory candidate (decision, constraint, trap, handoff) |
| `bclaw_accept` | Accept a pending candidate into canonical memory |
| `bclaw_reject` | Reject a pending candidate |
| `bclaw_claim` | Claim a work scope (advisory lock) |
| `bclaw_release_claim` | Release a claim, optionally updating the linked plan status |
| `bclaw_session_start` | Start an agent session and register identity |
| `bclaw_session_end` | End session, optionally auto-reflect notes as candidates |
| `bclaw_create_plan` | Create a new plan item |
| `bclaw_update_plan` | Update plan status, actual effort, priority, or assignee |
| `bclaw_add_step` | Add a sub-step to a plan item |
| `bclaw_complete_step` | Mark a plan sub-step as done |

---

## Version Management

### `brainclaw version`

Show or manage the brainclaw version.

| Option | Description |
|---|---|
| `--check` | Check for a newer version |
| `--publish-local` | Pack and publish locally (uses `npm pack`) |
| `--release-notes <text>` | Release notes for `--publish-local` |
| `--json` | Output as JSON |

```bash
brainclaw version
brainclaw version --check
brainclaw version --publish-local --release-notes "Add estimation-report command"
```
