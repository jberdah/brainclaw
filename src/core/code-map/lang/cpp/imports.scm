; Code Map — C++ imports (imports.scm). Provider #? (langs batch 2).
;
; enclosingStatementNodeTypes = [preproc_include] (the include span/ordinal anchor).
; A C++ `#include` path is either a `system_lib_string` (`<vector>`, `<sys/types.h>`)
; or a `string_literal` (`"config.h"`). Both carry their surrounding delimiters in
; the captured text, so the provider's refine() strips the `<>`/`"` to the bare path
; (the runtime's stripQuotes handles the quote case; refine also strips the angle
; brackets the runtime leaves in place). One preproc_include = one module node.
;
; C++20 `import` modules (`import std;`) are intentionally NOT captured in v1 — rare
; in practice and grammar-version-dependent.

(preproc_include
  path: [(system_lib_string) (string_literal)] @import.source)
