; Code Map — C definitions (tags.scm). Provider #6 (langs batch 2).
;
; Capture-name convention (query-runtime.ts is the contract):
;   @definition.<subtype>.node = identity-span anchor (the whole declaration)
;   @definition.<subtype>.name = the symbol name node
; Subtypes: function/type/enum/macro are universal; a named C struct maps to
; `class` (the named aggregate devs search for like a class); a union has no
; universal peer so it is provider-namespaced → `c.union`.
;
; C's function grammar is NESTED: a function_definition's name lives inside a
; `function_declarator declarator: (identifier)`, and that function_declarator is
; wrapped in one `pointer_declarator` PER `*` on the return type
; (`char *f()` → 1 level, `char **f()` → 2). Tree-sitter queries can't express
; arbitrary depth, so the `declarator:` field is an alternation covering 0..3
; pointer levels (covers all real C; 3 stars on a return type is already exotic).
;
; struct/union/enum REQUIRE a `body:` so only real DEFINITIONS are captured, never
; references. Without it, `typedef struct Point PointT;` (an aggregate REFERENCE)
; would double-capture a phantom `class:Point` at a second span. The named-aggregate
; struct DEFINITION inside a `typedef struct Foo {..} Bar;` still matches (it has a
; body) and coexists with the typedef's `type:Bar` — genuinely two named entities.

(function_definition
  declarator: [
    (function_declarator
      declarator: (identifier) @definition.function.name)
    (pointer_declarator
      (function_declarator
        declarator: (identifier) @definition.function.name))
    (pointer_declarator
      (pointer_declarator
        (function_declarator
          declarator: (identifier) @definition.function.name)))
    (pointer_declarator
      (pointer_declarator
        (pointer_declarator
          (function_declarator
            declarator: (identifier) @definition.function.name))))
  ]) @definition.function.node

(struct_specifier
  name: (type_identifier) @definition.class.name
  body: (field_declaration_list)) @definition.class.node

(union_specifier
  name: (type_identifier) @definition.c.union.name
  body: (field_declaration_list)) @definition.c.union.node

(enum_specifier
  name: (type_identifier) @definition.enum.name
  body: (enumerator_list)) @definition.enum.node

; typedefs are structurally varied; capture the declared name best-effort — the
; bare declared type_identifier and the `typedef char *Str;` pointer wrapping.
(type_definition
  declarator: (type_identifier) @definition.type.name) @definition.type.node

(type_definition
  declarator: (pointer_declarator
    declarator: (type_identifier) @definition.type.name)) @definition.type.node

; `#define NAME value` and `#define NAME(x) ...` are both macros (object-like and
; function-like); the name is the identifier in either case.
(preproc_def
  name: (identifier) @definition.macro.name) @definition.macro.node

(preproc_function_def
  name: (identifier) @definition.macro.name) @definition.macro.node
