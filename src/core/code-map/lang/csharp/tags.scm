; Code Map — C# definitions (tags.scm). Provider #6 (langs batch 2).
;
; Capture-name convention (query-runtime.ts is the contract):
;   @definition.<subtype>.node = identity-span anchor (the whole declaration)
;   @definition.<subtype>.name = the symbol name node
; Subtypes: namespace/class/interface/enum/method/constructor/property/field/
; constant are universal. C#-distinct kinds are namespaced (Codex/Java R1 precedent
; for record/annotation): a struct is a VALUE type first-class-distinct from a class
; (reference type) — devs choose between them deliberately — so struct →
; csharp.struct (NOT class like Go, where struct is the only aggregate); records →
; csharp.record; delegates (named function-type declarations) → csharp.delegate.
; enum members → constant. Constructors are a distinct grammar node
; (constructor_declaration → constructor, not method). Nested/inner types + their
; members are emitted by the same patterns; the finalizer emits only file-level
; contains/defines (no fabricated nesting edges).

; namespace Acme.Widgets { … }  — name is a qualified_name or a bare identifier.
(namespace_declaration
  name: [(qualified_name) (identifier)] @definition.namespace.name) @definition.namespace.node

; File-scoped namespace (C# 10): `namespace Acme.App;` — its own grammar node.
(file_scoped_namespace_declaration
  name: [(qualified_name) (identifier)] @definition.namespace.name) @definition.namespace.node

(class_declaration
  name: (identifier) @definition.class.name) @definition.class.node

(interface_declaration
  name: (identifier) @definition.interface.name) @definition.interface.node

(struct_declaration
  name: (identifier) @definition.csharp.struct.name) @definition.csharp.struct.node

(enum_declaration
  name: (identifier) @definition.enum.name) @definition.enum.node

; `record`, `record class`, and `record struct` all parse as record_declaration.
(record_declaration
  name: (identifier) @definition.csharp.record.name) @definition.csharp.record.node

; `delegate int Transformer(int x);` — a named function-type declaration.
(delegate_declaration
  name: (identifier) @definition.csharp.delegate.name) @definition.csharp.delegate.node

(method_declaration
  name: (identifier) @definition.method.name) @definition.method.node

(constructor_declaration
  name: (identifier) @definition.constructor.name) @definition.constructor.node

(property_declaration
  name: (identifier) @definition.property.name) @definition.property.node

; enum members map to constant: `enum Color { Red, Green }` → one per member.
(enum_member_declaration
  name: (identifier) @definition.constant.name) @definition.constant.node

; `public int a, b;` yields one match per variable_declarator (all sharing the
; field_declaration identity span) — mirrors the Java field multi-declarator rule.
; The declarator's name is its first (unlabelled) identifier child.
(field_declaration
  (variable_declaration
    (variable_declarator (identifier) @definition.field.name))) @definition.field.node
