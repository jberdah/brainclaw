; Code Map — Ruby definitions (tags.scm). Provider #6 (langs batch 2).
;
; Capture-name convention (query-runtime.ts is the contract):
;   @definition.<subtype>.node = identity-span anchor (the declaration)
;   @definition.<subtype>.name = the symbol name node
;
; Subtype mapping (verified against tree-sitter-ruby via dogfood):
;   class   -> class      (name: a (constant))
;   module  -> namespace  (name: a (constant); Ruby modules are namespaces/mixins)
;   method (def ...)          -> method  (name: any node — identifier/operator/setter)
;   singleton_method (def self.x) -> method  (always a member method)
;   constant assignment (FOO = ...) -> constant  (left is a bare (constant))
;
; TOP-LEVEL vs CLASS/MODULE def: `method` is captured UNIFORMLY as
; @definition.method (like Python captures every function_definition as function).
; The provider's refine() reclassifies a `method` whose enclosing scope is NOT a
; class/module body (i.e. a top-level `def`, or a def nested in another def/block)
; to `function` — mirroring Python's module-level-function analog. `singleton_method`
; stays `method` regardless of location (def self.x is a member method by intent).
; refine() must do this because the structural query cannot inspect the enclosing
; scope chain (query-runtime nests every def under a `body_statement`).
;
; The method `name:` field is captured with `(_)` (any node) so operator/setter
; methods (`def <=>`, `def []`, `def foo=`) are captured too, not just identifiers.
;
; NAMESPACED constant assignments (`Foo::BAR = 1`, left is a `scope_resolution`,
; NOT a bare `constant`) are intentionally NOT captured in v1 — low value and the
; bare-constant pattern below deliberately does not match them.

(class
  name: (constant) @definition.class.name) @definition.class.node

(module
  name: (constant) @definition.namespace.name) @definition.namespace.node

; def foo / def <=> / def foo= — captured uniformly; refine() may narrow a
; non-class/module-body method to `function`.
(method
  name: (_) @definition.method.name) @definition.method.node

; def self.foo — a singleton (class-level) method; always `method`.
(singleton_method
  name: (_) @definition.method.name) @definition.method.node

; FOO = ... — a constant assignment (left is a bare constant). Captured at ANY depth
; (top-level, class body, module body) — a Ruby constant is a meaningful symbol
; wherever it is declared (parity with Go's const capture).
(assignment
  left: (constant) @definition.constant.name) @definition.constant.node
