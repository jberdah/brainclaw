# Changelog

All notable changes to brainclaw are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and brainclaw adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.20.0] — 2026-08-02

A dispatched lane now works from what it demonstrably HAS, not from what its profile declares. The brief carries the project's constraints/traps/decisions inline (MCP becomes a refresh, never a prerequisite), states the gate's deliverable contract instead of hoping the worker infers it, never asserts MCP access it cannot verify, and stops prescribing a session lifecycle that was never the lane's to own. Underneath, the guard rails watching all of this were rebuilt from regex prose to AST structure after two of them were shown to hold nothing — and every guard in this release was watched failing on an induced violation before being trusted.

### Added

- **ContextEnvelope — survival context rides IN the dispatch brief** (pln#638 6b, #161). Briefs used to tell workers "call `bclaw_context` for project memory" — an instruction that assumes MCP is reachable, which is exactly the assumption this cycle set out to kill: a production critic ran with the declared-MCP flag true, no server there, and worked blind. The brief is the one artifact every tier demonstrably receives, so active constraints, traps and decisions are now inlined: bounded (3000 chars, 220/item, top-K 6 per kind), deterministic byte-for-byte, newest-first, with truncation STATED in the snapshot line ("6/20 trap(s)") — silent truncation reads as complete. Deliberately NOT scope-filtered: relevance guessing risks hiding the one trap that mattered. Empty or missing store → no section, never throws, never blocks a brief. Injected in both `generateBrief` and `generateDispatchBrief`, pinned at EMISSION (the delivered brief), not at the helper. Two corrections landed inside the same PR after the full regression caught them: the envelope reads the **target** project's store on cross-project dispatch (defaulting to `process.cwd()` was the coordinator's store, not the worker's), and the ideation-critic path opts out via `contextEnvelope: false` — its content already inlines a BM25-selected, budget-managed memory bundle, and the generic envelope stacked on top blew the documented ~48K content cap by exactly the envelope's size.

- **Worker reply contract — the gate's expectations travel in the brief** (pln#638 PR-5, #159). The phase gate (`min_artifacts_by_type` et al.) was checked at `complete_turn` but never COMMUNICATED at dispatch: a worker learned what the loop wanted only by failing it. `deriveWorkerReplyContract` extracts the current phase's stop condition recursively — `all`/`any` composition preserved, not flattened — freezes it at dispatch (phase + loop_version), and renders both the prose block and the machine `next_action` from the same object: one source, two audiences. The block is budget-deducted but never truncated; a brief that keeps its memory bundle but loses its deliverable contract would be worse than the reverse.

- **Transport parity — the brief never asserts MCP it cannot verify** (pln#638 PR-4, #157). `hasMcp` is a DECLARATION (static profile flag): `dispatchHasMcp` reads `runtime.mcp_direct` with no config/server/stdio check, which is precisely how the blind-critic incident happened. Declared-MCP briefs now say so and carry the conditional — "if `bclaw_*` tools respond, use them; if not, do not stop and do not discard your work — write `LANE-RESULT.json`". Tier-C gets the file protocol plus the candidate channel; UNKNOWN profiles get the conditional form instead of (as before) no transport section at all. One shared `laneResultShape()` ends the era of two conflicting LANE-RESULT shapes in the same codebase.

### Changed

- **Lanes have no sessions** (pln#638 6a, #160; decided by ideation `lop_2d838a638b1e2956`). A session is an AGENT's lifecycle and its effects overflow the lane: `session-end --auto-release` releases ALL of the agent's active claims — one finishing lane could tear down its siblings' work — and the handoff aggregates ALL its commits. The engine already scrubbed `SESSION_ID` from the worker env; the brief text now agrees: protocol sections stop instructing `bclaw_session_start`/`end` and an explicit prohibition names the reason. A lane's identity is assignment + claim + AgentRun. The doctrine is written at both halves of the seam (6d, #161): `buildProtocolSection` (brief side) and `attemptExecution` (wrapper side), each pointing at the other and naming the actual owners of the three needs hooks used to cover — inlined envelope (6b), mechanical sentinels + `bclaw_assignment_update` (6a), harvest/report as the only business closure (6c).

### Fixed

- **`--dry-run` previewed a brief that differs from the real one** (pln#638 PR-3, #156). The dry-run path called `generateBrief` without the agent, so the preview showed a generic brief while the spawn built an agent-specific one — the operator approved text the worker never saw.

- **Computed advisories now reach the surfaces agents call** (Fable audit P0/P1/P2, #158). Three advisories were computed and then dropped before the MCP boundary: `stale_surfaces` (the freshness reconcile was gated behind a maintenance mode no MCP path sets — now ungated, it costs ~25 `existsSync`), session-end `scope_warnings`, and `shared_checkout_warning` at session-start all now reach the actual responses — `bclaw_work` included — as `warnings` + `warning_details`. A permanent SEAM GUARD test walks every field of the result interfaces via AST and fails when a field has no genuine reader in `src/` (construction and assignment targets don't count). It caught the third instance on its first run.

- **A FIFTH claim-creation path, and an AST guard that actually holds** (#155). Adversarial review showed 1.19.1's structural guard held nothing: identifier arguments were invisible to it, files already on its list were skipped, and the assertion was module-wide rather than per-callsite. The rewrite resolves variables scope-first, classifies each callsite as create vs update, and pins the expected-files list in BOTH directions — then immediately found `watch.ts` auto-claim as a fifth creation path missing its `base_sha`, which now stamps it.

- **Reconciler effects boundary, pinned** (pln#638 6c, #161). The audit concluded the boundary already holds — transport completion (exit-0 sentinel, post-start commit inference) never releases claims nor triggers review; business proof (harvest/report) does. A test now pins it: commit inference marks the run `inferred_completed` while the claim stays `active`. One tension deliberately left open and logged for the operator (dec_a0759586): the ideation failure path releases the lane's claim on run failure, which is defensible but sits against the letter of this boundary.

- **`context-core` bootstrap test was hostage to the runner's environment** (pln#640, #161). `buildContext` short-circuits ALL bootstrap machinery under `BRAINCLAW_TEST_MODE=1`; CI never sets it, agent shells always do (to protect the real store), so `bootstrap_available` read `false` on every local agent run and `true` in CI — deterministically, for as long as the test existed. The test file now scrubs and restores the variable itself. No product code touched.

## [1.19.1] — 2026-08-02

Fixes a defect that made two of 1.19.0's headline features **inert in production**. If you installed 1.19.0, upgrade: the scope-conformity reconcile it advertised never emitted anything.

### Fixed

- **`base_sha` is now stamped on every claim-creation path** (trp#1292). 1.19.0 introduced the immutable claim baseline and stamped it from exactly one place — inside `acquireClaimScope`. Nothing user-facing calls that function: all four real creation paths build their claim literal inline and call `saveClaim` directly, including `bclaw_work(intent="execute")`, the entry point the session protocol tells every agent to start with. Without a baseline the conformity reconcile returns `unverifiable`, so **pln#636 C0-b and C2 shipped and published doing nothing at all**.

  Found by verifying the release empirically rather than trusting green tests — creating a claim through the live 1.19.0 server and reading the file off disk. The tests missed it because `claim-base-sha.test.ts` calls `acquireClaimScope` directly: green test, untested surface. That is the same failure shape as trp#1275 (a guard checking less than it claimed), and it is the finding an adversarial reviewer had raised hours earlier about a different module — "test the delivered artifact, not the assembler."

  The fix is a named, greppable `claimBaselineFields(cwd)` spread at each site, resolved outside every `mutate()` so a git subprocess never widens the lock that serializes claim-store writes. Deliberately **not** applied inside `saveClaim`, which also persists updates — re-stamping there would move a baseline whose whole purpose is to be a fixed point.

  The accompanying test is structural rather than example-based, since example tests are what failed: it enumerates the creation sites from source, asserts each calls the helper (comments stripped, so prose cannot fake a pass), and scans `src/` for any *other* claim-creation site absent from the list — so a fifth path fails CI instead of silently shipping a third inert feature.

  Existing claims are not backfilled; "optional, never backfilled" remains the contract and a missing baseline correctly reads as `unverifiable`. Claims created from 1.19.1 onward carry one.

## [1.19.0] — 2026-08-01

Guidance stops being prose an agent may or may not read. Responses now carry **outcome-derived next actions** and **structured warnings that name their own recovery path** (pln#634/#635), a **consistency suite** turns "generated guidance drifted from the engine" into a CI failure (pln#638 2c), claims gain a **scope grammar with an inverted default** plus an immutable `base_sha` baseline and a lazy conformity reconcile that reaches even MCP-less workers (pln#636), claim liveness finally honours the **file evidence** a sandboxed worker can actually emit, and the loop engine's **phase gates stop being satisfiable by empty artifacts** (pln#639). No breaking API changes; every addition is optional and legacy records parse unchanged.

The through-line is that several of these were found by *disproving* an assumption rather than implementing a spec — three plan premises were abandoned mid-flight after the code said otherwise, and two independent bugs surfaced from a multi-agent ideation that had been convened to design something else entirely.

### Added

- **Outcome-derived `next_actions` on the write surfaces** (pln#634 PR1, #140). The write facades returned pure data: an agent that had just released a claim, transitioned a plan or dispatched a lane got no machine-readable indication of what came next, so protocol-defined follow-ups were left to prose in a brief the agent may never have read. `src/core/next-actions.ts` derives the follow-up from **what actually happened** — `releaseClaimNextActions` reads whether the plan cascade fired or refused, `dispatchNextActions` points at `bclaw_dispatch_status` (never a pid check — trp_7fc3e3c4), `coordinateNextActions` reflects the intent that ran. Builders return `[]` when there is no genuine follow-up and callers omit the key entirely, so the field never degrades into decoration; fan-out is capped at 3 with an explicit remainder note.

- **Structured warnings that carry their recovery path** (pln#635, #141). `FacadeResponse.warnings` is a `string[]`, so handlers with genuinely structured information had been encoding it via `warnings.push(JSON.stringify({...}))` — five such sites in the coordination handler alone, forcing every consumer to sniff-parse a string that may or may not be JSON, and unable to carry the one thing an agent needs: what to DO about it. `warning_details` is an **additive sibling** carrying `code` / `message` / `data` / `next_actions`; `warnings` keeps its type AND its byte-identical historical contents, derived from the structured record for an **enumerated** set of legacy JSON codes so a new code can never start emitting JSON at a consumer that only ever saw prose. Scope stated plainly in the module: `warning_details` is a structured *subset*, not a mirror — consumers keep reading `warnings` for completeness.

- **Guidance-adherence telemetry** (pln#634 PR2, #142). Emitting guidance is worthless if nobody acts on it, and there was no way to know. `bclaw_*` responses now record which tools they suggested and whether the next call matched, locally and cheaply: tool names only (never arguments or content), flushed every 20 observations, rotated at 512 KB, never throwing, and switchable off with `BRAINCLAW_GUIDANCE_TELEMETRY=0`. Deliberately shipped *before* judging pln#636's advisory work, so a near-zero adherence rate would re-scope that plan instead of expanding it.

- **Claim scope grammar with `unverifiable` as a first-class verdict** (pln#636 C0-a, #145). A census over the **613 real claims** in the dogfood store found 57.6% path-like, 22.8% semantic (`review-loop:lop_…`), 19.6% free prose — so **42.4% cannot be matched to a path at all**, and a naive path-aware gate would have false-accused on nearly one claim in two. `src/core/claim-scope.ts` validates a declared form instead of guessing from syntax: reserved loop prefixes are **enumerated** (`review-loop`, `ideate-loop`, `ideation-loop` — all three exist live; the pre-existing matcher knew only the first), a Windows drive letter is checked *before* prefixes so `C:/…` stays a path, and an unknown `word:` prefix reads as prose rather than being promoted to a loop reference by shape alone. `assessScopeConformity` returns `unverifiable` — rendered as SILENCE by every consumer — for loop-ref, prose, glob, empty or no-touched-files cases, and `.brainclaw/`/`.git/` are never out of scope. Acceptance criterion, kept as a test: replaying the real corpus produces **zero** accusations that a genuine path scope does not explain.

- **`base_sha` and optional `paths[]` on claims** (pln#636 C0-b, #146). `ClaimSchema` gains an immutable `base_sha`, resolved once at creation and never moved: the design review rejected *both* options it had offered, because neither `git diff HEAD` nor the worktree's dirty set is authoritative once a lane commits mid-work — each would report "touched nothing" the instant it committed. `paths[]` lets a creator declare a machine-readable footprint, raising conformity coverage above what classifying a free-string `scope` can reach. Both optional and never backfilled: the claims that predate them have no baseline, which a conformity check must treat as `unverifiable` rather than guess. Acquisition never fails or blocks on a missing baseline — outside a git repo the claim is created with no `base_sha` at all.

- **Server-side lazy scope-conformity reconcile** (pln#636 C2, #148). Four triggers on existing paths, no daemon: `bclaw_release_claim`, assignment→`completed`, **LANE-RESULT harvest ingestion**, and `session-end`. The harvest trigger is the one that matters most and the reason the design was revised: it trusts the lane's own `files_changed` declaration rather than running git, because by harvest time the worktree may already have been reaped — making the worker's statement both cheaper and the only source that still works, and reaching precisely the MCP-less tier the other triggers miss. Emits `wrote_outside_claim_scope` in the pln#635 format with the strays and two recovery paths (declare the footprint, or capture the coupling as a trap). Silent on every doubt: no baseline, unreachable baseline, reaped worktree, non-path scope, empty footprint. A failed `git diff <sha>` is read as "cannot tell" — neither "touched nothing" (which would silently disable the check) nor a violation (which would be a false accusation).

- **Lazy freshness reconcile for generated guidance surfaces** (pln#638 2a+2b, #150). The live header used to stamp "auto-refreshed" while regeneration is in fact explicit (session-end, handoff, `export --write`), so a tier that never fires those events read a file claiming to be fresh while being arbitrarily stale. 2a made the header honest — real triggers, writing version, timestamp; 2b now *uses* that stamp: `session-start` compares each surface against the running version over paths **derived** from the export registries (a hand-kept list of generated surfaces would itself be an unguarded generated surface). A surface with **no** stamp is `unknown`, never stale — otherwise every project predating the stamp, and every hand-written `AGENTS.md`, would be accused on every session start. Nothing is regenerated: that stays the explicit act it always was.

- **Guidance ↔ engine consistency suite** (pln#638 2c, #143). Two instances of the same class had already shipped with no test watching: guidance contradicting pln#520 diffused to every project (trp_7fc3e3c4), and a generated PreToolUse hook reading a protocol Claude Code no longer uses — dead for an unknown number of releases. The suite scans **rendered** guidance (not source text, which cannot tell a template literal from a comment explaining an exclusion), asserts every tool it names exists in the published catalog, exercises generated hooks against their host's current contract, and derives the set of `BRAINCLAW_*` switches from the call sites that actually read them. It caught three live drifts on its first run.

### Fixed

- **Claim liveness honours file evidence** (pln#636 C0-c, trp_4d0fc2ef, #147). A spawned sandboxed worker cannot reach MCP, so it cannot maintain any server-side liveness record — which is why the project moved proof-of-life to filesystem sentinels. `assignment-sweeper` already trusted that evidence; `assessClaimLiveness` did not, so the same demonstrably-alive worker kept its **assignment** while its **claim** aged out on wall-clock alone. Worse for the case that matters: a coordinator-created claim carries no `session_id` and fell straight through to `never-adopted`. The evidence branch reads the same two signals the sweeper reads and sits *before* the session branch, because it is the only proof a sandbox can emit. Also fixes the freshness comparison itself: a slightly-future timestamp now clamps to age 0 rather than being discarded — NTFS `mtimeMs` is sub-millisecond while `Date.now()` is coarser, so evidence written microseconds ago stats as newer than now, and the naive `age < 0 → ignore` threw away the *freshest evidence possible*, making the verdict flip between `live` and `never-adopted` with machine load. Grossly-future timestamps (>5 min) are still discarded.

- **`install-hooks` now OWNS PreToolUse activation** (pln#636 C1, #149). Generation is not activation: the command produced a hook script and then merely *printed* instructions, so the hook stayed dead even for operators who ran it. The PreToolUse entry is now merged into `.claude/settings.json` in the matcher-array shape Claude Code actually accepts — non-destructively, because that file holds the operator's own permission allow-list: unknown keys preserved, a pre-existing `PreToolUse` array appended to rather than replaced, unparseable JSON left byte-identical with a manual instruction printed instead, and idempotent re-runs (including a hand-wired Windows path with backslashes). The advisory reaches the model through `hookSpecificOutput.additionalContext` on stdout with exit 0 — the only non-blocking channel; a hook writing to stderr at exit 0 is structurally invisible to the model, which was a fourth way the old hook was dead and one that neither the plan nor its reviewer had spotted. Advisory-only is non-negotiable (trp_5f342186): `permissionDecision` is always `allow`, the exit code always 0. The matcher deliberately excludes `Bash` — a shell command's file footprint is not statically knowable, so it is `unverifiable`, never guessed.

- **LANE-RESULT bodies survive the worker, and the CLI harvest path converges its loop** (pln#638 1c+1d, #144). Two independent leaks. `LANE-RESULT.json` had nowhere to put the **body** of a review — only a one-line summary and artifact labels — so three substantial reviews were reduced to a line and their reasoning had to be reconstructed from stderr logs, with the reviewer's worktree liable to be cleaned before anyone read it. And an ideation lane completed via `LANE-RESULT.json` and harvested by the CLI never converged in its loop, because the closer fired only at the coordinator's two harvest sites — the champion had to map the critique and complete the turn by hand, twice.

- **Loop gate integrity: empty artifacts and late lane returns** (pln#639, #151). Two defects surfaced by a multi-agent ideation convened to design something else. **(1)** `body` is optional in both the input schema and `LoopArtifactSchema`, so an artifact carrying only `{phase, type}` was schema-valid *and* counted toward `min_artifacts_by_type` — a phase gate, whose entire job is to prove the phase produced real work, could be opened by producing nothing. The invariant already existed one layer too low (`ideationReducer`: "a bare summary with no critique body → gate stays shut"), guarding only the reducer path while a direct MCP call bypassed it; it now lives in the evaluator, so it holds for every entry path. A `ref` counts as content — the rule is "no usable content", not "body required", which would have broken every ref-based artifact. **(2)** `turn()` stamps the slot's phase at dispatch, but both loop closers recorded `phase: loop.current_phase` — the phase at *close* time — so a lane returning after an advance had its work filed under the new phase, invisible to the gate that was waiting for it. Fixed in the ideation and review closers (`reconcile-turn` already did the right thing via its reservation). Truthful attribution is also the fix for "do not count a late return": the gate filters on phase, so an out-of-phase artifact stops satisfying the current gate by construction, and the content is preserved rather than dropped. Verified against live data before shipping — 219 loops / 321 artifacts, zero content-less — so the stricter gate cannot stall a running loop.

### Known gaps

- `paths[]` is readable by the conformity reconcile and settable through the core and CLI, but is **not** exposed in `bclaw_claim`'s published inputSchema — so an MCP agent cannot declare a footprint yet, and coverage still rests on classifying `scope`. Widening a published inputSchema moves the public surface fingerprint and belongs in its own governed change rather than riding along in a release.
- The generated `.codex/hooks.json` and `.claude/settings.json` are gitignored, so **no hook reaches a spawned worker's worktree** — lifecycle parity for dispatched lanes runs entirely through the brief today (trp#1277). Scoped as pln#638's remaining work rather than papered over with a copy into each worktree, which would have created store-lock contention.

## [1.18.0] — 2026-07-31

The whole review loop is now exactly-once and autonomous end to end (pln#630 — initial dispatch included, on by default with a kill-switch), Code Map nearly triples its language coverage to 11 languages and learns to answer across every package of a monorepo (pln#631), implementation/research/debug loops become real protocols with a deterministic engine-run verify gate (pln#632/#628), the inbox is usable at scale (pln#627), and review loops refuse to open in a project nobody selected (pln#521 P1). Every substantial change went through adversarial multi-agent review before merge. No breaking API changes; the one behavioral default flip (turn-owned review) ships with an explicit kill-switch.

### Changed

- **Turn-owned exactly-once review is now the default — and it covers the whole review loop, initial dispatch included** (pln#630). Both the **initial reviewer dispatch** (`bclaw_coordinate(review, open_loop)`, round 0) and the autonomous `request_changes` **fix-cycle re-dispatch** (rounds 1+) now route through the turn-owned attempt state machine instead of the legacy best-effort projection: each dispatched turn gets an immutable attempt record (`turn_id`/`run_id`/`nonce`) behind an atomic launch fence (reserve → arm → consume) so it is **spawned at most once** even under concurrent dispatch or crash-recovery, and `reconcileTurn` finalizes it from **read-strict, turn-keyed evidence** (the coordinator's completion sentinel from the ack-wrapper) rather than presence-based markers — closing the double-spawn and false-green windows the legacy path had. On the initial dispatch, each reviewer slot gets its **own** reservation (symmetric fan-out = N distinct reservations) with the assignment + run pre-minted **deterministically** by the fence: the coordinator never mints a second `agent_run` (on a real spawn it transitions the deterministic run to `running`), and a **denied** fence verdict means no spawn, no legacy fallback, and no claim release — the slot is left for reconcile/self-heal, keeping the double-spawn hole closed. Cross-project reviews (`project=…`) keep the legacy chain (no local worktree/sentinel). The fix cycle itself (bump round + retain worktree + re-dispatch, cap → `blocked`) and the crash-strand self-heal run on this path — and the self-heal now also recovers a **revoked-grant strand** (a pass that crashed between arm and consume): the lazy pre-run reconciler revokes the expired still-armed grant, the strand detector treats a revoked/absent grant as a strand and re-emits, and the re-dispatch re-arms a fresh generation at a strictly-higher epoch, with the reservation's 30-minute dispatch lease decoupled from the 10-minute grant lease so a revoked round has a real recovery window (armLaunch still enforces the dispatch lease — never a phantom spawn after lease). Shipped across six PRs (finalization, fix-cycle, strand self-heal + §9 conformance harness, revoked-grant recovery, the default flip, and the initial-dispatch conversion), with the exactly-once fence adversarially reviewed and verified sound each round through the default flip, plus a live end-to-end for both verdicts (real spawn → cmd.exe-written turn-keyed sentinel → harvest → `reconcileTurn` → close-on-approve / bump-on-request_changes). **Kill-switch:** `BRAINCLAW_TURN_OWNED_REVIEW=0` (also `false`/`off`/`no`) reverts the whole review loop — initial dispatch and fix cycle — to the legacy closer. Triply-safe: harvest only turn-owns a lane that (a) owns a reservation AND (b) has turn-keyed evidence — a reviewer that resolves to inbox/manual (no ack-wrapper, no sentinel) or any legacy-dispatched lane falls back to the legacy closer and still converges, while evidence that mismatches the live attempt (a stale generation) is never legacy-closed and instead emits an observable runtime event for the operator. No change to ideation/implementation loops or the MCP tool surface; every non-review `bclaw_coordinate` intent (assign/consult/reroute/ideate) takes the byte-identical legacy branch.

- **Usable-at-scale inbox: focused `bclaw_read_inbox` reads, a write-time size cap, and CoDev artifact routing** (pln#627 Phases A/B/C, #105). The inbox had become the store's token bomb: full persona/CoDev phase briefs were persisted as inbox `rfc` messages (one reached 960 KB, the inbox 3.8 MB), and a single `bclaw_read_inbox` could blow the whole MCP token budget. **Phase A (reads):** the default status filter is now **actionable** (pending + read) — acknowledged/archived are hidden unless `includeAll=true` or an explicit `status` is passed (previously an unset status returned *every* message; the "pending by default" description was wrong); results are ordered **newest-first** by `created_at` before pagination, so a bounded page serves the most recent messages instead of the oldest debris; bodies are **previewed** (~500 chars, each message reporting `text_length` + `truncated`) unless `full=true`; and the page is size-bounded by `budget_tokens` with `has_more`/`next_offset` paging hints and a ready-made next-page `next_actions` call — the same `boundListResult` mechanic as `bclaw_find`/`bclaw_search` (~4 chars/token). The three new input fields (`includeAll`, `full`, `budget_tokens`) are additive; the MCP surface fingerprint moves to `sha256:fd8a7e910bf5f751`, and the CLI `inbox list --all` maps onto `includeAll`. **Phase B (writes):** a hard 128 KB cap on the inline body persisted per message (`MAX_INLINE_MESSAGE_CHARS = 131 072`) — an over-cap body is truncated at write with a marker naming the original size, flagged `truncated_at_write` + `original_text_length` on the stored message, and the sender gets an explicit warning (CLI `inbox send` and MCP `bclaw_send_message`). The cap sits ~2.4× above the largest *legitimate* message (the ~54 KB coordinate dispatch envelope over the 48 000-char loop-brief bound) while catching the ~960 KB dump class an order of magnitude below it. **Phase C (root cause):** CoDev/ideation phase bodies are routed to the artifact store (`.brainclaw/coordination/ideation/<slug>/phases/<label>.md` via `writePhaseArtifact`); the thread message keeps a bounded 4 000-char head + pointer (`ref` + `payload.artifact_path`/`char_count`), which comfortably covers the largest thread readback (`getThread(truncateText: 3000)`) so CoDev's iterative context stays byte-identical while each inbox message drops from hundreds of KB to a few KB. Phase D (disk cleanup of existing debris) was deferred per operator decision. Also folded in: `isolateAgentEnv` now strips the `BRAINCLAW_CLOUD_*` env vars, so in-process tests on a cloud-configured dev machine no longer see federation enabled (which flipped "disabled"-path assertions and silently enqueued outbox records into test stores).

- **VS Code extension: registry section content served from the journal once authoritative** (pln#560 completion, #97). Since pln#568 the registry/coordination families (claim, assignment, agent_run, action_required, candidate, sequence) carry full post-images in the journal, but only their **counts** had cut over (`mergeCounts` gated on the `registry_genesis` marker) — expanding ATTENTION / IN_PROGRESS / SPRINTS or the flat CLAIMS/ASSIGNMENTS/RUNS/ACTIONS/CANDIDATES drill-downs still fired N MCP fetches every time. Now, once the observer has ingested the `registry_genesis` backfill marker (`registryAuthoritative()`), those sections render their entity content straight from the in-memory journal projection — zero MCP display fetches on expand — and journal growth also invalidates the registry section cache. The IN_PROGRESS semantics (terminal-status split + the pln#559 recently-terminal window) and the pending filter were extracted into pure, tested selectors (`selectInProgress`, `filterPending` in board-projection) shared by the MCP and journal paths so the two cannot drift. The non-journaled extras on the composites — server-computed `workflow_hints`, loops via `bclaw_loop(intent='list')`, and the `bclaw_dispatch_status` evidence digests — stay best-effort MCP reads through a **nullable** client: a missing brainclaw binary no longer blanks these sections (the MCP-only path threw without a client); they render their entities, just without the enrichments. SYSTEM keeps its MCP fetch regardless — it mixes private/machine runtime_notes (never journaled, a visibility boundary) and cross-project config, neither derivable from the shared journal. A Codex review round on PR #97 caught an `in_progress`-actions leak into ATTENTION/ACTIONS in journal mode only (the MCP path pre-filters `status:'pending'` server-side; both journal branches now apply `filterPending`, locked with a selector-level regression test) and documented that journal-served sections are deliberately **legacy-inclusive**: the genesis backfill journals `provenance.kind='legacy'` records that the MCP default read filter excludes, and the projection trim drops nested provenance, so client-side parity is not reconstructable — accepted since the operator tree already opts into legacy wherever it fetches explicitly. Cutover documented in observer-protocol §6.1.

### Added

- **Code Map: 6 new languages — Go, Rust, C#, Ruby, C, C++ (11 total)** (#118). The symbol index previously covered only TS/JS, Python, PHP, and Java, so `bclaw_code_find` / `bclaw_code_brief` were blind on the other half of mainstream dev work. Six new providers land via the standard `LanguageProvider` extension points (per-language `tags.scm` + `imports.scm` + an optional `refine()` pass; grammars from the existing tree-sitter-wasms bundle — no new runtime deps, no core orchestration touched): Go (struct→class, import-path quote stripping), Rust (trait/mod/macro, in-query `use`-tree expansion incl. groups/aliases/wildcards), C# (file-scoped namespaces, records, delegates, `using`-alias lift), Ruby (`require`/`require_relative` as imports, top-level `def`→function), C (pointer-declarator-aware function names, `#include` quote+bracket stripping, body-guarded struct/enum so type references aren't double-captured), and C++ (template-transparent, `qualified_identifier`→method — registered BEFORE C so C++, a C superset, wins the shared `.h` extension). Each provider ships a fixtures-as-spec oracle test plus a real-repo dogfood run (cobra, clap, Newtonsoft.Json, sinatra, cJSON, fmt — thousands of symbols, zero extraction errors); the symmetric review round added the C++ `union` capture that a `.h` header would otherwise have missed.

- **Workspace-aggregated Code Map: find + brief across every package of a monorepo** (pln#631, dec#146 — #120, #121, #122, #125). In a multi-project workspace, find/brief only ever answered from a single store: an agent at the root couldn't see symbols defined in nested packages, couldn't brief a symbol without already knowing which package owns it, and had zero visibility into cross-package blast radius. The Code Map backend's find/brief inputs gain `traversal: 'auto' | 'project' | 'workspace'` (default `auto` — aggregate only when cwd is a multi-project root, single-store everywhere else, so existing behavior is unchanged; `project` forces single-store). Aggregation is pure read-time over the per-project stores the refresh cascade already builds — no persisted root super-index, no cross-store index writes. Root **find** (#120) surfaces symbols from any child store, deduped, workspace-relative + project-tagged, under one shared lazy-validation budget that scales with store count (capped 256 files / 10 s); the merged badge reports the worst status across indexed stores plus `projects_indexed/total` coverage, so one unindexed child never drags the top line to `missing`, and git-HEAD drift is checked per child store. Root **brief** (#121) resolves the target across all stores and contributes reading lists only from the highest match tier present (exact > path > fuzzy), so an exact definition is never diluted by a sibling's fuzzy token match — with a fallback preserving single-store parity for imported-but-not-locally-defined names. **Cross-package reverse dependents** (#122): a brief on a symbol defined in package B also surfaces sibling packages importing B's public `package.json` name, as flagged `cross_package` rows — name-level imports (the importer's named imports include a target symbol) outrank bare package-level ones, and every row is lazy-validated so a deleted/stale importer is suppressed, same as intra-package graph rows. **Workspace-from-child + locality** (#125): an explicit `traversal:'workspace'` from inside a package walks up to the nearest enclosing multi-project root and aggregates from there — and a locality tiebreak (containment-based, Windows-case-safe) ranks the caller's own package first at equal score, marking its hits `local: true`. Each PR went through adversarial review; the confirmed findings — shared-`project_id` memo/dedup collision, budget starvation of later stores, missing per-child HEAD drift, an empty aggregated brief for imported-but-not-locally-defined names, unvalidated cross-package rows, and an exact-cwd locality check that no-op'd from a package subdirectory — were all fixed and locked with tests.

- **Implementation loops became real: `bind → execute↔verify → handoff_ready` with a deterministic, engine-run `command_green` gate** (pln#609 Increments 1+2 continued as pln#632; #112, #126, #129). The implementation loop protocol was an unused five-phase ceremony skeleton (`sequence_build → dispatch → execute → self_check → handoff_ready` — no iteration, no gates, and phases nothing implemented). Three increments turn it into a working protocol. **Protocol** (#112): phases are now `bind → execute ↔ verify → handoff_ready` with a per-phase `context_filter`; `execute↔verify` is a bounded cycle (`max_iterations: 3`) with a new `exit_when: 'command_green'` — the cycle exits early only when the *current* iteration carries a passing `verify_report` artifact (new typed body schema: command, exit code, `passed`, duration, output tails; a green from a prior iteration never satisfies the current one), and an `advance_gate` on `verify` refuses to leave the phase without a `verify_report` produced this iteration (guards "narrated verify, didn't run it"). The stop condition mirrors review loops: handoff within budget → `completed`, cap exhausted without green → `blocked`. **Deterministic verify** (#126, pln#632 PR1): `command_green` no longer trusts an agent-narrated report — which the agent under test could fabricate — because brainclaw itself now runs an opener-configured verify command (tests/build/lint) and records the `verify_report` the iteration engine reads. `bclaw_loop(intent="open")` gains an opt-in `verify: {command: […], timeout_ms?}` block (merged onto the kind-default protocol without discarding its iteration block) and `bclaw_loop(intent="verify")` runs it. Security is the point: the command's provenance is the loop's `protocol.verify`, set by the OPENER at open and absent from the verify request schema entirely — never the worker under test; it is an argv array spawned `shell:false` (no injection surface — a pipeline is an explicit `['bash','-lc',…]` the operator owns); every `BRAINCLAW_*` env var (+ `BCLAW_PROMPT_FILE`) is stripped from the child env so the spawned suite can't hit the real brainclaw store; and the run is bounded (10-min default timeout, 15-min hard cap, 8 MiB output cap) with a timeout or spawn error (ENOENT) staying RED with the reason — never a false green. The multi-minute spawn runs *outside* the loop lock (two lock scopes with the command between), a re-invoked verify is idempotent per (loop, iteration), and adversarial review closed two correctness gaps: the report is stamped with the iteration *snapshotted before the spawn* (a concurrent `advance` mid-run can no longer credit green to an iteration whose code was never tested), and output tails are byte-fit so multibyte/ANSI output can't overflow the 4 KiB artifact-body limit and silently drop a green suite's report. Opt-out preserved: a loop without `protocol.verify` gets a typed `unconfigured` result and the agent-narrated path is unchanged; per-lane worktree cwd is a planned follow-up (the runner uses the loop project's cwd). **Bind** (#129): the protocol declared `bind` as "bind plan+sequence and dispatch" but no engine action existed. `bclaw_loop(intent="bind")` now dispatches the loop's linked sequence and advances `bind → execute`: `dispatch()`/`analyzeSequence` gain an optional `sequenceId` so the loop drives its *own* `linked.sequence_ids` sequence by id without hijacking the project's global active-sequence pointer (omitted → active sequence, byte-identical for all existing callers). Bind is idempotent (a loop past `bind` → noop), `dry_run` previews with no spawn and no advance, and a crash between dispatch and advance recovers safely on retry (lanes with an active assignment are skipped). Adversarial review closed three findings: bind refuses a non-`open` (paused/terminal) loop *before* any spawn fires; the phase-recheck + advance are atomic under the loop lock, so concurrent binds can't each advance and push the loop to `verify` with no execute work done; and dispatched work carries coordinator attribution (agent id + MCP session id) like `bclaw_dispatch`/`bclaw_coordinate`. Because bind spawns real workers, the MCP wrapper gates it at the same `trusted` bar as turn-dispatch. Implementation loops only — review/ideation loops keep dispatching via `bclaw_coordinate`.

- **Research and debug loops go from bare skeletons to real protocols** (pln#628 PART 3, #113). Both loop kinds shipped as placeholder phase lists with `stop_condition: manual` — no gates, no iteration, and a human had to close every one by hand. Research is now ideation-shaped: `investigate ↔ synthesize → conclude` (cycle cap 3) with an advance gate requiring at least one `finding` artifact gathered *this* iteration before synthesizing (no empty rounds), exiting on `critic_signal` — `synthesize` emits it when the question is judged answered, because explicit sufficiency beats saturation-by-absence for open-ended research. Deliberately, the stop condition has no `max_iterations` branch: research *always* lands in `conclude` and completes with a `synthesis` artifact — there is no "blocked" research outcome. Debug is implementation-shaped, built on the equivalence "bug fixed ⟺ the reproducing command is now green": `reproduce → hypothesize ↔ isolate ↔ fix → handoff`, where an advance gate demands a `repro` artifact before hypothesizing can start, another demands a `verify_report` re-run of the repro before leaving `fix` (mirroring the implementation loop's verify gate), and the `hypothesize↔isolate↔fix` cycle (cap 3) exits on `command_green` — which means debug loops inherit the deterministic engine-run verify runner (#126) for free — or exhausts the cap → handoff with the red report → `blocked`. The whole change is two `DEFAULT_PROTOCOLS` literals reusing existing machinery (`command_green`, `verify_report`, the iteration-aware gate evaluators): no engine, schema, or evaluator change. Back-compat safe: a loop snapshots its protocol at open, so already-open loops are untouched.

- **Project resolution gate for review loops** (pln#521 P1, #136). `bclaw_coordinate(intent="review", open_loop=true)` now resolves WHICH project the loop belongs to before anything persists. A review loop that landed in the wrong store persisted a candidate, claim, assignment and loop where nobody was watching, and spawned the reviewer against the wrong repo (the DGX misroute class this plan was written for). Resolution ladder: explicit `project` → any selector that already won upstream (`--cwd`, `BRAINCLAW_PROJECT`, a session switch, the physical child store, the workspace active-project pointer) → the bare cwd fallback — accepted in a single-project store (exactly one answer; the gate is a strict no-op there, asserted explicitly) and refused with `needs_project_selection` when the store can host several projects (`project_mode: multi-project`, or a `store_type: workspace` parent with nested project stores): the error lists the candidates, creates nothing, and names both remedies (`project='<name>'` or `bclaw_switch`). Ref/scope/path are never used to guess the project (B3 rejected in the design review — a wrong guess costs more than an explicit choice). The routing decision is echoed as `project_name`/`project_cwd` on the coordinate result and on `bclaw_dispatch_status`, which also carries a `_resolution_trace` (`source_cwd`, `effective_cwd`, `active_source`, `project_arg`) so a misroute is diagnosable without reverse-engineering cwd + store state.

- **Content-aware gated-sequence code propagation** (pln#529, dec#122 B+A, #117). Closes the highest-impact gated-sequence hole: releasing a predecessor's claim (`planStatus=done`) opens the `hard_after` gate, but the predecessor's *code* may still live only on its branch, un-integrated on HEAD — so the dependent lane was spawned from HEAD silently *without* the work it depends on ("readiness ≠ code-availability"; the old path only attached a generic advisory warning). New `resolveGatedLaneBase` resolves each gated lane's fork base by **content**, not ancestry (the squash-merge workflow breaks ancestry — trp#926 — so it reuses `isBranchMergedByContent`: git-cherry patch-id + file-content), probing each predecessor's deterministic `feat/<sanitized scope>` branch: **0** committed-but-unintegrated predecessors → base `HEAD`; **exactly 1** → the dependent lane forks from that predecessor's branch so it carries the socle code (dec#122 B); **≥2** (or any unverifiable probe) → the gate stays CLOSED (`gateBlocked`, routed to `blocked`) with actionable "integrate onto HEAD first" guidance (dec#122 A) — a single worktree cannot fork from multiple un-integrated bases without silently dropping some predecessor's code. `analyzeSequence` computes the base per gated ready lane and `dispatch()` consumes it instead of the old blind `HEAD`; the advisory `code_propagation_note` now reports the resolved base. A symmetric whole-diff review round hardened the resolver before merge: the predecessor branch is ground-truthed from the persisted **claim** scope (stable across the coordinate/assign paths, survives a `scope_hint` edit, persists on release; sequence-item fallback only when no claim exists) instead of mutable sequence metadata; a tri-state `probeLocalBranch` treats a failed git probe as `unknown` → fail SAFE (`gateBlocked`), never silently "on HEAD", while a clean not-found is `absent` → assumed merged + branch cleaned, honestly labelled "assumed" rather than "content-verified"; a non-git project keeps the legacy `HEAD` base rather than false-blocking; and dropped predecessors still satisfy the gate but are excluded from the socle-fork (abandoned code is never propagated). `selectWorktreeBaseForReadyLane` is kept as a deprecated shim; eight real-git tests cover fork-from-branch / on-HEAD-by-content / branch-absent / non-git / diamond-blocked / mixed / tri-state probe. (Folded in: a per-file CI timeout override giving the `journal-crash-storm` stress test a 10-minute budget — it completes in ~4.5 min on an idle runner but tipped the 5-minute e2e cap under CI load, a recurring false TIMEOUT that blocked merges.)

- **Ideation-loop convergence from a critic lane** (pln#521 P2-bis, #128). The ideation loop's critics were already dispatched by `bclaw_coordinate(intent="ideate")` with `targetAgents` (claim + assignment + slot binding + brief + spawn, from pln#626 Phase 2), but nothing turned a critic's `LANE-RESULT.json` back into a loop transition — the critique-phase gate (`min_artifacts_by_type critique n:3`) never satisfied from spawned critics and the loop couldn't advance autonomously (the "dispatched_critics=N announced, zero convergence" symptom: the real gap was convergence, not dispatch). New `closeIdeationLoopFromLaneResult` (`src/core/ideation-loop-close.ts`, the direct ideation mirror of the review closer) fires on an `ideate-loop:<lop>` scope + a completed lane at the two harvest sites that already call the review closer: it maps the critic's summary/notes into one `critique` artifact (byte-capped to the artifact-body limit), runs `complete_turn(done)`, then attempts `advance` — a blocked n:3 gate is expected (more critics still needed), not an error. Convergent + idempotent under the loop lock; a bare lane fails the slot rather than faking gate progress. An adversarial review round hardened three defects before merge: slot resolution filters to `role === "critic"` (without it, the single-active fallback could complete the loop's unbound champion slot, inject a stray critique, and cycle the loop backward), a crash between the final `complete_turn` and `advance` is now resumable (no active critic slot + a critique gate that evaluates MET resumes the advance, precisely gated so a loop already past `critique` is never over-advanced), and only `phase_advance_blocked` counts as gate-not-met — any other advance error surfaces as a noop carrying the real message instead of being misreported as `critique_recorded`. Purely additive: the closer returns undefined for non-ideate scopes so review and other harvests are byte-identical, no review-dispatch code is touched, and nothing spawns (convergence side only). Uses the legacy lane-harvest path like the review closer; the ideation reducer remains the forward-compatible seam for turn-owned reconciliation.

- **`loop_artifact_harvested` observability event** (pln#521 P4, #127). `reconcileTurn` integrates a turn-owned worker's artifact into its loop (reducer → add_artifact → complete_turn) but emitted no event for the harvest — the convergence was invisible in the runtime-event stream even though the neighboring paths (`run_blocked`, `candidate_harvested`, `lane_result_harvested`, `lane_integrated`) were already observable. A successful convergence now emits a `loop_artifact_harvested` runtime event after `complete_turn` succeeds, carrying the loop/slot/turn ids, the reservation's `assignment_id` + `run_id`, the slot outcome, artifact count and phase. Best-effort by construction: a telemetry failure never undoes the harvest. Flag-independent and spawn-free — pure observability on the already-merged reconcile path.

### Fixed

- **Code Map find ranking discriminant, brief source-reserve, and a coarse freshness rollup** (pln#601, #119). Three defects from a Fable audit undercut the "stop grepping blind" value prop. (1) `scoreEntry` compared raw-lowercased strings, so a Pascal-case query (`EntityRegistry`) failed to match a snake_case definition (`ENTITY_REGISTRY`) and dropped to the sub-token floor — score 1, indistinguishable from 19 unrelated `*Registry` symbols, sending the agent straight back to grep. Matching is now separator/case-insensitive (normalized identifiers) through the exact/prefix/substring tiers, and test-file symbols are biased down (×0.4) so a test helper never outranks the real definition of the same name; the review round broadened `isTestPath` beyond JS/TS to conventions across all 11 languages (`*_test.go`, `test_*.py`, `*_spec.rb`, `FooTests.cs`, …) so the source-over-test bias actually works polyglot. (2) On a symbol with many test importers, reverse-dependent test files could fill the entire 12-file brief cap and crowd source out of the reading list: `reserveSourceSlots` now holds test importers to ~1/4 of the cap (min 2), with deferred tests backfilling only when non-test files can't fill it — and defining files are never counted as noise, so a symbol legitimately defined in a test file still leads. (3) `FreshnessBadge` gains an optional `coarse` rollup (`fresh|stale|partial|missing`) derived from the 7-value status via a single `coarseFreshness()` definition stamped uniformly across find/brief/status/work, recomputed in lockstep by `applyGitHeadDrift`, with a compile-time exhaustiveness guard (review F4) so a future `FreshnessStatus` can't silently roll up to `stale`.

- **Ideate critic slots are now bound to their assignment + claim** (pln#629, #100). The ideate multi-agent dispatch called `turn()` *before* the critic's assignment existed, so `slot.assignment_id` stayed undefined — `bclaw_loop get`'s reconcile skipped the slot (`if (!assignmentId) continue`) and `dispatch_status(lop_…)` resolved no assignment, so ideate loops could never be reconciled (trp_dfe0b941 / trp_2187b340 / trp_1de94516). The dispatch now mirrors the review path (pln#628 BLOCKING 2): create the claim + assignment first, then `turn()` with `assignment_id` + `claim_id` to bind them onto the slot. A slot whose claim/assignment creation fails now stays open instead of dangling `assigned`. Regression test asserts the critic slot carries both ids and that the `turn_assigned` event records the assignment id.

- **Launch-fence review fixes landed after an early auto-merge** (pln#630 PR2a follow-up, #104). PR #103's auto-merge fired on the base commit before its symmetric review cycle completed, so the merged launch-grant fence lacked the round-1 + round-2 fixes; this lands them on master. The consume-XOR-revoke decision is now one atomic exclusive-create (`O_EXCL`) of a per-(turn, epoch) decision file — the first writer wins, the loser reads the incumbent verdict — closing the round-2 BLOCKING TOCTOU where a reaped lock holder could overwrite the other terminal transition. Also: a lock-lost fence check now guards every reservation write; `armLaunch` rejects a non-parseable `lease_deadline` (`lease_invalid` — `Date.parse` NaN would otherwise make the grant never expire); `consumeLaunchGrant` checks epoch before token; consume and the expiry sweep share one inclusive (now ≥ deadline) rule; and the decision file is authoritative when reading a grant's status, so a winner that crashed before updating the record projection is still reconciled correctly.

- **`journal-crash-storm` CI flake root-caused and fixed — it was never slowness** (pln#565 follow-up). Green master runs used ~1% of the 210s startup budget (0.7–2s across six sampled runs), so the three ~210s CI failures of late July were not load-induced slowness. The store lock is maximally unfair (an incumbent re-acquires microseconds after release while a contender polls every 50ms), so a spawned storm child could lose the 5s acquire race repeatedly and die pre-commit — designed contention destroying the test's own quorum precondition. Three surgical fixes, all in the test: a child now retries pre-first-commit lock starvation (any other error, or any error after committing, still crashes loudly), the parent fails fast the moment quorum becomes unreachable and SIGKILLs the storm in a `finally` (a hopeless run reports the real diagnostic in seconds instead of burning the 210s budget and then hanging into the 600s per-file cap), and `waitForChild` resolves already-exited children instead of waiting forever on a `close` event that fired before the kill. All four crash-safety invariants — readable-after-storm, unique seqs, recovery seq > pre-storm max, materialization — assert exactly as before; N=3, QUORUM=2 and every budget are unchanged.

## [1.17.0] — 2026-07-19

Autonomous review-loop fix cycle (the second half of the pln#628 Focus 4B flagship), a Turbopack-compatible per-worktree dependency mode, and a Codex integration refresh (native lifecycle hooks + an MCP config-field fix) after Codex's architecture moved on. Every code change was Codex-reviewed before merge (the fix-cycle and hooks work each went through multiple review rounds); the MCP timeout fix was a doc-verified one-line field rename. No breaking changes — all new behavior is additive and opt-in, defaults unchanged.

### Fixed

- **Codex MCP startup-timeout field name.** brainclaw wrote `startup_timeout_ms = 20000` into `~/.codex/config.toml`, but Codex renamed the field to `startup_timeout_sec` ([docs](https://developers.openai.com/codex/extend/mcp) note "uses `_sec`, not `_ms`") — the `_ms` key is unrecognized, so Codex silently fell back to its default MCP startup timeout. Now writes `startup_timeout_sec = 20` for fresh configs. (Existing hand-written configs are preserved as-is, as before.) Verified against the official Codex MCP docs during a broader Codex-integration audit; the skills path (`.agents/skills/brainclaw/SKILL.md`) and per-tool `approval_mode = "approve"` were both confirmed still current.

### Added

- **Codex lifecycle hooks integration.** Codex CLI gained a native lifecycle hook surface (`SessionStart` / `UserPromptSubmit` / `Stop` / `PreToolUse` / … via `.codex/hooks.json` or a `[hooks]` table in `config.toml`; [developers.openai.com/codex/hooks](https://developers.openai.com/codex/hooks)), which brainclaw's integration didn't yet use — it declared Codex `hasHooks: false` and `docs/integrations/codex.md` claimed "no native lifecycle hook surface" (both stale). `brainclaw init` now writes project-level `.codex/hooks.json` (`ensureCodexHooks`) wiring `SessionStart → session-start --include-context`, `UserPromptSubmit → context-diff`, and `Stop → session-end --auto-release --reflect --reflect-handoff --dispatch-review` — the same session lifecycle as the Claude Code / Cursor / Antigravity hook writers. Codex's capability profile is now `hasHooks: true`, the integration surface list gains the hook file, `.codex/hooks.json` is git-ignored (machine-specific command paths), and the README integrations table + `codex.md` reflect the new surface. brainclaw owns the three event arrays (overwrite = idempotent regardless of CLI-path resolution, no cross-upgrade pile-up — the same contract as the Cursor/Antigravity hook writers); other user-defined events are untouched. The hooks target *interactive* Codex sessions (a one-time `/hooks` trust applies): `SessionStart`/`UserPromptSubmit` inject model-visible context, `Stop` runs `session-end` for its side effects. Headless dispatched `codex exec` workers don't rely on them (they use the dispatch brief + `LANE-RESULT.json`).

- **Autonomous request_changes → fix → re-review cycle** (pln#628 Focus 4B PR2 — completing the flagship). PR1 auto-closed a review loop on `approve` but stalled on `request_changes` (a human had to drive the fix cycle). Now, on the `harvest --integrate` path, a `request_changes` verdict bumps the loop's round counter, **keeps the claim + worktree alive**, and re-dispatches the same reviewer slot into that **same worktree** (symmetric mode) with a findings-aware brief to apply the requested changes and re-review — commits accumulate on one branch, so no fresh-worktree-per-turn (which would trip the branch-per-scope / refuse-unharvested-commits worktree invariants). The cycle runs until `approve` (→ `reviewer_green` close) or the `max_iterations` cap (n=3 → auto-close `blocked` for a human). New reusable `dispatchReviewLoopTurn` (the coordinate handler's claim+assignment+turn+brief+spawn chain, lifted closure-free into `src/core/review-loop-turn-dispatch.ts`); `runHarvestLane` is now async so the re-dispatch spawn is awaited. The report-only harvest path never cycles (it can neither re-dispatch nor retain the claim) — it defers to `--integrate` and still closes on `approve`. Asymmetric (author ≠ reviewer) cross-agent worktree sharing is a planned follow-up.

- **Per-worktree dependency mode** (`worktree.deps_mode`, trp_37b05a15 — the Turbopack-compatible follow-up to 1.16.0's warning). A dispatched worktree's JS `node_modules` was always a junction to the main tree — an out-of-worktree-root symlink that `next dev` (Turbopack) rejects (`tsc`/`vitest`/`build` are fine). `createWorktree` now supports four modes: `link` (default, unchanged — the junction), `install` (runs the detected package manager's install at the worktree root for a real in-root `node_modules`), `copy` (recursively mirrors `node_modules` from the main tree — offline, disk-heavy), and `none` (no deps). `install`/`copy` yield a Turbopack-compatible in-root `node_modules` and suppress the Next.js warning (whose text, in the unchanged default `link` mode, now points at `deps_mode`). A failed best-effort install/copy is recorded as `deps_provisioned: false` in the sidecar, and the dispatch brief then tells the worker to install rather than claiming the deps are ready. The package manager is auto-detected from the lockfile (pnpm/yarn/bun/npm) or the `packageManager` field. Precedence: `BRAINCLAW_WORKTREE_DEPS_MODE` (env) > `BRAINCLAW_NO_LINK_DEPS=1` (→ `none`) > config `worktree.deps_mode` > `link`. Install timeout is bounded by `BRAINCLAW_WORKTREE_INSTALL_TIMEOUT_MS` (default 10 min). Provisioning is best-effort — a failed install/copy is recorded as a `symlink_warnings` note (the worker can install by hand), never fatal to worktree creation. The chosen mode is recorded in `.brainclaw-worktree.json` (`deps_mode`) and the dispatch brief tells the worker whether `node_modules` is an out-of-root link, a real in-root dir, or absent, so it doesn't needlessly reinstall. Default behavior is unchanged.

## [1.16.0] — 2026-07-18

Autonomous review-loop convergence (the flagship of the pln#628 hardening push) plus a batch of cross-platform dispatch fixes from a macOS field report. Each change was Codex-reviewed before merge; the review findings (dual harvest path, slot↔assignment binding, atomic+resumable close, tracked-aware node_modules exclusion) were applied and locked with tests. No breaking changes.

### Added

- **Autonomous review-loop close on approve** (pln#628 Focus 4B, PR1). A review loop opened via `bclaw_coordinate(intent="review", open_loop=true)` used to spawn the reviewer automatically but then stall: the worker reported via `LANE-RESULT.json`, and nothing mapped that back into the loop, so `reviewer_green` was never evaluated and a human had to drive `complete_turn`/`advance` by hand. Now `LaneResultSchema` carries an optional `review_verdict` (`approve`/`request_changes`) + `review_summary`; the reviewer brief instructs the worker to set them; and `brainclaw harvest` (report path + `--integrate`) maps a completed review lane onto its loop — recording a `verdict` artifact and advancing, which **auto-closes the loop on `approve`** (`reviewer_green`) with no human in the loop. `request_changes` records the verdict and advances to `author_response` without closing (the automated re-review cycle is a follow-up). The mapping resolves the reviewer slot strictly by `assignment_id` (correct under symmetric multi-reviewer loops), runs `complete_turn`+`advance` under the loop lock (resumable if interrupted), is idempotent, and never blocks harvest. Non-review lanes and lanes without a verdict are unaffected. A review loop opened via `bclaw_coordinate(intent="review", open_loop=true)` used to spawn the reviewer automatically but then stall: the worker reported via `LANE-RESULT.json`, and nothing mapped that back into the loop, so `reviewer_green` was never evaluated and a human had to drive `complete_turn`/`advance` by hand. Now `LaneResultSchema` carries an optional `review_verdict` (`approve`/`request_changes`) + `review_summary`; the reviewer brief instructs the worker to set them; and `brainclaw harvest --integrate` maps a completed review lane onto its loop — recording a `verdict` artifact and advancing, which **auto-closes the loop on `approve`** (`reviewer_green`) with no human in the loop. `request_changes` records the verdict and advances to `author_response` without closing (the automated re-review cycle is a follow-up). The callback is idempotent and never blocks harvest. Non-review lanes and lanes without a verdict are unaffected.

### Fixed

- **Cross-platform dispatch tooling (macOS)** — two bugs surfaced by an external field report (Codex driving a real project on macOS with the shipped release). (1) The dispatch watcher's child-process probe called `ps -o comm= --ppid <pid>`; `--ppid` is a GNU flag that BSD `ps` (macOS) rejects, so the probe errored on **every** poll and child-pid liveness detection was broken on Mac. It now lists processes with `ps -A -o ppid=,comm=` (portable) and filters by parent pid in code (`parseChildCommsByPpid`, unit-tested). (2) `commitWorktreeOnBehalf` staged everything and only unstaged `LANE-RESULT.json` / `.brainclaw` / heartbeat files — so the `node_modules` link(s) brainclaw provisions **and** the `.brainclaw-worktree.json` marker (which sits at the worktree root, outside `.brainclaw/`) leaked into on-behalf lane commits. The exclusion list now also covers `.brainclaw-worktree.json`, top-level `node_modules`, and monorepo per-package `**/node_modules` (both the link entry and its contents).
- **Next.js / Turbopack worktree warning** (trp_37b05a15, field report). The `node_modules` link brainclaw provisions into a dispatched worktree is an out-of-worktree-root symlink to the main repo. `tsc` / `vitest` / `build` follow it fine, but `next dev` (Turbopack) panics on a `node_modules` link outside the worktree root. `createWorktree` now detects a Next.js project (a `next` dependency or a `next.config.*`) and, when it links `node_modules`, records a `symlink_warnings` note with the workaround (run `npm install` in the worktree for dev-server work, or smoke-test on the merged branch). Warning only — the link stays correct for build/typecheck; a full Turbopack-compatible per-worktree dependency mode is a planned follow-up.
- **Sandboxed-dispatch brief coherence** (pln#628 Focus 4A). A dispatch brief for a sandboxed worker (codex `--sandbox`) simultaneously carried a Protocol section instructing `bclaw_*` calls **and** a transport addendum stating "the brainclaw MCP server is NOT reachable — Do NOT call bclaw_* tools" — a self-contradiction that gave the worker two incompatible sets of instructions. An empirical probe (codex 0.144.4; dec#133) proved the addendum's premise false: the MCP server runs as a separate out-of-sandbox process and `approval_policy=never` auto-approves every tool call, so MCP **is** reachable from a sandboxed run. `dispatchHasMcp` is now driven by `runtime.mcp_direct` alone (decoupled from `isSandboxedSpawn`), so the no-MCP addendum fires only for genuinely MCP-less agents (nanoclaw/nemoclaw/picoclaw/zeroclaw). The sandbox's one real constraint — `.git` is read-only, so `git commit` is unavailable — is still communicated (working-defaults: the coordinator commits the worktree at harvest). `dispatchCanCommit` is deliberately left conservative (sandbox ⇒ no commit) since commit-from-sandbox was not empirically verified.

## [1.15.0] — 2026-07-15

MCP model-selection parity, federation increment 1 (signed claim sync), and two dogfooding fixes. Each change was reviewed before merge (gpt-5.6-luna review on the model + worktree work). No breaking changes.

### Added

- **MCP model selection** (pln#520/#606) — `bclaw_dispatch` and `bclaw_coordinate` gain an optional `model` string that selects the spawned worker's model (e.g. `sonnet`, `gpt-5-codex`), decoupled from agent identity. Closes the CLI/MCP gap: the CLI `dispatch run --model` already existed, but agents driving brainclaw over MCP had no way to set it. Injected only for agents that declare a `model_flag` (claude-code / codex / github-copilot); no-op otherwise, and consistent with the dispatcher's resolveModel chain.
- **Federation increment 1** (pln#100/#101) — Ed25519 request signing for the cloud bridge, `brainclaw federation identity` + `ensureAgentSigningKey`, a canonical (whitespace-invariant) public-key fingerprint, and a signed claim-sync engine with an outbox. Additive and opt-in (new `federation` CLI commands + core modules); no change to default behavior.

### Fixed

- **Worktree branch-slug collision** (trp#950) — two distinct claim/assign scopes sharing a >48-char prefix collapsed to the same `feat/<slug>` branch → same worktree path → the second claim was refused. `sanitizeBranchComponent` now appends a deterministic 8-char digest of the full cleaned slug when (and only when) the scope exceeds the 48-char cap, so distinct scopes diverge while the same scope stays stable (resume/re-assign). Short scopes are unchanged.
- **Federation `push --to-agent`** (pln#365) — the flag was declared but never wired into the message `to` block, so every push landed with `to_agent` NULL and was broadcast to every inbox. It now targets the named agent; omitting it keeps the broadcast default.

### Docs

- Trimmed the ~260-line inline Changelog section from `README.md` — the full version history lives in this `CHANGELOG.md`, and MCP protocol/schema changes in `docs/mcp-schema-changelog.md`.

## [1.14.0] — 2026-07-05

Coordination-hygiene, dispatch-supervisor spec, and a monorepo worktree fix — from continued cross-machine dogfooding. Each landing was Codex-reviewed before merge. No breaking changes.

### Added

- **Coordination hygiene v1** (pln#602, #48). Stops serving stale coordination debris to agents: a family-level TTL policy (park-don't-delete, config-overridable via `config.hygiene`), a lazy assignment sweep at the `bclaw_work` read path (zero extra file reads on a healthy store — pln#578 guardrail) plus a full sweep at session-start, K-times aging of `stale_warnings`/`workflow_hints` into a single actionable aggregate, and a `brainclaw doctor --hygiene` operator report. Assignment transitions go through the canonical grammar (audit trail); every park writes a backup first.

### Fixed

- **Worktree creation for in-tree projects** (pln#614, #49). `bclaw_coordinate(assign|review)` on a project whose directory is **not** the git root (e.g. an app inside a monorepo) failed to spawn — `git worktree add` ran from the project dir and derived the worktree hash from it, while the ideation path resolved the toplevel (observed as two divergent worktree hashes), and an empty `.git` left by the embedded init made it worse. New `resolveGitToplevel(cwd)` — `git rev-parse --show-toplevel` with a **parent-walk** that skips past an invalid nested `.git` — is applied in `createWorktree`, `cleanMergedWorktrees`, `gcWorktreeIfHarvested`, and the harvest scan base, so git runs from the real repo root and the worktree hash agrees across dispatch paths. Standalone projects (dir == toplevel) are unchanged. Validated E2E on the reporting monorepo.

### Docs

- **Dispatch-supervisor round-3 spec** (pln#545, #47). `docs/concepts/dispatch-supervisor.md` — the round-3 design for honest worker-liveness attribution (Node supervisor owning the real worker pid + `run_id`-keyed sentinels): A0→B as a hard dependency, an explicit spawn-eligibility contract, the Windows Job Object FAIL-CLOSED mechanism, and a complete behavior matrix. Codex-reviewed (7 spec↔code mismatches integrated); implementation lands later as A0-first increments.

## [1.13.0] — 2026-07-04

Operator-maturity batch from two days of heavy multi-agent dogfooding (pln#598–613): dispatch/worktree lifecycle fixes, claim-lifecycle parity, write-path auto-repair, model routing for spawns, a reproducible agent-experience benchmark with blocking CI budgets, and a 2× faster context read on large stores. No breaking changes (MCP surface fingerprint bumped, additive only).

### Added

- **Model selection for codex and copilot spawns** (pln#606, #41). `model_flag` added to the codex and github-copilot capability profiles so the existing `resolveModel` → `buildInvokeCommand` chain (pln#520) reaches them: `dispatch run --model <m>` now injects the model into codex/copilot spawn argv (codex needs `exec -m`, handled by a per-profile `model_flag_insert_index`; flag support verified empirically on the installed binaries). The companion `--add-dir` writable-roots spike closed **negative** on Windows (codex 0.130's restricted-token sandbox ignores it) — the file-first protocol stays the codex transport, MCP write access remains the pln#497 IPC track.
- **Auto-repair identity and session on canonical writes** (pln#608 P0, #42). `bclaw_create`/`update`/`remove`/`transition` without a resolvable identity/session no longer throw "Start a session first": the engine falls through to the same auto-register + auto-session mechanic as `session-start`, announces it in the response (`session auto-created` warning), and tags the session `auto_created` for aggressive GC (pln#602). Unknown identities without a reliable signal still refuse — the trust boundary is unchanged.
- **Reproducible time-to-first-value benchmark with blocking CI budgets** (pln#604, #43). Seeded synthetic stores calibrated on the real store shape, a harness measuring wall-clock / call count / serialized MCP `structuredContent` chars, three scenarios (`cold_onboard`, `warm_work`, `first_edit`), and a CI gate against versioned `bench-budgets.json`. First calibrated baseline: cold_onboard ≈3.3 s · warm_work ≈6.5 s · first_edit ≈48 ms.

### Fixed

- **Claim lifecycle parity** (trp#928, #44). Four gaps behind the ghost-claims reports (claims surviving merged+done plans): `transitionEntity` now routes `entity='claim'` (released via the release cascade, stale via `markClaimStale`); explicit `coordinator_override: true` on `bclaw_release_claim` + `bclaw_transition` (gated trusted+, and the rejection error is now executable as written); **real cascade release with per-claim logging** wired into plan→done, loop close, assignment-completed and `harvest --integrate`/`--orphaned`; `bclaw_find` mis-scoped filter keys (`assignment_id` outside `agent_run`, …) get a first-class entity-scoping rejection naming the caller's entity.
- **Worktree GC on squash-merge workflows** (trp#926, #40). Merged-lane detection is now content-based (`git cherry`/patch-id) so squash-merged lanes are actually collected; the manual-removal fallback is junction-recursive-safe on Windows (never follows `node_modules` junctions into the main repo again — the pln#498 incident class); `dispatch_status` `commits_ahead` compares against the worktree's **creation ref** instead of `master`, killing false "worker delivered" verdicts.
- **VS Code extension: Backlog no longer hides recent plans** (trp#925, pln#610, #38). `_findEntities` walks `has_more`/`next_offset` through a unit-testable `paginatedFind` helper instead of reading a single size-bounded page sorted oldest-first.
- **VS Code extension: probe/spawn parity + classified resolver failures** (trp#927, pln#611, #39). The command probe now uses the exact spawn mechanic McpClient uses (`node <cli.js>`, `shell: false`); win32 `.cmd` shims are derived to the real global `cli.js`; every probe failure is classified (`binary-missing` / `module-missing` / `timeout` / …) with a targeted hint instead of an opaque `spawn ENOENT`.
- **@types/node 26 type regression unblocked**; `web-tree-sitter` pinned to 0.25.x (#33, #35, dependabot #29/#31/#34/#36/#37).

### Changed

- **Context read: 3 of 4 full-store read passes eliminated** (pln#578, #45). Instrumenting fs reads on the real 4300-file store showed one `context --json` performed **four** complete projection passes — the disabled-reputation sweep ran twice and was discarded (`agents: []`), the estimation calibration reloaded the full state for its plans, and pending candidates were scanned three times. All three now reuse the single load: wall 23.9 s → 11.9 s on the reference store, handoff bytes parsed 196 MB → 49 MB, `context --json` output byte-identical. The remaining single 49 MB handoff pass belongs to the checkpointRead/journal track (pln#566).

## [1.12.0] — 2026-06-27

Auto-localized execution writes for multi-project workspaces, from DGX-Spark dogfooding. An agent on a monorepo could not create a plan (or claim/step) in a sibling child project without first remembering to `bclaw_switch`: `bclaw_create(entity: "plan", project: "<child>")` was rejected as a cross-project execution write, so plans silently fell back to the default project. No breaking changes.

### Changed

- **Execution writes auto-localize into a workspace sibling named by `project=X`** (pln#597). `bclaw_create` / `bclaw_transition` (plan & claim), `bclaw_claim`, the step tools (`add`/`complete`/`update`/`delete_step`) and `bclaw_delete_plan` now accept `project=X` when X resolves to a **workspace store-chain child**: instead of the hard *"limited to signaling entities"* rejection, they open a session + a session-scoped (sticky) switch into X and write locally there, echoing `auto_switched` in the response. This re-scopes the `cross_project_signaling_vs_execution` boundary to what it was always about — **federation** (`cross_project_links` / other machines), not monorepo siblings. Federated links and unknown project names stay blocked; a configured link is matched (by name/path/basename, at both the effective cwd and the workspace anchor) **before** the workspace-child check, so a link whose target happens to sit under the workspace tree can't be folder-discovered into a local sibling. Trust/identity for an auto-localized `bclaw_claim` resolve against the **source** cwd while the claim is tagged with the target child's `project_id`. Closes the DGX-Spark dogfood gap where an agent had to manually `bclaw_switch` before it could create a plan in a child project (the same monorepo that, separately, had a stale global active-project pin shadowing the root).

## [1.11.1] — 2026-06-24

Agent-identity / session-hook resilience + deeper repo discovery, from a fresh-CLI dogfood on the DGX-Spark monorepo (trp#917, trp#918). A new CLI install whose agent wasn't yet registered produced an endless `UserPromptSubmit hook error: Failed with non-blocking status code: No stderr output` on every prompt — four compounding causes, now fixed. No breaking changes.

### Fixed

- **The agent-identity error hint contradicted the resolver.** `AgentIdentityResolutionError` told users to run `register-agent <name> --set-current`, but the session-start resolver deliberately ignores `config.current_agent` (pln#562 multi-agent safety) — so following the hint printed `✔ … [current]` and then failed identically. The hint now points at what the resolver actually honors: `--agent` / `$BRAINCLAW_AGENT_NAME` / `register-agent`. **New: a single-registered-agent fallback** — when there is no identity signal at all (no env, no detected native agent) and exactly one agent is registered in scope, it resolves automatically. The pln#562 guard is intact: with ≥2 registered agents, resolution still stays `undefined` and never consults `config.current_agent`. A solo dev testing in the CLI no longer needs to know `register-agent`.
- **Session hooks no longer hard-fail the prompt loop.** `session-start` / `context-diff` / `session-end` accept `--hook`: on any advisory failure (no identity, no diff baseline, store not initialised) they degrade to exit 0 and append one line to `~/.brainclaw/hook.log` instead of erroring. The generated Claude Code hooks pass `--hook`, so a misconfiguration is now silent-but-logged rather than a contentless warning on every prompt. (Previously `2>/dev/null` swallowed the *actionable* error too — the diagnostic now lands in the log, which survives the redirect.)
- **`brainclaw doctor --fix-hooks`** — purges stale/broken/duplicate brainclaw session hooks across **all** Claude Code settings scopes (`~/.claude/settings*.json` **and** `<cwd>/.claude/settings*.json`) and rewrites the canonical entry, independent of git-repo discovery. Closes the gap where `setup` only sanitized the discovered git repos' settings, so the launch dir and user scope accumulated broken hooks (legacy `node session-start` with the `cli.js` arg dropped, dead install paths, N× stacked) exactly where the agent executes them. Only collapses events that already carry a brainclaw hook — never injects hooks into a file that lacked them.
- **`setup` repo discovery is no longer depth-1 (trp#918).** It now recurses (bounded depth, skipping `node_modules`/build/hidden dirs) so repos nested in a workspace — e.g. `/srv/dev/repos/global/<svc>` — are found instead of silently missed when only shallow repos surfaced. After configuring agents, `setup` registers the detected agent (or, when none is detected, prints an actionable note) so the hooks it just installed can resolve an identity rather than being installed dead-on-arrival.

## [1.11.0] — 2026-06-24

Monorepo Code Map + project-resolution improvements from real-agent dogfooding (multi-project workspace on DGX Spark). No breaking changes.

### Added

- **`code-map refresh --cascade` — monorepo-native, per-project indexing.** In a `project_mode: multi-project` workspace, a plain refresh at the root built one monolithic index that descended every child subtree while the sibling projects stayed `missing_index`. The new opt-in cascade (`code-map refresh --cascade`, or `bclaw_code_refresh(cascade=true)`) instead refreshes **every nested brainclaw project** into its own `<child>/.brainclaw/code/` store and refreshes the **root** store *scoped to the files no child owns* — each file is indexed by exactly the most specific project that contains it, so there is **zero double-indexing**, even under nesting. `code-map status --cascade` (`bclaw_code_status(cascade=true)`) adds a per-child recap (built-index vs `missing_index`, plus an aggregate). Opt-in: plain refresh keeps the single-tree behaviour, and single-project repos ignore the flag. A federated *query* across child indexes remains on the roadmap.
- **`bclaw move` / `bclaw_move` — id-preserving cross-project relocation** (pln#595). Move a brainclaw item to another project in a multi-project workspace while **keeping its id** (so `pln#`/`dec#` references stay stable) — closing the gap the monorepo switch bug exposed (items created in the wrong store, no way to relocate them without minting a new id). CLI: `brainclaw move <entity> <id> --to <project> [--from <project>] [--force]`; MCP: `bclaw_move(entity, id, to_project, …)`. Relocatable: plan, decision, constraint, trap, handoff, sequence. **Execution-local entities (claim, assignment, agent_run, session) are rejected** — they stay in the project where the work ran. Safe by default: refuses id collisions in the target, a missing source, and moving a plan under an **active claim** (unless `--force`, which warns); audits **both** stores; warns about sequences that still reference a moved plan (refs are not auto-rewritten in v1). candidate/runtime_note and **host/private traps** (host-scoped storage) are deferred.
- **Auto-clean dispatched sub-agent worktrees when a loop closes** (pln#594). Review/dispatch loops left their sub-agent worktrees under `~/.brainclaw/worktrees/` to accumulate — observed in dogfooding as orphaned codex review-loop worktrees from closed sessions that were never removed. Closing a loop as **completed** now garbage-collects each slot-assignment's worktree (junction-safe, then deletes the redundant dispatch branch). Safe by default: it **keeps** a worktree (and warns via debug log) when the worker still looks alive (recent heartbeat), when there are un-harvested edits (anything beyond brainclaw birth-noise / `LANE-RESULT.json` / heartbeat), or when the lane branch carries commits not reachable from the main HEAD. A **cancelled/blocked** close keeps the worktree (and its run logs) for forensics. Best-effort — never blocks the close; opt out with `BRAINCLAW_NO_WORKTREE_GC=1`. New helper `gcWorktreeIfHarvested` in `core/worktree.ts`.

### Fixed

- **An agent inside a monorepo child could not make the workspace root the active project, and a project switch was silently ignored.** Two root causes: (1) `resolveProjectRef` skipped the workspace root when matching by name, so `bclaw_switch("<root-name>")` (or `project="<root-name>"`) failed with `Cannot resolve project` — an agent could never switch *up* to the umbrella/monorepo-root project. (2) Sessions are stored per-cwd, so an agent physically inside a child had its session (and its switch) persisted under the *child* store, while `resolveEffectiveCwdInfo` read it only under the workspace *anchor* (`BRAINCLAW_CWD`) — the switch was written and read in different stores, so resolution silently fell through to the physical child (`cwd_child`) and pinned the agent there. The resolver now matches the workspace-root project by its own `project_name`/`project_id` (still name/id-only — the path-injection trust boundary is unchanged), and probes the anchor, the physical cwd, and the workspace root for the session (first one carrying a still-valid `active_project` wins). Net effect: `bclaw_switch` is authoritative for every subsequent call in the session — including Code Map (`bclaw_code_status` / `find` / `brief`) — without needing `--cwd`.

## [1.10.2] — 2026-06-22

A dispatch worktree-creation hardening patch from real-agent dogfooding (parallel-lane dispatch on a large multi-file repo). No breaking changes.

### Fixed

- **Parallel dispatch could fail to create a worktree on multi-file scopes.** The git branch slug derived from a claim's scope was length-capped (`.slice(0, 48)`) *after* its trailing-dot/dash strip — so a scope ending in e.g. `…IntegrationHubPage.astro` was cut mid-token to `feat/…IntegrationHubPage.`, a trailing dot git rejects (`fatal: not a valid branch name`), and the whole lane's worktree creation aborted. The cap now runs *before* the trailing strip (and the `.lock` re-strip), so truncation can never re-introduce an invalid ref. `sanitizeBranchComponent` is validated against `git check-ref-format`.
- **`git worktree add` could be killed mid-checkout on large repos / Windows.** Every git invocation shared a flat 15s timeout, but a worktree add materializes the entire working tree — a several-hundred-file checkout exceeded it and was SIGTERM-killed partway, surfacing as a misleading `git worktree add failed: Updating files: 94%` even though the branch name was valid. Worktree creation now uses a dedicated timeout (120s default; override with `BRAINCLAW_WORKTREE_ADD_TIMEOUT_MS`), and a timed-out git call reports the timeout explicitly instead of dumping partial progress output.

## [1.10.1] — 2026-06-21

Code Map fast-follows from the 1.10.0 real-agent dogfood, plus a lint-baseline cleanup. No breaking changes.

### Fixed

- **Code Map flags a stale index after a git branch switch.** The index records the commit it was built at, but no read path compared it to the working tree's current HEAD — so `git checkout <other-branch>` left `bclaw_code_status` / `find` / `brief` reporting `fresh` (and possibly serving old-branch paths). Reads now compare HEADs and surface a dedicated `stale_git_head` reason, kept distinct from `stale_changed_files` so a HEAD move is not misreported as confirmed per-file drift.
- **Code Map honors `.gitignore` during refresh.** Enumeration consulted only a hardcoded ignore list, so gitignored output dirs (e.g. a build `out/`) were indexed and polluted `brief`/`find`. Refresh now runs `git check-ignore` inside a git repo (nested files, negations, and global ignores all honored); non-git projects keep the hardcoded defaults.
- **`brief("<path>")` resolves the exact file** instead of fuzzy-tokenizing the path and flooding the reading list with same-token symbols; its imports / dependents / direct tests rank below it.

### Changed

- **Freshness badge distinguishes index freshness from a call's spot-check** — `find` / `brief` add an `index_status` detail when their per-query spot-check status diverges from the index, so `status()=fresh` alongside `brief()=partial` reads as "index fresh, this call's spot-check incomplete", not a contradiction.
- **Skills + agent instructions teach Code Map** — the `brainclaw-session` protocol skill and the generated instruction surface now point agents at `bclaw_code_brief` / `bclaw_code_find` (and the `code-map` CLI) before grepping unfamiliar code.
- **Lint baseline cleared to zero** and the low-churn stylistic rules (`no-useless-assignment`, `preserve-caught-error`, `no-useless-escape`, `no-empty-object-type`) ratcheted to `error` so they cannot silently regress — a behaviour-preserving cleanup only.

### Docs

- README Documentation links are now clickable, and `docs/code-map.md` lists the full supported-language set (JS / TS / JSX / TSX · Python · PHP · Java) in its intro and WASM-bundling notes.

## [1.10.0] — 2026-06-20

### Added

- **Code Map (P0)** — a per-project structural index of the JS/TS/TSX codebase
  (symbols, imports/exports, React component/hook detection) built with
  Tree-sitter WASM and stored as JSONL shards under `.brainclaw/code-map/`. New
  CLI: `brainclaw code-map status | refresh [--changed|--all] | find <query> |
  brief <symbol-or-path>`. New MCP tools: `bclaw_code_status`,
  `bclaw_code_find`, `bclaw_code_brief`, `bclaw_code_refresh`. Every output
  carries a freshness badge (`fresh` / `stale_changed_files` / `stale_extractor`
  / `stale_grammar` / `partial` / `missing_index`). `refresh --changed` re-parses
  content-changed files and heals version-stale shards on the cheap path; the
  Tree-sitter engine + grammars are bundled into `dist/` and loaded lazily on
  first parse, so the rest of the CLI/MCP never depends on the WASM engine. See
  `docs/code-map.md`.

### Changed

- **BREAKING — minimum Node.js is now 22.12** (`engines.node = ">=22.12.0"`).
  Node 20/21 and Node 22.0–22.11 are no longer supported. This formalizes the
  runtime floor already verified in CI (Node 22/24 only since Node 20's April
  2026 EOL) and is required by the commander 15 upgrade below.
- **commander 14 → 15** — the CLI argument parser is now ESM-only and requires
  Node ≥ 22.12. No CLI behavior change: brainclaw's `--no-*` flags are all lone
  negations, unaffected by v15's positive/negative default-value change.
- **Monorepo multi-project safety — `brainclaw switch` is session-scoped by
  default.** A plain `switch <project>` (and `switch --clear`) now only affects the
  calling agent's session; the new `--global` flag is the sole path that writes or
  clears the shared `.brainclaw/active-project.json`. `switch --list` / show are
  session-aware. Prevents two agents in one monorepo from clobbering a shared
  active-project pointer (last-writer-wins).
- **Dispatched / CoDev workers spawn with a scrubbed identity.** The coordinator's
  `BRAINCLAW_SESSION_ID` / `BRAINCLAW_PROJECT` / `BRAINCLAW_AGENT*` no longer leak into
  a spawned worker (new `buildWorkerIdentityEnv`), so an MCP-capable worker is an
  independent agent rather than a clone of the coordinator. `BRAINCLAW_CLAIM_ID` is set
  only for a real claim (never inherited).

### Fixed

- **Anchored agent resolves the child project it works in (monorepo).** With
  `BRAINCLAW_CWD` anchoring the workspace, an agent working inside a child project now
  resolves *that* child (new `cwd_child` resolution step, guarded by a containment
  check) instead of defaulting to the repo root — the "plans / Code Map target the repo
  root" symptom.
- **Physical location beats a stale shared global.** A session-less agent physically
  inside a child project resolves the child rather than a stale/foreign
  `active-project.json` pointer (no-anchor `cwd_child`, bounded by the discovered
  workspace root, never `$HOME`).

## [1.9.1] — 2026-06-18

Maintenance release: monorepo project-scoping fixes, case-insensitive agent
names, and a documentation accuracy pass.

### Fixed

- **MCP project scoping in monorepos** — effective-cwd resolution now follows a
  defined precedence (explicit arg → MCP session → `BRAINCLAW_CWD` → global
  active project → process cwd) so reads/writes target the intended project
  store inside a monorepo / multi-project workspace.
- **Legacy filter diagnostics** — search can count `provenance.kind="legacy"`
  records excluded by the default `bclaw_find` filter, surfacing why a known
  record is missing from default results.
- **Case-insensitive agent-name resolution** — `targetAgents=["Codex"]` resolves
  like `codex`; the dispatch pre-flight no longer drops a reviewer over casing.
  An unknown name now returns a distinct `unknown_agent` reason (check
  spelling/case) instead of the misleading "no CLI spawn template (IDE-only?)".

### Changed

- **Documentation** — revamped Loop Engine, Git Worktrees, Cross-Project
  Signals, and the Orchestration Playbook, corrected against actual code behavior.

## [1.9.0] — 2026-06-14

Release hardening for npm publishing and agent-surface coherence.

### Added

- **Release package gate** — CI now builds the CLI, builds the optional VS Code extension, runs the extension tests, verifies the release tarball contents, and requires the bundled `dist/brainclaw-vscode.vsix` for release builds.
- **Packaging tests** — local release publishing now executes `build:release` and `pack:check` before `npm pack`, with tests covering that path.

### Changed

- **Agent surfaces no longer pin the npm semver** — generated instruction headers use a stable `Managed by brainclaw` banner to avoid stale version drift across files.
- **VS Code extension positioning** — the `.vsix` is bundled as an optional IDE companion, not a requirement for CLI/MCP use. Local development builds skip it when extension dependencies are absent; release builds remain strict.
- **`.brainclaw/project.md` clarified as legacy derived output** — the canonical durable project vision is root `PROJECT.md`; live claims, plans, handoffs, and runtime state belong in `agent-board`, MCP context, and structured store files.

### Fixed

- **Strict claim isolation** — creating a second active claim for the same exact scope now fails inside the mutation lock instead of creating an advisory conflict.
- **JsonStore path safety** — entity IDs are validated before resolving file paths, preventing malformed IDs from escaping the store directory.
- **Integration docs** — Roo, Continue, Windsurf, Copilot, OpenClaw, quickstart, and agent integration docs now match the current export formats and setup behavior.

## [1.8.0] — 2026-06-09

Multi-agent dispatch convergence — the "new frontier", driven by a real
cross-project field session (a real NestJS/React monorepo) where a sandboxed
codex worker could neither commit nor reach MCP and the coordinator had to carry
every lifecycle step by hand. Theme: reduce the worker's contract and let
brainclaw carry the rest. Builds on the 1.7.5 security patch.

### Added

- **Worktree-as-contract** (pln#534) — the headline lever. The worker's contract
  shrinks to "edit files in this worktree + drop `LANE-RESULT.json`". For a
  worker that cannot self-commit (`dispatchCanCommit=false`, i.e. a sandboxed
  agent whose root excludes `.git`), `brainclaw harvest --integrate` now commits
  the worktree diff on its behalf onto the lane branch, then completes the
  assignment and releases the claim with plan cascade. Strictly additive +
  opt-in (`integrateLaneResults()` / the `--integrate` flag); existing harvest
  stays report-only. The commit is hard-guarded to the linked worktree only
  (`isLinkedWorktree` — never the main repo).
- **Pre-flight spawn validation** (pln#533) — `bclaw_coordinate(open_loop=true)`
  runs one trivial validation spawn per reviewer agent before opening the loop,
  so an environment death (config rejected, auth fail, model mismatch) surfaces
  instantly with a clear reason (via `recognizeStderrSignature`) instead of a
  generic "did not acknowledge" loop timeout. Reviewers that fail are dropped
  with a targeted warning; opt-out with `preflight: false`; skipped under
  `BRAINCLAW_NO_SPAWN` or cross-project dispatch.
- **Perishable-memory anti-staleness** (pln#530) — decisions and traps accept
  `verified_at` + `verify_cmd`; staleness detection flags an active trap whose
  verification is older than 30 days (or never run) and surfaces the
  `verify_cmd` to re-confirm it.

### Changed

- **`LANE-RESULT.json` is the #1 verdict signal** (pln#532) — `dispatch_status`
  now treats a `LANE-RESULT.json` at the worktree root as the top-priority
  verdict: the worker FINISHED (even if it could not self-update its
  `agent_run`), returning `health: terminal` above every pid/heartbeat/run-status
  check.
- **No-worktree ⇒ refuse-spawn** (pln#531) — the dispatcher refuses to spawn a
  worker without an isolated worktree (returns `command_ready_manual` with
  `failure_kind: spawn_no_worktree`) rather than running it in the integration
  repo. New `requireWorktree` option on the real worker-dispatch path.

## [1.7.5] — 2026-06-09

Security patch. **Upgrade from 1.7.4 (and any 1.7.x) is recommended.**

### Security

- **Fixed a git command-injection / RCE vector** (Socket AI, medium). Several
  commands built `git` invocations as `execSync` shell strings that interpolated
  a ref — notably one derived from the persisted session snapshot's `git_sha`
  (`session-end.ts`), plus `release-claims.ts`, `release-notes.ts`, and
  `sync.ts`. A `git_sha` (or ref) carrying shell metacharacters (`$(…)`, `;`,
  backticks, `&&`) would execute arbitrary commands. All git calls now use
  `execFileSync('git', [args])` (no shell — arguments are passed literally), and
  `git_sha` is additionally validated as a hex SHA before it can reach a git ref
  (untrusted values fall back to a safe literal). No functional/API change.

## [1.7.4] — 2026-06-08

Multi-agent dispatch hardening, driven by a real cross-project field session
(NestJS/React monorepo, sequence dispatch + codex review loop). Focus: spawn
observability that reflects real work, transport-aware briefs, worker DX, and
lifecycle GC.

### Added

- **Advisory claims** (trp#431). `bclaw_claim` accepts `advisory: true` (or
  `worktree: false`) to take an advisory-only lock with NO worktree — for
  in-place work that already lives uncommitted in the main tree, where a fresh
  worktree was counterproductive (agents had to skip the claim).
- **Opt-in per-worktree typecheck gate** (pln#479). With
  `BRAINCLAW_WORKTREE_TYPECHECK_GATE=1`, a dispatched worktree gets an isolated
  `pre-commit` running `tsc --noEmit` (via `--worktree core.hooksPath`, so the
  main repo is never affected) — blocks a worker from committing type-broken
  code. Default off (tsc can be slow on large monorepos).

### Changed

- **Dispatch liveness reflects real work** (pln#527). The reconciler and
  `bclaw_dispatch_status` now fold a filesystem-activity signal (max mtime of the
  captured stdout/stderr logs + a junction-safe worktree walk) into the verdict:
  a stale heartbeat with active fs is "working", not `stalled` — fixing the
  false-`stalled` that fired while a worker was actively editing files or
  streaming to stderr. `bclaw_dispatch_status` also recognizes known codex boot
  stderr signatures (model 400 / `service_tier`) and returns a targeted
  diagnosis instead of a generic `silent_death`.
- **Transport-aware briefs + capability matrix** (pln#528). Derived
  `dispatchHasMcp` / `dispatchCanCommit` / `isSandboxedSpawn` expose that a
  sandboxed worker (codex `--sandbox workspace-write`) can neither call MCP nor
  `git commit`. The generated brief now appends an explicit "sandboxed — no MCP,
  no commit" note making the file protocol (`LANE-RESULT.json`) authoritative,
  so a sandboxed worker no longer receives `bclaw_*` instructions it cannot
  follow.
- **`bclaw_find` payloads are size-bounded** (pln#491). A verbose page is shrunk
  to fit a char budget (count was already capped) and the response advertises
  `returned` / `has_more` / `next_offset` / a hint, so a large result set never
  silently overflows the MCP token cap and pushes the agent to the terminal. The
  tool description documents pagination, the size bound, and load-order semantics.
- **MCP doc fixes** (trp#291): `bclaw_assignment_update` documents its
  cross-agent ownership rule; `bclaw_find` documents ordering/pagination.
- **`code_propagation_note` on gated ready lanes** (pln#529, advisory). When a
  lane unblocks via `hard_after`, `analyzeSequence` flags that gate-readiness ≠
  code-availability (commit/merge the predecessor, or dispatch with
  `ref=<predecessor branch>`) — making the silent "spawn from HEAD without the
  socle" risk visible. (The structural auto-fix is tracked separately.)

### Fixed

- **`plan.related_paths` is now updatable** (trp#434) — it was settable at create
  but rejected by `bclaw_update` (decision/constraint/trap already allowed it).
- **GC cascade on inferred failure** (trp#433). When the reconciler infers a run
  `failed` (silent_death / stalled past the stale window), it auto-releases the
  linked claim so dead runs stop leaving claims + worktrees accumulating for
  manual cleanup.

## [1.7.3] — 2026-06-05

Patch release hardening multi-agent dispatch ergonomics on real JS/TS monorepos:
worktree dependency provisioning, worktree garbage collection, dispatch
verification guidance, and a standard worker-result channel.

### Added

- **`LANE-RESULT` convention + `brainclaw harvest <assignment_id>`** (pln#526).
  A dispatched worker writes a single `LANE-RESULT.json` at its worktree root as
  its final step — a brief-boilerplate-free channel that works even when MCP is
  unavailable (e.g. sandboxed agents). The coordinator ingests it (status,
  summary, files, artifacts) with `brainclaw harvest <assignment_id>` (or
  `--all`), which emits a durable `lane_result_harvested` event and is idempotent
  via a per-assignment marker.

### Changed

- **Dispatch verification leads with `bclaw_dispatch_status`** (pln#524, trp#428).
  The generated session-protocol guidance and the `bclaw_coordinate` description
  no longer tell agents to check liveness via the tracked pid — on Windows an
  ack-wrapped spawn runs under `cmd.exe`, so `agent_run.pid` is the wrapper
  (which exits early by design) and `Get-Process` reads it dead while the worker
  is alive and committing. They now point at `bclaw_dispatch_status`, with the
  wrapper-pid caveat spelled out.
- **Agent inventory decouples spawnability from the `--version` probe** (trp#427).
  An agent whose invoke binary resolves on PATH is reported `installed` (and
  carries a `spawnable` flag) even when its cold-start `--version` probe times
  out (timeout raised 3s → 8s). Fixes claude-code being shown "Not detected" and
  wrongly excluded from dispatch.

### Fixed

- **Monorepo per-package `node_modules` in dispatched worktrees** (pln#523).
  Worktrees now junction-link each workspace package's `node_modules` (npm / yarn
  / bun `workspaces` + `pnpm-workspace.yaml`), not just the root, so a worker can
  build/typecheck a sub-package instead of stalling on `tsc`. Failed links are
  surfaced (worktree sidecar `symlink_warnings` + log) instead of silently
  swallowed; `BRAINCLAW_NO_LINK_DEPS=1` opts out.
- **Worktree garbage collection actually runs** (pln#525, trp#371).
  `brainclaw worktree clean` no longer skips every merged worktree as
  "uncommitted changes": it ignores worktree birth-noise (the
  `.brainclaw-worktree.json` sidecar and a `.gitignore` flagged by Windows
  autocrlf) and forces git's removal past the untracked sidecar. The dispatch
  dirty-guard (`isSystemDirtyPath`) also excludes `.claude/`, `.cursor/`, and
  `.codex/` agent-local config dirs.

## [1.7.2] — 2026-06-04

Patch release for sequence-driven parallel dispatch ergonomics in MCP clients.

### Changed

- **Sequence MCP tools are default-discoverable**. `bclaw_list_sequences`,
  `bclaw_create_sequence`, `bclaw_update_sequence`, and
  `bclaw_delete_sequence` now live in the default `standard` catalog instead of
  the hidden `advanced` tier, so fresh agents can build and activate sequences
  without requesting `catalog=all`.
- **Sequence item schemas are explicit**. The MCP schema for sequence `items`
  now documents the full lane item shape: `planId`, optional `stepId`, `rank`,
  `hard_after`, `soft_after`, `lane`, `scope_hint`, and `rationale`.

### Fixed

- **Canonical sequence CRUD parity**. `bclaw_create/update(entity="sequence")`
  now rejects malformed `items` clearly instead of silently ignoring non-array
  payloads, while preserving the same item shape as the specialized sequence
  tools.

## [1.7.1] — 2026-06-02

Patch release for MCP project-context isolation in large multi-project
workspaces.

### Fixed

- **`bclaw_switch` MCP session scoping**. MCP project switches now create or
  reuse an agent session and never fall back to the shared global
  `active-project.json` when `sessionOnly=true`. Session lookup now honors
  explicit session IDs, avoids adopting another live process's session, and
  detects Codex through the shared AI-agent detector (`CODEX_*` runtime env
  vars), closing the DGX monorepo case where Codex could see another agent's
  active project.
- **`bclaw_switch(list=true)` session-aware output**. Project listings now mark
  the session-scoped active project when present, expose `active_source`, and
  include available `cross_project_links` so externally-linked projects can be
  listed consistently with the switch path.

## [1.7.0] — 2026-05-28

Dispatch reliability plus a scope-aware coordination guard, with the Hermes
agent integration.

### Added

- **Hermes agent integration** (Nous Research). MCP client config, SKILL, setup
  writer, and detection wired through `setup` / `setup-machine`; new
  `docs/integrations/hermes.md`. The detected-agent setup flow is generalized via
  `agent-integrations.ts` / `agent-files.ts` / `agent-inventory.ts`.
- **`ref` on `bclaw_coordinate`** (pln#520 Tier 2). `assign` / `review` / `reroute`
  can build the dispatched worker's git worktree from an explicit ref
  (commit/branch/tag) instead of HEAD. `createCoordinatorClaim` owns the
  invariant "a pinned ref ⇒ the worktree reflects that ref" — it resets a stale
  `feat/<scope>` branch, re-points a reused worktree, and reports untracked
  residue rather than letting stale state pass silently.
- **VS Code extension — backlog by status**. The backlog section loads `todo` +
  `in_progress` plans by status before applying per-query limits; nested-project
  discovery is gated by a dependency-free `config.yaml` read (canonical
  `multi-project` mode).

### Changed

- **Scope-aware dispatch dirty-guard** (trp#371). `bclaw_coordinate`'s
  uncommitted-changes guard is now scope- and intent-aware: it only guards
  worktree-spawning intents (`assign` / `review` / `reroute`), probes the
  dispatch target (`dispatchCwd`), excludes `.brainclaw/` + `.git/`, and blocks
  only when dirty files overlap — or cannot be proven disjoint from — the
  dispatch scope. `allow_dirty` is now exposed in the `bclaw_coordinate` input
  schema (with `"true"`/`"false"` string coercion) and downgrades a would-be
  block to a warning. `consult` / `ideate` / `summarize` are no longer guarded
  (they spawn no worktree).
- **MCP public surface fingerprint** → `sha256:4a6f612ad952fb52` (additive:
  `allow_dirty` + `ref` on `bclaw_coordinate`).
- **Build decoupling**: `emit-site-facts` is no longer part of `build` /
  `build:cli`; it runs via the dedicated `emit:facts` script and at publish time
  (`prepublishOnly`), so the package build no longer depends on site-sync
  tooling. `dist/facts.json` now also exposes the agent-integration matrix.

### Fixed

- **Dispatch reliability — evidence-first reconciliation** (pln#520 P1). The
  `agent_run` read-path reconciler no longer cancels a `running` run when its pid
  is dead but untrusted. It infers completion from evidence (commits/claims),
  converges genuinely-stale runs to `failed` after 30 minutes, and otherwise
  leaves the run `running` (`health_check_unverified`) — eliminating both
  false-positive and false-negative dispatch verdicts.
- Six pre-existing unit-test failures (source-regex brittleness + MCP
  surface-guard drift).

## [1.6.0] — 2026-05-23

The bootstrap loop chantier — collaborative `PROJECT.md` materialization driven
by the loop engine, plus the cross-project agent workflow that lets one MCP
session operate on a project in another folder.

### Added

- **Bootstrap loop preset** (pln#511 → pln#518). `bclaw_coordinate(intent='ideate', preset='bootstrap')`
  opens a 5-phase loop (`survey → propose → clarify → review_draft → converge`)
  that converges on a materialized `PROJECT.md` at project root. Singleton-per-project
  via opportunistic coordination claim ; concurrent callers join the existing loop.
- **`bclaw_init_project` MCP verb**. Initialize brainclaw at an arbitrary path
  AND register it as a `cross_project_link` in the caller's store, in one call.
- **Cross-project routing extended to `bclaw_work` + `bclaw_loop`**. The `project=`
  parameter (already honored by canonical-grammar verbs) now also routes these
  two coordination verbs to a linked project. `switchProject` falls back to
  `resolveProjectCwd` so an MCP session can switch to externally-linked projects,
  not just workspace store-chain children.
- **`bclaw_work` returns `bootstrap_recommended` + `next_action` hint** when the
  project lacks a usable `PROJECT.md` (absent or zero bytes). Cheap probe, no
  gating flag.
- **`brainclaw bootstrap-loop` CLI command** — open / join / `--status` / `--cancel`
  the bootstrap loop on the current project. Delegates open/join to the shared
  `acquireBootstrapLoop` helper.
- **`brainclaw loop {turn,complete-turn,advance,add-artifact}` CLI wrappers**
  for the corresponding `bclaw_loop` intents. Lets external orchestrators drive
  loop turns without an MCP session.
- **`brainclaw init --cwd <path>`** for off-tree initialization (parity with the
  rest of the CLI).
- **`min_iterations` StopCondition kind** — atomic gate that requires
  `iteration_count >= n` before the phase can be exited. Wired into the
  bootstrap preset's `clarify` gate so the phase cannot be silently traversed.
- **`writeProjectMdSafe` + `RefBasedArtifactBody` schema**. Atomic materialization
  of `PROJECT.md` from a `project_md_final` artifact. Three branches: `absent` /
  `empty` direct-write, `present_non_empty` → diff + `operator_question` for
  approval, `no_final_artifact` → no-op. Ref-based body shape carries
  `{ ref, byte_count, sha256 }` and persists the actual content under
  `.brainclaw/loops/threads/<loop_id>/artifacts/<ref>`.
- **`acquireClaimScope` atomic CAS helper** in `src/core/claims.ts`. Wraps
  `listClaims` + decision + `saveClaim` inside one `mutate()` call so the
  mutation-pipeline mutex serializes filesystem writes on the claims store.
- **OS-native notification hook** (`src/core/loops/hooks/notify-operator.ts`)
  on `input_requested` events for bootstrap-preset loops. Gated by
  `BRAINCLAW_OPERATOR_NOTIFICATIONS=1`. Platform-aware (`notify-send` /
  `osascript` / `BurntToast`), best-effort, never throws.
- **Bootstrap coordination lock hardening**: scope key normalization
  (symlinks + Windows casing collapse to one canonical key) + TTL sweep that
  releases orphan locks older than 5 minutes when no backing loop exists.

### Changed

- **`advance` auto-close materializes `PROJECT.md`** (regression fix for
  field-observed gap on `anonymizer_3CX`). `commitClosedTransition` now
  delegates to `closeLoop` when `final_status='completed' && preset='bootstrap'`,
  so the FSM auto-close path runs the same `writeProjectMdSafe` pre-hook as
  the explicit `bclaw_loop intent='close'`. The stop-condition check also moved
  before `decideNextPhase` in `advance`, so the iteration engine no longer
  shadows the pre-advance auto-close branch at the final phase.
- **MCP coordinate handler** consolidated against a shared `acquireBootstrapLoop`
  helper (`src/core/loops/bootstrap-acquire.ts`). The CLI's
  `brainclaw bootstrap-loop` calls the same helper, eliminating duplicate
  find-existing logic that bypassed the coordination lock.
- **`switchProject` resolution** now consults `resolveProjectCwd`
  (cross_project_links) when `resolveProjectRef` (store-chain) returns
  `undefined`. Both `brainclaw switch` CLI and `bclaw_switch` MCP verb benefit.
- **`bclaw_loop` MCP facade** structurally surfaces
  `awaiting_file_apply_approval` errors with full details
  (`{ loop_id, question_id, target_path, diff_artifact_id }`) instead of a
  generic `verb_error` (codex Phase 3 review fix).
- **`brainclaw reply` CLI** refuses `--answer <text>` on questions with
  structured `options`, pointing the operator at `--choose <id>` with the
  matching id when the answer text matches an option literally (codex Phase
  3 review fix). Prevents the file-overwrite approval bug where
  `--answer approve` silently materialized as REJECT.

### Fixed

- **Bootstrap survey signal extraction depth**. New `readSurveySources(cwd, opts?)`
  helper reads README + LICENSE + the manifest-referenced entry point
  (PyInstaller `.spec` / `package.json` / `pyproject.toml` / `Cargo.toml` /
  `go.mod`) up to 50KB. Closes the gap where the survey phase missed the
  actual implementation in projects like `TranslaVox` and produced
  durable memory of  insufficient depth.
- **Codex Phase 4 review concerns** applied inline (Wave 1 + Wave 2 reviews),
  including the missing `joined_existing` flag on CLI join responses
  (parity with MCP coordinate join), notification hook reading the
  pre-write thread snapshot, and bootstrap-acquire helper losing
  `title/goal/created_by/agent_id` metadata.
- **Lock scope path normalization** so symlinks + Windows casing don't
  produce different keys for the same project.
- Various test isolation fixes (`normalizeLockKey` in test fixtures,
  `BRAINCLAW_CWD` anchoring for `switchProject` tests).

### Docs

- **`docs/concepts/loop-engine.md`** gained an "Artifact body shapes" section
  documenting `RefBasedArtifactBody` (`{ ref, byte_count, sha256 }`),
  ref file placement convention, which artifact types use ref-based vs
  inline JSON, and a complete attach-flow code snippet (pln#517 step 1).
  `KNOWN_ARTIFACT_BODY_SCHEMAS` entries in `src/core/loops/types.ts`
  annotated with their body-shape category.

### Validation

End-to-end validation re-run on a fresh project (`anonymizer_3CX`,
docker-compose POC with FastAPI / Celery / Postgres / Redis / Presidio /
Meilisearch / Streamlit / Next.js / MinIO) — loop traversed all 5 phases,
`PROJECT.md` materialized at root, evidence chain artifact-to-decision
preserved in the final document. Full report linked from `run_79f8443a`.

## [1.5.4] and earlier

See git history for releases before this changelog was introduced
(commit `1f8c5dd` and earlier).

[1.7.2]: https://github.com/jberdah/brainclaw/compare/v1.7.1...v1.7.2
[1.7.1]: https://github.com/jberdah/brainclaw/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/jberdah/brainclaw/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/jberdah/brainclaw/compare/v1.5.4...v1.6.0
