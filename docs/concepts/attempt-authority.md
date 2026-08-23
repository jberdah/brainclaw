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

## Normal chronology

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

## Recovery rules

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
