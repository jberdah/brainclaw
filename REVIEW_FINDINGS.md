# Review of 82a94e9 — federation Phase 1 lifecycle wiring

**Reviewer**: claude-code (self-adversarial — three consecutive codex dispatch attempts failed silently, see trap `trp_to_be_created`; doing the review myself rather than block the work indefinitely)

**Date**: 2026-05-15

## Verdict: NEEDS_REVISION → FIXED in-line → READY TO MERGE

One real exfiltration risk found on axis C (handoff/candidate visibility) and fixed conservatively in this same branch (commit follows this file).

## Findings

### A. Gate correctness — `isCloudSyncEnabled` (federation-cloud.ts:19-45, 148-151)

**Verdict: OK**

Walked through the 5 cases manually:

| # | Inputs | `apiKey` | `enabled` flag | `isCloudSyncEnabled` | Expected | ✓ |
|---|---|---|---|---|---|---|
| 1 | no env, no `cloud_sync` block | undefined → return undefined | n/a | false | false | ✓ |
| 2 | env `BRAINCLAW_CLOUD_API_KEY` set | envApiKey | `Boolean(envApiKey)` = true | true | true | ✓ |
| 3 | `cloud_sync.api_key` set, `enabled=false`, no env | configApiKey | `false || false` = false | false | false (stale-key safety) | ✓ |
| 4 | `cloud_sync.api_key` set, `enabled=true`, no env | configApiKey | `false || true` = true | true | true | ✓ |
| 5 | `cloud_sync.enabled=true`, NO key, no env | undefined → return undefined | n/a | false | false | ✓ |

The 5 unit cases in `tests/unit/federation-cloud.test.ts` cover these.

Edge cases checked:
- Empty-string env key → `if (!apiKey)` falsy check handles it → undefined returned. ✓
- `cloud_sync.enabled === undefined` → strict `=== true` comparison handles it → false. ✓

### B. Async propagation blast radius — `startSession` / `endSession`

**Verdict: OK**

Grep for both function names across `src/` and `tests/` returns 25 call sites. All are awaited:
- `src/cli.ts:1393` ✓
- `src/cli.ts:1411` ✓
- `src/commands/mcp.ts:3233, 3377, 4447, 6038` ✓
- `src/commands/session-end.ts:99, 169` (`runSessionEnd` + decl)
- `src/commands/session-start.ts:74, 144` (`runSessionStart` + decl)
- 17 test-site awaits in 5 test files

No unawaited call detected.

### C. Visibility filter on cloud push — `pushSessionCloudSignals` (session-end.ts:577-672)

**Verdict: ORIGINAL HAD A REAL EXFILTRATION RISK — FIX APPLIED**

Original `isShared` helper treated absent `visibility` field as shared. Investigation:

- `HandoffSchema` (schema.ts:216-249): **NO `visibility` field**
- `CandidateSchema` (schema.ts:569-612): **NO `visibility` field**
- `RuntimeNoteSchema` (schema.ts:887-905): HAS `visibility: MemoryVisibilitySchema.default('shared')`
- `TrapSchema` (schema.ts:163-189): HAS visibility (not cloud-pushed anyway)

Consequence: once `cloud_sync` is opted-in, EVERY session handoff (including `handoff.snapshot.diff` — the full git diff) and EVERY session candidate leak to `app.brainclaw.dev`. Secrets accidentally committed to a session would be exfiltrated.

**Fix applied in this commit**: renamed `isShared` → `isExplicitlyShared` and tightened the predicate to require `entity.visibility === "shared"` literally. Today that means only runtime_notes (which default to shared) are pushed. Handoffs and candidates stay local until their schemas get an explicit `visibility` field — captured as follow-up below.

### D. Cloud signal dedup — `pullSignalsFromCloud` (session-start.ts:319)

**Verdict: KNOWN RISK, NO LOCAL FIX (cloud-side validation needed)**

`pullSignalsFromCloud(actor.agent, { limit: 100 }, options.cwd)` is called with no `since` cursor. If the cloud `GET /api/v1/inbox/:agent` endpoint at `brainclaw-cloud/src/handlers/inbox.ts` does NOT filter via per-agent read state, every session-start will re-materialize the last 100 signals → memory explosion within a few days.

Cannot verify cloud-side from this branch. Already flagged in commit message and in `dec#63`. Follow-up: validate the cloud endpoint behavior before any `cloud_sync.enabled=true` deployment, or implement a local `last_cloud_sync_at` cursor as defensive measure.

### E. Refactor regression — `federation-materialize.ts`

**Verdict: OK**

Read both the helper (`src/core/federation-materialize.ts:18-72`) and the new caller blocks in `session-start.ts:298-336`. Semantic preserved:
- Origin tag still set to `remote:<project>:<agent>`.
- Three type branches: candidate (parse + saveCandidate), handoff (parse + mutateState push to open_handoffs), runtime_note (parse + saveRuntimeNote).
- Unknown type returns false (no-op).
- 22 new unit tests in `tests/unit/federation-cloud.test.ts` + 154 MCP unit tests + the existing session-* tests all pass.

## Fixes applied

One follow-up commit on this branch (after this file), with the visibility-filter tightening:
- session-end.ts `isShared` → `isExplicitlyShared` requiring literal `visibility === "shared"`.
- Comment block documenting WHY (real exfiltration risk if handoff.snapshot.diff leaks).

## Notes — Follow-up items (separate PR)

1. **Add `visibility: MemoryVisibilitySchema.default('shared')` to HandoffSchema and CandidateSchema** in `src/core/schema.ts`. Then handoffs/candidates can deliberately opt-in to cloud push. Estimate: 30 min + tests.
2. **Cloud-side `since` cursor validation**: confirm `brainclaw-cloud/src/handlers/inbox.ts` filters per-agent read state. If not, either implement cloud-side OR add a local `last_cloud_sync_at` to the agent registry, passed as `since` on every pull.
3. **Unit test for `pushSessionCloudSignals` visibility gate**: today only the HTTP layer (`pushSignalToCloud`) is tested. Add cases for: runtime_note with shared visibility (pushed), runtime_note with machine visibility (skipped), handoff (skipped — no visibility), candidate (skipped — no visibility).
4. **Codex review dispatch regression**: three consecutive codex spawns this session died silently with no captured output. Separate trap + plan to investigate the dispatch chain (capture codex stdout/stderr per-assignment as `.brainclaw/coordination/runtime/log/<asgn>.log`).
