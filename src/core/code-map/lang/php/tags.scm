; Code Map — PHP definitions (tags.scm). Provider #3 (langs#3-4).
;
; Capture-name convention (query-runtime.ts is the contract):
;   @definition.<subtype>.node = the identity-span anchor (the whole declaration)
;   @definition.<subtype>.name = the symbol name node
; Subtypes: namespace/class/interface/enum/function/method/constant/property are
; universal; php.trait is namespaced (a trait is NOT substitutable for an
; interface). __construct is captured as `method` here and reclassified to
; `constructor` in the provider's refine() (the grammar node is method_declaration).
; enum cases and class consts both map to `constant`.

(namespace_definition
  name: (namespace_name) @definition.namespace.name) @definition.namespace.node

(class_declaration
  name: (name) @definition.class.name) @definition.class.node

(interface_declaration
  name: (name) @definition.interface.name) @definition.interface.node

(trait_declaration
  name: (name) @definition.php.trait.name) @definition.php.trait.node

(enum_declaration
  name: (name) @definition.enum.name) @definition.enum.node

(enum_case
  name: (name) @definition.constant.name) @definition.constant.node

(function_definition
  name: (name) @definition.function.name) @definition.function.node

(method_declaration
  name: (name) @definition.method.name) @definition.method.node

; `const A = 1, B = 2;` yields one match per const_element (all sharing the
; const_declaration identity span) — mirrors the JS/TS `const a,b` shared-span rule.
(const_declaration
  (const_element (name) @definition.constant.name)) @definition.constant.node

; `public int $a, $b;` yields one match per property_element. The name node is the
; `variable_name` (text "$a"); refine() strips the leading `$` for the symbol name.
(property_declaration
  (property_element (variable_name) @definition.property.name)) @definition.property.node
