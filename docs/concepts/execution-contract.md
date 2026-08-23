# Execution contract and capability snapshot

Every worker-backed Loop turn now carries an immutable `ExecutionContract v1`.
It answers a narrower question than the Loop protocol: **what exact work may
this selected worker launch, under which capabilities and evidence rules?** The
Loop Engine still owns phases, gates, iteration and convergence. The contract
freezes one physical attempt at the dispatch boundary.

This is shared infrastructure for all five `LoopKind` values. It is neither a
review-loop feature nor a new workflow engine:

| Loop kind | Examples of contracted worker phases |
|---|---|
| `review` | `findings`, `author_response`, `followup_review` |
| `ideation` | `critique` |
| `implementation` | `execute` |
| `research` | `investigate`, `synthesize` |
| `debug` | `reproduce`, `hypothesize`, `isolate`, `fix` |

Engine and manual phases do not launch workers and therefore do not create an
execution contract.

## What is frozen

`ExecutionContract v1` contains:

- loop, turn, logical attempt epoch, Assignment and AgentRun identity;
- LoopKind, phase and iteration;
- completion mode and explicitly typed expected artifacts;
- a `CapabilityRequirement`;
- workspace scope, checkout isolation and write policy;
- dispatch and launch-grant durations;
- evidence requirements (`turn_id`, `run_id`, nonce and artifact-hash policy);
- the minimum contract and AttemptAuthority protocol versions a reader must
  understand.

The logical attempt epoch belongs to immutable identity. It is distinct from
the mutable launch-grant epoch, which may increase when an armed generation is
revoked and safely re-armed before crossing.

Canonical JSON recursively sorts object keys, removes `undefined`, preserves
array order and normalizes strings to Unicode NFC. Its SHA-256 is the immutable
contract identity. A policy change therefore changes the hash; equivalent
Unicode and object-key ordering do not.

## Requirement is not observation

`CapabilityRequirement` says what the attempt needs. Before reservation,
Brainclaw resolves the selected agent's declared profile into a separate,
persisted `CapabilitySnapshot`:

```text
CapabilityRequirement + selected agent profile
                 |
                 v
        deterministic resolver
                 |
       accepted snapshot or reasons
```

The resolver checks role, integration surfaces, execution surface and model.
Current profiles do not attest an exact tool catalog, so a named
`required_tools` list fails closed with `tool_catalog_unattested`; Brainclaw
does not infer tool availability from generic MCP or skill support.

For worker-backed turns, the resolved snapshot also freezes a
`HarnessCapabilityBinding`: adapter id/version plus requested and selected model
string. A CLI model selector is marked `unattested` unless the harness can
actually attest account-specific availability; it is never mislabeled as an
exact capability merely because `--model` exists. The adapter cannot change on
replay or after a feature-flag flip. Runtime model and adapter observations are
stored separately on AgentRun and compared with the contract-bound snapshot.
See [Harness adapters](./harness-adapters.md).

Default roles follow the work performed by each worker phase: review findings
and follow-up plus ideation critique require `review`; research requires
`consult`; review author response, implementation and debug require `execute`.
A caller can provide a stricter explicit requirement when a protocol needs one.

## Persistence and authority

No new store or event journal was introduced.

| Record | Persisted contract data | Role |
|---|---|---|
| `TurnReservation` | full contract, hash/reference, capability snapshot | authoritative immutable attempt record |
| `Assignment` | hash/reference + snapshot | business projection |
| `AgentRun` | hash/reference + snapshot + optional monotone anomaly fence | runtime projection |

The Assignment and AgentRun are created or validated before the launch fence
crosses. Recovery enriches a legacy projection only when its new fields are
absent; a present, divergent hash or snapshot is a projection conflict. A
pre-v1 reservation remains readable and adoptable without fabricating a
historical contract (`contract_status: legacy_uncontracted`). New records
always persist the complete triplet. A partial triplet fails closed because it
cannot prove which contract and capability observation belong together.

Compatibility is symmetric at the projection boundary. A legacy-shaped caller
may replay a record that already contains P1 fields without erasing or
conflicting with them; a P1 caller may enrich an older projection whose fields
are absent; two present but divergent values remain a hard conflict.

## Launch acceptance

The safe order for every worker-backed protocol is:

```text
validate loop/slot/claim
  -> resolve CapabilitySnapshot
  -> build + hash ExecutionContract
  -> reserve / commit / arm
  -> project Assignment + AgentRun + bindings
  -> cross launch fence exactly once
```

An adapter that can attest an accepted contract before crossing passes both the
contract and capability-snapshot hashes to `prepareTurnExecution`; a mismatch
is rejected before reservation and the caller may reselect a worker. The normal
CLI path crosses the exactly-once launch fence immediately before spawn. The
contract variables take precedence over any environment supplied by the invoke
template. A small child bootstrap then reads the environment it actually
received, compares it with the immutable reference and:

1. writes a JSON `ack` containing the effective hashes and an
   `accepted`/`rejected` status before invoking the worker;
2. exposes the hashes as `BRAINCLAW_EXECUTION_CONTRACT_HASH` and
   `BRAINCLAW_CAPABILITY_SNAPSHOT_HASH`;
3. echoes them into the mechanical `completed` or `failed` sentinel; and
4. asks the worker to echo them in `LANE-RESULT.json`.

The dispatcher validates the acknowledgement, and harvest/reconciliation
validate terminal evidence against the authoritative reservation reference. A
missing or different hash after `launch.status=crossed` is a
`post_crossing_anomaly`: convergence is withheld and `respawn:false` is
propagated. The first observation is persisted on AgentRun as a monotone fence;
the bootstrap ack remains a durable fallback signal. Later correct-looking
lane or sentinel data cannot erase the anomaly. The process may already be
running, so Brainclaw never converts this condition into a manual fallback or
a second launch for the generation.

Manual execution uses the same environment, child bootstrap, ack and terminal
sentinels. The bootstrap creates the generation-keyed ack exclusively, so
re-running a copied command cannot start the same generation twice. Once an
automatic spawn has been attempted, a missing handshake or spawn error is
treated as an uncertain post-crossing anomaly: Brainclaw does not offer a
manual fallback command for that contracted generation. Contracted manual
commands are currently emitted only by Brainclaw's native adapter; an opaque
custom adapter cannot self-declare its command safe.

## Version and rollback behavior

Contract and protocol readers reject a `minimum_reader_version` above the
version they implement. Contract fields on TurnReservation, Assignment and
AgentRun are optional only for dual-reading records written before v1. A fully
legacy reservation continues under its historical evidence rules; new work is
contracted; partial or unknown future contracts fail closed instead of being
silently misinterpreted. The projection compatibility rules above make a
producer rollback non-destructive for already-enriched records.

Reference implementation:

- [`src/core/execution-contract.ts`](../../src/core/execution-contract.ts)
- [`src/core/loops/turn-execution.ts`](../../src/core/loops/turn-execution.ts)
- [`src/core/loops/attempt-reservation.ts`](../../src/core/loops/attempt-reservation.ts)
- [`tests/unit/execution-contract.test.ts`](../../tests/unit/execution-contract.test.ts)
- [`tests/unit/loops-p0c-conformance.test.ts`](../../tests/unit/loops-p0c-conformance.test.ts)
