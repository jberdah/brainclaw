# Changelog

All notable changes to brainclaw are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and brainclaw adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.6.0]: https://github.com/jberdah/brainclaw/compare/v1.5.4...v1.6.0
