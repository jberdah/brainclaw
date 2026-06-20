/**
 * Code Map P1c — PythonProvider.resolveImport (file-level resolution rules).
 * Mock ctx file-set; asserts relative-dot (PEP 328) + bare `.` → __init__ +
 * parent-package + absolute dotted (root-relative) + module-shadows-package +
 * stdlib/missing = no edge.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pythonProvider } from '../../../src/core/code-map/lang/python/index.js';
import type { ResolveImportContext } from '../../../src/core/code-map/lang/provider.js';

function ctxOf(files: string[]): ResolveImportContext {
  const set = new Set(files);
  return { fileExists: (r) => set.has(r), langOfFile: (r) => (set.has(r) ? 'python' : undefined) };
}
async function resolve(source: string, fromPath: string, files: string[]): Promise<string | null> {
  const out = await pythonProvider.resolveImport!({ source, fromPath, importedNames: [] }, ctxOf(files));
  return out[0]?.resolvedPath ?? null;
}

describe('code-map P1c Python resolveImport', () => {
  it('relative .mod resolves to a sibling module', async () => {
    assert.equal(await resolve('.mod', 'pkg/a.py', ['pkg/mod.py']), 'pkg/mod.py');
  });
  it('relative .sub resolves to a sub-package __init__', async () => {
    assert.equal(await resolve('.sub', 'pkg/a.py', ['pkg/sub/__init__.py']), 'pkg/sub/__init__.py');
  });
  it('a module shadows a package of the same dotted name', async () => {
    assert.equal(await resolve('.mod', 'pkg/a.py', ['pkg/mod.py', 'pkg/mod/__init__.py']), 'pkg/mod.py');
  });
  it('bare `.` (from . import x) resolves to the current package __init__', async () => {
    assert.equal(await resolve('.', 'pkg/sub/a.py', ['pkg/sub/__init__.py']), 'pkg/sub/__init__.py');
  });
  it('`..pkg` walks up one package level', async () => {
    // importer pkg/sub/a.py: `..` = pkg, then `pkg` segment → pkg/pkg.py
    assert.equal(await resolve('..pkg', 'pkg/sub/a.py', ['pkg/pkg.py']), 'pkg/pkg.py');
  });
  it('`..other.thing` resolves a dotted tail under the parent package', async () => {
    assert.equal(await resolve('..other.thing', 'pkg/sub/a.py', ['pkg/other/thing.py']), 'pkg/other/thing.py');
  });
  it('bare `..` resolves to the parent package __init__', async () => {
    assert.equal(await resolve('..', 'pkg/sub/a.py', ['pkg/__init__.py']), 'pkg/__init__.py');
  });
  it('absolute dotted resolves project-root-relative to a module', async () => {
    assert.equal(await resolve('a.b.c', 'pkg/x.py', ['a/b/c.py']), 'a/b/c.py');
  });
  it('absolute dotted resolves to a package __init__', async () => {
    assert.equal(await resolve('a.b', 'pkg/x.py', ['a/b/__init__.py']), 'a/b/__init__.py');
  });
  it('stdlib / third-party names do not resolve (no edge)', async () => {
    assert.equal(await resolve('os', 'pkg/a.py', ['pkg/a.py']), null);
    assert.equal(await resolve('os.path', 'pkg/a.py', ['pkg/a.py']), null);
    assert.equal(await resolve('numpy', 'pkg/a.py', []), null);
  });
  it('missing relative target does not resolve', async () => {
    assert.equal(await resolve('.gone', 'pkg/a.py', ['pkg/a.py']), null);
  });
  it('root-level importer with a relative sibling', async () => {
    assert.equal(await resolve('.helper', 'main.py', ['helper.py']), 'helper.py');
  });
});
