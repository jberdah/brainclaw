# Review loop

> Loop kind: `review`. One of five equal protocols driven by the shared
> [Loop Engine](../concepts/loop-engine.md). Identity, dispatch decisions and
> spawn authority belong to [`AttemptAuthority`](../concepts/attempt-authority.md);
> nothing on this page overrides them.

## Purpose

A `review` loop validates a change that already happened. The change lives on
a candidate, a handoff, a diff, or another primitive the caller passes in; the
loop drives a reviewer through evidence, findings, an author response, and a
verdict, until either the reviewer greenlights or an iteration cap forces the
loop to stop.

`review` is the workflow with the most automated coordinator shortcut, but it
runs on the same engine as `ideation`, `implementation`, `research`, and
`debug`: same phases model, same artifacts, same lifecycle verbs, same
authority record for each dispatched turn.

## Default protocol

```
change_summary → findings → author_response → followup_review → verdict
```

| Phase | Purpose | Typical artifact |
|---|---|---|
| `change_summary` | Recap the change under review; anchor the reviewer | inline `change_summary` |
| `findings` | Reviewer records issues against the change | `finding` (repeatable) |
| `author_response` | Author responds to each finding | `author_response` |
| `followup_review` | Reviewer re-inspects after fixes | `finding` or `verdict` |
| `verdict` | Convergence phase: `approve` or `request_changes` | `verdict` |

**Iteration.** `review` uses `max_iterations: 3` at the loop level rather than
a phase-local iteration block. The default `stop_condition` is
`any([reviewer_green, max_iterations n=3])`: an accepted verdict closes with
`completed`; three rounds without acceptance close with `blocked`.

## Entry points

- **Coordinator shortcut (recommended).**
  `bclaw_coordinate(intent='review', open_loop=true, mode?='symmetric' | 'asymmetric')`
  creates the candidate, opens a review loop with an `author` slot and a
  `reviewer` slot, links the candidate as the `change_summary` artifact,
  advances to `findings`, and dispatches the reviewer.
- **Dispatch shortcut.** `bclaw_dispatch(intent='review', openLoop=true, …)`
  produces the same result on the dispatch code path.
- **Direct open.** `bclaw_loop(intent='open', kind='review', allow_orphan=true)`
  followed by manual `turn`/`complete_turn`. Use only when neither shortcut
  fits — `allow_orphan=true` is the explicit acknowledgement that you will
  drive the loop yourself.

The default review mode is `asymmetric` (reviewer finds, author fixes).
`symmetric` mode collapses find + fix into one turn per side — see
[Symmetric review-and-fix](#symmetric-review-and-fix) below.

## Advance gates

`review` ships no `advance_gate` on any phase — advance is driven by the
`change_summary`, `finding`, `author_response`, and `verdict` artifacts and by
the shared `advance_when: 'all'` slot policy. The gate that matters lives on
the reducer: a `verdict` artifact converts to an `accepted…` body only when
the reviewer wrote `review_verdict: 'approve'`. `reviewer_green` in the stop
condition tests exactly that.

## Stop condition

```ts
{ kind: 'any', conditions: [{ kind: 'reviewer_green' }, { kind: 'max_iterations', n: 3 }] }
```

- **`reviewer_green`** — closes the loop `completed` on the first `verdict`
  artifact with an `accepted…` body.
- **`max_iterations n=3`** — closes the loop `blocked` after three rounds
  without acceptance; a human takes over.

## Artifacts

| Type | Phase | Body |
|---|---|---|
| `change_summary` | `change_summary` | inline text ≤ 4 KB |
| `finding` | `findings` / `followup_review` | inline text ≤ 4 KB |
| `author_response` | `author_response` | inline text ≤ 4 KB |
| `verdict` | `verdict` | inline; `accepted…` for approve, otherwise `request_changes` |
| `changes_applied` | any phase (symmetric only) | inline turn summary; at most one per turn |
| `file_diff` | any phase | ref-based body (`{ref, byte_count, sha256}`) |

Artifacts either link a primitive (`ref`) or carry an inline `body` ≤ 4 KB;
larger content must move behind a `ref` — see the ref-based body shape in
[loop-engine.md](../concepts/loop-engine.md#artifact-body-shapes).

## How verdicts reach the loop

A turn-owned dispatched reviewer worker does **not** call `bclaw_loop`
directly. It writes its outcome to `LANE-RESULT.json` at the worktree root,
including `review_verdict: 'approve' | 'request_changes'` and
`review_summary`. `brainclaw harvest <assignment_id>` — both the report-only
path and `--integrate` — maps that lane onto its loop and calls
`reconcileTurn`, which:

1. Validates the LANE evidence against
   [`evidenceMatchesAttempt`](../concepts/attempt-authority.md#functional-api)
   (`turn_id`, `run_id`, current-generation nonce all match).
2. Runs the review reducer to record a `verdict` artifact on the reviewer
   slot.
3. Calls `advance`, which auto-closes on `reviewer_green` when the verdict is
   `approve`.

## Autonomous fix cycle

On a `request_changes` verdict, `harvest --integrate` may re-dispatch the
reviewer slot into the **same worktree** (symmetric mode) or the author slot
(asymmetric). The claim and the worktree stay alive, the round counter bumps,
and a fresh turn is prepared through the full
`reserve → commit → arm → consume` sequence — a new generation, so a stale
prior-generation LANE-RESULT can never terminate the new round. The cycle
repeats until `approve` (→ `reviewer_green` close) or the `max_iterations`
cap (→ `blocked`, handed to a human). The report-only harvest path never
cycles: it can neither re-dispatch nor retain the claim, so it defers
`request_changes` to `--integrate` and still closes on `approve`.

Set `BRAINCLAW_TURN_OWNED_REVIEW=0` (also `false`/`off`/`no`) to fall back to
the legacy review finalizer if a problem surfaces in production.

## Symmetric review-and-fix

When both slots are coding agents with write access to the reviewed artifact
(the common case for spec, doc, and small refactor reviews),
`mode: 'symmetric'` collapses the two phases `findings` and `author_response`
into one behavior per turn: the reviewer reviews **and** applies whatever
fixes it can make directly, then hands back a `changes_applied` summary
alongside its remaining `finding` artifacts. The next slot picks up from that
committed state and does the same. Exit: a reviewer turn produces an
accepted `verdict` with no unapplied findings and no `changes_applied` in the
turn, or `max_iterations` fires.

The phase sequence is unchanged; `mode` is persisted on
`loop.protocol.review_mode` at `open` time so resume and turn handlers do not
depend on the original request envelope. A slot that lacks write authority
degrades gracefully to asymmetric behavior for that turn: findings/verdicts
are still allowed, `changes_applied` is omitted, and the loop continues.

## Routing and project resolution

`review` routes turns by `slot_id`, using the reviewer/author slot pointer;
`session_id` is observability-only. The shortcut path applies the
[project resolution gate](../concepts/loop-engine.md#project-resolution-gate)
before writing anything — a review loop cannot land in the wrong store.

## Recovery

- **Reviewer worker crashed before writing LANE-RESULT.** The launch grant
  lease expires; `sweepExpiredLaunchGrants` revokes the grant
  (`reserved_never_launched`). A subsequent dispatch arms a new generation
  at a strictly greater epoch.
- **LANE-RESULT written, harvest not yet run.** Idempotent: any harvest
  trigger — the wrapper completion signal, `brainclaw harvest`, session-end
  — calls `reconcileTurn`, and its convergence body is idempotent under the
  loop lock (a superseded turn no-ops; a terminal loop no-ops).
- **Completed lane + failed sentinel present.** `reconcileTurn` withholds
  convergence (§13 R4), journals a `run_blocked` runtime event with
  `status_reason: turn_evidence_contradiction`, and escalates to a human.
- **Iteration cap hit.** Loop closes to `blocked`; the coordinator claim
  is released; the worktree becomes ordinary once the harvest pass runs.

Every one of these outcomes is a total function of the reservation record
plus the run status — never a decision on marker-file presence.

## When NOT to use

- **Ideation before a decision is made** — use [`ideation`](./ideation.md).
- **Adversarial pressure on a proposal that has no candidate yet** — use
  [`ideation`](./ideation.md); a review loop with no `change_summary`
  artifact is empty.
- **Running the failing repro of a bug** — use [`debug`](./debug.md).
- **Executing a bound plan** — use [`implementation`](./implementation.md).
- **Open-ended discovery** — use [`research`](./research.md).

## Reference implementation

| Component | File |
|---|---|
| Default protocol | [`src/core/loops/types.ts`](../../src/core/loops/types.ts) (`DEFAULT_PROTOCOLS.review`) |
| Coordinator dispatch | [`src/core/review-loop-turn-dispatch.ts`](../../src/core/review-loop-turn-dispatch.ts) |
| Close / reducer | [`src/core/loops/reconcile-turn.ts`](../../src/core/loops/reconcile-turn.ts), [`src/core/review-loop-close.ts`](../../src/core/review-loop-close.ts) |
| Result reducer | [`src/core/loops/result-reducers.ts`](../../src/core/loops/result-reducers.ts) |
| Tests | [`tests/unit/review-loop-close.test.ts`](../../tests/unit/review-loop-close.test.ts), [`tests/unit/loops-mcp-facade.test.ts`](../../tests/unit/loops-mcp-facade.test.ts) |

## Related

- [Loop Engine](../concepts/loop-engine.md)
- [Attempt authority](../concepts/attempt-authority.md)
- [Dispatch lifecycle](../concepts/dispatch-lifecycle.md)
