# MCP surface governance

How the brainclaw MCP server evolves — catalog tiers, breaking-change
policy, versioning, deprecation cadence, and changelog discipline.

Operator-facing. Agents that cache tool catalogs use this to know when
to invalidate and what to expect when we change things. Source of
truth for `pln_aaf94588` (doc/mcp-versioning-and-surface-governance).

## Tiers

The MCP surface is split into four tiers. Callers filter via the
`tools/list` params `catalog`, `include`, `advanced`, or `tier` (see
[docs/integrations/mcp.md](../integrations/mcp.md)).

| Tier         | Use                                     | Stability guarantee                                      |
|--------------|-----------------------------------------|----------------------------------------------------------|
| `facade`     | `bclaw_work`, `bclaw_coordinate`, `bclaw_loop`, … | **Public, stable.** Breaking changes require a schema major bump. |
| `standard`   | Common CRUD + read tools                | **Public, stable.** Same rules as facade.                |
| `advanced`   | Low-level ops used by specialised flows | **Public, evolving.** Breaking changes require a minor bump + deprecation warning. |
| `internal`   | Build-only, test fixtures, experimental | **Unstable.** No compatibility guarantees — can change between patch releases. |

`facade + standard` are the default `tools/list` output. `advanced`
must be opted-into. `internal` is never returned by `tools/list`.

A tool's tier is declared at registration time in
`src/commands/mcp.ts`. Moving a tool between tiers is itself a
contract change — moving *up* (e.g., advanced → standard) is safe,
moving *down* (standard → advanced) requires a deprecation window.

## What counts as a breaking change

Anything that can cause a previously-working MCP client call to fail
or return a differently-shaped response. Concretely:

- **Tool surface**
  - Removing a tool.
  - Renaming a tool.
  - Adding a required input argument.
  - Changing an argument's type, enum values, or shape.
  - Tightening validation in a way that rejects previously-accepted inputs.
  - Moving a tool to a lower tier (e.g., standard → advanced or removed from default catalog).

- **Response shape**
  - Removing a field from `structuredContent`.
  - Renaming a field.
  - Changing a field's type (string → object, array → scalar).
  - Changing the meaning of an existing enum value.

- **Behaviour**
  - Changing a tool's error model (new exit codes, new error shapes callers might pattern-match on).
  - Changing default values in a way that flips a downstream decision (e.g., `openLoop: true` becoming the default when it was `false`).
  - Removing or renaming env vars that affect tool behaviour (`BRAINCLAW_*`).

**Non-breaking additions** (safe at any time):

- Adding a new tool in any tier.
- Adding a new **optional** argument.
- Adding a new field to `structuredContent`.
- Loosening validation (accepting a superset of previous inputs).
- Moving a tool to a higher tier.

## Schema versioning rules

`SCHEMA_VERSION` in `src/commands/mcp.ts` tracks the MCP *protocol*
version — distinct from the `package.json` app version which follows
app evolution. A call to `initialize` returns this in `serverInfo.version`
and every tool response includes it in `schema_version`.

Semver interpretation:

| Bump      | Allowed changes                                             | Required artefacts                                   |
|-----------|-------------------------------------------------------------|------------------------------------------------------|
| **patch** (`x.y.Z`) | Bug fixes, doc updates, internal refactors with no contract change | Changelog entry under "Fixed" |
| **minor** (`x.Y.0`) | Non-breaking additions (new tools, optional args, new response fields). `advanced`-tier breaking changes *with* a deprecation window. | Changelog entry under "Added" / "Changed". Deprecation warnings for `advanced` changes. |
| **major** (`X.0.0`) | Breaking changes on `facade`/`standard` tiers. Removal of any deprecated tool. Schema rename/rework. | Changelog entry under "Removed" / "Breaking". Migration guide. Clients expect to update. |

Public stability guarantees apply from `1.0.0` onward (the Phase 3
canonical grammar refactor, `pln_c6472192`). Subsequent v1.x releases
follow the rules above strictly.

## Deprecation policy

A tool slated for removal goes through a deprecation window, not a
silent drop. Pattern:

1. **Mark deprecated.** Add an entry in `LEGACY_MCP_TOOL_WARNINGS`
   (`src/commands/mcp.ts`) with a short message pointing at the
   replacement. Tool keeps working. Changelog entry under "Deprecated".
2. **Surface the warning.** Every call to the tool during this window
   returns a `warning` in `structuredContent` and stderr. Warnings are
   not errors — callers continue to work.
3. **Minimum compatibility window.**
   - `facade`/`standard` tier tools: at least **two minor releases**
     with warnings before removal.
   - `advanced` tier tools: at least **one minor release**.
   - `internal` tools: no window required.
4. **Removal.** Allowed only on a major bump. Changelog entry under
   "Removed" with the replacement path.

Deprecation warnings must name the replacement. "Deprecated, use X
instead" — no orphan deprecations.

## Changelog discipline

`docs/mcp-schema-changelog.md` is the single source of truth for MCP
protocol changes. Conventions:

- One section per released version (`## x.y.z`). The current in-flight
  version is marked `(current)` until it ships; the marker moves on
  release.
- Subsections in this order:
  - `**Added**` — new surface.
  - `**Changed**` — modifications to existing surface (non-breaking
    unless flagged).
  - `**Deprecated**` — tools entering the deprecation window.
  - `**Removed**` — tools or fields gone.
  - `**Fixed**` — bug fixes that may affect behaviour.
  - `**Breaking**` — any breaking change, called out explicitly. Must
    map to a major bump.
- Every changelog entry must name the tool and/or field it touches,
  so a client maintainer can grep for references.
- `SCHEMA_VERSION` constant in `src/commands/mcp.ts` must match the
  latest released version in this changelog. A mismatch is a bug —
  bump the constant or amend the changelog, but do not ship drift.

## Enforcement guard

`tests/unit/mcp-governance.test.ts` computes a stable fingerprint of
the published MCP surface from `src/commands/mcp.ts`:

- tool name
- tier
- category
- input schema with descriptions stripped

The test requires the current section of
`docs/mcp-schema-changelog.md` to include that fingerprint. If a
public tool is added, removed, moved between tiers, or has its input
contract changed, the test fails until the changelog is updated.

This guard is intentionally advisory-by-test rather than a runtime
block. It catches contract drift in CI and local validation without
preventing operators from using `brainclaw doctor` during active
development.

## Schema source-of-truth — zod-derived inputSchemas

MCP tool `inputSchema` blocks in `src/commands/mcp.ts` are JSON Schema.
The runtime validation that actually rejects bad calls lives in zod
schemas elsewhere (e.g. `src/core/loops/types.ts`,
`src/core/loops/facade-schema.ts`). When the same shape is expressed
twice — once as zod, once as hand-written JSON Schema — the two drift,
silently. The class is the same one flagged by
`feedback_cross_agent_patterns` rule 2 ("catalog source-of-truth >
hardcoded constants"); it produced `trp#180` in May 2026 (Copilot
rejected `bclaw_loop` because `phases`/`slots` arrays had no `items`,
which Claude Code's permissive validator had silently accepted).

The fix is to derive the JSON Schema from the zod source at build time
and commit the generated artifact. Hand-written schemas remain for tools
without a zod backing (intent-polymorphic dispatchers, etc.) and stay
protected by the strict CI test in
`tests/unit/mcp-input-schema-strict.test.ts`.

### How it works

1. Zod schemas are exported from their owning module (e.g.
   `LoopPhaseSchema`, `LoopSlotInputSchema`).
2. `scripts/build-mcp-schemas.mjs` reads the compiled zod from `dist/`
   and emits `src/commands/mcp-schemas.generated.ts` via zod v4's
   native `z.toJSONSchema()`.
3. `src/commands/mcp.ts` imports `generatedSchemas` and uses the
   generated objects inline as `items:` / sub-schemas inside the tool's
   `inputSchema`.
4. The migrated tool descriptor carries
   `annotations.schemaSource: 'zod-derived'` as a grep-target marker.
5. `tests/unit/mcp-zod-parity.test.ts` re-runs `z.toJSONSchema()` at
   test time and deep-compares against the committed generated file.
   Drift fails CI with a one-line fix instruction.

The generated file is committed (protobuf pattern). Developers run
`npm run build:mcp-schemas` after editing a zod schema and commit the
regen alongside their source change. CI then verifies parity.

### How to migrate a tool to zod-derived schemas

Use this checklist when you touch a tool's source for any reason. Do
**not** mass-migrate in a dedicated PR — the regression risk on the
combined diff outweighs the cleanup benefit.

1. **Identify the zod schema.** Locate the existing zod that the
   handler validates against (or extract a partial form for input-only
   shapes — see `LoopSlotInputSchema` for the precedent).
2. **Export it** as a named symbol so the build script can import it
   from `dist/`.
3. **Add the generation entry** in `scripts/build-mcp-schemas.mjs`
   under the `SCHEMAS` map.
4. **Run** `npm run build:mcp-schemas`. Inspect the diff in
   `src/commands/mcp-schemas.generated.ts` — it must be small,
   readable, and free of unwanted `$schema` / `$id` / `$defs` headers
   for sub-schemas you intend to inline.
5. **Replace the hand-written sub-schema** in `mcp.ts` with the
   generated reference (e.g. `items: generatedSchemas.LoopPhase`).
6. **Tag** the tool descriptor with
   `annotations.schemaSource: 'zod-derived'`. The annotation is
   informational today (see comment in `mcp.ts`); the parity test
   currently hardcodes its (tool, schema) pairs explicitly.
7. **Add an entry** to `tests/unit/mcp-zod-parity.test.ts` mirroring
   the pattern of `LoopPhase` / `LoopSlotInput`. The test exists to
   catch silent regen drift; it must include every newly migrated
   shape.
8. **Run the strict + parity tests** locally
   (`node --test dist-test/tests/unit/mcp-input-schema-strict.test.js
   dist-test/tests/unit/mcp-zod-parity.test.js`). Both must pass.

### When to skip the migration

Some inputSchemas should stay hand-written:

- **Intent-polymorphic surfaces.** Tools whose `inputSchema` is a flat
  union of intents (`bclaw_work`, `bclaw_coordinate`) where each
  intent permits a different field set. zod can express this via
  `discriminatedUnion`, but `z.toJSONSchema()` produces verbose
  `oneOf` blocks that are harder to read than the hand-written
  flat-properties form. The strict CI test (Phase 1) still protects
  these.
- **Tools without a zod handler at all.** Some adapters and admin
  utilities validate manually. Migrating them just to satisfy the
  pattern would add zod definitions for shapes that have no other
  consumer.
- **Build-time-only or developer-only tools.** No external client
  reads their schema; drift cost is bounded.

### Adding a new tool

For tools added _after_ Phase 2 of `pln#494`, the default is
zod-derived. Skip the hand-written sub-schemas entirely:

1. Define the zod input schema in the owning module.
2. Export it.
3. Add it to the `SCHEMAS` map in `scripts/build-mcp-schemas.mjs`.
4. Run `npm run build:mcp-schemas` and reference the generated entry
   in your tool descriptor.
5. Add the parity test entry.

The strict CI test still runs and validates the generated output —
defense in depth.

## Changelog → code cross-check

Quick command to verify `SCHEMA_VERSION` matches the changelog:

```bash
node -e "import('./dist/commands/mcp.js').then(m => console.log(m.SCHEMA_VERSION))"
head -5 docs/mcp-schema-changelog.md
```

Both should report the same version. Drift = bug.

Quick command to inspect the current public-surface fingerprint:

```bash
node --test dist-test/tests/unit/mcp-governance.test.js
```

If the test fails, copy the reported fingerprint into the current
`docs/mcp-schema-changelog.md` section and describe the surface change.
