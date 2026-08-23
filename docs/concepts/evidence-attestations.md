# Evidence envelopes, attestations, and protocol gates

The Loop Engine does not treat an artifact's text as proof that a transition
is safe. Every new loop binds `gate-policy-v1`; every artifact committed by
the engine receives a server-sealed `EvidenceEnvelope` before it enters the
thread.

This contract applies equally to the five shipped loop kinds: review,
ideation, implementation, research, and debug. It refines their gates; it
does not introduce a separate workflow or event store.

## EvidenceEnvelope v1

An envelope binds:

- the artifact digest, including id, phase, type, body/ref, producer,
  production time, critique links, and iteration;
- the exact subject: loop, artifact, phase, iteration and, when available,
  slot, turn, assignment, claim, run, launch-nonce digest/epoch, execution-contract
  hash, command digest, and workspace digest;
- a server-derived producer and ingress channel;
- an observation time and explicit validity window;
- independent attestations;
- a canonical SHA-256 integrity seal.

Ingress callers never submit an envelope. `complete_turn`, turn reconciliation,
the engine verify runner, operator-input handlers, bootstrap hooks, and
`add_artifact` all seal at their server-controlled commit boundary. Likewise,
`produced_by` is derived by the server; the public `add_artifact` input no
longer accepts it as authority. A direct `add_artifact` commit is intentionally
audit-only: its observation carries `artifact:write`, not `gate:artifact`.
The internal evidence context and sealing helper are omitted from the public
Loop Engine barrel; public completion and artifact functions explicitly strip
any runtime object that attempts to smuggle such a context.

The SHA-256 seal detects accidental or local-store tampering. It is not a
remote cryptographic identity signature: Brainclaw's local store remains in
the trusted computing base.

## Attestations are independent

There is deliberately no global confidence score and no ordering such as
“verification is stronger than approval”. A policy asks for the exact right
and attestation it needs:

| Attestation | Meaning | Typical right |
| --- | --- | --- |
| `claim` | the result is bound to the recorded claim/attempt subject | `subject:claim` |
| `observation` | the engine observed and committed an artifact | `gate:artifact` |
| `verification` | Brainclaw ran the opener-configured command | `gate:command_green` |
| `approval` | an authorized reviewer slot returned an accepted verdict | `gate:reviewer_green` |

A worker or adapter can report a passing `verify_report`, but it cannot grant
itself `verification`. A generic artifact insertion can store a deliverable or
an accepted verdict for audit, but cannot open either a generic artifact gate
or a reviewer gate.

Gate authority is an explicit tuple, not a producer-kind shortcut: policy
matches the ingress channel, producer kind, attestation kind, issuer, right,
and required subject fields. For example, `reviewer_green` accepts an approval
issued by `brainclaw:review-slot` through `complete_turn` or a fully bound
`reconcile_turn`; `command_green` accepts only `brainclaw:verify-command`.

## Gate evaluation

One evaluator is used by terminal stop conditions, phase-advance gates, and
iteration exits. A decision records:

- `passed`, plus distinct `strict_passed` and `legacy_passed` dimensions;
- policy version and rollout mode;
- a digest of the evaluated condition;
- accepted evidence ids;
- rejected artifact ids with machine-readable reasons.

The decision is attached to causal `phase_advanced`,
`phase_advance_blocked`, and automatic `closed` LoopEvents. RuntimeEvents
remain best-effort telemetry and never authorize a transition.

The evaluator rejects missing evidence on strict threads, invalid seals,
artifact/subject mismatches, cross-loop or cross-iteration replay, evidence
predating the loop, future timestamps, unauthorized channel/producer/issuer
combinations, missing execution bindings or rights, and duplicate payloads in
threshold gates. If an envelope is present but invalid, legacy behavior is
never used as a fallback.

The engine snapshots the workspace bytes immediately before and after
`verify_command`, then again at the evidence commit boundary. A concurrent
mutation changes the digest and forces the report red. The command argv and
its digest plus the stable workspace digest are copied into the report and its
sealed subject. Gate policy requires those bindings to match the configured
command and recomputes the current workspace digest whenever the gate is read;
a post-verification mutation therefore invalidates an earlier green report.
Reconciled worker evidence likewise binds the run, launch generation, and
execution contract. Pre-P1 reservations retain a deterministic hash of their
immutable legacy reservation fields so an in-flight historical attempt can
converge without pretending it carried a v1 execution contract.

Reviewer approval is scoped to the current loop iteration and to the slot's
current turn, assignment, and claim projections. A creator/admin recovery may
settle a slot, but it is recorded as coordinator evidence and cannot mint the
reviewer's approval.

Negative convergence is fail-closed too: an invalid critique cannot be used
to manufacture “no new critique”. After at least one full ideation cycle, a
settled critique round with no eligible new critiques is evaluated before the
quantitative critique gate. “Settled” is causal: the last trusted critic
successful completion emits an engine-owned `critique_window_closed` artifact
for that iteration. An open, assigned, running, failed, or cancelled critic
turn therefore cannot create saturation merely by staying silent.

## Rollout and legacy threads

`LoopThread.evidence_policy` makes compatibility explicit:

- absent: pre-policy thread; unsealed legacy artifacts retain legacy gate
  semantics (including duplicate threshold counting), while any present
  envelope is still validated;
- `{version: "gate-policy-v1", mode: "shadow"}`: writers seal evidence and
  decisions report both the independently composed strict and legacy results,
  while the legacy outcome controls the transition;
- `{version: "gate-policy-v1", mode: "strict"}`: only policy-eligible evidence
  influences gates.

New loops default to `strict`. Set `BRAINCLAW_EVIDENCE_ENVELOPES=shadow` for a
measured rollout, or `off` before opening a loop to create an explicit
pre-policy thread. The policy is frozen on the thread: changing the process
flag later does not silently downgrade an already-strict loop.

## Persistence model

Evidence lives on `LoopArtifact`; gate decisions live in the existing
append-only LoopEvent journal. Brainclaw does not add an evidence database or
a second event journal. The attempt reservation, execution contract,
artifact, evidence envelope, and causal event remain separately inspectable
parts of one execution history.
