# Autonomy-safety regression pack (pln#621)

Every scenario below is a REAL incident from the dogfood store (trap ids), mapped
to the non-destruction invariant it taught us and to the test that now pins it.
The acceptance bar: **zero false destructive verdicts on this corpus** — a
coordination engine may be wrong about liveness, but it must never destroy work
(kill a working agent, reset an unharvested diff, strand or steal a claim,
double-apply a verdict) on ambiguous evidence.

Classification (step 3 of the plan): ✅ pinned = trap resolved with a
counterfactual/regression test · 📋 mitigated = documented operator rule, not
engine-enforceable · 🔴 red = open defect → the only candidates for new
implementation work.

Baseline corpus: snapshot `2026-08-03T09-38-35-129Z`
(hash `399599d1…`, see docs/playbooks/store-snapshot.md). Shape fixtures for
synthetic scenario stores: `tests/fixtures/store-corpus/`.

## Kill / reroute — liveness verdicts must never destroy work

| Incident | Invariant | Status |
|---|---|---|
| pln#520 — 6 workers killed on a dead WRAPPER pid, they committed 4-7 min later | Commits ahead + clean tree ⇒ verdict "harvest it", never kill/reroute, even with a dead pid | ✅ `dispatch-status.test.ts` "never kill-and-reroute" |
| pln#520 variant — dead pid but the worker is WRITING (logs/worktree mtime fresh) | Fresh fs activity ⇒ the recommendation must never contain a kill instruction | ✅ `dispatch-status.test.ts` "no kill while the filesystem is active" (added by this pack) |
| pln#527 — stale heartbeat during a long single operation | Stale heartbeat + fresh fs activity ⇒ "working, not stalled" (no fail inference) | ✅ `agentrun-reconciler.test.ts` heartbeat/fs-veto cases |
| trp#292 — spawn deaths mis-diagnosed; stderr never read | Failure verdicts carry the stderr tail (worker's last words) | ✅ `dispatch-status.test.ts` stderr-signature cases |
| Operator rule — never blanket-kill agents by process name (IDE runs them too) | Kill only pids from `agent_run.pid` cross-checked with `launched_at` | 📋 mitigated (operator rule; engine cannot see foreign processes) |

## Harvest — verdicts and results are exactly-once and owned

| Incident | Invariant | Status |
|---|---|---|
| trp_e824d2af — round 1's LANE-RESULT read as round 2's terminal signal | A lane result is terminal ONLY for the assignment named in its own `assignment_id`; foreign ⇒ `lane_result_stale` | ✅ `dispatch-status-lane-result.test.ts` |
| Same trap, write side — stale terminal file survives worktree reuse | `resetWorktreeToRef` archives the prior LANE-RESULT out of the signal path | ✅ `worktree.test.ts` re-dispatch hygiene |
| Double harvest of one lane | Re-ingesting the same LANE-RESULT is an idempotent no-op (marker) | ✅ `lane-result-harvest.test.ts` "skips on re-run" |
| Double integration of a turn-owned approve lane | Exactly-once finalization — no duplicate verdict, loop stays terminal | ✅ `loops-pr3a-harvest-reconcile.test.ts` T7 |
| pln#638 1c — CLI-harvested ideation lane never converged its loop | The ideation closer fires on the CLI harvest path too | ✅ `lane-harvest-cli-convergence.test.ts` |
| 2026-08-02/03 ×2 — CLI-harvested REVIEW lane (file protocol, no turn keys) left its loop turn open; coordinator converged manually both times | A review lane harvested by assignment_id should converge its turn (or fail loudly naming the missing keys), never silently leave the loop blocked | 🔴 red → pln#644 |

## Worktrees — the workspace carries unharvested work

| Incident | Invariant | Status |
|---|---|---|
| trp_72b4e9b3 — round-2 path collision wedged the scope | Same-branch registered worktree is ADOPTED, not refused | ✅ `worktree.test.ts` adoption |
| PR#167 review P1 — adoption would hard-reset a sandboxed worker's uncommitted output | ANY tracked dirt refuses adoption, unconditionally (a reset pin is not a discard order) | ✅ `worktree.test.ts` tracked-dirt refusal |
| can_2e282880 — branch reuse ran a worker on an April base / would destroy commits | Unharvested commits refuse silent reuse/adoption | ✅ `worktree.test.ts` unharvested-commits guards |
| trp (2026-08-01) — `git worktree remove` follows Windows junctions, wiped main-repo node_modules | brainclaw's own removal detaches junctions first; raw git remove remains dangerous | ✅ engine path (`detachWorktreeJunctions`) · 📋 the raw-git variant stays an operator rule |
| trp#950 — two >48-char scopes collapsed to one branch slug | Distinct scopes yield distinct valid slugs | ✅ `worktree.test.ts` slug suite |
| Duplicate spawn — a respawned assignment ran beside its "dead" predecessor in one worktree | Two live workers must never share a worktree unknowingly | 📋 mitigated (heartbeat-file coordination; pln#630 launch fence covers the turn-owned path: reservation + grant make a duplicate launch DENIED) — engine-wide guard tracked in pln#644 classification notes |

## Claims / cascades — advisory locks that cannot lie or leak

| Incident | Invariant | Status |
|---|---|---|
| trp#433 — dead runs left active claims accumulating | Failed runs release their claim (GC cascade, non-turn-owned) | ✅ `agentrun-reconciler.test.ts` trp#433 cases |
| pln#638 6c — transport completion released claims / triggered reviews | Transport evidence carries NO business effect; only harvest/report proof does | ✅ 6c pin + `loops-reconcile-turn.test.ts` |
| dec#151 — turn-owned failure released via transport GC | Turn-owned release is a LOOP business decision (recorded on the loop first, audited) | ✅ `agentrun-reconciler.test.ts` pln#641 cases |
| PR#166 review P1 — the promised lazy retry was unreachable (read paths skip terminal runs) | A stranded claim converges from a plain `bclaw_find(agent_run)` read | ✅ `agentrun-reconciler.test.ts` P1 cases incl. `listEntities` surface test |
| PR#166 review P1 round 2 — the release audit could lie under a concurrent release | `releaseClaimIfActive`: check+transition atomic; the event fires only for the call that transitioned | ✅ `loops-reconcile-turn.test.ts` atomic-contract cases |
| trp_72b4e9b3(2) — a worktree-less claim wedged all dispatch on its scope | Reuse heals the claim (provisions + patches under the store lock); a concurrently-released claim never reaches the dispatcher | ✅ `worktree.test.ts` heal test |
| trp#928 — any caller could release any claim | Ownership-checked release; coordinator override is explicit + audited | ✅ claim auth suites |
| Claim reuse across review rounds (trp_e824d2af context) | A SUPERSEDED turn's convergence never releases the live turn's reused claim | ✅ `loops-reconcile-turn.test.ts` superseded case |

## Loop closure — verdicts recorded once, loops never wedged

| Incident | Invariant | Status |
|---|---|---|
| pln#630 — double reconcile spawned both rounds | Exactly-once iteration bump under the loop lock | ✅ `loops-reconcile-turn.test.ts` findings 1/2 |
| §13 R4 — completed+failed contradiction auto-accepted | Contradiction WITHHOLDS convergence, journals a conflict | ✅ `loops-reconcile-turn.test.ts` R4 cases |
| pln#639 — empty artifacts satisfied phase gates | Gates reject empty artifact bodies | ✅ gate suites |
| Stale/mismatched lane evidence converging the wrong attempt | Read-strict turn keys (turn_id+run_id+nonce) or no convergence | ✅ `loops-reconcile-turn.test.ts` read-strict case |

## Red defects opened by this classification

- **pln#644 — review-loop CLI-harvest turn convergence**: a review lane
  delivered via the file protocol without turn keys is harvested into the
  assignment but its loop turn stays open silently; the coordinator converged
  by hand twice on 2026-08-02/03 (loops `lop_626271ee10ad09d8`,
  `lop_4d869568bd99ddc0`). Wanted: assignment-keyed convergence for review
  loops at the CLI harvest site (mirroring pln#638 1c for ideation), or a loud
  failure naming the missing turn keys — never a silent stall.

Everything else in the corpus is pinned or explicitly an operator rule. New
incidents: add the trap, add the row, add the counterfactual test — in that
order.
