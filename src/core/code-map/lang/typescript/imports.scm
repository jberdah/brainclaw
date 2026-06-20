; Brainclaw Code Map — TypeScript/TSX/JavaScript IMPORTS + EXPORTS query (curated, vendored).
; See ./README.md for the capture-name convention and provenance.
;
; Capture -> draft mapping performed by the query-runtime:
;   @import.source            -> ImportDraft.source (string literal text; quotes stripped
;                                by the runtime). The @import.source node ALSO anchors the
;                                ImportDraft.span = enclosing import/export statement span.
;   @import.default.name      -> contributes source-side imported name "default"
;   @import.namespace.name    -> contributes source-side imported name "*"
;   @import.named.name        -> contributes source-side imported name = specifier `name`
;                                (NOT the local alias)
;   @export.name              -> ExportDraft.name (a re-export / mark-or-add export target)
;
; This asset covers: `import` statements, `export { ... }` clauses (no source),
; `export ... from '...'` / `export * from '...'` re-exports (WITH source), and
; `export default <identifier>`. Declaration exports (`export function/class/...`) are
; NOT handled here — they are definitions and carry their `exported` flag from tags.scm.
;
; Re-export source detection is the discriminator the provider's refine() uses to build
; a module node (no phantom symbol) vs. a local `export {a}` mark-or-add. The runtime
; surfaces both @import.source and @export.name on a re-export match; refine() routes
; on source presence.

; ===========================================================================
; IMPORT STATEMENTS
; ===========================================================================

; bare side-effect import:  import 'm';
(import_statement
  source: (string (string_fragment) @import.source))

; default import:  import def from 'm';
(import_statement
  (import_clause (identifier) @import.default.name)
  source: (string (string_fragment) @import.source))

; namespace import:  import * as ns from 'm';
(import_statement
  (import_clause (namespace_import (identifier) @import.namespace.name))
  source: (string (string_fragment) @import.source))

; named imports:  import { a, b as c } from 'm';
; `name:` is the source-side specifier name (`a`, `b`) — the alias (`c`) is the
; `alias:` field and is deliberately NOT captured (importedNames are source-side).
(import_statement
  (import_clause
    (named_imports
      (import_specifier
        name: (identifier) @import.named.name)))
  source: (string (string_fragment) @import.source))

; ===========================================================================
; RE-EXPORTS WITH A SOURCE MODULE  (export { a } from 'm';  export * from 'm';)
; These carry @import.source so refine() builds a module node + imports edge.
; ===========================================================================

; export { a, b as c } from 'm';  -> source-side names a, b
(export_statement
  (export_clause
    (export_specifier
      name: (identifier) @import.named.name))
  source: (string (string_fragment) @import.source))

; export * from 'm';  (no export_clause) -> the runtime supplies "*" for the names
(export_statement
  "*"
  source: (string (string_fragment) @import.source))

; export * as ns from 'm';  -> namespace re-export
(export_statement
  (namespace_export (identifier) @import.namespace.name)
  source: (string (string_fragment) @import.source))

; ===========================================================================
; LOCAL EXPORT CLAUSES  (export { a, b as c };  no source module)
; -> @export.name per source-side specifier name; refine() does mark-or-add-export.
; ===========================================================================
(export_statement
  (export_clause
    (export_specifier
      name: (identifier) @export.name))
  !source)

; ===========================================================================
; DEFAULT EXPORT OF AN IDENTIFIER  (export default foo;)
; -> @export.name = the referenced identifier; refine() links it if it names a symbol.
; ===========================================================================
(export_statement
  "default"
  (identifier) @export.name)
