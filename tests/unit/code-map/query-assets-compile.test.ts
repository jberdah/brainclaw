/**
 * Query-asset COMPILE guard (spec §7 / §86 — "compile failure is fatal + loud").
 *
 * The curated tree-sitter queries under `src/core/code-map/lang/typescript/`
 * (`tags.scm`, `imports.scm`) are compile-once assets fed to the generic
 * query-runtime in a later sprint. Spec §86 makes a broken bundled asset a HARD
 * failure (fail the build/tests, never a silent per-file skip). This test is that
 * loud failure: it compiles each asset against the grammar(s) it is meant to run
 * against and asserts the `Query` constructor accepts it.
 *
 * IMPORTANT grammar-coverage reality (verified, not assumed):
 *  - `imports.scm` compiles against ALL THREE grammars (typescript, tsx, javascript).
 *  - `tags.scm` references TypeScript-ONLY node types (`type_alias_declaration`,
 *    `interface_declaration`, `type_identifier`), so it compiles against
 *    typescript + tsx but NOT javascript (tree-sitter rejects the whole query with
 *    "Bad node name 'type_identifier'"). The JS extraction path therefore needs the
 *    runtime/provider to compile a JS-compatible definition subset — tracked as a
 *    P1a wiring-sprint task. This test pins that contract so a regression (e.g. a
 *    future edit that assumes `tags.scm` is JS-safe) fails loudly here.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getParser, loadGrammar } from '../../../src/core/code-map/wasm-loader.js';
import type { CodeLang } from '../../../src/core/code-map/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SCM_DIR = path.join(REPO_ROOT, 'src', 'core', 'code-map', 'lang', 'typescript');

/** Compile `src` against `lang`'s grammar; returns the captured-name list or throws. */
async function compile(lang: CodeLang, src: string): Promise<readonly string[]> {
  const Parser = await getParser();
  // web-tree-sitter exposes Query both as a named export and as `Language.query`.
  // Use the engine glue's Query via the loaded grammar to stay version-agnostic.
  const grammar = await loadGrammar(lang);
  // `new (Query)(grammar, src)` is the 0.25 API; `grammar.query(src)` is the
  // instance shortcut. Prefer the named constructor on the glue module.
  const mod = (await import('web-tree-sitter')) as unknown as {
    Query: new (g: unknown, s: string) => { captureNames: string[] };
  };
  void Parser;
  const q = new mod.Query(grammar, src);
  return q.captureNames;
}

const tagsScm = () => fs.readFileSync(path.join(SCM_DIR, 'tags.scm'), 'utf-8');
const importsScm = () => fs.readFileSync(path.join(SCM_DIR, 'imports.scm'), 'utf-8');

describe('code-map query assets compile cleanly (spec §86)', () => {
  before(async () => {
    // Engine init is lazy; force it once so the grammars are ready.
    await loadGrammar('typescript');
  });

  it('the curated assets exist on disk', () => {
    assert.ok(fs.existsSync(path.join(SCM_DIR, 'tags.scm')), 'tags.scm missing');
    assert.ok(fs.existsSync(path.join(SCM_DIR, 'imports.scm')), 'imports.scm missing');
  });

  it('imports.scm compiles against typescript, tsx, AND javascript', async () => {
    for (const lang of ['typescript', 'tsx', 'javascript'] as CodeLang[]) {
      const caps = await compile(lang, importsScm());
      assert.ok(caps.length > 0, `imports.scm produced no captures for ${lang}`);
      // The capture surface the runtime's captureMap depends on.
      for (const expected of ['import.source', 'import.named.name', 'export.name']) {
        assert.ok(caps.includes(expected), `imports.scm missing capture ${expected} (${lang})`);
      }
    }
  });

  it('tags.scm compiles against typescript and tsx', async () => {
    for (const lang of ['typescript', 'tsx'] as CodeLang[]) {
      const caps = await compile(lang, tagsScm());
      for (const expected of [
        'definition.function.node',
        'definition.function.name',
        'definition.class.node',
        'definition.type.node',
        'definition.interface.node',
        'definition.variable.node',
      ]) {
        assert.ok(caps.includes(expected), `tags.scm missing capture ${expected} (${lang})`);
      }
    }
  });

  it('tags.scm references TS-only node types — NOT JS-safe (pins the wiring contract)', async () => {
    // Documents the known constraint: the same tags.scm cannot compile against the
    // javascript grammar (type_alias_declaration / interface_declaration / type_identifier
    // are TS-only). The wiring sprint MUST select a JS-compatible definition subset for
    // .js files. If a future edit makes tags.scm JS-safe, flip this assertion.
    await assert.rejects(
      () => compile('javascript', tagsScm()),
      /Bad node name|node name/i,
      'tags.scm unexpectedly compiled against javascript — update the JS-subset wiring note',
    );
  });
});
