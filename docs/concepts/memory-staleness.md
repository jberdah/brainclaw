# Memory staleness + session resume

How brainclaw keeps long-lived memory usable without forcing cleanup.
Phase 4 Sprint 1 Lane A (`pln#390`).

## The two concerns

1. **Session resume.** When an agent reconnects to a workspace it already
   worked in, the conversation starts fresh — but the store has
   accumulated activity since the last session. Resume should hand
   back a *delta* (what changed since last time) rather than the full
   world.

2. **Memory staleness.** Plans marked `in_progress` that have not been
   touched in a week, traps whose expiry has passed, observation runtime
   notes a month old with no expiry — these accumulate and eventually
   drown signal. They should be flagged, not auto-archived.

Neither case requires destructive cleanup. Signals surface; the
operator (human or agent) decides.

## Session resume

`bclaw_work(intent: "resume")` automatically includes the memory delta
since your previous session for the same agent:

```jsonc
bclaw_work({ intent: "resume" })
// → context result contains:
//   context_diff: {
//     since_session: "sess_abc123",
//     summary: "5 decisions, 2 handoffs",
//     counts: { constraints: 0, decisions: 5, ... }
//   }
```

Under the hood this maps to `buildContext(... sinceSession: <last session>)`,
identical to `bclaw_context({ kind: "delta", since: "<session_id>" })`
but without the operator needing to know the session id.

The legacy flow still works for CLI:

```bash
brainclaw session-start --include-context
```

## Staleness signals

`detectStaleness()` flags items across five entity kinds using
age-based heuristics. Thresholds live in
[`src/core/staleness.ts`](../../src/core/staleness.ts) `STALENESS_THRESHOLDS`:

| Entity | Flag when… | Default threshold |
|---|---|---|
| plan (in_progress) | no update for N days | 7 days |
| plan (todo / blocked) | never progressed in N days | 30 days |
| trap (active) | `expires_at` is in the past | — |
| handoff (open) | created more than N days ago | 14 days |
| candidate (pending) | age exceeds source-specific threshold | 21 days (user) / 30 days (auto) |
| runtime_note (observation) | no `expires_at` and older than N days | 30 days |

Session start/end runtime notes are transient markers and never
flagged regardless of age.

## Where the signal surfaces

The same `StalenessReport` is emitted by three surfaces — no separate
probe required.

- **`bclaw_context(kind: "memory")`** — top 5 warnings included in the
  context payload as `stale_warnings`.
- **`brainclaw agent-board`** — warnings appended after the core
  board output. Shows the first 5 with their suggested action.
- **`brainclaw doctor`** — `stale_memory` check in the health report,
  including full details in JSON mode.

## The resolve flow

`brainclaw stale` is the minimal operator wrapper over the canonical
CRUD verbs:

```bash
# List what's currently flagged
brainclaw stale list

# Apply the canonical action for the entity type
brainclaw stale resolve <id>
```

Dispatch table:

| Entity kind | `stale resolve` effect |
|---|---|
| plan | `bclaw_transition(entity: "plan", to: "dropped")` |
| handoff | `bclaw_transition(entity: "handoff", to: "closed")` |
| candidate | `bclaw_transition(entity: "candidate", to: "rejected")` |
| trap | `bclaw_transition(entity: "trap", to: "resolved")` |
| runtime_note | `bclaw_remove(entity: "runtime_note", …)` |

For finer control, use the canonical verbs directly — the warning's
`suggested_action` field names the exact invocation.

## Not done by design

- **No auto-archive.** Staleness is a soft signal. An item stays
  visible until the operator resolves it. Exception: runtime notes
  with an explicit `expires_at` that passed — those were operator-
  declared TTLs, so we flag them *as* expired.
- **No reference-recency weighting (yet).** A stale plan that's still
  referenced by a fresh handoff is treated the same as a truly orphaned
  one. Cross-entity reference graph is a follow-up if the noise signal
  shows it matters.
- **No per-agent thresholds.** All thresholds are global. Individual
  agents cannot raise or lower their own. Config-driven overrides are
  a follow-up.

## Tuning

Thresholds live in `src/core/staleness.ts` as a module-level const.
Config-file override would land under `staleness: { plan_in_progress_days: … }`
in `config.yaml`. Not wired yet; open as follow-up when the defaults
start causing noise complaints.
