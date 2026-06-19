/**
 * Copy Tree-sitter WASM assets into dist for the Code Map (spec §6.2).
 *
 * tsc only emits .js — this script bundles the runtime WASM:
 *  - the web-tree-sitter engine glue .wasm  -> dist/wasm/ + dist/vendor/web-tree-sitter/
 *  - prebuilt grammar .wasm (typescript / tsx / javascript) -> dist/wasm/
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
// Engine JS glue is bundled by Node's module resolution of the web-tree-sitter
// import in wasm-loader.js; we vendor the .wasm because only the .wasm is loaded
// by explicit path. (If a future publish drops the devDep, the .js import would
// also need vendoring — tracked for P1 packaging hardening.)

const grammars = [
  ['tree-sitter-wasms/out/tree-sitter-typescript.wasm', 'tree-sitter-typescript.wasm'],
  ['tree-sitter-wasms/out/tree-sitter-tsx.wasm', 'tree-sitter-tsx.wasm'],
  ['tree-sitter-wasms/out/tree-sitter-javascript.wasm', 'tree-sitter-javascript.wasm'],
];

let grammarOk = true;
for (const [spec, name] of grammars) {
  grammarOk = copyResolved(spec, wasmDir, name) && grammarOk;
}

if (engineOk && grammarOk) {
  console.log('[copy-code-map-wasm] bundled engine + 3 grammar wasm into dist/wasm/');
} else {
  console.warn('[copy-code-map-wasm] some wasm assets missing; runtime will fall back to node_modules');
}
