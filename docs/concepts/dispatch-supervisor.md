# Dispatch supervisor — coordination-enforcement spec (round 3)

**Status:** design spec, revised after the Codex round-3 review (PR #47) — all 7 findings integrated (A0→B hard dependency, explicit `checkSpawnEligibility` contract, run-identity schema migration in A0 scope, cascade wired on the reconciler failure path, `createWorktree` removed from the F7 gate list, tightened never-adopted exemption, completed F10 host-mismatch/no-signal rows). Ready for implementation starting at A0.
**Plan:** pln#545 (feat/coordination-enforcement).
**Predecessors:** round-2 pivot review (folded into this assignment brief); round-2 baseline resolved F1, F3, F4, F5, F6; round-3 Codex review (loop lop_f212bbabb8f7310f) resolved the 7 spec↔code mismatches.
**Companion docs:** [dispatch-lifecycle.md](dispatch-lifecycle.md) (entities + FSMs), [parallel-merge-protocol.md](parallel-merge-protocol.md) (merge safety), [coordinator-runbook.md](coordinator-runbook.md) (operator patterns).

This doc is doc-only. It specifies WHAT changes and WHY. Implementation lands as separate A0-first increments (see §7), each with its own code-review loop.

---

## 1. Executive summary

Current dispatch spawns a worker as `spawn("shell", [ack-wrap "<agent>"])`. The tracked `pid` on the agent_run is the ack-wrap SHELL's pid, not the worker's. That shell exits early on Windows (`cmd.exe` → `.cmd` → `node.exe` shim), so:

- The reconciler's `isProcessAlive(run.pid)` reads the wrapper's dead pid and calls the worker dead while the real worker keeps writing files (`can_f792cacd` — 6 workers cancelled while committing, 4–7 min after "death").
- The `completed` / `failed` sentinels are keyed by `assignment_id`, so a re-dispatch that reuses the same assignment inherits the prior attempt's signal — a stale-nonce false-positive we cannot rule out today.
- Nothing owns the child's stdout/stderr file descriptors; the ack-wrap redirects at the shell level, which the codex.cmd shim breaks (the empty-logs symptom in `can_f792cacd`).

The round-2 pivot: replace the shell ack-wrap with a **Node supervisor process** that (a) owns the spawn of the real worker, (b) owns its stdout/stderr fds, (c) stays alive until the worker's process tree exits, and (d) emits `run_id`-keyed sentinels only after the real child is gone. That single change resolves the central false premise every downstream problem inherited.

The supervisor is a small helper binary shipped in the coordinator install, started as the immediate child of the dispatch entrypoint. It is NOT another agent, NOT persistent, and NOT stateful across dispatches — it is a per-run process wrapper whose only job is honest liveness attribution.

**A0** — the first incremental delivery — creates the `agent_run` right after spawn-eligibility passes and BEFORE the spawn, and adds the run-identity fields (`host_id`/`host_os`/`boot_id`/`start_time_hint`) to the schema. **A0 is a HARD prerequisite for B**, not a soft one (Codex review of PR #47, HIGH): the supervisor keys its sentinels on `run_id` and needs the run to exist before it spawns, but today both entrypoints call `attemptExecution` → `adapter.start(assignmentId)` BEFORE `createAgentRun` and `runtime-signals.ts` is assignment-keyed — so a supervisor shipped without A0 has no `run_id` to write `<run_id>.*` sentinels with. There is no safe "B without A0" rollback; §5.2 documents what the reconciler does for the identity-none runs A0 has not yet reached, but B itself does not ship until A0 is deployed.

---

## 2. Round-2 baseline (what is already settled)

The following resolutions from round 2 stand as-is and are the contract this spec builds on.

**F1 — supervisor knows the real worker pid.**
The Node supervisor `spawn()`s the worker directly (no `shell:true`, no `.cmd` shim indirection where we can avoid it). The supervisor records the worker's real pid on the agent_run. `run.pid` on the record refers to the worker, not any shell wrapper.

**F3 — start_time is one factor of ProcessIdentity, not the sole factor.**
`ProcessIdentity` is `{ host_id, host_os, boot_id, pid, start_time_hint }`. On any host we cannot reliably read `start_time` for (Windows without WMI / Job-Object attach failure, macOS `ps` variance), the reconciler MUST NOT call the worker dead solely on a pid-mismatch: a missing `start_time_hint` is `unknown`, not `mismatched`. `start_time_hint` remains a corroborating signal for pid re-use detection, not a hard veto.

**F4 — host_id / host_os / boot_id scope identity per machine.**
Two workers with the same pid on different hosts are unambiguously distinct. `boot_id` distinguishes two workers with the same pid on the same host across a reboot. The reconciler MUST veto liveness verdicts whose `host_id` does not match the host currently running the reconciler pass — it cannot decide anything about a foreign host's pid.

**F5 — run-keyed supervisor signals after the real child exits; legacy assignment-keyed sentinels are legacy-only.**
New signals: `runtime/signal/<run_id>.completed`, `runtime/signal/<run_id>.failed`, `runtime/signal/<run_id>.launched`, `runtime/signal/<run_id>.exited`. Written only by the supervisor, only after the worker's process tree has actually exited. Legacy `<assignment_id>.completed|.failed|.ack|.heartbeat` remain accepted for backwards compatibility with in-flight or manually-spawned workers, but are downgraded to *corroborating* evidence — the run-keyed set is authoritative when present.

**F6 — three split predicates.**
A single "is this worker alive" question is decomposed into three predicates with distinct callers, distinct evidence bars, and distinct failure modes:

- **`orphan_recover_veto(run)`** — hard veto used by the reconciler and the claim-release cascade before it declares a run orphaned. Returns `veto` when we see *any* evidence of life (pid alive on this host, recent heartbeat, recent fs-activity in the worktree, run-keyed sentinel absence, live supervisor). Returns `no_veto` only when the whole surface is quiet.
- **`ingest_result_authoritative(run)`** — used by `bclaw_dispatch_status`, harvest, and the completion path. Returns a verdict ONLY on a run-keyed `completed`/`failed` sentinel AND a matching nonce AND a subsequent quiescence period (heartbeat + fs-activity have not moved since the sentinel timestamp). Never guesses.
- **`merge_safe(worktree)`** — used by worktree merge/reset/remove. Returns `safe` only when there is evidence of a completed run (LANE-RESULT.json OR authoritative sentinel OR claim is released) AND no fs-activity in the worktree in the last N seconds (N configurable, default 30s).

The three CANNOT collapse to one predicate. Merging them is the exact class of bug that produced the 2026-07-04 incident (§6).

---

## 3. Detailed round-3 spec

Round 3 is spec depth against the round-2 baseline. No new architectural surface.

Code references below re-anchor against current master (post PRs #40 squash-aware GC + creation-ref evidence, #41 model routing, #42 auto-repair, #44 releaseClaimWithCascade + coordinator_override, #45 context perf). The plan's original paths (`src/dispatcher.ts`, `src/mcp.ts`, `src/execution.ts`, `src/worktree.ts`, `src/claims.ts`, `src/agentruns.ts`) refer to a pre-refactor layout; source now lives under `src/core/` and `src/commands/`.

### 3.1 F2 / F9 — A0: `createAgentRun` after spawn-eligibility, before the spawn

A0 is the observability + run-identity increment, and B's HARD prerequisite (§1, §7): it moves run creation before the spawn AND adds the identity fields the supervisor writes. B cannot ship without it, because the supervisor keys its sentinels on a `run_id` that must exist before `adapter.start`.

**Both dispatch entrypoints are in scope.** They share structure but not code today and are both structurally identical for A0's purposes:

- `src/core/dispatcher.ts:1146–1266` — the automatic dispatcher's E2E execution phase (post-refactor equivalent of `dispatcher.ts:1150–1238` in the plan). `attemptExecution` is called (line 1146), and both `createAgentRun` calls happen post-hoc: the `spawn_no_handshake` branch at line 1168 and the nominal branch at line 1213.
- `src/commands/mcp.ts:5948–6072` — the `bclaw_coordinate` E2E path (post-refactor equivalent of `mcp.ts:5447–5557`). `attemptExecution` at line 5955, then `createAgentRun` at line 5978 (`spawn_no_handshake`) and line 6020 (nominal).

Split the execution API into three pieces. The eligibility contract is EXPLICIT about which ineligible states consume an `attempt_index` (Codex review of PR #47, HIGH — the earlier draft named worktree/capacity/canSpawn as both "no-run exits" AND "failed runs", which is contradictory; in the real code they are all branches inside `attemptExecution` at `src/core/execution.ts:215–281` / `344–366` returning `command_ready_manual` with a failure kind):

- **`checkSpawnEligibility(...) → { eligible: true } | { eligible: false, record_run: boolean, failure_kind, reason }`** — the single classifier. `record_run` is the decisive field:
  - `record_run: false` — intentional non-spawns that must NOT consume an attempt: `inbox_only` (delivery channel = inbox), and `command_ready_manual` caused by `autoExecute=false` (the operator will launch by hand). No run, no `attempt_index`.
  - `record_run: true` — spawn ATTEMPTS that failed pre-spawn and must be honest in the run history: `spawn_no_worktree`, `spawn_capacity`, `!canSpawn` (agent not spawn-capable and not an opt-out manual path), and `!invoke` (no invoke command). These get a run in terminal `failed` with the `failure_kind`, consuming an `attempt_index`.
- **`beginAgentRun(...)`** — when eligible, creates the `agent_run` in status `created` BEFORE `attemptExecution` calls `adapter.start(...)`, stamping the identity fields (see schema migration below).
- **`transitionAgentRun(run.id, 'launching' | 'failed', ...)`** — called with the spawn outcome and the pid the supervisor reports; an adapter throw (spawn ENOENT) transitions `created → failed` with `failure_kind='spawn_failed'`.

**Schema migration is A0 scope (Codex review of PR #47, HIGH).** `AgentRunSchema` (`src/core/schema.ts`, the run record — today only `pid` among identity fields) and `CreateAgentRunOptions` (`src/core/agentruns.ts`) currently declare NONE of `host_id` / `host_os` / `boot_id` / `start_time_hint`, so a naive `createAgentRun({ host_id, … })` would have zod strip them and the matrix's `identity_partial`/`identity_full` states would never materialise. A0 MUST add these optional fields to both the schema and the create/begin options, and ship a persistence test proving a written run round-trips them. B later writes `start_time_hint` (from the supervisor) into the same typed fields — never via tags or unknown properties.

`beginAgentRun` MUST take the assignment id and set `attempt_index` via `nextAttemptIndex(assignment_id, cwd)` in `src/core/agentruns.ts:96–100` — this field already exists and increments correctly today, but only because we create the run once per attempt. A0 keeps that invariant across attempts by:

- Setting `retry_of_run_id` (already a field, `src/core/agentruns.ts:132`) on every run except the first attempt for a given assignment, pointing at the previous attempt's run_id. Failed pre-spawn attempts (worktree missing, capacity full, spawn ENOENT) STILL consume an `attempt_index` and STILL get a `run` in a terminal status (`failed` with a specific `failure_kind`). This is what makes the run history honest — the current path silently discards failed pre-spawn attempts, which is why the `dispatch_status` UI can show a re-dispatched assignment as "never attempted" even after two failed spawns.
- Recording the pre-spawn failure reason on the run's `status_reason` and audit entry.

**Invariant:** A0 does not introduce ANY new trust in assignment-keyed legacy signals. Everything downstream that reads `ack` / `completed` / `failed` today keeps its current behaviour. A0 changes WHEN a run is created; it does not change WHAT the reconciler trusts. B is the layer that shifts trust to run-keyed signals.

**Failure modes covered by A0:**

- Pre-spawn failure (worktree missing, capacity, canSpawn=false when not opt-out) → run exists in `failed`, `failure_kind` labelled, next dispatch increments `attempt_index`.
- Spawn ENOENT / adapter throws → run exists in `created`, transitioned to `failed` with `failure_kind='spawn_failed'`. Today's code creates a run only in the handshake-timeout branch (spawn returned a pid but the ack never appeared), so the ENOENT case leaves a hole.
- Handshake timeout → unchanged from today; supervisor B will refine.

**Non-goals of A0:** no supervisor, no new sentinels, no reconciler changes. Only the run creation timing.

### 3.2 F7 — worktree-mutation gate at core chokepoints, not callers

The round-2 principle was "guard mutations behind an aliveness check." Round 3 pins the exact placement: the gate is inside the mutating core functions, not sprinkled across callers.

Introduce `assertWorktreeMutationSafe(worktreePath, intent, options)` in `src/core/worktree.ts`. It calls `merge_safe(worktree)` (F6) and throws a typed `WorktreeMutationBlockedError` when it is not safe. Called at:

- `commitWorktreeOnBehalf` (`src/core/worktree.ts:327`) — the coordinator commits on behalf of a worker at harvest. The gate ensures the worker has actually stopped writing before we commit its tree. Passing without the check races the worker's own commit.
- `resetWorktreeToRef` (`src/core/worktree.ts:400`) — hard reset destroys uncommitted work. Never safe while a worker is active.
- `removeWorktree` (`src/core/worktree.ts:1032`) — removing while a worker's fd is open on a file inside kills the worker in a way that leaves no signal.
- `mergeWorktreeBranch` (`src/core/worktree.ts:1409`) — the parasitic-deletion restoration step (lines 1430–1444) only runs if the merge itself proceeds; a live worker mid-commit produces exactly the kind of partial branch content that turns into a parasitic deletion after merge.
`createWorktree` is deliberately NOT in this list (Codex review of PR #47, MED — the earlier draft anchored it to the wrong behaviour). Current `createWorktree` (`src/core/worktree.ts`) rejects an existing target path (`:568–572`) and a branch already checked out in an attached worktree (`:582–588`); its force-reset branch (`:590–621`) is a `git branch --force` on an *unattached* branch, which destroys no live worktree. The actual reused-claim worktree reset happens elsewhere — `createCoordinatorClaim` calls `resetWorktreeToRef` at `src/core/claims.ts:910–912`, and `resetWorktreeToRef` is already gated above. So worktree-liveness safety for reuse rides on `resetWorktreeToRef`; `createWorktree` would need a *different* guard (branch-destruction, different evidence) and is out of scope for F7.

The gate is placed inside these functions, not at the CLI/MCP callers (`src/commands/worktree.ts:79–159`, and the MCP handlers). This closes the class of "someone added a new caller and forgot to gate" bugs.

**Explicit exemption (with reason and audit line):** `cleanMergedWorktrees` and the never-dispatched-cleanup path. **The exemption must NOT rely on `never-adopted` alone** (Codex review of PR #47, MED): `assessClaimLiveness` (`src/core/claims.ts:768–782`) classifies `never-adopted` purely as "no `session_id` ever assigned and older than the stale threshold" — but a sandboxed / zero-MCP worker legitimately runs WITHOUT adopting the claim's session, so it can have a live assignment/run, a fresh heartbeat, and a written LANE-RESULT while the claim still reads `never-adopted`. Bypassing the gate on that status alone could delete a live or already-delivered worker tree. The exemption therefore requires POSITIVE proof of no worker: no assignment/agent_run references the claim, AND no heartbeat / LANE-RESULT / fs activity in the worktree within the freshness window. Only then is removal safe. The exemption call:

```ts
// Signature (illustrative — do not treat as final API):
assertWorktreeMutationSafe(worktreePath, intent, {
  exempt_reason: 'never-adopted-claim-cleanup',
  audit_actor: 'coordinator',
  // Guard must verify ALL before bypassing (Codex PR#47 MED):
  proof: {
    no_assignment_or_run: true,   // no assignment/agent_run references this claim
    no_recent_heartbeat: true,    // no heartbeat within the freshness window
    no_lane_result: true,         // no LANE-RESULT.json at the worktree root
    no_fs_activity: true,         // no worktree fs activity within the window
  },
});
```

The exemption is recorded in the audit log (actor + reason + claim id + worktree + the four proof fields). If a "never-adopted" claim is actually being adopted late (a race), the proof check fails and the gate holds; the audit trail names who attempted the bypass.

**Test bar for F7:** two callers exercising each chokepoint (one blocked by an active worker, one exempted or passing) plus a regression test that a caller added tomorrow — with no manual guard — still cannot mutate a live worktree.

### 3.3 F8 — Windows Job Object mechanism, FAIL-CLOSED, breakaway detection

The supervisor's tree-kill guarantee is what makes cancellation honest. On Windows, this requires a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and the worker process assigned to it before it spawns children.

Node's built-in `child_process.spawn` does NOT expose Job Objects. We need one of:

| Option | Approach | Verdict |
|---|---|---|
| A | Native N-API helper (`brainclaw-supervisor.node`) bundled with the package | **Chosen.** Native code owns the Job Object; the JS layer never touches HANDLE lifetimes. |
| B | FFI via `koffi` or similar to call `CreateJobObjectW` / `AssignProcessToJobObject` / `SetInformationJobObject` directly | Rejected: FFI on Windows is brittle across Node versions; a HANDLE leak would silently break tree-kill. |
| C | Wrap the spawn in a PowerShell script that uses `Add-Type` with C# to create a Job Object | Rejected: PS startup latency, quoting minefield, and no way to hand the HANDLE back to the parent to add later children. |
| D | Ship a small tested `supervisor.exe` written in Rust/Go | Second choice if the N-API helper fails a Node-version bump. Larger install, extra binary per platform. |

**Chosen: A — native N-API helper.** Rationale:

- Job Object HANDLE lives in the supervisor process's own address space; the JS supervisor process (which IS the parent of the worker) does the `AssignProcessToJobObject` call, and when the supervisor process exits FOR ANY REASON, the OS closes the HANDLE, `KILL_ON_JOB_CLOSE` fires, and the entire tree dies. This is the guarantee we need.
- N-API isolates us from V8 ABI churn — the helper compiles once per platform and works across Node minors without rebuild.
- Prebuilt binaries per (Windows) architecture in the npm tarball; `postinstall` picks the right one, no compile toolchain on user machines.

**FAIL-CLOSED.** If the N-API helper cannot be loaded OR the Job Object cannot be created OR the worker cannot be assigned to it, the supervisor MUST refuse to spawn. `execution_status = 'command_ready_manual'` with `failure_kind = 'supervisor_unavailable'`, `error = 'Windows Job Object could not be created; refusing to spawn without validated tree-kill'`. This is a deliberate reversal of today's behaviour where a broken supervisor would silently degrade to "spawn and hope." A validated tree-kill capability is the whole point of B; without it, we do not spawn.

**Breakaway detection.** A Windows child process can escape a Job Object with `CREATE_BREAKAWAY_FROM_JOB` if the Job Object has `JOB_OBJECT_LIMIT_BREAKAWAY_OK` set OR the child has SeTcbPrivilege. The supervisor MUST:

- Set `JOB_OBJECT_LIMIT_BREAKAWAY_OK = false` and `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK = false` in the Job Object information class.
- After spawn, call `IsProcessInJob(worker_pid, job_handle, &result)` and refuse the spawn (kill the child, return `supervisor_unavailable`) if the worker somehow escaped. This is defence-in-depth; today, no worker we ship needs breakaway, so a `false` result is a bug and we should say so.
- Log `job_object_verified=true|false` on every supervisor launch; a `false` value on any dispatch is a fleet-wide alert (see the reconciler recommended action in §5).

**POSIX label — honest naming.** On POSIX we use `setsid()` to place the worker in its own process group and kill via `killpg(-pid, SIGTERM)` then `SIGKILL` after a grace period. We label this capability **`validated pgroup kill`**, not "guaranteed tree-kill." Rationale: a nested worker process can itself call `setsid()` again and escape the group. In practice today's spawned agents do not (codex, claude, copilot, cline, gemini, opencode all inherit the pgroup and stay in it). The label is honest so a future agent that DOES escape is not silently uncovered.

### 3.4 F10 — complete behavior matrix

The matrix specifies, for every axis crossing, what the reconciler + `bclaw_dispatch_status` + the mutation gate do. Rows: identity present/absent (does the run record carry `host_id` + `boot_id` + `start_time_hint`?). Columns: host match/mismatch (is the reconciler running on the same host?) × signal version (run-keyed / assignment-keyed / none).

See §5 below for the full table. The matrix explicitly covers the **B-before-A0 rollback case** — the deployment order where the supervisor lands before the run-creation shift. In that case, B has no supervisor identity on runs created by the old code path, and the reconciler MUST no-op to "legacy conservative" behaviour (assignment-keyed signals, `isProcessAlive(run.pid)`) for those specific runs. This lets B roll forward and back safely.

---

## 4. Living invariants — the round-3 spec MUST NOT contradict

These invariants have landed in master since the plan was written (PRs #40–#45) and constrain the supervisor design. Each is a real behaviour the current fleet relies on; a spec that breaks it is a regression.

| Invariant | Landed by | What it means for the supervisor |
|---|---|---|
| `dispatch_status` counts commits ahead via **patch-id**, not just ancestry, so a squash-merged commit reads as 0-ahead | PR #40 (`src/core/dispatch-status.ts:82–98`, `commits_ahead` docstring) | The supervisor's `ingest_result_authoritative` verdict MUST not contradict a `commits_ahead=0` reading — a worker whose patch is on master is done, even if the branch head diverges. |
| Worktree `.brainclaw-worktree.json` sidecars now record their **creation SHA**; `commits_ahead_base` and `commits_ahead_raw` are surfaced separately | PR #40 (`src/core/dispatch-status.ts:82–106`) | `merge_safe` uses the sidecar creation SHA as the base, not moving `master`. Legacy sidecars without the SHA report `commits_ahead=unknown`; the gate treats `unknown` as "insufficient evidence" — falls back to fs-activity + LANE-RESULT. |
| `releaseClaimWithCascade` propagates plan status with a last-claim rule and audits every cascade decision | PR #44 (`src/core/claims.ts:313–431`) | **The reconciler failure path does NOT use it yet** — `src/core/agentrun-reconciler.ts` imports `releaseClaim` (line 38) and calls `releaseClaim(run.claim_id, cwd)` (line 297), the non-cascading variant (Codex review of PR #47, HIGH — the earlier draft wrongly claimed the cascade was already wired). Increment B's scope therefore INCLUDES replacing that call with `releaseClaimWithCascade(run.claim_id, cwd, { planStatus: <explicit> })` plus a test that the last-claim plan cascade fires on `run_failed`. Until B lands, an orphan-recovered run releases its claim WITHOUT cascading plan status — the current, documented behaviour, not a regression. |
| `coordinator_override:true` provides an audited ownership bypass for release calls | PR #44 (`src/core/claims.ts:200–208, 473–521`) | The supervisor never uses `coordinator_override` — it operates as a system caller (auth undefined) with the same bypass. Human operators keep the override for manual recovery. |
| Model routing per agent (`ec49e6c`) is a spawn-time concern only | PR #41 | The supervisor does not need to know which model was selected; it only knows the invoke command. |
| Auto-repair of identity + session on canonical writes | PR #42 | The supervisor's writes to the run record MUST tolerate identity auto-repair — do not assume the run's `agent_id` matches the coordinator's `BRAINCLAW_AGENT_ID` at time of read; look it up fresh. |

The spec below is written to be consistent with all six invariants.

---

## 5. F10 — the behavior matrix (complete)

**Legend:**

- `RK` — run-keyed sentinel present (`runtime/signal/<run_id>.completed|.failed|.exited`).
- `AK` — legacy assignment-keyed sentinel present (`runtime/signal/<assignment_id>.completed|.failed`).
- `identity_full` — run record has `{ host_id, host_os, boot_id, start_time_hint }`.
- `identity_partial` — run record has `{ host_id }` but is missing one or more of the other three (a run written by an older coordinator, or a partial supervisor init).
- `identity_none` — pre-A0 / pre-B run: only `pid`, no host scoping.
- `host_match` — reconciler runs on the same host_id as the run record.
- `host_mismatch` — reconciler runs on a different host.

The four decisions the matrix must specify:

1. **`orphan_recover_veto`** — what the claim-release cascade + reconciler orphan pass decide.
2. **`ingest_result`** — what `bclaw_dispatch_status` + harvest report.
3. **`merge_safe`** — whether `assertWorktreeMutationSafe` lets the mutation through.
4. **Reconciler recommended action** — what a human operator sees.

### 5.1 Steady state — B and A0 both deployed

Every row here has `identity_full`.

| Row | Signals present | host_match? | orphan_recover_veto | ingest_result | merge_safe | Reconciler rec |
|---|---|---|---|---|---|---|
| S1 | RK + LANE-RESULT | match | `no_veto` (worker done) | authoritative from RK | `safe` | ingest + release claim |
| S2 | RK only, no LANE-RESULT | match | `no_veto` | authoritative from RK | `safe` | ingest + release claim |
| S3 | AK only (worker used legacy path) | match | `no_veto` (corroborated by AK + quiescence) | corroborating; verdict from claim/assignment state | `safe` if quiescent | ingest with `legacy_signal` audit note |
| S4 | none, pid alive on host | match | **`veto`** | none | `blocked` | wait; heartbeat check |
| S5 | none, pid dead on host, no fs-activity in worktree for > N | match | `no_veto` | `silent_death` — declare `failed` with `silent_termination_no_evidence` | `safe` | GC cascade + audit |
| S6 | none, pid dead on host, recent fs-activity in worktree | match | **`veto`** | none — worker likely respawned via IDE/detached | `blocked` | wait; investigate |
| S7a | RK completed/failed + nonce, host_mismatch | mismatch | **`veto`** (cannot judge a foreign pid) | **authoritative from RK** — the run-keyed sentinel is a FACT written by the owning host's supervisor, not a local pid judgement (Codex review of PR #47, HIGH — the earlier S7 wrongly blocked an authoritative RK verdict on host mismatch) | `blocked` (merge/GC run on the owning host) | ingest the verdict; defer any worktree op to that host |
| S7b | AK-only or no signals, host_mismatch | mismatch | **`veto`** | `unknown_host` (cannot infer a foreign pid's fate without a sentinel) | `blocked` | escalate to that host's coordinator |

### 5.2 Legacy runs — `identity_none` records created before A0

A0 is a hard prerequisite for B (§1, §3.1), so "B running without A0" cannot happen by fresh deployment. What CAN happen: a fleet on A0+B still has OLD `agent_run` records in its store, created by the pre-A0 code path (post-hoc, only in the handshake-timeout branch) and carrying `identity_none`. B must degrade gracefully on those rows rather than mis-judge them. This table is that degradation contract.

| Row | Signals present | pid alive? | orphan_recover_veto | ingest_result | merge_safe | Reconciler rec |
|---|---|---|---|---|---|---|
| R1 | RK present (supervisor ran anyway) | irrelevant | delegate to steady-state row (S1/S2) | authoritative from RK | `safe` | ingest — supervisor was active even without A0 |
| R2 | AK only, pid alive | alive | **`veto`** | none | `blocked` | wait; **legacy-conservative** mode — same as today |
| R3 | AK only, pid dead, no fs-activity | dead | `no_veto` | best-effort from AK + assignment state | `safe` | GC as today |
| R4 | AK only, pid dead, recent fs-activity | dead | **`veto`** | none | `blocked` | wait; **legacy-conservative** |
| R5 | no signals, pid alive | alive | **`veto`** | none | `blocked` | wait |
| R6 | no signals, pid dead, no fs-activity | dead | `no_veto` | `silent_death` | `safe` | GC + audit |

**Rule:** B, when it encounters an `identity_none` legacy record, behaves EXACTLY like today's code (legacy-conservative: assignment-keyed signals + `isProcessAlive(run.pid)`). It never invents a `run_id` sentinel for a run that predates A0. This bounded back-compat — not a rollback path — is what lets B ship without a store migration of historical runs. Row R1 (a legacy record that nonetheless has an RK sentinel) only arises if a supervisor was manually pointed at it; it is included for completeness, not as a supported deploy order.

### 5.3 A0-deployed, B-not-deployed (or B rolled back)

Runs carry `identity_partial` — `host_id` and `boot_id` from the coordinator, but no `start_time_hint` (because there is no supervisor to record the OS-reported start time of the worker). Signals are still assignment-keyed today.

| Row | Signals present | host_match? | pid alive? | orphan_recover_veto | ingest_result | merge_safe | Reconciler rec |
|---|---|---|---|---|---|---|---|
| P1 | AK completed / failed | match | irrelevant | `no_veto` | authoritative from AK (nonce check via message_id linkage) | `safe` | ingest |
| P2 | AK ack only, pid alive | match | alive | **`veto`** | none | `blocked` | wait |
| P3 | AK ack only, pid dead, no fs-activity for > N | match | dead | `no_veto` | `silent_death` | `safe` | GC + audit — note `identity_partial` in audit |
| P4 | AK ack only, pid dead, recent fs-activity | match | dead | **`veto`** | none | `blocked` | wait — likely IDE-respawned child, look for heartbeat |
| P5 | none, pid alive | match | alive | **`veto`** | none | `blocked` | wait |
| P7 | none, pid dead, no fs-activity for > N | match | dead | `no_veto` | `silent_death` (audit notes `identity_partial`) | `safe` | GC + audit |
| P8 | none, pid dead, recent fs-activity | match | dead | **`veto`** | none | `blocked` | wait — IDE-respawn suspected (Codex review of PR #47, HIGH — the no-signal dead-pid rows were missing) |
| P6 | AK-only or none, host_mismatch | mismatch | irrelevant | **`veto`** | `unknown_host` (no RK possible in A0-only, since B is not deployed) | `blocked` | escalate to that host |

**Rule for A0-only:** the run record gets richer (`host_id`, `boot_id`, per-attempt `retry_of_run_id`, honest `attempt_index`), but the reconciler still uses `isProcessAlive(run.pid)` where `run.pid` is the ack-wrap SHELL's pid. Nothing gets more trustworthy — the record just gets more diagnosable. This is intentional: A0 shifts observability, B shifts trust.

### 5.4 Cross-host coordinator

On `host_mismatch`, `orphan_recover_veto` is ALWAYS `veto` and `merge_safe` is ALWAYS `blocked` — a coordinator MUST NOT declare a foreign pid dead or mutate a worktree on another host, even when the run record lists `identity_full`. The one thing that DOES cross the host boundary is an authoritative **RK completed/failed sentinel** (row S7a): it is a fact the owning host's supervisor wrote, so `ingest_result` may adopt its verdict (a worker that reported done is done, regardless of which host observes the record). AK-only / no-signal foreign runs stay `unknown_host` (S7b). The reconciler emits `cross_host_reconcile_skipped` (run id, observed host, this host) whenever it withholds a liveness/merge decision on a foreign host. Full cross-host reconciliation remains a separate feature (see [project_federation_premium](../../.brainclaw/memory/project_federation_premium.md) for the eventual pull-and-materialize model).

---

## 6. Validation scenario — 2026-07-04 morning fleet

Three workers dispatched on 2026-07-04 morning died without self-reporting. Observed evidence at time of triage:

- All three worker pids were dead when `bclaw_dispatch_status` was called.
- All three had a **legacy assignment-keyed `ack`** sentinel (spawn shell reached `touch`).
- None of the three had a **legacy assignment-keyed `completed`** or `failed` sentinel.
- All three had a **LANE-RESULT.json** written at the worktree root — the workers had finished their work.
- The coordinator's next `worktree clean` pass GC'd the worktrees.
- No `run_completed` runtime event was emitted; the review loops that waited on it did not advance.

This is exactly the case the round-2 pivot addresses. Walking the matrix:

**Under the current (pre-A0, pre-B) code path:** row P3-like — `AK ack only, pid dead, no fs-activity`. The reconciler declares `silent_death`, emits `run_failed`, cascades the claim release, and worktree clean GCs the tree. The LANE-RESULT.json — which is the actual verdict — is read by `bclaw_dispatch_status` today (`src/core/dispatch-status.ts:78–82`) but the reconciler's `silent_death` path does not treat it as a `completed` signal. Result: the review loop stays open, the operator has to manually harvest.

**Under A0 alone (row P3):** the run record now carries `identity_partial` and an honest `attempt_index`. The audit trail names the run as `silent_death` with `identity_partial`. The operator has strictly more information to investigate, but the loop is still stuck at the same place.

**Under A0 + B (row S1 or S2):** the supervisor stays alive after the worker exits. It sees the worker's exit code, writes `runtime/signal/<run_id>.completed` if code 0 (else `.failed`), and only then exits. `ingest_result_authoritative` reads the RK completed sentinel + the nonce + observes quiescence, and declares `completed` — even though the worker never called `bclaw_assignment_update(completed)`. The review loop advances. The operator sees "worker delivered, harvest ready" instead of "silent death, investigate."

**Under B alone (rollback of A0, row R1):** the supervisor still writes RK signals. `orphan_recover_veto` delegates to steady-state, `ingest_result` is authoritative. The main degradation vs. steady-state is the run record: it may carry `identity_partial` and the pre-spawn attempt history is missing. Fleet operability is preserved.

The three predicates being distinct is what makes this work. If we had a single `is_worker_alive` returning true/false, the LANE-RESULT + dead pid combination would return `false` (dead), and everything downstream would still call it silent-death. The three-way split lets `ingest_result_authoritative` say "worker delivered" even while `orphan_recover_veto` would say `no_veto`.

**Audit trail expected under A0 + B for this incident:**

```
run_created           (created + spawn-eligible; carries host_id, boot_id)
run_launching         (supervisor spawned worker, pid recorded)
run_running           (heartbeat observed; state confirmed)
supervisor_exit       (worker tree exited; run-keyed signal written; code=0)
run_completed         (ingest_result_authoritative reads RK signal + nonce)
plan_cascade_to_done  (releaseClaimWithCascade — last-claim rule fired, PR #44)
worktree_gc_ok        (merge_safe passed — LANE-RESULT + RK signal + quiescence)
```

Every step is a discrete audit line naming the actor (supervisor / reconciler / coordinator) so a future post-mortem can replay the decision tree.

---

## 7. A0-first implementation plan

Each increment lands as a separate PR with its own code-review loop. The order is deliberate and A0→B is a HARD dependency (§Order dependencies): A0 improves observability + adds the run-identity schema without changing trust; B (which requires A0) changes trust to run-keyed signals while staying legacy-conservative on pre-A0 `identity_none` records already in the store; C shifts callers to the new predicates once B is proven; D deprecates the legacy signals.

### Increment A0 — creation-after-spawn-eligibility, run per attempt

**Scope.**

- **Schema migration FIRST** (finding 7): add optional `host_id`, `host_os`, `boot_id`, `start_time_hint` to `AgentRunSchema` (`src/core/schema.ts`) AND to `CreateAgentRunOptions` (`src/core/agentruns.ts`), so the fields are not zod-stripped. Ship a persistence test that a written run round-trips them.
- Introduce `beginAgentRun(...)` in `src/core/agentruns.ts` (thin wrapper around `createAgentRun` with the round-2 semantics baked in).
- Extract the pre-spawn eligibility checks in `src/core/execution.ts:215–281,344–366` into a `checkSpawnEligibility(...)` helper returning `{ eligible: true } | { eligible: false, record_run: boolean, failure_kind, reason }` (§3.1). `record_run` explicitly classifies each ineligible state: `false` for `inbox_only` and `autoExecute=false` manual paths; `true` for `spawn_no_worktree`, `spawn_capacity`, `!canSpawn`, `!invoke`, and adapter throw (`spawn_failed`).
- Refactor `src/core/dispatcher.ts:1146–1266` and `src/commands/mcp.ts:5948–6072` to:
  1. Call `checkSpawnEligibility` first.
  2. If `!eligible && record_run`, call `beginAgentRun` in status `failed` with the `failure_kind` (consumes an `attempt_index`). If `!eligible && !record_run`, return with NO run.
  3. If eligible, call `beginAgentRun` in status `created`, then `attemptExecution` → transition to `launching` on success or `failed` on adapter throw.
- Set `retry_of_run_id` on every non-first attempt via a lookup against the current latest run for the assignment (`findLatestAgentRunForAssignment` already exists at `src/core/agentruns.ts:102–109`).
- Record `host_id`, `host_os`, `boot_id` on the run at creation time (populates `identity_partial`).

**Non-scope.** No supervisor. No new sentinels. No reconciler trust changes. Trust in legacy signals is unchanged (A0 shifts observability + the record shape, not what the reconciler believes).

**Tests.**

- Unit: `beginAgentRun` increments `attempt_index` across attempts and links `retry_of_run_id`. Verified via the existing `nextAttemptIndex` helper.
- Unit: pre-spawn failures now produce runs. Regression against the current behaviour of silently discarding them.
- Integration: two consecutive dispatches of the same assignment produce runs 1 and 2, second carries `retry_of_run_id = <run_1_id>`.
- Integration: `bclaw_dispatch_status` reports `attempt_index=2` and links the retry chain.

**Rollout gate.** A0 goes live on the main brainclaw store and the DGX with the existing feature flag surface (no new flag). Rollback = revert the PR; existing runs stay valid because A0 only ADDS fields, never removes.

### Increment B — Node supervisor + run-keyed signals

**Scope.**

- Ship the N-API helper `brainclaw-supervisor` bundled with prebuilds for `win32-x64`, `win32-arm64`, `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`.
- Introduce a `SupervisorExecutionAdapter` implementing `ExecutionAdapter` that:
  - On start, launches the N-API supervisor helper (which creates the Job Object / pgroup, spawns the real worker, records the real pid and start_time_hint).
  - Passes the supervisor pid + worker pid + `run_id` back to the caller.
  - The supervisor owns stdout/stderr; caller reads via the existing log paths.
- New run-keyed signals `<run_id>.launched|.exited|.completed|.failed`. Legacy `<assignment_id>.*` signals continue to be written by legacy adapters (fallback path when the supervisor is not usable).
- Reconciler learns to prefer RK signals when both present.
- Register the `identity_full` fields (`host_id, host_os, boot_id, start_time_hint`) on the run at supervisor launch.
- **Wire the cascade on the failure path** (finding 1): replace `releaseClaim(run.claim_id, cwd)` at `src/core/agentrun-reconciler.ts:297` with `releaseClaimWithCascade(run.claim_id, cwd, { planStatus: <explicit> })`, so an orphan-recovered run propagates plan status per the PR #44 last-claim rule. Add a test that the cascade fires on `run_failed`.

**Non-scope.** Callers other than the two dispatch entrypoints. Removal of legacy signals.

**Tests.**

- Unit: Job Object creation FAIL-CLOSED (mock the N-API load failing → `spawn_failed / supervisor_unavailable`).
- Unit: breakaway detection (mock `IsProcessInJob` returning false → kill child + fail).
- Integration: kill supervisor process externally → worker tree dies (Job Object close).
- Integration: worker exits 0 → RK completed signal written, run transitions to completed, LANE-RESULT.json optional.
- Integration on legacy-path assignment (identity_none row R2) → supervisor sees no `identity_full`, behaves as today.

**Rollout gate.** Feature flag `dispatch.supervisor=true` in config, default false initially. Enable on the main brainclaw store first; observe two full sprint cycles; then default true.

**Backout.** Setting the flag to false reverts to the ack-wrap adapter. Runs already carrying `identity_full` continue to be readable — the reconciler's steady-state rows just downgrade to §5.2 rows if the flag flips back and forth. No data corruption.

### Increment C — shift chokepoint callers to `assertWorktreeMutationSafe`

**Scope.** F7. Insert the gate inside the five worktree-mutation functions listed in §3.2 with the never-adopted-cleanup exemption.

**Non-scope.** New callers or new mutation surface.

**Tests.** Two per chokepoint (blocked + exempted). Regression: a synthetic new caller cannot mutate a live worktree.

### Increment D — deprecate legacy assignment-keyed signals

**Scope.** Log a deprecation audit whenever the reconciler resolves a verdict from AK signals (not RK). Add a config `dispatch.signals.legacy_ak.warn_only` and later `.forbid`.

**Non-scope.** Removing the AK code path. It stays until the fleet is entirely on B for at least two release cycles.

**Backout.** Trivial — the deprecation is warn-level.

### Order dependencies

- A0 → B: **hard** (Codex review of PR #47, HIGH — corrected from the earlier "soft"). B keys sentinels on a `run_id` that must exist before the spawn, and writes the identity fields A0 adds to the schema; without A0 there is no run to key on and no typed field to write. B does not ship until A0 is deployed.
- B → C: hard. C's gate depends on `merge_safe` returning trustworthy verdicts, which requires B's run-keyed sentinels.
- C → D: hard. D is only meaningful once C proves the RK-signal path is the norm.

---

## 8. Open questions folded from round 2 (still open)

- **Supervisor supervision.** If the supervisor process itself dies (host OOM, kill -9), the Job Object closes and takes the worker. The run record ends with `.exited` never written. We accept this: the reconciler treats "supervisor gone, worker gone, no exit signal" as row S5 (`silent_death` with quiescence). A dedicated `supervisor_died` audit event helps diagnose the class.
- **Retry policy.** A0 does not auto-retry failed attempts. `retry_of_run_id` records the chain, but the operator (or a future feature flag) decides to re-dispatch. Keep retry out of the enforcement surface.
- **Sandboxed agents that cannot write RK signals.** Same as today — they use LANE-RESULT.json + heartbeat. `ingest_result_authoritative` treats a LANE-RESULT with `status='completed'` + supervisor `.exited` signal as an authoritative verdict; the missing `.completed` sentinel is fine as long as the exit code was 0.
- **Windows Server Core / Nano.** N-API helper depends on `kernel32.dll` for Job Object APIs — present on all supported Windows SKUs. Nano Server is out of scope (no supported agent CLI runs there today).

---

## 9. Delivery checklist for the next round of review

- [ ] Reviewer confirms A0 does not change the reconciler's trust surface. (§3.1)
- [ ] Reviewer confirms F7 chokepoint placement covers every current mutation caller. (`src/commands/worktree.ts:79–159` + MCP handlers.)
- [ ] Reviewer confirms the Job Object FAIL-CLOSED policy is compatible with the offline / air-gapped install target (npm postinstall must supply the prebuilt binary, or the entire dispatch surface is disabled — desired).
- [ ] Reviewer walks the 2026-07-04 scenario against §5.1 rows S1/S2 and confirms every declared audit line is producible.
- [ ] Reviewer confirms no invariant listed in §4 is contradicted.

After sign-off, implementation begins with increment A0 as its own PR, its own review loop.
