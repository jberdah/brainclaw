/**
 * Copy Tree-sitter WASM assets into dist for the Code Map (spec §6.2).
 *
 * tsc only emits .js — this script bundles the runtime WASM:
 *  - the web-tree-sitter engine glue .wasm  -> dist/wasm/ + dist/vendor/web-tree-sitter/
 *  - prebuilt grammar .wasm (typescript / tsx / javascript / python) -> dist/wasm/
 *
 * Runtime resolves these via `new URL('../../wasm/<file>.wasm', import.meta.url)`
 * from dist/core/code-map/wasm-loader.js (== dist/wasm/). Mirrors
 * scripts/copy-default-profiles.mjs. Run AFTER tsc in build:cli.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const wasmDir = 'dist/wasm';
const vendorDir = 'dist/vendor/web-tree-sitter';
fs.mkdirSync(wasmDir, { recursive: true });
fs.mkdirSync(vendorDir, { recursive: true });

function copyResolved(spec, destDir, destName) {
  let src;
  try {
    src = require.resolve(spec);
  } catch (err) {
    console.warn(`[copy-code-map-wasm] could not resolve ${spec}: ${err.message}`);
    return false;
  }
  const dest = path.join(destDir, destName ?? path.basename(src));
  fs.copyFileSync(src, dest);
  return true;
}

// Engine glue .wasm -> dist/wasm/ (loaded by path) + vendored copy for provenance.
const engineOk = copyResolved('web-tree-sitter/tree-sitter.wasm', wasmDir, 'tree-sitter.wasm');
copyResolved('web-tree-sitter/tree-sitter.wasm', vendorDir, 'tree-sitter.wasm');

// Engine JS glue -> dist/vendor/web-tree-sitter/tree-sitter.js. The loader
// dynamic-imports THIS vendored copy (resolved via import.meta.url) on first
// parse, so the published package works even after devDeps are dropped. The
// glue is a single self-contained ESM file (only node builtins fs/path/url at
// runtime; the .wasm is passed in explicitly via wasmBinary), so a flat copy
// is sufficient. We also copy the source map for debuggability when present.
let glueOk = false;
try {
  // IMPORTANT: resolve the ESM entry explicitly, not via require.resolve (which
  // would return the CJS `require` condition = tree-sitter.cjs). brainclaw's
  // package.json is "type":"module", so a vendored `.js` MUST be the ESM build —
  // copying the .cjs under a .js name would crash with "module is not defined".
  // Read the package's exports["."].import target and copy THAT file.
  // package.json is not in the package's exports map; derive the package dir from
  // the exported .wasm subpath (which sits at the package root) instead.
  const wasmPath = require.resolve('web-tree-sitter/tree-sitter.wasm');
  const pkgDir = path.dirname(wasmPath);
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf-8'));
  const esmRel = pkg.exports?.['.']?.import ?? './tree-sitter.js';
  const glueSrc = path.resolve(pkgDir, esmRel);
  fs.copyFileSync(glueSrc, path.join(vendorDir, 'tree-sitter.js'));
  glueOk = true;
  const mapSrc = `${glueSrc}.map`;
  if (fs.existsSync(mapSrc)) {
    fs.copyFileSync(mapSrc, path.join(vendorDir, 'tree-sitter.js.map'));
  }
} catch (err) {
  console.warn(`[copy-code-map-wasm] could not vendor web-tree-sitter JS glue: ${err.message}`);
}

const grammars = [
  ['tree-sitter-wasms/out/tree-sitter-typescript.wasm', 'tree-sitter-typescript.wasm'],
  ['tree-sitter-wasms/out/tree-sitter-tsx.wasm', 'tree-sitter-tsx.wasm'],
  ['tree-sitter-wasms/out/tree-sitter-javascript.wasm', 'tree-sitter-javascript.wasm'],
  ['tree-sitter-wasms/out/tree-sitter-python.wasm', 'tree-sitter-python.wasm'],
  ['tree-sitter-wasms/out/tree-sitter-php.wasm', 'tree-sitter-php.wasm'],
  ['tree-sitter-wasms/out/tree-sitter-java.wasm', 'tree-sitter-java.wasm'],
  ['tree-sitter-wasms/out/tree-sitter-go.wasm', 'tree-sitter-go.wasm'],
];

let grammarOk = true;
for (const [spec, name] of grammars) {
  grammarOk = copyResolved(spec, wasmDir, name) && grammarOk;
}

// Curated tree-sitter query assets (.scm) -> next to the compiled provider in
// dist. tsc only emits .js; the TypeScriptProvider reads these by import.meta.url
// (dist/core/code-map/lang/typescript/), so a published package can resolve them
// without the src/ tree. (Tests fall back to src/ via the repo-root walk.)
let scmOk = true;
try {
  // Per-provider .scm asset sets (read by each provider via import.meta.url from
  // dist/core/code-map/lang/<provider>/). Tests fall back to src/ via a repo-root walk.
  const scmSets = [
    ['src/core/code-map/lang/typescript', 'dist/core/code-map/lang/typescript', ['tags.scm', 'tags.js.scm', 'imports.scm']],
    ['src/core/code-map/lang/python', 'dist/core/code-map/lang/python', ['tags.scm', 'imports.scm']],
    ['src/core/code-map/lang/php', 'dist/core/code-map/lang/php', ['tags.scm', 'imports.scm']],
    ['src/core/code-map/lang/java', 'dist/core/code-map/lang/java', ['tags.scm', 'imports.scm']],
    ['src/core/code-map/lang/go', 'dist/core/code-map/lang/go', ['tags.scm', 'imports.scm']],
  ];
  for (const [scmSrcDir, scmDestDir, names] of scmSets) {
    fs.mkdirSync(scmDestDir, { recursive: true });
    for (const name of names) {
      const src = path.join(scmSrcDir, name);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(scmDestDir, name));
      } else {
        scmOk = false;
        console.warn(`[copy-code-map-wasm] query asset missing: ${src}`);
      }
    }
  }
} catch (err) {
  scmOk = false;
  console.warn(`[copy-code-map-wasm] could not copy query assets: ${err.message}`);
}

if (engineOk && grammarOk && glueOk && scmOk) {
  console.log(
    `[copy-code-map-wasm] bundled engine + ${grammars.length} grammar wasm into dist/wasm/ and vendored JS glue into dist/vendor/web-tree-sitter/`,
  );
} else {
  console.warn('[copy-code-map-wasm] some wasm/glue assets missing; runtime will fall back to node_modules');
}
