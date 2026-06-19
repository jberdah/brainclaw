; Code Map — Java imports (imports.scm). Provider #4 (langs#3-4).
;
; enclosingStatementNodeTypes = [import_declaration] (provider declaration); that
; statement is the import span/ordinal anchor. Java import shapes (Codex R1):
;   import a.b.C;            -> module a.b.C
;   import a.b.*;            -> module a.b   + imported name '*'
;   import static a.b.C.m;   -> module a.b.C + imported name 'm'   (split type/member)
;   import static a.b.C.*;   -> module a.b.C + imported name '*'
;
; A single capture takes the scoped_identifier path verbatim (e.g. "a.b.C" or, for a
; wildcard import, the package "a.b" — the grammar puts the `*` in a sibling
; `asterisk` node, NOT inside scoped_identifier). The provider's refine() inspects
; each import_declaration for the `static` keyword and the `asterisk` sibling and
; rewrites source/imported-names accordingly (the static-split and wildcard rules
; can't be expressed structurally without overlapping matches).

(import_declaration [(scoped_identifier) (identifier)] @import.source)
