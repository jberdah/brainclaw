# TypeScript provider — curated tree-sitter query assets

`tags.scm` and `imports.scm` are **curated, vendored** tree-sitter queries for the
`tree-sitter-typescript`, `tree-sitter-tsx`, and `tree-sitter-javascript` grammars
(WASM vendored under `dist/wasm/`). They are authored and maintained **here** — they
are NOT copied from the grammars' upstream `queries/tags.scm` (whose capture names and
scope differ). The Code Map query-runtime depends on the exact capture-name convention
below; do not swap in upstream assets.

These assets feed the generic, query-driven runtime (spec §7). They are sha256-hashed
and copied into `dist/` by the build (mirroring `copy-code-map-wasm.mjs`); editing an
asset changes its hash, which folds into `extractor_config_hash` and flips affected
shards to `stale_extractor`. The hashing/build wiring lands in a later sprint — these
files are the source-of-truth content only.

## Capture-name convention

Every capture name encodes both its role and the draft field it maps to. The runtime's
`captureMap` translates captures into `DefinitionDraft` / `ImportDraft` / `ExportDraft`
fields. Last-wins per node for duplicate captures (deterministic).

### `tags.scm` — definitions

`@definition.<subtype>.<role>`

| Capture | Role | Maps to |
| --- | --- | --- |
| `@definition.<subtype>.node` | the declaration node | `DefinitionDraft.span` (legacy IDENTITY span = enclosing declaration statement) |
| `@definition.<subtype>.name` | the identifier | `DefinitionDraft.name` |
| `@definition.<subtype>.exported` | wrapping `export_statement` | presence ⇒ `DefinitionDraft.exported = true` (a node flag, NOT an `exports` edge) |

`<subtype>` ∈ `function | class | type | interface | variable` — the **structural**
subtype only. React `component` (PascalCase + returns JSX) and `hook` (`/^use[A-Z0-9]/`)
reclassification happens in the provider's `refine()` pass, because JSX-body inspection
is beyond what a static query can express. The runtime emits one definition per
declarator name; multi-declarator statements (`const a = 1, b = 2`) share one
`@definition.variable.node` span (legacy identity parity).

> **Grammar coverage — `tags.scm` is NOT JavaScript-safe.** `tags.scm` references
> TypeScript-only node types (`type_alias_declaration`, `interface_declaration`, and
> `type_identifier` for class/type/interface names), so it compiles against the
> `typescript` and `tsx` grammars but **fails to compile against the `javascript`
> grammar** (`tree-sitter` rejects the whole query with `Bad node name
> 'type_identifier'`). Per spec §86 a query that fails to compile is a fatal error,
> so the query-runtime/provider MUST select a JS-compatible definition subset (a
> separate JS query or a stripped variant) for `.js` files — `tags.scm` cannot be
> handed verbatim to the JS grammar. `imports.scm` compiles against all three
> grammars. This contract is pinned by `tests/unit/code-map/query-assets-compile.test.ts`.

### `imports.scm` — imports, re-exports, exports

| Capture | Maps to |
| --- | --- |
| `@import.source` | `ImportDraft.source` (string-fragment text; runtime strips quotes) + anchors `ImportDraft.span` |
| `@import.default.name` | source-side imported name `"default"` |
| `@import.namespace.name` | source-side imported name `"*"` |
| `@import.named.name` | source-side imported name = specifier `name:` field (NOT the alias) |
| `@export.name` | `ExportDraft.name` — a local `export { a }` clause or `export default <ident>` |

A re-export (`export { a } from 'm'`, `export * from 'm'`) match surfaces BOTH
`@import.source` and the named/`*` captures; `refine()` routes on source presence to
build a module node + `imports` edge with no phantom symbol. `export * from 'm'` carries
no named capture, so the runtime supplies `"*"` for the imported names.

## Scope / parity notes (P1a)

- TOP-LEVEL declarations only — no methods, no nested defs (matches the legacy extractor).
- `importedNames` are **source-side**: default → `"default"`, namespace → `"*"`, named →
  specifier `name` (not alias).
- Declaration exports (`export function/class/type/interface`, exported lexical) set the
  `exported` node flag only — no `exports` edge. Only `export { a }` clauses and
  `export default <identifier>` emit an `exports` edge; `export … from` / `export *`
  emit a module node + `imports` edge.
- These assets emit only the existing universal subtypes/edge kinds — no new vocabulary.

## Grounding

Node-type names (`function_declaration`, `class_declaration`, `type_alias_declaration`,
`interface_declaration`, `lexical_declaration`/`variable_declaration` →
`variable_declarator`, `import_statement` → `import_clause` / `named_imports` /
`import_specifier` / `namespace_import`, `export_statement` → `export_clause` /
`export_specifier` / `namespace_export`, `string` → `string_fragment`) are confirmed
against the legacy `extractor.ts` traversal this provider replaces and verified to
compile against the live grammars by `query-assets-compile.test.ts`. NOTE the TS-only
node types (`type_alias_declaration`, `interface_declaration`, `type_identifier`) exist
in `tree-sitter-typescript`/`tree-sitter-tsx` but NOT in `tree-sitter-javascript` — see
the JavaScript-safety callout above.
