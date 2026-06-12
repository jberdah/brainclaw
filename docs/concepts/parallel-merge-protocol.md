# Parallel-lane merge protocol

Status: operational (pln#396). When a sequence runs multiple lanes in parallel
worktrees, their branches must land back on the base without silently
overwriting each other. This is the minimum protocol; `brainclaw worktree
check` is its tool.

## The risk

Each lane is a worktree branched from the base (master) at dispatch time. Two
lanes editing the same file will, on the second merge, either conflict
(visible, recoverable) or — worse — produce a clean-but-wrong merge where one
lane's change is silently dropped or a file is parasitically deleted
(trp_merge_wipes_node_modules class). File-level overlap between lanes is the
predictor; `worktree check` surfaces it before `git merge`, not after.

## Before merging any lane

```
brainclaw worktree check
```

It reports, per live worktree lane: the files it changes (committed since base
+ uncommitted tracked), the owning claim / session / agent, and — the payload —
**which files are touched by more than one lane**. Exit code:

- `0` — lanes are disjoint. Merge in any order; no cross-lane conflict possible.
- `3` — overlapping files exist. Follow the ordering rule below.

`brainclaw worktree merge <branch>` runs the same check inline and prints an
advisory warning if the branch overlaps another live lane (it never blocks —
the operator decides).

## Ordering rule when lanes overlap

1. **Merge the overlapping lanes one at a time**, never as a batch.
2. After merging lane A, **rebase (or re-create) the still-pending overlapping
   lanes onto the new base** so they see A's change, then re-run `worktree
   check`. The overlap on the merged file should now be gone (the pending lane
   either already has A's change or will conflict explicitly on rebase, where
   it is resolvable in isolation).
3. Disjoint lanes (no shared files with anything merged) can merge freely at any
   point — `check` confirms they carry no risk.
4. Prefer merging the **smallest / most foundational** overlapping lane first
   (fewer files, or the one others build on), so the rebases that follow are
   the cheap direction.

## When automatic reconciliation is not possible

`worktree check` is a *predictor*, and `worktree merge` auto-restores parasitic
deletions but does **not** resolve real content conflicts. Escalate to a human
(or a single coordinator session doing the merge serially) when:

- Two lanes changed overlapping *hunks* of the same file (not just the same
  file) — git will conflict; resolve in the main worktree, do not `--force`.
- A lane's worktree carries **uncommitted** changes to a shared file (it spawned
  from HEAD; those edits never reach the merge). `check` flags these as
  `(+N uncommitted)` — harvest or discard them deliberately before merging
  (a dead worker's stranded edits are the feedback_review_loop_symmetric_fixer
  / trp#545 case).
- The overlap is in a generated / high-churn file (lockfiles, `dist/`) — prefer
  regenerating post-merge over merging both sides.

## Invariants

- The check is pure-read: only `git diff` / `git status`, no store lock, no
  mutation — safe to run anytime, even mid-dispatch with workers live.
- `.brainclaw/` and `.gitignore` are never counted as conflict surface (store-
  internal + birth noise).
- A flagged overlap that turns out disjoint at the hunk level costs one glance;
  the protocol deliberately over-reports rather than miss a real conflict.
