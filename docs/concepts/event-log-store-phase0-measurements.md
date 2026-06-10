# Event-Log Store — Phase-0 Measurements (C3 falsifier)

> Measured 2026-06-10 on the brainclaw dogfood store (`shared_agent_memory_mvp/.brainclaw`),
> per spec §6 C3: "p95 size × frequency per item_type; if a poison combination exists
> (record > 64 KB or segment rolls faster than ~weekly), `payload_ref` enters phase 1
> and the record schema changes — decide before the format ships."

## Entity snapshot sizes (current per-entity JSON files as payload proxy)

| item_type | files | p50 B | p95 B | max B |
|---|---|---|---|---|
| assignment | 160 | 1,900 | 7,209 | 10,680 |
| claim | 383 | 692 | 5,535 | 10,385 |
| constraint | 12 | 654 | 1,542 | 1,542 |
| decision | 73 | 1,190 | 2,451 | 4,768 |
| **handoff** | **495** | **109,700** | **225,157** | **296,032** |
| plan | 193 | 2,195 | 7,481 | 13,388 |
| trap | 55 | 1,196 | 3,680 | 4,217 |

## Event frequency (events.jsonl, 17,727 events since 2026-04)

| item_type | events (all) | events (last 7d) |
|---|---|---|
| runtime_note | 5,192 | 244 |
| session | 4,611 | 223 |
| state | 3,060 | 275 |
| agent_run | 1,387 | 424 |
| assignment | 1,316 | 401 |
| claim | 717 | 83 |
| handoff | 454 | 0 |
| plan | 399 | 41 |
| trap | 156 | 31 |
| decision | 147 | 9 |

## Verdict — the falsifier FIRES on handoffs

- **Handoffs are 15-45× over the 64 KB poison threshold** at p50 already (the inline
  `snapshot.diff` dominates — same root cause as the 41 MB `handoffs/compacted.jsonl`).
  At historical frequency (454 events), full-snapshot handoff records would roll a
  10 MB segment in ~90 events — days, not weeks.
- **Every other entity class is comfortable** (worst p95 = plan at 7.5 KB; even
  the high-churn registry classes are ≤ 7.2 KB p95). Full-snapshot-per-event stands
  for everything except handoff-class payloads.

**Consequence for the spec (phase 1, per C3's own rule):** `payload_ref` enters the
record format in phase 1 for oversized payloads — recommended shape: inline snapshot
when `payload <= 64 KB`, else `payload_ref` to a content-addressed blob
(`journal/blobs/<sha256>`), with the envelope carrying the hash either way.
Alternative worth Codex's review: a handoff "diet" (externalize `snapshot.diff` from
the handoff entity itself, which would also fix the 41 MB compacted.jsonl class) —
the two are composable, not exclusive.

~~Open for C3 review~~ — **RESOLVED 2026-06-10** in spec §2.10: blob gc extends the
two-checkpoint floor verbatim (a blob archives only when unreferenced by non-archived
segments AND by both newest verified checkpoints' closures); `runtime_note`/`session`
volume needs **no early retention knob** — both classes are payload-free
(observability) in v2, so 10k events ≈ 2–3 MB of line overhead, no threat to the
weekly-roll target (J5 unchanged). Residual product call: J6 (handoff diet).
