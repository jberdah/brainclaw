# Coordinator runbook

Operational procedures for running multi-agent dispatches, distilled from the
2026-06-10 coordination session (pln#554). Audience: the coordinator — human or
agent — who dispatched workers and now has to triage what came back (or didn't).

Rule zero across everything below: **evidence before verdict**. Administrative
status (assignment/run records) is the WEAKEST signal; worker-written results
and git state are the strongest. Acting on administrative status alone expired
live workers three times in one night (can_948acfd6).

## 1. Baseline triage — is it actually a regression?

Before calling anything a regression, run the exact same check on the
pre-change ref. Twice in the 2026-06-10 session a "sprint-1 regression" turned
out to be a bug that had always existed — manual workflows had simply masked it
(see also trap: bisect state before code).

Procedure:

1. Reproduce the failure on the current ref. Capture the command verbatim.
2. `git stash` nothing, delete nothing — check out the pre-change ref in a
   SEPARATE worktree (`git worktree add ../baseline <ref>`).
3. Run the same command there.
   - Fails on the baseline too → not a regression. Re-scope the bug, exonerate
     the change, and continue the dispatch.
   - Passes on the baseline → real regression; only now is bisecting the diff
     worth the time.
4. Before bisecting code at all, read the historical ENTITY state first
   (assignment / event / completed_at records): the May 2026 codex
   `run_completed` "regression" was state drift, not code.

## 2. Dead-worker decision tree

A worker looks dead (stale heartbeat, exited process, expired assignment).
Collect worktree evidence BEFORE any kill / reroute / re-dispatch — recovery is
cheap, a wrongly killed worker is not.

```
worker presumed dead
│
├─ 1. LANE-RESULT.json at the worktree root?
│     yes → it FINISHED. `brainclaw harvest <asgn> [--integrate]`. Done.
│
├─ 2. git evidence (shared helper: commits_ahead + dirty_tracked,
│     surfaced by dispatch-status / dispatch watch):
│     commits ahead + CLEAN tracked tree
│        → worker delivered, only exit formalities missing.
│          Harvest/merge it. NEVER kill-and-reroute a delivered lane.
│
├─ 3. dirty tracked files? → work in flight. Check liveness before declaring death:
│     ├─ fs mtime fresh (logs/worktree written < ~5 min)? → ALIVE, leave it.
│     ├─ real agent child process under the wrapper pid?
│     │   (wrapper alive + child gone = abrupt death; orphaned grandchildren
│     │   hold the pipes open so the wrapper never emits a sentinel)
│     └─ both dead + fs stale → recover, do not re-dispatch blind:
│           `brainclaw harvest <asgn> --orphaned`
│           (typecheck if possible → commit on-behalf with the standard
│            marker → lifecycle → release claim → run targeted tests + merge)
│
└─ 4. clean tree, no commits ahead, no result → nothing to recover.
      Now (and only now) reroute / re-dispatch.
```

Hard rules:

- Never delete or reset a worktree during triage — the diff on disk IS the
  recovery (twice on 2026-06-10: 42 and 41 files recovered, zero loss).
- Never kill processes by name; source the pid from agent_run.pid and
  cross-check launched_at (the operator's IDE runs the same binaries).
- A failed observation is not evidence: "could not probe the child process"
  must never be read as "the child is dead".

## 3. Post-dispatch verification reflex

Delivery is not execution. `delivered_and_started` means the message landed and
a process spawned — not that the worker reached its work loop.

After every dispatch:

1. `bclaw_dispatch_status(target_id: <asgn|clm|run>)` — one call resolves the
   assignment, claim, run, heartbeat, logs, lane-result, and git evidence into
   a single health verdict + next action.
2. Or query directly: `bclaw_find(entity: "agent_run", message_id: <msg>)` —
   no run record means the spawn never produced a process.
3. Expect the step-0 heartbeat (`.brainclaw-heartbeat-<asgn>` at the worktree
   root) within the first minutes. Missing heartbeat + no fs activity = the
   worker never reached its loop; check the captured stderr for boot
   signatures (model/config mismatches are diagnosed by dispatch-status).

Known gap: `intent=ideate` dispatches are inbox-only (can_29f1e1ac) — there is
no agent_run to verify; track those by reply message, not by run records.

## 4. `brainclaw dispatch watch` — monitor contract

Blocking watch over one dispatch; encodes the decision tree above as a poller.

```
brainclaw dispatch watch <asgn_|clm_|run_> [--interval 60] [--timeout 90] [--base master] [--json]
```

Exit codes (script on these, not on the log text):

| code | state                | meaning / next action                                   |
|------|----------------------|---------------------------------------------------------|
| 0    | done                 | lane-result, run completed, or committed-clean → harvest |
| 2    | timeout              | worker still running at --timeout → re-run or inspect    |
| 3    | failed               | lane-result/run reported failure → read stderr, fix      |
| 4    | worker-process-gone  | dead with uncommitted work → `harvest --orphaned`        |
| 5    | unresolved           | target id did not resolve to anything                    |

Evidence priority inside the watch (strongest first): worker-written results >
git evidence > process evidence > administrative status. Fresh filesystem
activity vetoes process-gone verdicts (a stale tracked pid after a manual
respawn must not kill a worker that is visibly writing).

## Cross-references

- can_948acfd6 — assignment expired while the worker was delivering; git
  evidence outranks administrative status.
- can_d622e024 — claude -p "delivered-but-end-stalled": committed-clean is done.
- can_9458576e — wrapper-alive/child-dead death mode (orphaned pipe holders).
- can_29f1e1ac — intent=ideate is inbox-only; no run record to verify.
- cnd_asgn_7336aa79_heartbeat_sandbox / can_asgn_b0169fd8_heartbeat — sandboxes
  refuse absolute heartbeat paths; briefs point sandboxed workers at a
  worktree-relative path.
- trap: agent shell env contaminates tests — strip BRAINCLAW_CWD/_AGENT before
  running suites from an agent shell.
- docs/concepts/dispatch-lifecycle.md — full entity/FSM model behind all of this.
