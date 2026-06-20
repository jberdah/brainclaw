"""Independent semantic-fact oracle for the Code Map Python provider (cadrage §4).

Parses a target `.py` file with Python's OWN stdlib `ast` module and emits the
SEMANTIC FACT SET as JSON on stdout — independent of tree-sitter AND of the brainclaw
provider. The provider-oracle test asserts the provider extraction agrees on this set
(NOT on tree-sitter spans / finalizer ids — those stay the provider's job).

Emitted facts (all source-side, order-sensitive in source order):
  top_level_defs : [{name, async}]   top-level def / async def names
  classes        : [{name, methods:[{name, async}]}]   class names + their direct-body defs
  nested_defs    : [name, ...]        def names nested inside another def (NOT a class body)
  module_vars    : [name, ...]        module-level simple/annotated assignment identifier targets
  imports        : [{source, names, relative_level}]
                     - `import x`            -> {source:"x", names:[], relative_level:0}
                     - `import a, b`         -> two entries
                     - `import x as y`       -> {source:"x", names:[], relative_level:0}
                     - `from x import a,b`   -> {source:"x", names:["a","b"], relative_level:0}
                     - `from x import a as c`-> names source-side ["a"]
                     - `from . import z`     -> {source:".", names:["z"], relative_level:1}
                     - `from ..pkg import a` -> {source:"..pkg", names:["a"], relative_level:2}
                     - `from x import *`     -> {source:"x", names:["*"], relative_level:0}

Usage:  python ast_oracle.py <path-to-fixture.py>
"""
import ast
import json
import sys


def relative_source(node):
    """Reconstruct the verbatim relative specifier (leading dots + module), matching
    how the provider records `module_name` text for a relative import."""
    dots = "." * (node.level or 0)
    return dots + (node.module or "")


def main():
    path = sys.argv[1]
    with open(path, "r", encoding="utf-8") as fh:
        src = fh.read()
    tree = ast.parse(src)

    top_level_defs = []
    classes = []
    nested_defs = []
    module_vars = []
    imports = []

    def is_def(n):
        return isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))

    def collect_nested(body):
        """Recurse into a def body collecting nested def names (defs inside defs)."""
        for n in body:
            if is_def(n):
                nested_defs.append(n.name)
                collect_nested(n.body)
            elif isinstance(n, ast.ClassDef):
                # defs directly in a nested class body are methods, not nested defs;
                # but a def nested deeper still counts. Recurse over the class body's
                # non-method statements only is out of P1b scope — keep it simple:
                # the fixtures have no class-in-def, so recurse generically.
                for m in n.body:
                    if is_def(m):
                        collect_nested(m.body)

    def assignment_targets(n):
        names = []
        if isinstance(n, ast.Assign):
            for t in n.targets:
                if isinstance(t, ast.Name):
                    names.append(t.id)
        elif isinstance(n, ast.AnnAssign):
            if isinstance(n.target, ast.Name):
                names.append(n.target.id)
        return names

    for node in tree.body:
        if is_def(node):
            top_level_defs.append({"name": node.name, "async": isinstance(node, ast.AsyncFunctionDef)})
            collect_nested(node.body)
        elif isinstance(node, ast.ClassDef):
            methods = []
            for m in node.body:
                if is_def(m):
                    methods.append({"name": m.name, "async": isinstance(m, ast.AsyncFunctionDef)})
                    collect_nested(m.body)
            classes.append({"name": node.name, "methods": methods})
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            module_vars.extend(assignment_targets(node))
        elif isinstance(node, ast.Import):
            for alias in node.names:
                imports.append({"source": alias.name, "names": [], "relative_level": 0})
        elif isinstance(node, ast.ImportFrom):
            source = relative_source(node)
            names = []
            for alias in node.names:
                names.append(alias.name)  # source-side name; alias.asname ignored
            imports.append({"source": source, "names": names, "relative_level": node.level or 0})

    print(json.dumps({
        "top_level_defs": top_level_defs,
        "classes": classes,
        "nested_defs": nested_defs,
        "module_vars": module_vars,
        "imports": imports,
    }))


if __name__ == "__main__":
    main()
