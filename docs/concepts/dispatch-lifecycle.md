# Dispatch lifecycle

When brainclaw routes work to another agent — `bclaw_coordinate(intent="assign"|"review"|"consult")`, `bclaw_dispatch(intent="execute")`, or a multi-turn `bclaw_loop` — it spins up **up to six related entities** plus an on-disk **brief-ack sentinel** and (since pln#504) **per-assignment stdout/stderr log files**. Knowing what each one means lets you tell at a glance whether a dispatch is alive, dead, or merely slow.

This doc is the consolidated reference. It complements:
- [multi-agent-workflows.md](multi-agent-workflows.md) — happy-path coordination patterns
- [troubleshooting.md](troubleshooting.md) — symptom-driven diagnostic playbooks
- [loop-engine.md](loop-engine.md) — multi-turn loop protocol details
- [../integrations/codex.md](../integrations/codex.md), [../integrations/claude-code.md](../integrations/claude-code.md), etc. — per-agent spawn semantics

---

## The six entities

A single `bclaw_coordinate(intent="review", open_loop=true, targetAgents=[codex])` creates:

```
                         ┌─────────────────┐
                         │   candidate     │  cnd_…  (review payload)
                         └────────┬────────┘
                                  │ references
              ┌───────────────────┼──────────────────┐
              ▼                   ▼                  ▼
        ┌──────────┐       ┌─────────────┐    ┌──────────┐
        │   loop   │ ◄────►│ assignment  │    │ message  │
        │  lop_…   │       │  asgn_…     │    │  msg_…   │
        └──────────┘       └──────┬──────┘    └──────────┘
                                  │
                                  │ owned-by
                                  ▼
                           ┌──────────────┐
                           │    claim     │  clm_…  (worktree lock)
                           └──────┬───────┘
                                  │ triggers
                                  ▼
                           ┌──────────────┐
                           │  agent_run   │  run_…  (the OS-level spawn)
                           └──────┬───────┘
                                  │
              ┌───────────────────┼─────────────────┐
              ▼                   ▼                 ▼
        ┌──────────┐       ┌─────────────┐   ┌────────────┐
        │ ack file │       │ stdout log  │   │ stderr log │
        │ .ack     │       │ .stdout.log │   │ .stderr.log│
        └──────────┘       └─────────────┘   └────────────┘
        (pln#476)          (pln#504)         (pln#504)
```

| Entity | Prefix | Created by | Owner | Purpose |
|---|---|---|---|---|
| `candidate` | `cnd_` | the coordinate facade (review/ideate) | the dispatcher agent | Review payload that the loop references. Stays after the loop closes. |
| `loop` | `lop_` | `bclaw_coordinate(open_loop=true)` or `bclaw_loop(intent="open")` | the dispatcher | Multi-turn thread of structured work. Has its own FSM. |
| `assignment` | `asgn_` | dispatcher when targeting an agent | the **target** agent | Lifecycle event for that agent's turn. The only entity whose FSM tracks the WORKER's progress. |
| `message` | `msg_` | dispatcher | the dispatcher | The brief delivered to the target's inbox. |
| `claim` | `clm_` | dispatcher (or `bclaw_claim` directly) | the target agent | Worktree advisory lock. Released when the work is done or the agent gives up. |
| `agent_run` | `run_` | the CLI execution adapter, only when an OS-level spawn actually happens | the target agent | OS-level subprocess record. Status FSM tracks the LIFETIME of the process — but only the parts brainclaw can observe (see [§Liveness limits](#liveness-limits) below). |

Plus two filesystem-only artefacts created by the worker shell wrapper:

- **Brief-ack sentinel**: `.brainclaw/coordination/runtime/ack/<assignment_id>.ack` — touched by the spawn wrapper BEFORE the agent binary runs (pln#476). Proves the spawn shell got far enough to execute `touch`. Does NOT prove the agent binary itself succeeded.
- **stdout/stderr logs** (pln#504): `.brainclaw/coordination/runtime/log/<assignment_id>.{stdout,stderr}.log` — opened by the parent before the spawn, the child inherits dup'd fds and writes its streams there. This is the only window onto what a sandboxed worker actually said before dying.

---

## FSM cheatsheet

### `loop.status`

```
open ──▶ paused ──▶ open       (pause / resume)
  │
  ├──▶ completed                (stop_condition met)
  ├──▶ cancelled                (manual close — use when the loop dies abnormally)
  └──▶ blocked                  (external blocker; intent to resume later)
```

`bclaw_loop(intent="close")` accepts **only** `completed | cancelled | blocked` as `status`. **Not `failed`** — map crashed/dead loops to `cancelled` with a `reason`.

### `assignment.status`

```
created ──▶ offered ──▶ accepted ──▶ started ──▶ completed
   │            │            │            │           
   │            │            │            └──▶ failed (worker self-reported)
   │            │            │            └──▶ blocked (worker needs supervisor)
   │            │            │            └──▶ cancelled (rerouted away)
   │            │            └──▶ acceptance_ttl expired (default 15min) → cancelled
   │            └──▶ heartbeat_ttl expired (default 30min while running) → cancelled
   └──▶ removed by `bclaw_assignment_admin` (rare)
```

Transitions past `offered` require the assigned agent itself (or `bclaw_assignment_admin`). A coordinator that didn't create the assignment **cannot** update it — `Agent X cannot update assignment owned by Y` is the canonical rejection.

### `agent_run.status`

```
launching ──▶ running ──▶ completed
                  │           ──▶ failed (non-zero exit, worker reported)
                  │           ──▶ interrupted (TTL/heartbeat expiry, see below)
                  │
                  └──▶ failed (spawn returned no pid, brief-ack timeout)
```

**Liveness limits** {#liveness-limits}: `last_event_at` is bumped only when the worker writes a lifecycle event (via MCP or via the wrap shell). A worker that crashes before its first output keeps `status=running` and `last_event_at == launched_at` until reconciled. Since pln#503 phase 3.2, **any read of `agent_run` via `bclaw_find` / `bclaw_get` triggers a lazy reconciliation pass**: open runs past the 60s grace window get their pid checked, and dead workers transition to `failed` (`status_reason='silent_termination_no_evidence'`) once past the 30min stale threshold.

For a single consolidated check (run + assignment + claim + loop + pid + log tails + verdict in one response), use **`bclaw_dispatch_status(target_id)`** (pln#503 phase 3.1).

### `claim.status`

```
active ──▶ released
   │
   └──▶ adopted (another session inherited the claim, e.g. reconnect)
```

Releasing a claim does NOT cancel its assignment / agent_run / loop — those are independent entities. You generally need to clean up all of them together when aborting a dispatch.

---

## Observability decision tree

You called `bclaw_coordinate(intent="review", open_loop=true, …)` and got back `execution_status: "delivered_and_started"`. What does that actually mean?

**Fast path** (recommended since pln#503 phase 3.1): call `bclaw_dispatch_status(target_id="<asgn_…>")` and read its `diagnosis.health` + `diagnosis.recommended_next_action`. The tool consolidates the steps below into a single response — entity fan-out, pid liveness, log tails, verdict, recommended next action.

**Long path** (for understanding or when the tool isn't available):

```
1. execution_status = "delivered_and_started"
   ├──▶ Means: the spawn wrapper touched the brief-ack sentinel
   └──▶ Does NOT mean: the worker is doing useful work

2. Verify the spawn is alive — check the agent_run record
   bclaw_find(entity="agent_run", filter={assignment_id: "<asgn>"})
   ├──▶ status="running" AND pid alive on OS AND last_event_at < 5min ago → healthy
   ├──▶ status="running" AND pid alive AND last_event_at == launched_at → stalled (worker never produced output)
   ├──▶ status="running" AND pid dead → silently died (see logs)
   └──▶ status="completed" / "failed" / "interrupted" → terminal, read status_reason

3. If silent, read the logs (pln#504)
   cat .brainclaw/coordination/runtime/log/<asgn>.stderr.log
   cat .brainclaw/coordination/runtime/log/<asgn>.stdout.log
   ├──▶ Contains an error → root cause found
   └──▶ Empty → worker died before any write OR launched without log capture (legacy path)

4. If the worker is alive but doing nothing useful for 15+ min
   → most likely sandbox / MCP / capability mismatch with the brief
   → see ../integrations/<agent>.md "Caveats" for per-agent gotchas
```

---

## Worktree-as-contract harvest

Some dispatched workers cannot self-commit. For example, a sandboxed Codex run has `dispatchCanCommit=false` because its writable root is the linked worktree, while `.git` lives outside that root — so it cannot `git commit`. (It *can* still call brainclaw MCP — dec#133 — but the file-based contract below is used regardless, so harvesting stays coordinator-owned and does not depend on the worker's MCP writes.) In that case the worker contract is intentionally small:

1. Edit files inside the dispatched worktree.
2. Write `LANE-RESULT.json` at the worktree root.

The worker does not need to commit, call `bclaw_assignment_update`, or release the claim itself. The worktree is the contract.

When the coordinator runs `brainclaw harvest <assignment_id> --integrate`, brainclaw reads the worker's `LANE-RESULT.json`, commits the linked worktree diff on the worker's behalf onto the lane branch, then completes the assignment and releases the claim, including the normal plan-status cascade.

The on-behalf commit is guarded by the linked-worktree check (`isLinkedWorktree`): integration only targets the worktree associated with the assignment, never the main repository. This keeps sandboxed-worker harvesting from turning into an accidental main-repo commit path.

Integration is strictly additive and opt-in. Plain `brainclaw harvest <assignment_id>` remains report-only; it reads and reports the lane result without committing or mutating assignment / claim state. The on-behalf commit and lifecycle completion happen only when the coordinator passes `--integrate`.

### Worktree garbage collection on loop close (pln#594)

Closing a loop as **`completed`** garbage-collects the worktrees of its slot
assignments, so review/dispatch worktrees stop accumulating under
`~/.brainclaw/worktrees/`. The cascade runs inside `closeLoop` (so it covers MCP,
CLI, and reconciler-driven closes) and is **safe by default** — each worktree is
removed only when all of these hold:

- the worker no longer looks alive (no `.brainclaw-heartbeat-*` touched within the
  liveness window) — this guard is never bypassed, even with force;
- the worktree has no un-harvested edits — anything beyond brainclaw birth-noise
  (`.gitignore`, the sidecar), `LANE-RESULT.json`, and the heartbeat counts as
  real work and is preserved;
- the lane branch carries no commits unreachable from the main repo HEAD (so
  deleting the branch can't drop un-integrated work).

A worktree that fails a guard is **kept** (with a debug-log reason) so you can
harvest or inspect it. A **`cancelled`/`blocked`** close keeps the worktree and
its run logs for forensics. Removal is junction-safe (`removeWorktree` detaches
`node_modules`/`dist` junctions first), then the redundant dispatch branch is
deleted. The whole step is best-effort — it never blocks the close — and can be
disabled with `BRAINCLAW_NO_WORKTREE_GC=1`. The reusable primitive is
`gcWorktreeIfHarvested(mainWorktreePath, worktreePath, { force? })` in
`core/worktree.ts`; `brainclaw worktree clean` remains the manual/TTL backstop
for anything the cascade keeps.

---

## Diagnostic playbook

When a dispatch hangs, work top-down through these checks. For the symptom-driven variant see [troubleshooting.md#inbox-messages-stuck--brief-ack-never-arrived](troubleshooting.md#inbox-messages-stuck--brief-ack-never-arrived).

### Quick triage (≤5s)

```bash
# Single call covers process liveness + ack + log tails + entity state + verdict
bclaw_dispatch_status(target_id="<asgn>")        # or clm_/lop_/run_
```

Read `diagnosis.health` (`healthy` | `stalled` | `silent_death` | `terminal` | `not_dispatched` | `unknown`) and `diagnosis.recommended_next_action` — usually that's all you need.

### Manual triage (≤30s — when `bclaw_dispatch_status` isn't available)

```bash
# 1. Is the OS-level process alive?
Get-Process -Id <pid>          # Windows
ps -p <pid>                    # POSIX

# 2. Did the spawn wrapper actually run?
ls .brainclaw/coordination/runtime/ack/<asgn>.ack

# 3. What did the worker say? (pln#504)
cat .brainclaw/coordination/runtime/log/<asgn>.stderr.log
cat .brainclaw/coordination/runtime/log/<asgn>.stdout.log
```

### Deeper (1-5min)

```bash
# Full entity state — same fan-out bclaw_dispatch_status does for you
bclaw_get(entity="assignment", id="<asgn>")     # owner, ttls, status_reason
bclaw_get(entity="agent_run", id="<run>")       # pid, started_at, last_event_at
bclaw_get(entity="claim", id="<clm>")           # worktree, agent
bclaw_get(entity="loop", id="<lop>")            # current_phase, slot states

# Worktree activity
git -C <worktree> log --oneline -5              # any new commits?
git -C <worktree> status                        # uncommitted work?
ls <worktree>/REVIEW_FINDINGS.md                # for review loops
```

### Abort a dispatch cleanly

A dead dispatch needs four cleanup steps (no single facade does all of them today):

```text
1. Stop-Process -Id <pid>                                   # if pid still alive
2. bclaw_loop(intent="close", loop_id="<lop>", status="cancelled", reason="...")
3. bclaw_release_claim(id="<clm>")
4. (optional) bclaw_assignment_admin or leave assignment as `offered`
   — only the owning agent can transition assignment.status, and a
     released claim already makes it effectively orphan
```

---

## Per-agent spawn semantics

Spawn behaviour varies by agent. The capability profile in `src/core/agent-capability.ts` describes each agent's prompt delivery, sandbox model, and MCP availability. Per-agent caveats:

- [codex.md](../integrations/codex.md#caveats) — `--sandbox workspace-write` required; sandboxed codex reaches MCP but cannot `git commit` (dec#133 — coordinator harvests the worktree diff); stdin_pipe prompt delivery; brief-ack required for headless dispatch detection.
- [claude-code.md](../integrations/claude-code.md) — interactive vs `-p` headless modes; tools whitelist.
- [copilot.md](../integrations/copilot.md), [windsurf.md](../integrations/windsurf.md), [cline.md](../integrations/cline.md), [opencode.md](../integrations/opencode.md), [roo.md](../integrations/roo.md), [kilocode.md](../integrations/kilocode.md), [continue.md](../integrations/continue.md) — per-agent specifics.
- [mistral-vibe.md](../integrations/mistral-vibe.md) — EU/GDPR self-hosted option.

---

## See also

- [troubleshooting.md](troubleshooting.md) — symptom-driven diagnostic playbooks
- [loop-engine.md](loop-engine.md) — multi-turn loop protocol, locks, advance gates
- [multi-agent-workflows.md](multi-agent-workflows.md) — high-level coordination scenarios
- [../integrations/overview.md](../integrations/overview.md) — index of supported agents
- [../integrations/mcp.md](../integrations/mcp.md) — full MCP tool catalog
