# Store snapshot — the snapshot-before-curation rule (pln#619)

The loaded dogfood store IS a corpus: months of real claims, loops, assignments,
journals and debris that no synthetic fixture reproduces. Every curation
(candidate triage, GC, migration, mass-ack) destroys part of it. The rule:

> **Take a snapshot before ANY curation of the store.** Cleanup must be
> reversible and traceable; the regression pack (pln#621) needs a stable
> baseline to reproduce metrics against.

## Tool

`scripts/store-snapshot.mjs` — zero dependencies, four commands:

```
node scripts/store-snapshot.mjs create  [--store <dir>] [--out <dir>] [--brainclaw-version <v>]
node scripts/store-snapshot.mjs verify  --snapshot <dir>
node scripts/store-snapshot.mjs restore --snapshot <dir> --to <empty-dir>
node scripts/store-snapshot.mjs fixtures [--store <dir>] --out <dir>
```

- **create** copies the store into `<out>/store/`, writes `manifest.json`
  (schema version, timestamp, source path + git HEAD, per-directory totals,
  per-entity counts, one deterministic `corpus_hash` over path+size+sha256 of
  every file), then marks the snapshot files read-only. Default destination is
  `~/.brainclaw/snapshots/<project>/<stamp>/` — deliberately OUTSIDE any git
  repo: the store carries private coordination content and must never transit
  through a public remote. The hash is computed on the COPY, so a live store
  mutating mid-copy still yields an internally consistent manifest (for a
  perfectly quiescent capture, snapshot while the MCP is idle).
- **verify** recomputes totals, entity counts and the corpus hash and compares
  them to the manifest — immutability is checked, never assumed. Exit 1 on any
  divergence.
- **restore** copies into an EMPTY target only (never in place), clears the
  read-only bits, then verifies the restored tree against the manifest — the
  pln#619 acceptance criterion ("a restored store reproduces the metrics")
  executed on every restore.
- **fixtures** exports SHAPE summaries per entity collection (field names,
  value types, presence ratios) and observed values for an ALLOWLIST of
  enum-like field names only (status, type, severity, …). Free text and
  identity values are never exported, whatever their length — the rule is
  allowlist-only because two heuristics failed before it: a length gate leaked
  the hostname and OS username, and its identity-field patch still leaked
  short free text (adversarial review of PR #169 caught it in the shipped
  fixtures). Committed under `tests/fixtures/store-corpus/` for the
  regression pack.

The corpus hash serializes records NUL-delimited: a POSIX filename may legally
contain a newline, so newline-delimited records would let two distinct trees
share a preimage (same review, finding 2).

## Baseline of record

The pre-curation baseline of 2026-08-03 (brainclaw 1.20.2, store at ~1.9 GB /
12 121 files, 644 claims / 296 assignments / 243 loops):

```
~/.brainclaw/snapshots/shared_agent_memory_mvp/2026-08-03T09-53-14-067Z
corpus_hash 2732797349b1d61c38ba838f8d03ccba6fe901c755788ba212f0375db479094c
```

(The candidate-triage curation of 2026-08-03 was performed against the earlier
capture of the same morning; this retake follows the hash-encoding fix and
supersedes it.)

Restore-verified on capture day (hash + entity counts reproduced in an
isolated target). Any later "did the curation lose something?" question is
answered against this manifest.
