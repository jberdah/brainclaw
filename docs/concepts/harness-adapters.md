# Harness adapters

Brainclaw's Loop Engine can launch the same contracted turn through different
agent harnesses without teaching the engine about Codex, Claude, or their CLI
output formats. `HarnessAdapter` is the boundary between a logical worker
attempt and one concrete harness. It is shared by the `review`, `ideation`,
`implementation`, `research`, and `debug` protocols.

This is an execution seam, not another workflow engine. Loop phases, iteration,
stop conditions, evidence policy, and convergence remain owned by the Loop
Engine. Process creation, environment, working directory, timeout,
cancellation, sentinels, and Windows command handling remain owned by
`ExecutionAdapter`.

## The execution path

```text
Loop worker phase
  -> resolve capability + immutable harness binding
  -> freeze both in the ExecutionContract capability snapshot
  -> HarnessAdapter.prepare({ contract, prompt, mode })
  -> structured InvokeCommand
  -> ExecutionAdapter.start(...)
  -> raw transport observation
  -> HarnessAdapter.parseOutcome(...)
  -> normalized lane result
  -> server-owned evidence envelope and protocol gates
```

The adapter receives the prompt separately because `ExecutionContract v1`
freezes authority and requirements, not the complete prompt body. It returns a
structured invocation rather than spawning a process itself. On Windows this
keeps prompts out of argv and out of shell quoting. A direct child receives the
prompt through stdin. An ack-wrapped child receives the same bytes through a
private per-run file redirected to stdin; the wrapper removes that file after
writing the terminal sentinel. This gives native Windows children a reliable
EOF without embedding the prompt in a second command string.

## Built-in adapters

| Adapter | Selection | Native output | Compatibility |
|---|---|---|---|
| `prompt-only@1` | Default | Existing prompt/sentinel contract | Byte-for-byte invocation compatibility with the previous path |
| `codex-cli@1` | `BRAINCLAW_NATIVE_HARNESS=1` for a Codex profile | JSONL (`--json`) | Falls closed to a partial result when a successful process emits invalid structured output |
| `claude-cli@1` | `BRAINCLAW_NATIVE_HARNESS=1` for a Claude profile | JSON (`--output-format json`) | Rejects an unattested requested model before the launch fence |

The feature flag is deliberately opt-in. An unknown or unavailable native
adapter does not silently become another native adapter. Existing generic
profiles continue through `prompt-only@1`.

## Platform and opt-in E2E matrix

The adapter contract is cross-platform even though the process boundary is
different. CI runs the default suite on Linux and Windows; on Windows the
execution adapter owns shell resolution while the harness still supplies a
structured argv and a separate prompt body.

| Coverage | Linux | Windows |
|---|---|---|
| Unit/contract tests for prompt-only, Codex and Claude adapters | Default CI suite on Node 22 and 24 | Default CI suite on Node 24 |
| Command boundary | Direct executable + argv/stdin | ExecutionAdapter shell resolution; ack-wrapped stdin uses an ephemeral redirected file, never prompt re-quoting |
| Repository E2E suite | Dedicated Linux job | Covered by the default platform suite; no separate Windows E2E job |
| Real Codex/Claude account smoke | Explicit local opt-in | Explicit local opt-in |

The real-account smoke tests are skipped by default because they require an
installed, authenticated CLI and spend provider quota. Run either one after
`npm run build:test`:

```powershell
$env:BRAINCLAW_CODEX_HARNESS_E2E = '1'
$env:BRAINCLAW_CODEX_E2E_MODEL = 'gpt-5.6-sol' # optional
node --test dist-test/tests/unit/harness-adapters.test.js

$env:BRAINCLAW_CLAUDE_HARNESS_E2E = '1'
$env:BRAINCLAW_CLAUDE_E2E_MODEL = 'sonnet' # optional
node --test dist-test/tests/unit/harness-adapters.test.js
```

Use the equivalent environment-variable syntax on POSIX shells. These flags
only enable the two native smoke cases; deterministic adapter, parsing,
capability, restart and evidence-boundary tests always run.

## Requested, resolved, and observed capabilities

Model identity has three distinct stages:

- **requested** — what the caller asked the harness to run;
- **resolved** — the exact selector passed to the CLI, frozen with the adapter
  id and version in `CapabilitySnapshot.resolved.harness` before reservation.
  Because neither installed CLI exposes an authoritative account-specific
  model catalogue, an explicit selector is marked `unattested`, not falsely
  labelled `exact`;
- **observed** — what the harness reports after execution, stored separately on
  `AgentRun.runtime_capability_observation`.

Requested and resolved values are immutable attempt inputs. Runtime observation
never rewrites that snapshot. A different observed model creates a monotone
execution-contract anomaly: later correct-looking output cannot erase it or
open a convergence gate. A retry therefore needs a new attempt instead of an
in-place adapter or model substitution.

## Result and evidence boundary

`parseOutcome` converts harness-specific terminal output into a result claim.
Normalization may map transport failure, invalid JSON, blocked work, or a
successful result into the common lane-result vocabulary. It may not create an
`EvidenceEnvelope`, decide that a phase gate passed, or advance a Loop.

Native adapters append a versioned terminal contract to the worker prompt. The
final assistant message inside the Codex JSONL or Claude JSON envelope must be
exactly one strict object (no prose inference):

```json
{
  "schema_version": 1,
  "status": "completed",
  "summary": "No blocking findings",
  "body": "Optional details",
  "artifact_type": "verdict",
  "review_verdict": "approve"
}
```

`review_verdict` is mandatory for review-verdict work. A missing, unknown, or
narratively implied verdict remains partial/failed and cannot close a review
Loop. Other Loop kinds use the same result-claim envelope with their own
server-owned expected artifact type.

Those decisions remain server-controlled. The normal order is:

```text
transport facts -> harness result claim -> lane-result normalization
                -> reconciliation -> evidence sealing -> gate evaluation
```

This separation prevents a harness from turning its own prose or exit status
into proof. The same rule applies to all five Loop kinds; their different
artifact contracts are interpreted only after normalization.

## Failure and restart rules

- Missing native binaries and models known to be unsupported are rejected
  before the launch fence. Other explicit model names are passed unchanged,
  marked `unattested`, and never get a fallback flag; the CLI must either run
  that selector or fail the attempt.
- A persisted adapter id/version must match the adapter used to prepare a
  restart. A feature-flag change cannot silently move an existing attempt to a
  different harness.
- Spawn failures and timeouts are transport diagnostics, not protocol
  verdicts.
- Native structured-output parse failures are explicit partial/failed results,
  never successful fallback to unstructured prose.
- Observed capability mismatch fences convergence and is recorded once on the
  AgentRun.
- When a native worker does not write `LANE-RESULT.json`, targeted harvest can
  normalize its terminal runtime logs into the same untrusted lane-result
  ingress. Attempt identity is sourced from the reservation and completion
  signal; reconciliation still seals evidence and evaluates the protocol gate.

## Reference implementation

- [`src/core/harness-adapters/`](../../src/core/harness-adapters/)
- [`src/core/execution-adapters.ts`](../../src/core/execution-adapters.ts)
- [`src/core/execution-contract.ts`](../../src/core/execution-contract.ts)
- [`src/core/loops/turn-execution.ts`](../../src/core/loops/turn-execution.ts)
- [`tests/unit/harness-adapters.test.ts`](../../tests/unit/harness-adapters.test.ts)
