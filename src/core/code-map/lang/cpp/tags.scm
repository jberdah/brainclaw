; Code Map — C++ definitions (tags.scm). Provider #? (langs batch 2).
;
; Capture-name convention (query-runtime.ts is the contract):
;   @definition.<subtype>.node = identity-span anchor (the declaration)
;   @definition.<subtype>.name = the symbol name node
; Subtypes are all UNIVERSAL: class/enum/namespace/function/method/macro/type
; (a C++ struct maps to `class` — the named aggregate devs search for like a class;
; `enum` and `enum class` both map to `enum`).
;
; DOUBLE-MATCH avoidance (the CRITICAL rule): a `*_specifier` node is emitted by
; tree-sitter-cpp BOTH where a type is DEFINED and where it is merely USED as a
; type (`struct Point p;`, `friend class Bar;`, `enum Color c;`). Requiring
; `body: (_)` restricts each class/struct/enum pattern to the DEFINITION site, so a
; type is captured exactly once (and use-sites/forward-decls are never mis-emitted).
; struct→class and class→class share the `class` subtype but are distinct grammar
; nodes, so they never co-match the same node.
;
; TEMPLATES are transparent: `template <...> class/struct/function` wraps the inner
; specifier/definition, which the same patterns below capture directly (the
; template_declaration wrapper carries no name of its own).
;
; FUNCTIONS anchor on `function_declarator` (the canonical tree-sitter-cpp shape),
; NOT `function_definition`: this makes name capture immune to return-type
; declarator wrapping (`int* f()`, `int& f()`, trailing-return `auto f() -> T`) and
; keeps @node/@name in one match. The declarator's inner name node is mutually
; exclusive per function_declarator, so the three function/method patterns can never
; co-match the same node:
;   identifier            -> function  (free functions; also file-scope prototypes)
;   field_identifier      -> method    (in-class method decls / inline defs)
;   qualified_identifier  -> method    (out-of-line member defs `Foo::bar`, name text
;                                        is the fully-qualified path)
; This means a member declared in-class AND defined out-of-line surfaces as TWO
; method symbols (`bar` + `Foo::bar`) at distinct spans — accepted for v1 (aids
; discovery, never a duplicate id). SCOPED OUT of v1: fields/member variables, enum
; constants (enumerators), constructors/destructors/operators (their names are not
; plain identifier/field_identifier/qualified_identifier nodes), and pointer-wrapped
; typedefs — documented, low value, and kept out to avoid noise.

; --- Aggregates (require `body:` = DEFINITION site only) ---
(class_specifier
  name: (type_identifier) @definition.class.name
  body: (_)) @definition.class.node

(struct_specifier
  name: (type_identifier) @definition.class.name
  body: (_)) @definition.class.node

(enum_specifier
  name: (type_identifier) @definition.enum.name
  body: (_)) @definition.enum.node

; Named namespaces only (anonymous namespaces have no `name:` and are skipped). The
; name is a single `namespace_identifier` or, for `namespace a::b { }`, a
; `nested_namespace_specifier` whose text is the joined path `a::b`.
(namespace_definition
  name: [(namespace_identifier) (nested_namespace_specifier)] @definition.namespace.name) @definition.namespace.node

; --- Functions / methods (anchor on function_declarator; see header) ---
(function_declarator
  declarator: (identifier) @definition.function.name) @definition.function.node

(function_declarator
  declarator: (field_identifier) @definition.method.name) @definition.method.node

(function_declarator
  declarator: (qualified_identifier) @definition.method.name) @definition.method.node

; --- Macros ---
(preproc_def
  name: (identifier) @definition.macro.name) @definition.macro.node

(preproc_function_def
  name: (identifier) @definition.macro.name) @definition.macro.node

; --- Type aliases: `typedef T Name;` and `using Name = T;` ---
(type_definition
  declarator: (type_identifier) @definition.type.name) @definition.type.node

(alias_declaration
  name: (type_identifier) @definition.type.name) @definition.type.node
