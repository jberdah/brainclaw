; Code Map — C# imports (imports.scm). Provider #6 (langs batch 2).
;
; enclosingStatementNodeTypes = [using_directive] (the import span/ordinal anchor).
; C# using shapes:
;   using System.Text;          -> module System.Text
;   using static System.Math;   -> module System.Math  (imports the type's static
;                                  members; the whole qualified name IS the module —
;                                  no member split like Java `import static`)
;   using Json = Newtonsoft.Json; -> module Newtonsoft.Json + alias name `Json`
;
; The module reference is ALWAYS a direct qualified_name / identifier child of the
; using_directive. An alias binding lives inside a sibling `name_equals` node (never
; a direct qualified_name/identifier), so this single capture takes ONLY the module
; path in every shape (plain / static / alias) — the static keyword and the alias
; are not captured here. C# has no wildcard using and no string-literal module (so
; nothing to quote-strip). The provider's refine() lifts an alias's binding name
; (from the `name_equals` sibling) onto the module node's imported names.

(using_directive
  [(qualified_name) (identifier)] @import.source)
