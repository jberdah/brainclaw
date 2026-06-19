# Python provider — curated tree-sitter query assets

`tags.scm` (definitions) and `imports.scm` (imports) are **curated, vendored**
tree-sitter queries for the `tree-sitter-python` grammar (WASM vendored from the
`tree-sitter-wasms` devDep, copied into `dist/wasm/` by the build). They are authored
and maintained **here** — NOT copied from the grammar's upstream `queries/tags.scm`
(whose capture names and scope differ). The Code Map query-runtime
(`lang/query-runtime.ts`) hard-codes the exact capture-name convention below; do not
swap in upstream assets.

These assets feed the generic, query-driven runtime. They are sha256-hashed and copied
into `dist/` by the build (mirroring the TS provider); editing an asset changes its
hash, which folds into `extractor_config_hash` and flips affected Python shards to
`stale_extractor`.

## Capture-name convention (THE contract)

The runtime drives capture → draft mapping directly off the hard-coded convention; the
provider's `captureMap` is a declared **mirror** of it (validated by
`assertCaptureMapConforms`), not the driver. Name captures exactly per this convention.

### `tags.scm` — definitions  (`@definition.<subtype>.<role>`)

| Capture | Role | Maps to |
| --- | --- | --- |
| `@definition.<subtype>.node` | the declaration node | `DefinitionDraft.span` — the **identity span** |
| `@definition.<subtype>.name` | the identifier | `DefinitionDraft.name` (+ ordinal anchor) |
| `@definition.<subtype>.exported` | — | **unused for Python** (no export statement; never emitted) |

Structural subtypes emitted here: **`function` · `class` · `variable`**. The provider's
`refine()` pass derives the rest (it cannot be expressed by a static query):

| Source construct | Emitted by query | `refine()` result |
| --- | --- | --- |
| top-level `def` / `async def` | `function` | `function` |
| nested `def` (inside a function body) | `function` | `function` |
| `def` directly in a `class_definition` body | `function` | `method` |
| `@property` method | `function` | `property` |
| `@staticmethod` / `@classmethod` method | `function` | `method` |
| `class` | `class` | `class` |
| module-level `X = …` / `X: T = …` | `variable` | `variable` |
| module-level `UPPER_CASE = …` | `variable` | `constant` |

`function_definition` is captured **uniformly** as `@definition.function` regardless of
depth; `refine()` inspects the enclosing-scope chain (method-vs-function) and the
decorators (property/method) — neither is visible to the query. `async def` is the same
`function_definition` node (async is a keyword child), so async-ness is
**classification-only and NOT persisted** (there is no durable-attribute field — spec §5).

**Identity span vs name span.** Every `@definition.*.node` anchors on the **inner**
`function_definition` / `class_definition`, never on a `decorated_definition` wrapper, so
a decorated def's identity span **excludes its decorators** (spec §5). The same single
pattern matches both the bare and the decorated form (the inner node is identical in both
trees). `@definition.*.name` is the identifier node (`nameSpan`). Decorators are
otherwise non-emitting syntax (they produce no node).

Module-level variables are anchored under the `module` root so only top-level assignments
become symbols; class/instance attributes and locals are not. An `(ERROR …)`-rooted
recovery clause mirrors the def/class patterns (parity with the TS asset) so top-level
symbols in an error-recovered file are not silently dropped.

### `imports.scm` — imports  (T2 specifiers)

| Capture | Maps to |
| --- | --- |
| `@import.source` | `ImportDraft.source` (verbatim module text) + anchors `ImportDraft.span` |
| `@import.named.name` | a source-side imported name (`from x import NAME`; `*` for wildcard) |
| `@import.default.name` | unused for Python |
| `@import.namespace.name` | unused for Python |

**Multi-source aware** (spec §3.3 / §6): the runtime groups module nodes **per captured
`@import.source` node**, not per enclosing statement.

| Source construct | Module node(s) | `imported_names` (source-side) |
| --- | --- | --- |
| `import x` / `import x.y` | `x` / `x.y` | (none) |
| `import a, b` | `a` **and** `b` (two nodes) | (none each) |
| `import x as y` | `x` (alias ignored) | (none) |
| `from x import a, b` | `x` | `a`, `b` |
| `from x import a as c` | `x` | `a` (alias ignored) |
| `from x import *` | `x` | `*` |
| `from . import z` | `.` (dots verbatim) | `z` |
| `from ..pkg import a, b` | `..pkg` (dots verbatim) | `a`, `b` |
| `from .pkg import *` | `.pkg` | `*` |

`import a, b` is one statement with two `name:` children → two `@import.source` captures
→ two module nodes. A `from x import a, b` statement has one `module_name` source captured
once per imported `name:` child across N matches; the runtime accumulates the names onto
the single source node (keyed by node id). **Relative imports keep their leading dots
verbatim** (`.`, `..pkg`) — the `relative_import` node's text IS how the relative level
survives without a durable-attribute field (spec §6); P1c resolution consumes the dots.

## Scope / parity notes (P1b)

- **Definitions:** top-level + nested defs + class methods (a capability ADD over the
  JS/TS top-level-only asset). Methods are classified by `refine()` from the
  enclosing-scope chain; method identity is the standard finalizer id
  (path+lang+subtype+name+start_line+start_col) — no qualified names.
- **Imports:** specifiers only (T2). Import **resolution** is P1c (`resolveImport` stays
  declared-unused). `__all__` / package semantics / `.pyi` are out of scope.
- **Exports:** Python has no export statement — this provider emits **none**.
- **Durable attributes:** none. `async`, decorators, and relative-level are encoded as
  classification (subtype) or as the verbatim source string, never as a persisted
  attribute (no schema field exists).
- These assets emit only the existing universal subtypes/edge kinds — no new vocabulary.

## Grounding

Node-type / field names used here (`function_definition`/`class_definition`
`name: (identifier)`; `decorated_definition` wrapper excluded by anchoring on the inner
def; `expression_statement` → `assignment` `left: (identifier)` under `module`;
`import_statement` `name: (dotted_name)` / `name: (aliased_import name: (dotted_name))`;
`import_from_statement` `module_name: (dotted_name) | (relative_import)`,
`name: (dotted_name) | (aliased_import …)`, `(wildcard_import)`) are grounded in the
`tree-sitter-python` grammar. They are verified to **compile** against the live grammar
by the query-assets compile test, and the emitted fact set is cross-checked against
Python's own `ast` module by the Python `ast`-oracle test (defs/classes/methods/imports —
not spans/ids).
