; Code Map — Rust imports (imports.scm). Provider #6 (langs batch 2).
;
; enclosingStatementNodeTypes = [use_declaration] (the import span/ordinal anchor).
; Rust `use` paths are bare `a::b::c` (NO quotes) so — unlike Go — nothing to strip,
; and the common use-tree shapes expand STRUCTURALLY in the query (no refine()):
;   use a::b::c;            -> module a::b::c
;   use foo;                -> module foo
;   use a::b::{c, d};       -> module a::b   + imported names c, d   (group-use)
;   use a::b as c;          -> module a::b   + imported name  c      (alias)
;   use a::b::*;            -> module a::b   + imported name  '*'     (wildcard)
; Grouping is keyed by the captured @import.source NODE (query-runtime), so the two
; matches a `{c, d}` list produces share one source node -> one module with names
; [c, d].
;
; v1 limitations (documented, not bugs): NESTED use-trees `use a::{b, c::{d}}` capture
; only the top path `a` + the direct-identifier members (the nested `c::{…}` subtree
; is dropped); `use a::{self, b}` drops the `self`; `pub use` re-exports are treated
; as plain imports (NO exports edge — Rust re-export modelling deferred, capabilities
; declare T2 imports only).

; use a::b::c;  /  use foo;  (direct scoped/plain path is the module source)
(use_declaration
  argument: [
    (scoped_identifier)
    (identifier)
  ] @import.source)

; use a::b::{c, d};  -> source a::b, imported names c, d
(use_declaration
  argument: (scoped_use_list
    path: [(scoped_identifier) (identifier)] @import.source
    list: (use_list (identifier) @import.named.name)))

; use a::b as c;  -> source a::b, imported name c
(use_declaration
  argument: (use_as_clause
    path: [(scoped_identifier) (identifier)] @import.source
    alias: (identifier) @import.named.name))

; use a::b::*;  -> source a::b, imported name '*'
(use_declaration
  argument: (use_wildcard
    [(scoped_identifier) (identifier)] @import.source
    "*" @import.namespace.name))
