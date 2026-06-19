/**
 * Regenerate the PHP/Java code-map parser WITNESS fixtures (Codex R1 langs#3-4).
 *
 * Per fixture the witness records: source, tree-sitter query captures (capture →
 * node type + text), the id-free provider DRAFT, and the finalized ExtractResult.
 * It is explicitly a "parser witness, NOT an independent oracle" — tree-sitter's
 * own view — used to make the hand-authored semantic spec
 * (tests/unit/code-map/php-java-provider-oracle.test.ts) reviewable and to catch
 * query/refine/grammar drift.
 *
 * Run AFTER `npm run build:test` (imports the compiled dist-test provider/runtime),
 * and ONLY when an output change is intentional:
 *   node scripts/gen-code-map-langs-witness.mjs
 * The provider-oracle test compares live output to the committed witness and never
 * auto-blesses, so a drift is a real finding until this is re-run + re-reviewed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadGrammarWasm,
  getParser,
  getQueryClass,
} from '../dist-test/src/core/code-map/wasm-loader.js';
import { extractFile } from '../dist-test/src/core/code-map/core.js';
import { phpProvider } from '../dist-test/src/core/code-map/lang/php/index.js';
import { javaProvider } from '../dist-test/src/core/code-map/lang/java/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = 'prj_code_map_oracle';
const MAX = 1024 * 1024;

const LANGS = {
  php: {
    provider: phpProvider,
    grammar: ['tree-sitter-php.wasm', 'tree-sitter-wasms/out/tree-sitter-php.wasm'],
    dir: 'tests/fixtures/code-map/langs-php',
    fixtures: [
      'defs-class.php', 'defs-types.php', 'imports-simple.php', 'imports-group.php',
      'imports-funcconst.php', 'syntax-error.php', 'oversized.php',
    ],
    oversized: 'oversized.php',
  },
  java: {
    provider: javaProvider,
    grammar: ['tree-sitter-java.wasm', 'tree-sitter-wasms/out/tree-sitter-java.wasm'],
    dir: 'tests/fixtures/code-map/langs-java',
    fixtures: [
      'defs-class.java', 'defs-types.java', 'imports.java', 'multi-field.java',
      'generics.java', 'syntax-error.java', 'oversized.java',
    ],
    oversized: 'oversized.java',
  },
};

let QueryClass, ParserClass;

function captureList(grammar, source, scmSource) {
  const query = new QueryClass(grammar, scmSource);
  const parser = new ParserClass();
  parser.setLanguage(grammar);
  const tree = parser.parse(source);
  const out = [];
  for (const m of query.matches(tree.rootNode)) {
    for (const c of m.captures) {
      out.push({ capture: c.name, type: c.node.type, text: c.node.text.replace(/\s+/g, ' ').slice(0, 48) });
    }
  }
  parser.delete();
  return out;
}

function sanitizeDraft(draft) {
  return {
    definitions: draft.definitions.map((d) => ({
      ordinal: d.ordinal, captureName: d.captureName, name: d.name, subtype: d.subtype, span: d.span, exported: d.exported,
    })),
    imports: draft.imports.map((i) => ({
      ordinal: i.ordinal, source: i.source, importedNames: i.importedNames, span: i.span, isReExport: i.isReExport,
    })),
    exports: draft.exports.map((e) => ({ ordinal: e.ordinal, name: e.name, span: e.span })),
    parseStatus: draft.attributes?.parseStatus,
    facts: draft.facts,
  };
}

for (const [lang, cfg] of Object.entries(LANGS)) {
  const grammar = await loadGrammarWasm(cfg.grammar[0], cfg.grammar[1]);
  QueryClass = await getQueryClass();
  ParserClass = await getParser();
  const tagsSrc = cfg.provider.queries.tags.sourceForLang(lang);
  const importsSrc = cfg.provider.queries.imports.sourceForLang(lang);

  const witness = {};
  for (const file of cfg.fixtures) {
    const source = fs.readFileSync(path.join(ROOT, cfg.dir, file), 'utf-8');
    const relPath = `src/${file}`;
    const oversized = file === cfg.oversized;
    const sizeBytes = oversized ? 8 * 1024 * 1024 : Buffer.byteLength(source);

    const draft = await cfg.provider.extractDraft(
      { projectId: PROJECT, path: relPath, lang, source, sizeBytes, maxParseFileBytes: MAX },
      { version: '0.1.0' },
    );
    const refined = cfg.provider.refine ? await cfg.provider.refine(draft, { input: { lang }, lang }) : draft;
    const result = await extractFile({ projectId: PROJECT, path: relPath, lang, source, sizeBytes, maxParseFileBytes: MAX });

    witness[relPath] = {
      path: relPath,
      lang,
      _note: 'PARSER WITNESS, NOT an independent oracle (tree-sitter own view). Regenerate via scripts/gen-code-map-langs-witness.mjs only on intentional change.',
      tree_captures: oversized
        ? []
        : { tags: captureList(grammar, source, tagsSrc), imports: captureList(grammar, source, importsSrc) },
      draft: sanitizeDraft(refined),
      result,
    };
  }
  const outPath = path.join(ROOT, cfg.dir, `${lang}-witness.json`);
  fs.writeFileSync(outPath, JSON.stringify(witness, null, 2) + '\n', 'utf-8');
  console.log(`[gen-witness] wrote ${path.relative(ROOT, outPath)} (${Object.keys(witness).length} fixtures)`);
}
