# Audience: Teams & Ops

Design constraints for agents developing brainclaw features that serve team developers, project maintainers, and CI/CD operators.

## Profiles

### Team Developers
Developers collaborating on shared projects where multiple humans (and their agents) contribute. They need async coordination to avoid conflicting edits.

### Project Maintainers
Senior developers or tech leads responsible for code quality and architecture. They define the rules that all agents must follow in the repo.

### CI/CD Operators
Engineers who run agents in headless pipelines. They need brainclaw to work without interactive prompts and produce machine-readable output.

## Design Constraints

These rules apply to any feature that touches this audience:

1. **Concurrent agents is the nominal case, not the exception.** Any mutation of shared state (plans, claims, memory) must handle conflicts gracefully. File claims exist precisely for this — features that bypass claims are bugs. `bclaw_conflict_check` provides pre-edit safety, and `bclaw_check_policy` enforces scope compliance with glob-based pattern matching.

2. **Claims are mandatory for file-level coordination.** When multiple agents can be active, no agent should edit files without a claim. The claim system must be strict enough to prevent collisions and clear enough that agents understand scope boundaries. Policy checks return hard blocks (stops) and warnings (advisories) — both must be surfaced.

3. **Project constraints must be enforceable.** When a maintainer defines architecture rules or known traps, every agent joining the project must read them before working. This is not optional — it is the mechanism for scaling quality across agents. Lifecycle trigger tags (`trigger:post-claim`, `trigger:pre-session-end`) allow constraints to fire at specific moments.

4. **Headless operation must be first-class.** All CLI commands must work non-interactively (`--yes`, `--json`, exit codes). CI/CD agents cannot answer prompts. If a feature adds an interactive flow, it must have a non-interactive equivalent. Delivery methods (stdin_pipe, inline_arg, temp_file, inbox_structured) adapt to the agent's capabilities automatically.

5. **Audit trail matters.** For teams, knowing which agent did what and why is not a nice-to-have. The audit system (`audit.ts`) logs 30+ action types in JSONL with auto-rotation (10MB threshold), captures actor/action/before-after/scope/session_id/host_id. The governance posture report (`bclaw_audit`) aggregates this into constitution, red-lines, active claims, and recent activity summaries.

6. **Worktree isolation is the safe default for parallel work.** When multiple agents work simultaneously, each should get its own Git worktree. Worktrees are created under `~/.brainclaw/worktrees/<project-hash>/` with sidecar tracking (session_id, agent, user). `brainclaw worktree clean` prunes merged branches, `brainclaw worktree merge` handles restoration.

## Anti-Patterns

- Assuming single-agent, single-session usage
- Modifying shared state without conflict detection
- Adding interactive-only flows with no `--yes` / `--json` fallback
- Storing coordination state outside of Git-tracked `.brainclaw/` (breaks team sync)
- Silently overwriting another agent's claims or plan state
- Producing output that requires a human to interpret (no structured/machine-readable option)
- Ignoring reputation signals when evaluating agent contributions

## Key Features for This Audience

### Coordination & Claims
- `bclaw_claim` / `bclaw_release_claim` — file-level advisory locks with auto-worktree per claim
- `bclaw_find(entity="claim", filter?)` / `bclaw_get(entity="claim", id)` — list and read claims via the canonical grammar
- `bclaw_conflict_check` — pre-edit conflict detection between agents
- `bclaw_check_policy` — scope compliance with glob matching, returns blocks + warnings
- `bclaw_who` — list all active agent sessions on the workspace

### Planning & Sequencing
- `bclaw_create(entity="plan", data)` / `bclaw_update(entity="plan", id, patch)` / `bclaw_transition(entity="plan", id, to)` — shared work planning with priority/effort/assignee/status
- `bclaw_find(entity="plan", filter?)` — list plans
- `bclaw_add_step` / `bclaw_complete_step` / `bclaw_update_step` / `bclaw_delete_step` — plan sub-steps for granular tracking
- `bclaw_create_sequence` / `bclaw_list_sequences` / `bclaw_update_sequence` — multi-step coordination sequences with lane analysis

### Multi-Agent Dispatch
- `bclaw_dispatch(intent)` — `analysis` analyses an active sequence (ready/active/blocked/done per lane), `execute` fans out parallel work across lanes, `review` dispatches code reviews for completed handoffs
- `bclaw_coordinate(intent)` — facade for `assign` / `consult` / `review` / `reroute` / `summarize`. Pass `open_loop: true` on `intent="review"` to also dispatch the reviewer turn (the recommended path).
- `bclaw_loop(intent)` — drive a turn in an existing multi-turn loop (`turn`, `complete_turn`, `advance`, `close`)
- Delivery channels: spawn (CLI subprocess) or inbox (structured messages)
- Dry-run mode for previewing assignments

### Inter-Agent Messaging
- `bclaw_send_message` / `bclaw_read_inbox` / `bclaw_ack_message` — structured messaging between agents
- `bclaw_get_thread` — full thread view across agent inboxes
- CLI: `brainclaw inbox list/ack/archive/send/thread`

### Visibility & Governance
- `bclaw_context(kind="board")` / `bclaw_context(kind="board_summary")` — active plans, claims by agent, open handoffs, sequences, resolved instructions (full or compact form)
- `bclaw_audit` — governance posture report (constitution, red-lines, claim activity, recommendations)
- `bclaw_history` — full mutation history per memory item with before/after snapshots
- Reputation signals — 4 scores: contribution_quality, review_reliability, continuity_hygiene, internal_trust
- `bclaw_estimation_report` — estimation accuracy for completed plans

### Handoffs & Review
- `bclaw_get(entity="handoff", id)` / `bclaw_update(entity="handoff", id, patch)` — structured agent transitions with git diff and state snapshot
- `bclaw_create(entity="candidate", data)` / `bclaw_transition(entity="candidate", id, to="accepted"|"rejected")` — review workflow with candidate promotion
- `bclaw_coordinate(intent="review", open_loop: true, review_mode: "symmetric")` — open a multi-turn review-and-fix loop in one call (the recommended way to dispatch a reviewer)
- `brainclaw review` — reflective review from CLI

### Worktree Management
- `bclaw_claim` with auto-worktree — creates isolated branch per agent/scope
- `brainclaw worktree clean` — remove merged worktrees and orphan directories
- `brainclaw worktree merge <branch>` — merge with auto-restoration
- Sidecar tracking: session_id, agent name, user per worktree

## Known Gaps

Features this audience would naturally expect but that are not yet implemented:

### No merge conflict resolution tooling
brainclaw creates worktrees and manages branches but provides zero help when two agents' worktrees conflict at merge time. No pre-merge conflict detection, no merge strategy hints, no assisted resolution. Teams must handle all git merge/rebase manually.
**Impact:** The hardest part of multi-agent parallel work (the merge) is entirely outside brainclaw's scope.

### No push notifications or webhooks
The event log (`event-log.ts`) records all mutations in JSONL and supports cursor-based polling (`readUnseenEvents()`), but there is no push mechanism. No webhooks, no Slack integration, no email alerts. When a claim conflicts or a handoff is ready, agents must poll to discover it.
**Impact:** Teams can't get real-time alerts on coordination events. Stale claim detection depends on someone polling.

### Claim expiry has no background enforcement
Claim expiry logic exists (`claims.ts`: `isClaimExpired()`, `isClaimStale()`, `expireStaleActiveClaims()`), but there is no daemon or background process. Expiry only triggers when a command explicitly calls it. If an agent crashes and abandons a claim, it blocks other agents until someone runs a check.
**Impact:** Stale claims from crashed agents can block team progress indefinitely.

### No path-level access restrictions
Trust levels exist (observer/contributor/trusted/curator in `agent-registry.ts`), but they are all-or-nothing per tier. There is no way to say "junior agents can't modify src/core/" or restrict specific agents to specific scopes. Policy checks (`policy.ts`) warn on claim conflicts but don't enforce path-based permissions.
**Impact:** Maintainers cannot protect critical code paths from untrusted agents.

### No web dashboard or visualization
All output is CLI text or JSON (`metrics.ts`, `doctor.ts`, `audit`). There is no web UI, no HTML reports, no dependency graphs, no Gantt charts for plans. Teams that want visual coordination views must build their own from JSON exports.
**Impact:** Ops teams without CLI fluency have no visibility into coordination state.

### No pre-built CI GitHub Action
brainclaw works in CI (proven by `.github/workflows/brainclaw-sync.yml` in this repo), but there is no reusable GitHub Action or template. Operators must manually wire `brainclaw doctor --json` into their pipelines. No `--ci` mode flag, no structured exit codes (warning vs error).
**Impact:** CI adoption requires per-repo custom work instead of a one-line Action reference.

### Plan dependencies lack cycle/deadlock detection
Plans support `depends_on` and sequences support `hard_after`/`soft_after` (`schema.ts`, `dispatcher.ts`), but there is no transitive dependency validation. Circular dependencies (A→B→C→A) are not detected before dispatch. No critical path analysis or slack calculation.
**Impact:** Complex plan graphs can deadlock silently.

### No team onboarding walkthrough
When a new developer joins an existing brainclaw project, they get the same `init` flow as a greenfield project. There is no "get familiar with this project" step, no guided tour of existing plans/constraints/traps, no role assignment during setup.
**Impact:** New team members start without understanding the project's coordination state.
