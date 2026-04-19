# `brainclaw upgrade --to=1.0` — dogfood procedure

Step 9 of `pln_bc6e88cc`. Runs the v1.0 schema upgrade on real stores
before `feat/phase-3-canonical-grammar` (`pln_c6472192`) can start.

## Prerequisites

- CLI built from latest master: `npm run dev`.
- Store to migrate has an accessible `.brainclaw/` (any depth).
- **No agents actively writing** to the store during the upgrade
  — the transaction lock will serialize but aborted writes can
  leave half-written JSON that the patches will refuse on read.
- Disk space: roughly 2× the current `.brainclaw/` size (for the
  backup snapshot).

## Procedure

### 1. Dry-run

```
node dist/cli.js upgrade --to=1.0 --dry-run
```

Expected output (not a strict match — counts will differ per store):

- `(dry run — would create backup before upgrade)`
- `(dry run — would archive N pending candidate(s) to …/archive/candidates/<date>)`
- `(dry run — would strip review from N handoff(s) out of M scanned)`
- `(dry run — would stamp legacy provenance on N of M record(s))`
- `(dry run — would bump schema 0.6.0 → 0.8.0)`
- Plus any housekeeping actions from the pre-existing `upgrade` path
  (legacy → entity dir moves, Zod schema doc migrations, agent file
  refreshes).

**Abort conditions** — do not proceed if the dry-run:
- Reports any action the operator does not recognise or expect.
- Throws an unhandled exception (a `ZodError` during the archive
  pass, for instance, is a schema resilience regression).

### 2. Apply

```
node dist/cli.js upgrade --to=1.0
```

The real run does the following in order under the store-wide lock:

1. Creates a backup at `<parent>/.brainclaw.bak-<iso-ts>/` with a
   manifest carrying the store's prior schema version.
2. Archives pending candidates into
   `.brainclaw/archive/candidates/<YYYY-MM-DD>/` with a typed
   manifest. Legacy candidates that fail the current Zod schema are
   still archived; the manifest records the parse error.
3. Strips the `review` sub-object from every handoff that carries
   one. Logs each mutation at
   `.brainclaw/archive/migrations/<YYYY-MM-DD>/handoff-review-strip.json`.
4. Stamps `provenance: { kind: 'legacy' }` on every memory record
   (decision / constraint / trap / handoff / runtime_note) that
   lacks a valid v1 provenance. Logs at
   `.brainclaw/archive/migrations/<YYYY-MM-DD>/provenance-rollout.json`.
5. Writes `.brainclaw/schema-version.json` with `current: 0.8.0`
   and a history entry listing the patches applied.
6. Runs the existing upgrade housekeeping (entity dir moves,
   schema doc Zod migrations, agent file refreshes, MCP config
   patching).
7. Commits the memory repo if initialised.

### 3. Health check

```
node dist/cli.js doctor --after-migration
```

Exits non-zero on any failure. Expected green checks:

- `[provenance]` All N memory record(s) carry a valid provenance field.
- `[handoff_review]` No handoff carries a `review` sub-object.
- `[candidate_archive]` No pending candidates remain at
  `coordination/inbox/` root.
- `[schema_version]` Store is at schema 0.8.0.

### 4. Spot-check

- Open a few records in `.brainclaw/memory/decisions/` — every
  file should end with `"provenance": { "kind": "legacy" }`.
- Confirm `.brainclaw/schema-version.json` exists and shows
  `current: "0.8.0"` plus one history entry.
- Confirm `.brainclaw/coordination/inbox/` has no `*.json` at the
  root (only `accepted/` and `rejected/` subdirs).

## Rollback

If anything looks wrong:

```
node dist/cli.js upgrade --rollback
```

Restores the most recent backup and parks the current live store at
`<parent>/.brainclaw.rollback-<iso-ts>/`. The parked tree is kept
for manual inspection; delete it when you have confirmed rollback is
complete.

## Dogfood sign-off

The dogfood gate is considered passed once:

- [ ] This machine's store migrated cleanly + doctor green.
- [ ] Monorepo test server store migrated cleanly + doctor green.
- [ ] No manual intervention was needed beyond what this doc lists.

Once both checkmarks are ticked, `pln_c6472192` (Phase 3 grammar
refactor) can start. Capture any manual interventions inline in this
doc for future operators.
