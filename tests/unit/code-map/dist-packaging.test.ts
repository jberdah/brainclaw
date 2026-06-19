/**
 * Dist PACKAGING smoke (Codex R1 langs#3-4 required gate).
 *
 * `tsc` only emits .js — the grammar `.wasm` and curated `.scm` query assets are
 * copied into `dist/` by `scripts/copy-code-map-wasm.mjs` (run after tsc in
 * build:cli). A published/built package parses a language ONLY if its grammar wasm
 * and query assets actually landed in dist. trp_8df65ab7: the unit suite can be
 * green while the real dist path is broken — this test guards the packaging surface
 * directly so a new provider added without wiring its assets fails loudly.
 *
 * Runs against the on-disk `dist/` produced by build:cli (build:test runs build:cli
 * first, so dist/ is present in CI/test). Asserts the engine glue, every bundled
 * grammar wasm, and every provider's .scm assets exist — and cross-checks that the
 * default registry's bundled languages (incl. php, java) are all covered.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRegistry } from '../../../src/core/code-map/lang/providers.js';

function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('dist-packaging: could not locate repo root');
}

const ROOT = repoRoot();
const WASM_DIR = path.join(ROOT, 'dist', 'wasm');
const LANG_DIR = path.join(ROOT, 'dist', 'core', 'code-map', 'lang');

// The bundled grammar wasms + per-provider .scm asset sets that
// copy-code-map-wasm.mjs is responsible for placing in dist. Adding a provider
// MUST extend this list (and the copy script) in lockstep — that is the point.
const GRAMMAR_WASMS = [
  'tree-sitter-typescript.wasm',
  'tree-sitter-tsx.wasm',
  'tree-sitter-javascript.wasm',
  'tree-sitter-python.wasm',
  'tree-sitter-php.wasm',
  'tree-sitter-java.wasm',
];

const SCM_SETS: Array<[string, string[]]> = [
  ['typescript', ['tags.scm', 'tags.js.scm', 'imports.scm']],
  ['python', ['tags.scm', 'imports.scm']],
  ['php', ['tags.scm', 'imports.scm']],
  ['java', ['tags.scm', 'imports.scm']],
];

describe('code-map dist packaging smoke (langs#3-4)', () => {
  it('the dist/ build output exists (run build:cli / build:test first)', () => {
    assert.ok(fs.existsSync(WASM_DIR), `dist/wasm missing — packaging not built (${WASM_DIR})`);
  });

  it('the web-tree-sitter engine glue wasm is bundled', () => {
    assert.ok(fs.existsSync(path.join(WASM_DIR, 'tree-sitter.wasm')), 'engine tree-sitter.wasm missing from dist/wasm');
  });

  it('every bundled grammar wasm is present in dist/wasm', () => {
    for (const name of GRAMMAR_WASMS) {
      assert.ok(fs.existsSync(path.join(WASM_DIR, name)), `grammar ${name} missing from dist/wasm`);
    }
  });

  it('every provider .scm asset is present in dist', () => {
    for (const [dir, files] of SCM_SETS) {
      for (const f of files) {
        const p = path.join(LANG_DIR, dir, f);
        assert.ok(fs.existsSync(p), `query asset ${dir}/${f} missing from dist`);
      }
    }
  });

  it('php and java grammar wasm specifically landed (the new langs)', () => {
    assert.ok(fs.existsSync(path.join(WASM_DIR, 'tree-sitter-php.wasm')), 'tree-sitter-php.wasm missing');
    assert.ok(fs.existsSync(path.join(WASM_DIR, 'tree-sitter-java.wasm')), 'tree-sitter-java.wasm missing');
    assert.ok(fs.existsSync(path.join(LANG_DIR, 'php', 'tags.scm')), 'php tags.scm missing');
    assert.ok(fs.existsSync(path.join(LANG_DIR, 'java', 'tags.scm')), 'java tags.scm missing');
  });

  it('the default registry bundles php + java (assets must match registered langs)', () => {
    const active = new Set<string>(defaultRegistry.activeLanguages());
    assert.ok(active.has('php'), 'php provider not registered in defaultRegistry');
    assert.ok(active.has('java'), 'java provider not registered in defaultRegistry');
    // Every registered extension that maps to a bundled provider should have its
    // grammar/assets covered above; spot-check the new extensions enumerate.
    const exts = new Set(defaultRegistry.includedExtensions().map((e) => e.toLowerCase()));
    assert.ok(exts.has('.php'), '.php not enumerated by the registry');
    assert.ok(exts.has('.java'), '.java not enumerated by the registry');
  });
});
