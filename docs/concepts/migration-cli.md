# `brainclaw migrate` — v1.0 schema migration CLI

Design for the CLI command that upgrades a `.brainclaw/` store to the
v1.0 schema (MCP schema 0.8.0 final step). Hard prerequisite before
the Phase 3 grammar refactor (`pln_c6472192`) can start.

Tracked under `pln_bc6e88cc` / step `stp_3a866463`.

## Goals

- One authoritative command to move any existing store from schema
  0.6.x → 0.8.0 (covers all post-consult patches: P6.1 tombstone,
  P6.3 provenance, P6.6 candidate archive, handoff review-field
  strip).
- Safe by default: dry-run first, backup before any write, health
  check after apply, rollback path when things go wrong.
- Idempotent: running migrate twice on a store already at the target
  schema is a no-op (exit 0, no writes).
- Dogfoodable on real stores (this machine + monorepo test server)
  before Phase 3 unblocks.

## Command surface

```
brainclaw migrate [options]

Options:
  --to-schema <version>    Target schema (default: 1.0). Must match a
                           known migration path from current schema.
  --dry-run                Simulate all stages, print diff summary,
                           perform no writes. Exits non-zero if issues
                           are found that would abort a real run.
  --backup-dir <path>      Backup destination (default:
                           `<store>/../<store-name>.bak-<iso-ts>/`).
                           Ignored with --dry-run and --rollback.
  --rollback               Restore the most recent backup for this
                           store, then refuse to proceed if the schema
                           version after restore does not match a
                           known pre-migration state.
  --store <path>           Store root (default: auto-resolved via
                           existing store chain).
  --yes                    Skip the final confirmation prompt.
  --verbose                Per-record mutation log (default: summary
                           only).
  --json                   Machine-readable summary on stdout. Errors
                           still go to stderr as text.
```

Sub-command shape matches existing CLI conventions (`brainclaw
bootstrap`, `brainclaw doctor`, `brainclaw setup`). Implementation
lives in `src/commands/migrate.ts`; registration in `src/cli.ts`.

## Execution pipeline

Every stage runs in order. Any stage failing aborts the run *before*
any writes are committed (except when already past the backup stage —
then rollback is the recovery path).

1. **Resolve store.** Find `.brainclaw/` via the usual chain; refuse
   to operate on a non-store directory.
2. **Read current schema version.** From
   `.brainclaw/schema-version.json` if present, else infer from store
   shape (handoffs with `review` field → pre-migration). Refuse if
   ambiguous — require operator to pin `--from-schema`.
3. **Plan.** Compute the set of patches to apply (P6.1, P6.3, P6.6,
   handoff strip, SCHEMA_VERSION bumps). Each patch knows its
   pre-condition (does this store need it?) and post-condition (what
   does the store look like after).
4. **Pre-flight checks.** Read-only validation pass:
   - All memory records deserialize under the current schema.
   - No live claims (would be invalidated by the migration).
   - Store not on a schema version newer than the target (refuse
     down-migration).
   - Free disk space ≥ 2× store size (for backup).
5. **Print plan.** Human-readable summary of what will change (N
   candidates archived, M handoffs stripped, K records stamped with
   legacy provenance). With `--dry-run`, stop here.
6. **Confirm.** Prompt unless `--yes`. Shows backup destination.
7. **Backup.** Atomic copy `.brainclaw/` → `<backup-dir>/`. Write a
   manifest (`backup.json`) with original path, timestamp, schema
   version, brainclaw version.
8. **Apply patches.** Each patch is a function `(store) => void`
   working on an in-memory representation. All patches run against
   one snapshot, then the result is committed atomically via
   rename-based write to a `.brainclaw.new/` sibling, then swap.
9. **Bump schema version.** Write `schema-version.json` with history
   trail:
   ```json
   {
     "current": "0.8.0",
     "history": [
       { "from": "0.6.0", "to": "0.8.0", "at": "2026-04-18T...",
         "patches": ["candidate_archive", "handoff_strip",
                     "provenance_legacy_stamp"] }
     ]
   }
   ```
10. **Health check.** Run `brainclaw doctor --after-migration` as a
    subprocess. If it exits non-zero, print the doctor output, leave
    the backup in place, suggest `brainclaw migrate --rollback`. Do
    not attempt auto-rollback — the operator decides.
11. **Summary.** Lines changed, backup path, next suggested command
    (`brainclaw doctor`, or if dogfood phase, the Phase 3 plan id).

## Rollback path

`brainclaw migrate --rollback` resolves the most recent backup for
the store, validates its manifest, then does an atomic swap:

1. Rename `.brainclaw/` → `.brainclaw.rollback-<ts>/` (kept for
   inspection, deleted after 7 days by a future `brainclaw clean`).
2. Copy `<backup>/` → `.brainclaw/`.
3. Verify `schema-version.json` matches the pre-migration state
   declared in the backup manifest. Refuse if mismatch.
4. Print "rolled back to schema <version>".

Rollback is the recovery action, not an automatic fallback. Automatic
rollback would mask migration bugs we need to see.

## Idempotency

Running `brainclaw migrate` on a store already at the target schema:

- Pre-flight detects current == target.
- Plan stage produces zero patches.
- Prints "already on schema 0.8.0, nothing to do" and exits 0.
- No backup, no writes.

Running with a partial schema version (e.g., 0.7.0, after a prior
migration interrupted) resumes from the first un-applied patch.

## Failure modes

| Mode | Detection | Recovery |
|---|---|---|
| Disk full during backup | `copy` write fails | Abort before any schema write; original store untouched. |
| Patch throws mid-run | Exception in apply stage | Abort before atomic swap; original store untouched. |
| Atomic swap fails | rename() fails (antivirus, lock) | `.brainclaw.new/` persists; operator can inspect and retry. |
| Doctor post-check fails | doctor exits non-zero | Store is on new schema but invalid; operator inspects + runs `--rollback`. |
| Rollback manifest missing | No `backup.json` | Refuse rollback. Operator restores manually. |

No silent recovery. Every failure leaves a diagnosable trail.

## Patch catalogue (v1.0 scope)

Each patch is a named, independently testable unit:

- **`candidate_archive`** (P6.6) — move `.brainclaw/memory/candidates/`
  items to `.brainclaw/archive/candidates/<migration-date>/` with
  manifest.
- **`handoff_review_strip`** (groundwork for P6.1) — remove `review`
  sub-object from existing handoffs.
- **`provenance_legacy_stamp`** (P6.3) — stamp
  `provenance: { kind: 'legacy' }` on pre-existing memory records.
  Infer `auto_reflect` for items already tagged `source=auto`.
- **`schema_version_marker`** — write `.brainclaw/schema-version.json`
  with history trail.

Future patches add to the catalogue; each declares its source schema
and target schema, so the planner stitches a path.

## Open implementation questions

- Should `migrate` live under the `bootstrap` family or as a top-level
  command? Leaning top-level — the action is orthogonal to setup.
- Do we gate migration on `brainclaw --version` matching a known
  "migration-capable" range? For now yes: if the binary is older than
  0.63.0 it refuses to migrate to schema 0.8.0.
- Where do the patch implementations live? Proposal:
  `src/core/migrations/<name>.ts`, registered in
  `src/core/migrations/index.ts`, discoverable for tests.

## Acceptance criteria (step `stp_3a866463`)

- [x] Command surface documented (flags, exit codes, streaming
      semantics).
- [x] Execution pipeline defined stage-by-stage with failure semantics.
- [x] Idempotency and rollback behaviours specified.
- [x] Patch catalogue enumerated with source/target schemas.
- [x] Open questions captured for implementation follow-up.

Next step: implement the backup pass (`stp_b41a3bcc`).
