/**
 * Code Map P1c — TypeScriptProvider.resolveImport (file-level resolution rules).
 * Mock ctx file-set; asserts relative + extension/index + ESM .js→.ts + bare/missing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { typeScriptProvider } from '../../../src/core/code-map/lang/typescript/index.js';
import type { ResolveImportContext } from '../../../src/core/code-map/lang/provider.js';

function ctxOf(files: string[]): ResolveImportContext {
  const set = new Set(files);
  return { fileExists: (r) => set.has(r), langOfFile: (r) => (set.has(r) ? 'typescript' : undefined) };
}
async function resolve(source: string, fromPath: string, files: string[]): Promise<string | null> {
  const out = await typeScriptProvider.resolveImport!({ source, fromPath, importedNames: [] }, ctxOf(files));
  return out[0]?.resolvedPath ?? null;
}

describe('code-map P1c TypeScript resolveImport', () => {
  it('relative extensionless resolves to .ts', async () => {
    assert.equal(await resolve('./b', 'src/a.ts', ['src/b.ts']), 'src/b.ts');
  });
  it('prefers .ts over .js when both exist', async () => {
    assert.equal(await resolve('./b', 'src/a.ts', ['src/b.js', 'src/b.ts']), 'src/b.ts');
  });
  it('ESM ./b.js maps to b.ts when no real b.js', async () => {
    assert.equal(await resolve('./b.js', 'src/a.ts', ['src/b.ts']), 'src/b.ts');
  });
  it('exact ./b.js wins when a real b.js exists', async () => {
    assert.equal(await resolve('./b.js', 'src/a.ts', ['src/b.js', 'src/b.ts']), 'src/b.js');
  });
  it('directory specifier resolves to /index.ts', async () => {
    assert.equal(await resolve('./sub', 'src/a.ts', ['src/sub/index.ts']), 'src/sub/index.ts');
  });
  it('parent-relative ../utils', async () => {
    assert.equal(await resolve('../utils', 'src/a/x.ts', ['src/utils.ts']), 'src/utils.ts');
  });
  it('tsx resolves', async () => {
    assert.equal(await resolve('./C', 'src/a.tsx', ['src/C.tsx']), 'src/C.tsx');
  });
  it('bare / scoped externals do not resolve (no edge)', async () => {
    assert.equal(await resolve('react', 'src/a.ts', ['src/b.ts']), null);
    assert.equal(await resolve('@scope/pkg', 'src/a.ts', []), null);
  });
  it('missing target does not resolve', async () => {
    assert.equal(await resolve('./nope', 'src/a.ts', ['src/b.ts']), null);
  });
  it('root-level importer', async () => {
    assert.equal(await resolve('./b', 'a.ts', ['b.ts']), 'b.ts');
  });
});
