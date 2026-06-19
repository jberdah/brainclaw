; Brainclaw Code Map — TypeScript/TSX/JavaScript DEFINITIONS query (curated, vendored).
; See ./README.md for the capture-name convention and provenance.
;
; Emits one logical definition per top-level declaration. The query-runtime maps:
;   @definition.<subtype>.node     -> DefinitionDraft.span (the LEGACY IDENTITY span:
;                                      the enclosing declaration statement, NOT the
;                                      declarator/identifier — every declarator in
;                                      `const a = 1, b = 2` shares this statement span)
;   @definition.<subtype>.name     -> DefinitionDraft.name (identifier text)
;   @definition.<subtype>.exported -> presence marks DefinitionDraft.exported = true
;
; Subtypes captured here: function | class | type | interface | variable.
; (component / hook reclassification of function/variable subtypes happens in the
;  provider's refine() pass via PascalCase + returnsJsx / /^use[A-Z0-9]/ — queries
;  cannot perform JSX-body inspection, so this asset emits the structural subtype only.)
;
; Scope = TOP-LEVEL declarations only (P1a parity: no methods, no nested defs). Each
; pattern is anchored to a child of the `program` root, either directly or inside an
; `export_statement`. The unexported and exported forms are listed as sibling
; alternatives so an exported declaration carries the @definition.*.exported marker.

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
; class declarations  (class Foo {})
; ---------------------------------------------------------------------------
(program
  (class_declaration
    name: (type_identifier) @definition.class.name) @definition.class.node)

(program
  (export_statement
    (class_declaration
      name: (type_identifier) @definition.class.name) @definition.class.node) @definition.class.exported)

; ---------------------------------------------------------------------------
; type aliases  (type Foo = ...)
; ---------------------------------------------------------------------------
(program
  (type_alias_declaration
    name: (type_identifier) @definition.type.name) @definition.type.node)

(program
  (export_statement
    (type_alias_declaration
      name: (type_identifier) @definition.type.name) @definition.type.node) @definition.type.exported)

; ---------------------------------------------------------------------------
; interfaces  (interface Foo {})
; ---------------------------------------------------------------------------
(program
  (interface_declaration
    name: (type_identifier) @definition.interface.name) @definition.interface.node)

(program
  (export_statement
    (interface_declaration
      name: (type_identifier) @definition.interface.name) @definition.interface.node) @definition.interface.exported)

; ---------------------------------------------------------------------------
; lexical / variable declarations  (const a = 1, b = 2; let x; var y = () => {})
;
; The @definition.variable.node capture is the ENCLOSING statement (lexical_declaration
; / variable_declaration), so every declarator in a multi-declarator statement shares
; the same legacy identity span. One match is produced per declarator (one per
; identifier name); the runtime de-dupes node-handle reuse via the per-declarator name.
; Only simple `identifier` declarator names are captured (parity: object/array
; destructuring patterns are not emitted as symbols by the legacy extractor).
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
