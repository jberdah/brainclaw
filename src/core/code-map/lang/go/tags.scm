; Code Map — Go definitions (tags.scm). Provider #5 (langs batch 2).
;
; Capture-name convention (query-runtime.ts is the contract):
;   @definition.<subtype>.node = identity-span anchor (the declaration)
;   @definition.<subtype>.name = the symbol name node
; Subtypes: function/method/interface/constant/variable/package are universal;
; a Go struct maps to `class` (the named aggregate devs search for like a class).
; Patterns are mutually exclusive by the `type:` child so a type_spec is captured
; once (struct→class, interface→interface); bare type aliases are intentionally
; not captured in v1 (low value, and a general type_spec pattern would double-match
; struct/interface with a different subtype → duplicate symbol).

(package_clause
  (package_identifier) @definition.package.name) @definition.package.node

(function_declaration
  name: (identifier) @definition.function.name) @definition.function.node

(method_declaration
  name: (field_identifier) @definition.method.name) @definition.method.node

(type_spec
  name: (type_identifier) @definition.class.name
  type: (struct_type)) @definition.class.node

(type_spec
  name: (type_identifier) @definition.interface.name
  type: (interface_type)) @definition.interface.node

; `const ( A = 1; B = 2 )` and `const C = 3` both yield const_spec per name.
(const_spec
  name: (identifier) @definition.constant.name) @definition.constant.node

; Package-level `var x = …` → variable (one per var_spec name).
(var_spec
  name: (identifier) @definition.variable.name) @definition.variable.node
