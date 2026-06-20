; Code Map — PHP imports (imports.scm). Provider #3 (langs#3-4).
;
; enclosingStatementNodeTypes = [namespace_use_declaration] (provider declaration);
; that statement is the import span/ordinal anchor. PHP `use` brings a namespaced
; symbol/module into scope; the source-side path is the module specifier.
;
;  - simple / comma / `use function` / `use const`: each clause's qualified_name
;    (or bare name) is the full source path → captured directly as @import.source.
;    Aliases (`use A\B as C`) are dropped (we capture the path, not the alias) —
;    Codex R1.
;  - GROUP use (`use A\{B, C as Bee}`): no single tree node carries the full
;    `A\B` (the prefix `A` and the leaf `B` are separate nodes — Codex R1). We
;    capture each group clause's leaf name here; the provider's refine() prepends
;    the group prefix to synthesize the full source path.
;  - include/require are OUT of scope (dynamic/runtime, not static specifiers).

(namespace_use_clause [(qualified_name) (name)] @import.source)

; Group clauses only ever carry a `namespace_name` (which itself spans
; backslash-separated paths, e.g. `B\C`); `qualified_name` is not a valid child here.
(namespace_use_group_clause (namespace_name) @import.source)
