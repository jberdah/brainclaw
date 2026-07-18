# Troubleshooting & recovery

Runbook for the most common ways a brainclaw workspace gets into a degraded state during multi-agent coordination, and how to bring it back. Symptoms first, causes second, remediation third — pattern-matchable when you don't have time to read the whole page.

This is **operator-facing**: it assumes you can run CLI commands. Agents you orchestrate don't read this page; you do, when something stalls.

## Quick-reference cheatsheet

| Symptom | First-line check | First-line fix |
|---|---|---|
| Agent crashed, claim still active | `brainclaw claim list` | `brainclaw claim release <id>` (or `brainclaw stale resolve <id>`) |
| Plan stuck `in_progress` for days | `brainclaw stale list` | `brainclaw stale resolve <plan_id>` (transitions to `dropped`) |
| Dispatched worker finished without committing | `git -C <worktree> status` | manually `git add` + `git commit` in the worktree, then merge |
| `Cannot find module 'mcp-worker.js'` | `brainclaw doctor` | `brainclaw doctor --repair` |
| Octopus merge fails on parallel lanes | `git status` | merge lanes one-by-one, resolve conflicts, then proceed |
| `.brainclaw/` schema looks corrupt | `brainclaw doctor --after-migration` | `brainclaw upgrade --rollback` (restores last backup) |
| Inbox messages stuck / not delivered | `brainclaw inbox list` | `brainclaw inbox ack <id>` or check `bclaw_assignment_events` |
| `bclaw_work` returns 25k-token error | n/a | already mitigated since v1.0.14 (compact mode default); pass `compact: true` if older clients |
| Stale runtime notes flood `bclaw_context` | `brainclaw stale list` | `brainclaw stale resolve <id>` per noisy item |

If your symptom isn't here, jump to the relevant section below or run `brainclaw doctor --json` and inspect the `checks` array.

---

## Stale claims after a crashed agent

**Symptom**: an agent died (credit limit, terminal closed, network drop). Other agents see the scope as held and refuse to claim it.

**Why**: claims are advisory locks with a TTL, but expiry is not enforced by a daemon — it surfaces only when something queries it. So a crashed agent's claim stays "active" until someone runs a check.

**Fix**:

```bash
# See what's stale (uses the staleness scoring from src/core/staleness.ts)
brainclaw stale list

# Release a specific stale claim
brainclaw claim release <claim_id>

# Or, for any stale entity (plan, handoff, candidate, runtime_note, claim),
# trigger the canonical action:
brainclaw stale resolve <id>
```

`stale resolve` dispatches to the right transition per entity:
- claim → release
- plan → `bclaw_transition(entity="plan", to="dropped")`
- handoff → `bclaw_transition(entity="handoff", to="closed")`
- candidate → `bclaw_transition(entity="candidate", to="rejected")`
- trap → `bclaw_transition(entity="trap", to="resolved")`
- runtime_note → `bclaw_remove(entity="runtime_note", id=…)`

**Prevention**: agents that respect the protocol call `bclaw_session_end(auto_release: true)` on exit, which releases all their claims. This is the recommended default in every dispatch brief.

---

## `bclaw_coordinate` refused with `dirty_working_tree`

**Symptom**: an `assign` / `review` / `reroute` dispatch returns
`dirty_working_tree` instead of spawning.

**Why**: the worker spawns from a worktree branched at HEAD, so uncommitted
edits in the source repo are invisible to it. The guard (trp#371) is
scope-aware — it refuses only when the uncommitted files **overlap**, or
cannot be proven disjoint from, the dispatch `scope`. `.brainclaw/` and
`.git/` are always ignored, and `consult` / `ideate` / `summarize` are never
guarded (they spawn no worktree). A scope that is not a resolvable file path
(a plan-id, loop-ref, or prose) cannot be proven disjoint, so the guard stays
conservative and refuses while the tree is dirty.

**Fixes**:

- Commit or stash the overlapping files, then re-dispatch (cleanest).
- Pass `allow_dirty: true` to proceed anyway — the block becomes a warning
  that lists the overlapping files.
- Pass a resolvable file `scope` (e.g. `src/foo.ts`) so the guard can prove the
  dirty files are out of scope.
- Pass `ref: <commit|branch|tag>` to build the worktree from an explicit ref —
  uncommitted working-tree changes are then intentionally out of scope.

---

## Dispatched worker finished work but never committed

**Symptom**: a sequence's lane shows the worker as "task_complete" in the run log, but `git -C <worktree-path> status` shows uncommitted changes.

**Why**: some agents (notably codex when running in `--sandbox workspace-write`) sometimes finish editing without ever creating a git commit — they exit on `task_complete` from the prompt without the wrap-up step. The brief-ack file confirms the spawn *started*, not that it *committed*. See `trp#178`.

**Fix** (manual harvest):

```bash
# 1. Locate the worktree
git worktree list | grep feat/pln_<lane_id>

# 2. cd into it, inspect the work
cd ~/.brainclaw/worktrees/<project-hash>/feat_pln_xxxx
git status
git diff --stat

# 3. Stage + commit with a clear message that references the plan id
git add <files>
git commit -m "feat(<scope>): <summary> (pln#<id>)"

# 4. Back on master, octopus-merge as usual
cd <main repo>
git merge --no-ff feat/pln_xxxx -m "merge: <description>"
```

**Prevention**: every dispatch brief targeting agents prone to this pattern (notably codex) should include explicit commit instructions at the end, e.g. *"When done editing, stage your changes and create a commit with a clear message referencing the plan id (e.g. `feat(scope): summary (pln#XXX)`). Do not stop until the commit exists."*

---

## MCP runtime corrupted (mcp-worker.js missing)

**Symptom**: `MCP error -32603: Cannot find module 'mcp-worker.js'` or the server logs `MCP runtime corrupted (mcp-worker.js missing)` on startup.

**Why**: `dist/` was wiped or partially deleted. Common causes: a `git merge` that triggered worktree cleanup before pln#477 landed, an `npm run clean:dist` followed by an interrupted build, or filesystem-level corruption.

**Fix**:

```bash
brainclaw doctor --repair
```

This rebuilds `dist/` from `src/` (TypeScript compile + copy default profiles) and validates by running `node dist/cli.js --version`. The repair also writes `dist/.brainclaw-build.json` so subsequent runs can do a stale-check (compare `src_hash` vs `dist_hash`).

**If `--repair` fails**: it usually means `node_modules` is also damaged. Run a clean `npm install` first, then re-run `brainclaw doctor --repair`.

**Note**: read-only MCP handlers stay available in-process even when the worker is missing (since pln#478) — so basic `bclaw_context` and `bclaw_find` calls still respond, but anything requiring the worker (most write operations) returns `runtime_corrupted` with a repair pointer.

---

## Octopus merge fails on parallel lanes

**Symptom**: after a sequenced parallel dispatch finishes, you run `git merge --no-ff lane1 lane2 lane3 -m "merge: …"` and git refuses with conflict markers.

**Why**: octopus merges only succeed when the lanes touch disjoint files. If two lanes wrote to the same file, octopus aborts and you must merge them sequentially.

**Fix**:

```bash
# Cancel the failed octopus
git merge --abort

# Merge lanes one at a time, resolving conflicts as needed
git merge --no-ff lane1
# (resolve any conflicts, commit)
git merge --no-ff lane2
# (resolve any conflicts, commit)
git merge --no-ff lane3
```

**Prevention**: when defining a sequence, choose lane scopes that minimize file overlap. Use `hard_after` dependencies for lanes that genuinely need to land in order. The dispatcher does not itself enforce disjoint scopes — that's the caller's responsibility when designing the sequence.

---

## `.brainclaw/` looks corrupted (schema drift, malformed JSON)

**Symptom**: `bclaw_doctor` reports `state is invalid: <ZodError>` or files in `.brainclaw/memory/` fail to parse.

**Why**: usually a half-written file from an interrupted write (process killed mid-write), a migration that didn't complete, or a manual edit that introduced syntax errors. `brainclaw upgrade --rollback` exists precisely for this case.

**Fix**:

```bash
# 1. Inspect what's wrong
brainclaw doctor --after-migration

# 2. If the most recent migration is the cause, roll back
brainclaw upgrade --rollback
# This restores the last backup at <store>.bak-<iso-ts>/ and parks the
# current corrupted store at <store>.rollback-<iso-ts>/ for inspection.

# 3. If a single file is corrupted (and rollback is too aggressive),
# inspect the parked rollback dir and copy individual files back manually.
```

**Prevention**: brainclaw takes a backup before every `upgrade` run (see `docs/concepts/upgrade-cli.md`). For non-upgrade scenarios, rely on git: `.brainclaw/` is git-versioned by default, so `git log` and `git checkout <prev>` recover any committed state.

---

## Plan stuck `in_progress`

**Symptom**: a plan has been marked `in_progress` for days with no commits or claim activity.

**Why**: the agent that started it crashed, was rerouted, or simply forgot to transition to `done` / `blocked` / `dropped`.

**Fix**:

```bash
# Survey
brainclaw stale list  # plan_in_progress flagged after 7 days by default

# Decide based on context
brainclaw stale resolve <plan_id>            # → dropped (default for stale)
# or, via canonical grammar, transition to a different terminal state:
# bclaw_transition(entity="plan", id="<plan_id>", to="done")
# bclaw_transition(entity="plan", id="<plan_id>", to="blocked")
```

**Threshold tuning**: defaults live in `src/core/staleness.ts`. A config-driven override is on the roadmap (open follow-up); for now you adjust the source file if 7 days is too aggressive for your project.

---

## Inbox messages stuck / brief-ack never arrived

**Symptom**: a dispatched assignment shows `running` indefinitely, and `bclaw_assignment_events` shows `run_running` but no further progress.

**Why**: the spawned worker process either (a) crashed before reading its inbox, (b) started but the brief-ack sentinel never fired (spawn wrapper died, wrong CODEX_HOME/auth, or the CLI exited early — NOT because the sandbox blocks MCP: dec#133 shows a sandboxed codex reaches MCP fine), or (c) is genuinely still working but slow.

**Diagnostic order**:

```bash
# 1. Is the worker process still alive?
ps -ef | grep <agent-binary>      # codex, claude, copilot, …
# Windows: Get-Process -Id <pid>   # or `tasklist /FI "PID eq <pid>"`

# 2. Did the brief-ack file land?
ls .brainclaw/coordination/runtime/ack/<assignment_id>.ack
# If yes → spawn started, worker is somewhere in its loop
# If no → spawn never started or died before the wrap shell ran touch

# 3. (pln#504) What did the worker actually say? stdout/stderr capture
# Spawned workers now route their streams to per-assignment log files. If the
# worker died silently, the error usually shows up here.
cat .brainclaw/coordination/runtime/log/<assignment_id>.stdout.log
cat .brainclaw/coordination/runtime/log/<assignment_id>.stderr.log

# 4. Inspect the worktree for activity
git -C <worktree> log --oneline -5
git -C <worktree> status

# 5. Check the run log
brainclaw inbox list --agent <agent>
# or via MCP: bclaw_assignment_events(assignmentId="<id>")
```

**Fix paths**:
- Worker dead, no ack → reroute via `bclaw_coordinate(intent="reroute", …)` to another agent
- Worker dead, ack present, work uncommitted → manual harvest (see "Dispatched worker finished without committing" above)
- Worker still alive but slow → wait, or `kill` and reroute

**Brief-ack TTL** is configurable via `BRAINCLAW_HANDSHAKE_TIMEOUT_MS` (default 30s since pln#475+#476). Past that, the dispatcher times the spawn out and surfaces the failure in the assignment events log.

---

## See also

- [`docs/concepts/dispatch-lifecycle.md`](dispatch-lifecycle.md) — the entity model + FSMs + observability decision tree underlying every diagnostic step on this page
- [`docs/concepts/memory-staleness.md`](memory-staleness.md) — staleness signals and resolve flow in depth
- [`docs/concepts/loop-engine.md`](loop-engine.md) — multi-turn loops (review-fix), recovery semantics for in-flight loops
- [`docs/concepts/upgrade-cli.md`](upgrade-cli.md) — `brainclaw upgrade` design + rollback path
- [`docs/cli.md`](../cli.md) — full command reference for `doctor`, `stale`, `claim`, `upgrade`, `inbox`, `worktree`
- [`docs/concepts/multi-agent-workflows.md`](multi-agent-workflows.md) — happy-path coordination patterns (the inverse of this page)
