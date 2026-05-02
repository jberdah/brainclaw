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
