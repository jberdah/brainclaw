; Code Map — Java definitions (tags.scm). Provider #4 (langs#3-4).
;
; Capture-name convention (query-runtime.ts is the contract):
;   @definition.<subtype>.node = identity-span anchor (the whole declaration)
;   @definition.<subtype>.name = the symbol name node
; Subtypes: package/class/interface/enum/method/constructor/field/constant are
; universal; annotation types → java.annotation and records → java.record are
; namespaced (they are class-like at the JVM level but users reason about them as
; distinct kinds — Codex R1). Nested/inner classes are captured by the same
; class_declaration pattern (the finalizer emits file-level contains/defines only;
; no fabricated nesting edges). enum constants → constant; constructors are a
; distinct grammar node (constructor_declaration → constructor, not method).

(package_declaration
  [(scoped_identifier) (identifier)] @definition.package.name) @definition.package.node

(class_declaration
  name: (identifier) @definition.class.name) @definition.class.node

(interface_declaration
  name: (identifier) @definition.interface.name) @definition.interface.node

(enum_declaration
  name: (identifier) @definition.enum.name) @definition.enum.node

(enum_constant
  name: (identifier) @definition.constant.name) @definition.constant.node

(annotation_type_declaration
  name: (identifier) @definition.java.annotation.name) @definition.java.annotation.node

(record_declaration
  name: (identifier) @definition.java.record.name) @definition.java.record.node

(method_declaration
  name: (identifier) @definition.method.name) @definition.method.node

(constructor_declaration
  name: (identifier) @definition.constructor.name) @definition.constructor.node

; `int a, b;` yields one match per variable_declarator (all sharing the
; field_declaration identity span) — mirrors the const/property multi-declarator rule.
(field_declaration
  declarator: (variable_declarator name: (identifier) @definition.field.name)) @definition.field.node

; Annotation member declarations are method-shaped (`String value() default ""`).
(annotation_type_element_declaration
  name: (identifier) @definition.method.name) @definition.method.node
