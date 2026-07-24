; Code Map — Go imports (imports.scm). Provider #5 (langs batch 2).
;
; enclosingStatementNodeTypes = [import_declaration] (the import span/ordinal
; anchor). Go import paths are double-quoted string literals, so the captured
; @import.source text includes the surrounding quotes — the provider's refine()
; strips them (and lifts an optional alias `import f "fmt"` → imported name `f`).
; One import_spec per imported package (Go groups them in an import_declaration
; but each path is its own spec → its own module node).

(import_spec
  path: (interpreted_string_literal) @import.source)
