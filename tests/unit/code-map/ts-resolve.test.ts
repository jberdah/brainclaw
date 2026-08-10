/**
 * Code Map P1c — TypeScriptProvider.resolveImport (file-level resolution rules).
 * Mock ctx file-set; asserts relative + extension/index + ESM .js→.ts + bare/missing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { typeScriptProvider } from '../../../src/core/code-map/lang/typescript/index.js';
import { loadTypeScriptResolutionConfig } from '../../../src/core/code-map/lang/typescript/config.js';
import type { ResolveImportContext } from '../../../src/core/code-map/lang/provider.js';

function ctxOf(files: string[]): ResolveImportContext {
  const set = new Set(files);
  return { fileExists: (r) => set.has(r), langOfFile: (r) => (set.has(r) ? 'typescript' : undefined) };
}
async function resolve(source: string, fromPath: string, files: string[]): Promise<string | null> {
  const out = await typeScriptProvider.resolveImport!({ source, fromPath, importedNames: [] }, ctxOf(files));
  return out[0]?.resolvedPath ?? null;
}

async function resolveWithConfig(
  source: string,
  fromPath: string,
  files: string[],
  tsconfig: string,
  extraFiles: Readonly<Record<string, string>> = {},
): Promise<string | null> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-ts-resolve-'));
  try {
    fs.writeFileSync(path.join(root, 'tsconfig.json'), tsconfig, 'utf8');
    for (const [rel, content] of Object.entries(extraFiles)) {
      const filename = path.join(root, rel);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, content, 'utf8');
    }
    const out = await typeScriptProvider.resolveImport!(
      { source, fromPath, importedNames: [] },
      { ...ctxOf(files), resolverConfig: loadTypeScriptResolutionConfig(root) },
    );
    return out[0]?.resolvedPath ?? null;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

describe('code-map P2a TypeScript local configuration', () => {
  const aliases = '{"compilerOptions":{"baseUrl":"src","paths":{"@app/*":["app/*"],"@lib/*":["lib/*"]}}}';

  it('resolves exact aliases, wildcards, and a baseUrl bare specifier', async () => {
    assert.equal(await resolveWithConfig('@app/page', 'src/main.ts', ['src/app/page.ts'], aliases), 'src/app/page.ts');
    assert.equal(await resolveWithConfig('@lib/math', 'src/main.ts', ['src/lib/math.ts'], aliases), 'src/lib/math.ts');
    assert.equal(await resolveWithConfig('feature', 'src/main.ts', ['src/feature.ts'], aliases), 'src/feature.ts');
  });

  it('inherits paths through a bounded local extends chain', async () => {
    const rootConfig = '{"extends":"./config/base.json"}';
    const baseConfig = '{"compilerOptions":{"baseUrl":"../src","paths":{"@lib/*":["lib/*"]}}}';
    assert.equal(
      await resolveWithConfig('@lib/math', 'src/main.ts', ['src/lib/math.ts'], rootConfig, { 'config/base.json': baseConfig }),
      'src/lib/math.ts',
    );
  });

  it('abstains for overlapping patterns, ambiguous targets, and package extends', async () => {
    const overlap = '{"compilerOptions":{"baseUrl":"src","paths":{"@/*":["*"],"@/ui/*":["ui/*"]}}}';
    assert.equal(await resolveWithConfig('@/ui/button', 'src/main.ts', ['src/ui/button.ts'], overlap), null);
    const targets = '{"compilerOptions":{"paths":{"@lib/*":["src/a/*","src/b/*"]}}}';
    assert.equal(
      await resolveWithConfig('@lib/math', 'src/main.ts', ['src/a/math.ts', 'src/b/math.ts'], targets),
      null,
    );
    const packageExtends = '{"extends":"@acme/tsconfig","compilerOptions":{"baseUrl":"src"}}';
    assert.equal(await resolveWithConfig('feature', 'src/main.ts', ['src/feature.ts'], packageExtends), null);
  });
});

describe('code-map P2a TypeScript config fingerprint', () => {
  it('changes when tsconfig content changes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-ts-fingerprint-'));
    try {
      const filename = path.join(root, 'tsconfig.json');
      fs.writeFileSync(filename, '{"compilerOptions":{"baseUrl":"src"}}', 'utf8');
      const before = loadTypeScriptResolutionConfig(root).fingerprint;
      fs.writeFileSync(filename, '{"compilerOptions":{"baseUrl":"app"}}', 'utf8');
      const after = loadTypeScriptResolutionConfig(root).fingerprint;
      assert.notEqual(after, before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
