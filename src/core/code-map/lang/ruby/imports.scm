; Code Map — Ruby imports (imports.scm). Provider #6 (langs batch 2).
;
; Ruby has NO static import statement — `require` / `require_relative` are METHOD
; CALLS. So the "import" is a (call) whose `method:` is the identifier `require` or
; `require_relative` and whose single string argument is the required module/path.
;
; enclosingStatementNodeTypes = ['call'] (the require call is the import span/ordinal
; anchor). The captured @import.source is the STRING literal node; its text includes
; the surrounding quotes (`'sinatra'` / `"json"`), which the query-runtime strips
; automatically (stripQuotes) — and the provider's refine() strips again defensively
; (idempotent), matching the Go provider's documented pattern. Best-effort T2: the
; module node `name` is the required string verbatim (`sinatra`, `json`, `./helpers`);
; there is no path resolution (T3 = none).
;
; The `#any-of?` predicate restricts the match to require-family calls (verified:
; web-tree-sitter 0.25.x applies text predicates inside `matches()`, so ordinary
; calls like `puts "x"` / `foo.bar('y')` are filtered out and never emit a module
; node). @_req is a predicate-only capture — the runtime ignores it (only
; @import.source drives an ImportDraft).

(call
  method: (identifier) @_req
  arguments: (argument_list (string) @import.source)
  (#any-of? @_req "require" "require_relative"))
