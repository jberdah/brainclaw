; Brainclaw Code Map — Python DEFINITIONS query (curated, vendored).
; Grammar: tree-sitter-python (WASM vendored under dist/wasm/). See ./README.md for
; the capture-name convention, the Python→vocabulary mapping, and provenance.
;
; The generic query-runtime (lang/query-runtime.ts) maps each match's captures:
;   @definition.<subtype>.node     -> DefinitionDraft.span  (the LEGACY IDENTITY span)
;   @definition.<subtype>.name     -> DefinitionDraft.name  (identifier text + ordinal)
;   @definition.<subtype>.exported -> presence ⇒ exported=true  (UNUSED for Python:
;                                     Python has no export statement, so this asset
;                                     never emits it — every Python symbol is unexported)
;
; Structural subtypes emitted here: function | class | variable.
;  - function_definition is captured UNIFORMLY as @definition.function (whether bare,
;    decorated, top-level, nested, or sitting directly in a class body). The provider's
;    refine() pass reclassifies:
;      * a function_definition whose owner is a class body          -> method
;        (@property -> property; @staticmethod/@classmethod -> method)
;      * everything else (top-level + nested defs)                  -> stays function
;    refine() decides method-vs-function and decorator-driven subtypes because the
;    structural query cannot inspect the enclosing-scope chain or decorator semantics.
;  - module-level assignment is captured as @definition.variable; refine() narrows an
;    all-UPPER_CASE target to `constant`.
;
; IDENTITY SPAN: every definition pattern anchors @definition.*.node on the INNER
; function_definition / class_definition node — NOT on any enclosing decorated_definition
; wrapper. A decorated def's identity span therefore EXCLUDES its decorators (spec §5),
; and the same single pattern matches the bare and the decorated forms (the inner node
; is identical in both trees), so no separate decorated pattern is needed.

; ---------------------------------------------------------------------------
; function / async-function definitions  (def f(): ... / async def f(): ...)
;
; Matched at ANY depth (top-level, nested, class-body). `async def` is the same
; function_definition node (the grammar marks async with an `async` keyword child,
; not a distinct node type), so this one pattern covers sync + async; async-ness is
; classification-only and is NOT persisted (no durable attribute field — spec §5).
; refine() promotes class-body functions to `method`.
; ---------------------------------------------------------------------------
(function_definition
  name: (identifier) @definition.function.name) @definition.function.node

; ---------------------------------------------------------------------------
; class definitions  (class C: ... / class C(Base): ...)
; ---------------------------------------------------------------------------
(class_definition
  name: (identifier) @definition.class.name) @definition.class.node

; ---------------------------------------------------------------------------
; module-level variables / constants
;
; Anchored under `module` (the root) so ONLY top-level assignments are emitted —
; class/instance attributes and locals are NOT symbols in P1b (spec §5). Covers both
; a plain assignment (`X = 1`) and an annotated assignment (`X: int = 1`); both are a
; single `assignment` node, the annotation living in its `type:` field. Only a simple
; `identifier` target is captured (tuple/attribute/subscript targets are not symbols).
; The @definition.variable.node identity span is the `assignment` node. refine()
; narrows an all-UPPER_CASE name to `constant`; everything else stays `variable`.
; ---------------------------------------------------------------------------
(module
  (expression_statement
    (assignment
      left: (identifier) @definition.variable.name) @definition.variable.node))

; ---------------------------------------------------------------------------
; ERROR-root recovery (parity with the TS asset).
;
; When tree-sitter cannot parse a file cleanly it may promote a subtree to an `ERROR`
; node while still recovering well-formed declarations beneath it. Mirror the def/class
; patterns under an `(ERROR ...)` ancestor so top-level symbols in an error-recovered
; file are not silently dropped. (Functions/classes match at any depth above already,
; but anchoring these explicitly keeps content parity for the ERROR-root shape and
; documents the intent.) Module-level variables are intentionally NOT recovered under
; ERROR — without the `module` anchor a bare identifier-assignment match is ambiguous.
; ---------------------------------------------------------------------------
(ERROR
  (function_definition
    name: (identifier) @definition.function.name) @definition.function.node)

(ERROR
  (class_definition
    name: (identifier) @definition.class.name) @definition.class.node)
