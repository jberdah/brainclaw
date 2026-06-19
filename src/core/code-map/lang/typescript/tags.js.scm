; Brainclaw Code Map — JAVASCRIPT-grammar DEFINITIONS query (curated subset of tags.scm).
;
; The shared tags.scm references TypeScript-ONLY node types
; (type_alias_declaration, interface_declaration, type_identifier) which the
; tree-sitter JAVASCRIPT grammar rejects ("Bad node name 'type_identifier'").
; This file is the JS-compatible subset (trp_5026812e): it drops type/interface
; entirely (JS has none) and resolves a class name via `identifier` (the JS
; grammar names classes with `identifier`, not `type_identifier`).
;
; Capture convention + span semantics are IDENTICAL to tags.scm:
;   @definition.<subtype>.node     -> DefinitionDraft.span (enclosing declaration
;                                     statement — every declarator in `const a=1,b=2`
;                                     shares it)
;   @definition.<subtype>.name     -> DefinitionDraft.name
;   @definition.<subtype>.exported -> presence marks DefinitionDraft.exported = true
;
; Subtypes captured here: function | class | variable. (component / hook
; reclassification happens in the provider's refine() pass.)

; ---------------------------------------------------------------------------
; function declarations  (function foo() {}, function* gen() {})
; ---------------------------------------------------------------------------
(program
  (function_declaration
    name: (identifier) @definition.function.name) @definition.function.node)

(program
  (generator_function_declaration
    name: (identifier) @definition.function.name) @definition.function.node)

(program
  (export_statement
    (function_declaration
      name: (identifier) @definition.function.name) @definition.function.node) @definition.function.exported)

(program
  (export_statement
    (generator_function_declaration
      name: (identifier) @definition.function.name) @definition.function.node) @definition.function.exported)

; ---------------------------------------------------------------------------
; class declarations  (class Foo {})  — JS names the class with `identifier`.
; ---------------------------------------------------------------------------
(program
  (class_declaration
    name: (identifier) @definition.class.name) @definition.class.node)

(program
  (export_statement
    (class_declaration
      name: (identifier) @definition.class.name) @definition.class.node) @definition.class.exported)

; ---------------------------------------------------------------------------
; lexical / variable declarations  (const a = 1, b = 2; let x; var y = () => {})
; One match per declarator (one per identifier name); the enclosing statement is
; the shared legacy identity span.
; ---------------------------------------------------------------------------
(program
  (lexical_declaration
    (variable_declarator
      name: (identifier) @definition.variable.name)) @definition.variable.node)

(program
  (variable_declaration
    (variable_declarator
      name: (identifier) @definition.variable.name)) @definition.variable.node)

(program
  (export_statement
    (lexical_declaration
      (variable_declarator
        name: (identifier) @definition.variable.name)) @definition.variable.node) @definition.variable.exported)

(program
  (export_statement
    (variable_declaration
      (variable_declarator
        name: (identifier) @definition.variable.name)) @definition.variable.node) @definition.variable.exported)
