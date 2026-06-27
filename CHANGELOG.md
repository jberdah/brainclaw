# Changelog

All notable changes to brainclaw are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and brainclaw adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
