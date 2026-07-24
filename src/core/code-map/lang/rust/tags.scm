; Code Map — Rust definitions (tags.scm). Provider #6 (langs batch 2).
;
; Capture-name convention (query-runtime.ts is the contract):
;   @definition.<subtype>.node = identity-span anchor (the whole declaration)
;   @definition.<subtype>.name = the symbol name node
; Subtypes: function/enum/namespace/constant/type/macro are universal; a Rust
; struct maps to `class` (the named aggregate devs search for like a class), and a
; `trait` has no clean universal equal (it carries default methods + associated
; types/consts, unlike a plain interface) so it is NAMESPACED as `rust.trait`
; (guide §"when to namespace" cites this exact case).
;
; METHOD caveat (v1): Rust methods are `function_item` nodes nested in an
; `impl_item` (or `trait_item`) body — the SAME node type as a free `fn`. Tree-sitter
; queries can't express "function_item NOT inside an impl", so a single generic
; pattern maps ALL `function_item` -> `function` (no distinct `method` subtype in
; v1). Trait method *signatures* (`function_signature_item`, no body) are a distinct
; node type and are intentionally NOT captured in v1.
;
; const + static both map to `constant`; associated const/type inside impl/trait
; reuse the const_item/type_item patterns (captured as constant/type — acceptable).

(function_item
  name: (identifier) @definition.function.name) @definition.function.node

(struct_item
  name: (type_identifier) @definition.class.name) @definition.class.node

(enum_item
  name: (type_identifier) @definition.enum.name) @definition.enum.node

(trait_item
  name: (type_identifier) @definition.rust.trait.name) @definition.rust.trait.node

(mod_item
  name: (identifier) @definition.namespace.name) @definition.namespace.node

(const_item
  name: (identifier) @definition.constant.name) @definition.constant.node

(static_item
  name: (identifier) @definition.constant.name) @definition.constant.node

(type_item
  name: (type_identifier) @definition.type.name) @definition.type.node

(macro_definition
  name: (identifier) @definition.macro.name) @definition.macro.node
