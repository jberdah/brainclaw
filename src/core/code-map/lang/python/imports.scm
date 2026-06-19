; Brainclaw Code Map — Python IMPORTS query (curated, vendored).
; Grammar: tree-sitter-python. See ./README.md for the capture-name convention.
;
; Python has NO export statement, so this asset emits imports ONLY (no @export.name).
; Capabilities declare T2.imports = complete (specifiers); resolution is P1c.
;
; Capture -> draft mapping performed by the generic query-runtime:
;   @import.source       -> ImportDraft.source (the runtime strips surrounding quotes;
;                           Python module names are bare identifiers/dotted_names, so
;                           there is nothing to strip — the text passes through verbatim,
;                           which is exactly what relative-import dots `.` / `..pkg`
;                           need). ALSO anchors ImportDraft.span = enclosing
;                           import_statement / import_from_statement.
;   @import.named.name   -> a source-side imported name (the `from x import NAME` target,
;                           NOT the local alias; `*` for a wildcard import)
;   @import.default.name -> (unused for Python — no default-import concept)
;   @import.namespace.name -> (unused for Python — `import x as y` is a source-side
;                           module node, not a namespace specifier)
;
; MULTI-SOURCE awareness (spec §3.3 / §6): the runtime groups module nodes PER captured
; @import.source NODE, not per enclosing statement. So `import a, b` — one statement with
; two `name:` children — yields TWO @import.source captures and therefore TWO module
; nodes. For a `from x import a, b` statement the single module_name source node is
; captured once per imported `name:` child across N matches; the runtime accumulates all
; the names onto the one source node (keyed by node id). The span/ordinal stay anchored
; on the enclosing statement.

; ===========================================================================
; `import` STATEMENTS   (import x / import x.y / import a, b / import x as y)
; ===========================================================================

; import x   /   import x.y   /   import a, b
; Each `name:` child that is a bare dotted_name is one module source. A multi-source
; statement (`import a, b`) has multiple `name:` children => multiple matches =>
; multiple @import.source captures => multiple module nodes.
(import_statement
  name: (dotted_name) @import.source)

; import x as y   ->   source-side module is `x`; the alias `y` is ignored (imported
; names are source-side). Capture the INNER dotted_name only (NOT the aliased_import).
(import_statement
  name: (aliased_import
    name: (dotted_name) @import.source))

; ===========================================================================
; `from … import …` STATEMENTS
; ===========================================================================

; from x import a   /   from x.y import a, b
; One match per imported `name:` child; all share the single module_name source node,
; so the runtime accumulates a, b onto module `x` (grouped by source-node id).
(import_from_statement
  module_name: (dotted_name) @import.source
  name: (dotted_name) @import.named.name)

; from x import a as c   ->   source-side imported name is `a` (alias `c` ignored).
(import_from_statement
  module_name: (dotted_name) @import.source
  name: (aliased_import
    name: (dotted_name) @import.named.name))

; from x import *   ->   the wildcard_import node's text is `*`, captured as the name.
(import_from_statement
  module_name: (dotted_name) @import.source
  (wildcard_import) @import.named.name)

; ===========================================================================
; RELATIVE `from … import …`   (from . import z / from ..pkg import a, b / *)
;
; The relative_import node's TEXT is the verbatim specifier WITH its leading dots
; (`.`, `..`, `..pkg`) — that text IS how the relative-import level survives without a
; durable-attribute field (spec §6); P1c resolution consumes the dots. Capturing the
; relative_import node directly as @import.source preserves it verbatim.
; ===========================================================================

; from . import z   /   from ..pkg import a, b
(import_from_statement
  module_name: (relative_import) @import.source
  name: (dotted_name) @import.named.name)

; from .pkg import a as c
(import_from_statement
  module_name: (relative_import) @import.source
  name: (aliased_import
    name: (dotted_name) @import.named.name))

; from . import *
(import_from_statement
  module_name: (relative_import) @import.source
  (wildcard_import) @import.named.name)
