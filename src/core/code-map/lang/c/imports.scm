; Code Map — C imports (imports.scm). Provider #6 (langs batch 2).
;
; enclosingStatementNodeTypes = [preproc_include] (the import span/ordinal anchor).
; A `#include` path comes in two grammar shapes:
;   #include <stdio.h>   -> path: (system_lib_string)  text = "<stdio.h>"
;   #include "config.h"  -> path: (string_literal)      text = "\"config.h\""
; Both are captured as @import.source; the provider's refine() strips the angle
; brackets (`<...>`) or the surrounding double quotes (`"..."`) to the bare header
; path. C has no imported-name bindings, so imported_names stays empty.

(preproc_include
  path: [(system_lib_string) (string_literal)] @import.source)
