# Attempt authority

`AttemptAuthority` is the kind-neutral execution authority used by every
worker-backed phase of the Loop Engine. It answers three questions that must
never be inferred from process IDs, mutable projections, or telemetry:

1. was the logical turn committed;
2. which physical generation may spawn;
3. which generation may settle the turn.

It is not a sixth loop protocol and it adds no event journal. Review, ideation,
implementation, research, and debug all use the same substrate. Loop events
remain the causal history; runtime events remain telemetry; Assignment and
AgentRun remain queryable projections.

## Identity model

One logical turn may now have several physical runs.

| Identity | Lifetime | Rule |
|---|---|---|
| `turn_id` | logical turn | stable across takeover and retry |
| `assignment_id` | logical work assignment | stable across takeover and retry |
| `attempt_epoch` | physical generation | starts at `0`, increases by one |
| `run_id` | physical execution | fresh for every epoch |
| `launch_nonce` | launch fence | fresh and unpredictable for every epoch |
| `contract_hash` | execution contract | recomputed for the generation's run and workspace |
| `workspace_digest` | isolated workspace | binds the real workspace path to the turn and epoch |

For backward compatibility, the first worker phase to occupy a slot in a
protocol iteration uses the historical deterministic identity derived from
`(loop_id, slot_id, iteration)`. When the same slot is reused by a different
worker phase in that iteration, Brainclaw derives a versioned phase-qualified
identity from `(loop_id, slot_id, phase, iteration)`. The resolver adopts an
existing compatible legacy or phase-qualified reservation before minting
anything, so same-phase retries remain exactly-once and in-flight upgrades keep
their durable identity. A different logical phase is a different turn; a
takeover remains a new physical generation of the same turn.

Evidence for an AttemptAuthority v2 generation is accepted only when the full
tuple matches:

```text
(assignment_id, turn_id, attempt_epoch, run_id, launch_nonce,
 contract_hash, workspace_digest)
```

Matching only `turn_id`, `run_id`, and `nonce` remains supported for legacy
reservations. Once a turn has a v2 generation chain, the complete tuple is
mandatory. An old worker can therefore finish late, but its output cannot
mutate the loop or the current AgentRun.

## Durable decisions

The original `TurnReservation` still owns logical commit and the immutable
generation-zero contract. AttemptAuthority v2 adds small immutable decision
cells under `.brainclaw/memory/loops/attempt-generations/<turn_id>/`; rollout
guards and signed ACKs live separately under
`.brainclaw/memory/loops/attempt-authority-v2/rollout/`:

- one initial-generation cell per turn;
- `launch(epoch)`, decided once as `crossed` or `revoked`;
- `close(epoch)`, decided once as `settled`, `takeover`, `retry`, or
  `cancelled`;
- an optional `head.json`, which is only a rebuildable cache.

Settlement and takeover contend on the same `close(epoch)` cell. Exactly one
wins. A takeover embeds the complete successor generation in that cell, so a
crash after the decision but before projections is repaired by replaying the
same successor; it never mints another run.

The publish protocol is intentionally conservative on Windows and POSIX:

1. create a temporary file on the same volume;
2. write, flush, `fsync`, and close it;
3. publish the final path with a hard-link create-if-absent;
4. read and adopt the incumbent on `EEXIST`.

There is no rename fallback. If the filesystem cannot provide this no-clobber
primitive, v2 mutations fail closed. Orphan temporary files are
non-authoritative and safe to remove later.

## Surfaces and their roles

Four event/state surfaces exist. Their responsibilities are deliberately
non-overlapping; only the first one answers whether a process may launch or a
result may settle.

| Surface | Role | Owner | Authority rule |
|---|---|---|---|
| `TurnReservation` plus immutable `initial`, `launch(epoch)` and `close(epoch)` cells | **Authoritative** execution decisions | `AttemptAuthority` | The first no-clobber decision wins. Mutable projections never override it. |
| Loop `LoopEvent` journal | **Causal** protocol history | Loop Engine | Replays phases, artifacts, gates and generation-change causes; it does not grant spawn authority. |
| `RuntimeEvent` stream | **Telemetry** | execution/runtime layer | Reports processes, heartbeats, adapters and diagnostics; it is evidence for an operator, never a launch/settlement decision. |
| Legacy project `events.jsonl` | **Compatibility-only** audit stream | legacy consumers | Retained for compatibility. New AttemptAuthority or registry logic must not depend on it; journal v2 carries registry projections. |

Assignment, AgentRun, Claim, slot and `head.json` records are queryable
projections rather than a fifth event surface. The separation invariant is:
`AttemptAuthority` decides execution, `LoopEvent` explains protocol causality,
`RuntimeEvent` observes execution, and `events.jsonl` serves old readers.

## What can run in parallel

Brainclaw does not concurrently rewrite shared JSON files. That proved fragile
in particular on Windows. Instead it narrows serialization to the decision
that actually needs consensus:

- capability resolution, liveness collection, contract construction, isolated
  workspace preparation, and writer signatures can run in parallel;
- each rollout writer publishes its own immutable ACK file independently;
- contenders race on one immutable `launch(epoch)` or `close(epoch)` cell;
- Assignment, AgentRun, loop event, runtime event, and head updates are
  sequential, idempotent projections that may be replayed after a crash.

This gives parallel preparation without permitting concurrent mutation of the
same file. The global mutation pipeline remains serialized for ordinary store
entities; AttemptAuthority decisions do not hold that lock while agents work.

## Ordered dispatch

P0A characterised the legacy order as
`reserve → commit → durable projections → legacy launch CAS → spawn →
reconcile`. That order remains the compatibility prefix: a crash before the
launch CAS is repairable, and a replay observing an already-crossed legacy
decision never spawns again.

The shipped v2 order extends that prefix rather than bypassing it. During the
Release-B cutover, generation zero is anchored only after the legacy launch
decision has crossed. A crash between either boundary is repaired
idempotently: the initial cell embeds the same immutable generation, and the
v2 `launch(0)` cell remains the final spawn fence. Successor generations skip
identity reminting for the logical work and use the v2 path below.

The common worker path is
[`prepareTurnExecution`](../../src/core/loops/turn-execution.ts):

1. validate the loop phase, slot, claim, capabilities, and workspace policy;
2. reserve and commit the stable logical turn;
3. freeze its ExecutionContract and capability snapshot;
4. create or validate all durable projections (Assignment, AgentRun, claim, and slot) before crossing;
5. cross `launch(0)` immediately before spawn;
6. when Release B is active, anchor generation zero in the v2 chain;
7. accept completion only after rechecking the full fence under the loop lock;
8. race settlement on `close(epoch)` before applying loop projections.

For v2, worker MCP lifecycle reports stop at `accepted`, `started`, and
`progress`. A worker cannot set the stable Assignment terminal or release its
Claim, even with the current fence. It writes full-fence `LANE-RESULT.json`;
settlement seals that result first, then Brainclaw projects Assignment,
AgentRun, Claim, artifacts, and loop state.

After takeover, re-entering the same common path keeps the logical Assignment,
projects the successor AgentRun and contract, then races `launch(next_epoch)`.
Only the caller whose publish returns `won: true` may spawn. Replays adopt the
crossed cell and do not spawn.

The per-kind phase graph, artifacts, gates, iteration, and stop condition stay
in the [Loop Engine](./loop-engine.md). AttemptAuthority does not decide what a
review verdict means, when an ideation synthesis is sufficient, or whether an
implementation/debug verification is green.

## Functional API

The kind-neutral facade is
[`src/core/loops/attempt-authority.ts`](../../src/core/loops/attempt-authority.ts).
Its public operations map directly to the decisions above:

- `prepareAttempt` and `projectAndCross` implement the legacy
  reserve/commit/projection/cross compatibility prefix. `projectAndCross`
  authorises a spawn only when it returns `kind: 'won'`.
- `inspectAttempt`, `matchEvidence`, `revokeAttempt`, and `abortAttempt`
  expose read-strict inspection and the irreversible legacy decision axes.
- `bootstrapAttemptAuthorityV2` anchors generation zero without minting a
  second logical Assignment.
- `prepareAttemptTakeoverV2` closes the current epoch with a complete successor
  embedded in the immutable cell; `takeoverLoopAttempt` applies the loop-level
  causal and replayable projections.
- `crossActiveAttemptGenerationV2` arbitrates the successor's launch cell.
  Only its `won: true` result carries spawn authority.
- `settleActiveAttemptGenerationV2` seals result evidence, competes on
  `close(epoch)`, and exposes the incumbent verdict to losing/replaying calls.
- `resolveTurnGenerationChain` and `rebuildAttemptGenerationHead` read the
  immutable chain and repair the non-authoritative head.

The low-level cell functions live in
[`attempt-generations.ts`](../../src/core/loops/attempt-generations.ts); signed
membership and authority-home checks live in
[`attempt-rollout.ts`](../../src/core/loops/attempt-rollout.ts). The Loop Engine
still owns artifacts, phase transitions, gates and convergence. Harness and
execution adapters translate/execute a contracted turn but never call these
functions to approve their own output.

## Takeover and retry

A coordinator may fence a crossed generation and arm a successor with:

```bash
brainclaw loop takeover <loop_id> \
  --slot <slot_id> \
  --turn-id <turn_id> \
  --expected-epoch <n> \
  --cause "heartbeat and process evidence are stale" \
  --liveness-evidence "no heartbeat for 30m; wrapper exited" \
  --external-effect-policy idempotent \
  --next-workspace-path <existing-isolated-directory> \
  --agent <loop-coordinator>
```

The equivalent MCP call is `bclaw_loop(intent="takeover", ...)`. It records an
`attempt_generation_changed` LoopEvent, projects an `attempt_takeover`
RuntimeEvent, interrupts the old AgentRun best-effort, and creates the new
AgentRun. Its response is deliberately `spawn_authority: false`: the caller
must dispatch the same logical turn through the common path, which crosses the
new launch cell immediately before process creation.

Takeover requires:

- the loop coordinator identity;
- the expected active epoch;
- a non-empty cause and liveness evidence;
- an existing linked Git worktree of the same repository, with a distinct
  gitdir and top-level path that does not alias the prior workspace (including
  through a Windows junction);
- effects declared `none`, `idempotent`, or protected by an external fence.

An operation with non-idempotent external effects and no external fencing must
not be taken over automatically. Human recovery must first establish the
external system's outcome or fence it there.

## Two-release activation

AttemptAuthority v2 is a writer compatibility boundary. Enabling a new writer
beside an old binary would let the old binary ignore generation cells, so the
rollout has two releases.

Release A:

1. deploy v2-aware readers and guarded writers everywhere;
2. stop or drain pre-Release-A processes;
3. prepare one immutable membership guard;
4. let every active writer sign and publish its own ACK in parallel;
5. activate the guard only after every active writer ACKs the same digest.

Release B permits the first v2 generation write. CLI support:

```bash
brainclaw attempt-authority status --json
brainclaw attempt-authority prepare --writers <agent_id...>
brainclaw attempt-authority ack --membership-epoch 1 --agent-id <agent_id>
brainclaw attempt-authority activate --membership-epoch 1
```

Membership epochs form an immutable chain. A genuinely offline writer can be
revoked only by a later membership epoch chained to the active activation. A
pre-Release-A binary cannot sign or honor this guard; it must be stopped or
removed by deployment/service control before activation.

## Migration and rollout runbook

Treat the first v2 generation cell as the irreversible cutover boundary.
Release A can be rolled back while no v2 cell exists; Release B cannot be
downgraded in place.

1. **Drain and inventory.** Stop new loop dispatch, let active generations
   settle, list every process/service/host capable of writing this store, and
   stop pre-Release-A binaries. An offline writer is not implicitly safe: it
   must be removed from service control or excluded by a new membership epoch.
2. **Create and verify a private backup.** With writers quiescent, run:

   ```bash
   node scripts/store-snapshot.mjs create --store .brainclaw
   node scripts/store-snapshot.mjs verify --snapshot <snapshot-directory>
   ```

   Keep the snapshot outside the repository. Record its manifest hash and the
   output of `brainclaw attempt-authority status --json`. The detailed storage
   procedure is [store-snapshot.md](../playbooks/store-snapshot.md).
3. **Release A guard.** Run `prepare`, let every active writer run `ack` in
   parallel, then run `activate`. Re-run `status --json` and verify the
   membership epoch, authority home and ACK digest before enabling Release B.
   `prepare`/`ack` also exercise the hard-link create-if-absent primitive; a
   filesystem that cannot provide it stops the rollout here.
4. **Canary Release B.** Enable v2 on the authority home only. Run one
   no-external-effect worker attempt, then one explicit retry/takeover in a
   linked Git worktree. Verify that the Assignment stays stable, epochs and
   AgentRuns change, one `close(epoch)` winner exists, stale output is rejected,
   and `head.json` can be rebuilt from the chain. Observe LoopEvents and
   RuntimeEvents separately; neither may contradict the decision cells.
5. **Expand.** Resume ordinary dispatch only after the canary and targeted
   tests are green. Add or revoke writers through a new, digest-chained
   membership epoch; never edit an activated guard or ACK in place.

**Abort before cutover.** If no v2 initial/launch/close cell was ever written,
stop writers, restore the verified pre-cutover snapshot into an empty directory
with `store-snapshot.mjs restore`, verify it, and re-point the workspace under
the previous release. Do not restore over a live store.

**Recovery after cutover.** Once any v2 cell exists, disabling the feature flag
or installing an old writer is a forbidden downgrade. First stop all writers,
export the current v2 store with `store-snapshot.mjs create`, verify the export,
and restore it only into an empty directory using a v2-capable binary. Preserve
the immutable generation/rollout cells and use the same local authority-home
identity; a restore on another device is a passive replica until explicitly
re-authorised. A pre-v2 backup may be inspected or used to recover unrelated
data, but it must not replace a store whose v2 history has started.

## Authority home and federation

Every v2 fence carries an `authority_home`:

```text
{ store_instance_id, device_id }
```

The identity is random and stored outside the project store in the user's
Brainclaw registry (`~/.brainclaw/store-instances/` by default). It is not
derived from a path or hostname. Copying a `.brainclaw` directory therefore
does not copy write authority. `BRAINCLAW_AUTHORITY_IDENTITY_ROOT` may relocate
that local registry for managed or test environments.

Only the activated authority home may write v2 cells. Federated replicas are
passive readers of those cells; they do not arbitrate takeover independently.
A copied or foreign device fails with `authority_home_mismatch`.

## Recovery

- No initial-generation cell: use the legacy reservation path. A Release-B
  writer anchors generation zero only after the legacy launch has crossed.
- `launch(epoch)` absent: projections may be repaired, then callers may contend
  on launch.
- `launch(epoch) = crossed`, `close(epoch)` absent: the run may still produce
  acceptable full-fence evidence; do not respawn it.
- `close(epoch) = takeover|retry`: the embedded successor is authoritative.
  Replay missing projections and continue from it.
- `close(epoch) = settled`: replay any missing terminal projections; never
  takeover that generation.
- Corrupt cells, broken chain links, authority mismatch, incompatible writer,
  or unsupported hard links: fail closed and require operator repair.

`head.json`, AgentRun status, RuntimeEvents, and process liveness never override
the immutable chain. The head can always be rebuilt from generation and close
cells.

## Invariants (I1–I18)

- **I1 — Stable logical identity.** `turn_id` and `assignment_id` do not
  change across retry or takeover.
- **I2 — Fresh physical identity.** Every epoch has a fresh `run_id`, nonce,
  workspace identity/digest and generation contract hash.
- **I3 — Single execution authority.** Only reservation and immutable
  generation decision cells decide launch or settlement.
- **I4 — Irreversible logical commit.** A committed reservation never becomes
  aborted; an aborted reservation never becomes committed.
- **I5 — One launch verdict per epoch.** `crossed` and `revoked` are exclusive,
  and only the caller that creates `crossed` may spawn.
- **I6 — One close verdict per epoch.** `settled`, `takeover`, `retry`, and
  `cancelled` are mutually exclusive.
- **I7 — One receivable generation.** A closed generation is never active;
  late output stays audit-only.
- **I8 — Full-fence evidence.** V2 acceptance matches assignment, turn, epoch,
  run, nonce, contract hash and workspace digest.
- **I9 — Evidence before projections.** Settlement seals immutable result
  evidence before applying terminal Assignment, AgentRun, Claim, artifact or
  loop projections.
- **I10 — Projections are replayable.** Assignment, AgentRun, Claim, slot,
  events and head can be created-or-validated again after a crash without
  changing authority.
- **I11 — Shared mutable JSON is serialized.** Parallel work prepares inputs or
  publishes disjoint immutable files; it never concurrently rewrites one JSON
  projection.
- **I12 — No-clobber means hard link.** Final cells use same-volume temp,
  fsync/close and hard-link create-if-absent. There is no rename fallback.
- **I13 — Authority home is local.** Only the activated
  `(store_instance_id, device_id)` may mutate v2 cells.
- **I14 — Federation is passive.** Replicas may validate/replay the chain but
  never promote themselves during a partition.
- **I15 — Writer rollout is explicit.** Release B requires one activated,
  signed membership epoch whose active writers all ACK the same digest and
  both `minimum_writer_version` and `minimum_reader_version`.
- **I16 — External effects are fenced.** Automatic takeover is forbidden for
  non-idempotent external effects without an external fence.
- **I17 — Recovery is decision-driven.** Digests and immutable cells determine
  the next action; clocks, PIDs, heartbeats and marker files are supporting
  liveness evidence only.
- **I18 — Event roles remain separate.** AttemptAuthority is authoritative,
  LoopEvent causal, RuntimeEvent telemetry, and `events.jsonl`
  compatibility-only. No fifth journal is introduced.

## Code map

- [`attempt-reservation.ts`](../../src/core/loops/attempt-reservation.ts) —
  logical reservation and legacy launch authority.
- [`attempt-generations.ts`](../../src/core/loops/attempt-generations.ts) —
  immutable generation, launch, close, and head primitives.
- [`attempt-rollout.ts`](../../src/core/loops/attempt-rollout.ts) — signed
  writer membership and local authority identity.
- [`attempt-authority.ts`](../../src/core/loops/attempt-authority.ts) — common
  facade, bootstrap, takeover, crossing, and settlement.
- [`attempt-takeover.ts`](../../src/core/loops/attempt-takeover.ts) — loop-level
  takeover transaction and replayable projections.
- [`reconcile-turn.ts`](../../src/core/loops/reconcile-turn.ts) — full-fence
  validation, close-cell settlement, and business convergence.
- [`turn-execution.ts`](../../src/core/loops/turn-execution.ts) — common worker
  dispatch path for all five LoopKinds.

See also [Execution contract](./execution-contract.md),
[Harness adapters](./harness-adapters.md), and the
[Loop Engine](./loop-engine.md).
