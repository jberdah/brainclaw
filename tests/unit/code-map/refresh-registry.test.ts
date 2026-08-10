/**
 * Code Map P1a — refresh ↔ registry cutover (spec §9 / Sprint 4 item 4).
 *
 * Proves the post-cutover refresh pipeline is registry-driven:
 *  - extension → provider routing (a `.ts` and a `.jsx` route correctly; an
 *    unknown extension is skipped, never indexed);
 *  - `manifest.languages` is sourced from `registry.languageEntries()`;
 *  - bumping a query-asset hash (via `registry.configHashInputs()`) flips the
 *    affected shards to `stale_extractor`;
 *  - the symbols + imports indexes are produced with the expected structure.
 *
 * (Per-shard byte-equality vs pre-P1a is the orchestrator's dogfood gate, not here.)
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refresh } from '../../../src/core/code-map/refresh.js';
import { defaultRegistry } from '../../../src/core/code-map/core.js';
import { computeExtractorConfigHash, shardFreshnessStatus } from '../../../src/core/code-map/freshness.js';
import { loadTypeScriptResolutionConfig } from '../../../src/core/code-map/lang/typescript/config.js';
import { DEFAULT_EXTRACTOR_CONFIG } from '../../../src/core/code-map/refresh.js';
import { readManifest, listShards, readSymbolsIndex, readImportsIndex } from '../../../src/core/code-map/store.js';
import type { CodeLanguageRegistry, RegistryLanguageEntry } from '../../../src/core/code-map/lang/provider.js';
import type { CodeLang } from '../../../src/core/code-map/types.js';

const cleanupDirs: string[] = [];

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-codemap-reg-'));
  cleanupDirs.push(dir);
  return dir;
}

function writeSrc(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    fs.rmSync(cleanupDirs.pop() as string, { recursive: true, force: true });
  }
});

const PROJECT = 'prj_refresh_registry_test';

/**
 * A small mixed-extension fixture: a .ts, a .jsx, a .py (Python provider registered
 * since P1b), plus an UNSUPPORTED .md.
 */
function fixture(root: string): void {
  writeSrc(root, 'src/util.ts', `export function add(a: number, b: number) { return a + b; }\n`);
  writeSrc(
    root,
    'src/App.jsx',
    `import React from 'react';\nexport const App = () => <div>app</div>;\n`,
  );
  writeSrc(root, 'src/script.py', `def f():\n    return 1\n`);
  // unsupported extension — no provider owns it, must be skipped.
  writeSrc(root, 'README.md', `# not code\n`);
}

async function runAll(root: string, registry?: CodeLanguageRegistry) {
  return refresh({
    projectId: PROJECT,
    projectRoot: root,
    scope: 'all',
    cwd: root,
    disableGit: true,
    registry,
  });
}

/**
 * Wrap the real registry but override `configHashInputs()` so we can simulate a
 * query-asset (`.scm`) edit without touching the vendored files. Everything else
 * (routing, language entries, extensions) delegates to the real default registry.
 */
function registryWithBumpedQueryHash(): CodeLanguageRegistry {
  return {
    register: (p) => defaultRegistry.register(p),
    providerForPath: (p) => defaultRegistry.providerForPath(p),
    providerForLang: (l) => defaultRegistry.providerForLang(l),
    activeLanguages: () => defaultRegistry.activeLanguages(),
    includedExtensions: () => defaultRegistry.includedExtensions(),
    languageEntries: () => defaultRegistry.languageEntries(),
    // Pretend a tags.scm changed: a different fingerprint => different config hash.
    configHashInputs: () => [{ id: 'js-ts', version: '0.1.0', queries: [{ tags: 'sha256:EDITED' }] }],
  };
}

describe('code-map refresh ↔ registry (P1a cutover)', () => {
  it('routes .ts, .jsx and .py via the registry; skips unsupported extensions', async () => {
    const root = tmpProject();
    fixture(root);
    const res = await runAll(root);

    assert.equal(res.ran, true);
    assert.equal(res.files_parsed, 3, 'the .ts + .jsx + .py are routed to a provider');

    const shards = listShards(root);
    const paths = shards.map((s) => s.path).sort();
    assert.deepEqual(paths, ['src/App.jsx', 'src/script.py', 'src/util.ts']);

    // .jsx resolves to the tsx runtime lang (registry langForPath); .ts → typescript;
    // .py → python (PythonProvider registered since P1b).
    const byPath = new Map(shards.map((s) => [s.path, s.lang]));
    assert.equal(byPath.get('src/util.ts'), 'typescript' as CodeLang);
    assert.equal(byPath.get('src/App.jsx'), 'tsx' as CodeLang);
    assert.equal(byPath.get('src/script.py'), 'python' as CodeLang);

    // unsupported extensions never produced a shard.
    assert.ok(!shards.some((s) => s.path.endsWith('.md')), '.md skipped');
  });

  it('manifest.languages comes from registry.languageEntries()', async () => {
    const root = tmpProject();
    fixture(root);
    await runAll(root);

    const manifest = readManifest(root)!;
    const expected = defaultRegistry.languageEntries() as Record<string, RegistryLanguageEntry>;
    assert.deepEqual(
      Object.keys(manifest.languages).sort(),
      Object.keys(expected).sort(),
      'manifest languages keyed by the registry active langs',
    );
    for (const lang of Object.keys(expected)) {
      const entry = manifest.languages[lang]!;
      assert.equal(entry.enabled, expected[lang]!.enabled);
      assert.equal(entry.grammar_name, expected[lang]!.grammar_name);
      assert.equal(entry.grammar_version, expected[lang]!.grammar_version);
      assert.equal(entry.tree_sitter_grammar_hash, expected[lang]!.tree_sitter_grammar_hash);
    }
  });

  it('bumping a query-asset hash flips shards to stale_extractor', async () => {
    const root = tmpProject();
    fixture(root);
    await runAll(root);
    assert.equal(readManifest(root)!.freshness.status, 'fresh');

    // The config hash folds in the registry fingerprint, so a different query-asset
    // hash yields a different extractor_config_hash for the SAME config + langs.
    const resolverConfigFingerprint = loadTypeScriptResolutionConfig(root).fingerprint;
    const baseHash = computeExtractorConfigHash(
      DEFAULT_EXTRACTOR_CONFIG,
      defaultRegistry.activeLanguages(),
      defaultRegistry.configHashInputs(),
      resolverConfigFingerprint,
    );
    const bumpedReg = registryWithBumpedQueryHash();
    const bumpedHash = computeExtractorConfigHash(
      DEFAULT_EXTRACTOR_CONFIG,
      bumpedReg.activeLanguages(),
      bumpedReg.configHashInputs(),
      resolverConfigFingerprint,
    );
    assert.notEqual(baseHash, bumpedHash, 'editing a query asset changes the config hash');

    // A shard stamped under the original assets must read as stale_extractor once
    // the query asset (hence the registry fingerprint) changes.
    const shard = listShards(root)[0]!;
    assert.equal(shard.extractor_config_hash, baseHash, 'shard stamped with the live config hash');
    const status = shardFreshnessStatus({
      shard,
      currentExtractorConfigHash: bumpedHash,
      grammarHashFor: () => shard.tree_sitter_grammar_hash ?? undefined,
    });
    assert.equal(status, 'stale_extractor', 'query-asset edit => stale_extractor');
  });

  it('produces the symbols + imports indexes with the expected structure', async () => {
    const root = tmpProject();
    fixture(root);
    await runAll(root);

    const symbols = readSymbolsIndex(root);
    assert.ok(symbols, 'symbols index written');
    assert.ok(symbols!.entries['add'], 'add() indexed from util.ts');
    assert.ok(symbols!.entries['app'], 'App indexed from App.jsx (lowercase token)');
    const addEntry = symbols!.entries['add']!.find((e) => e.path === 'src/util.ts');
    assert.ok(addEntry, 'symbol entry carries its defining path');

    const imports = readImportsIndex(root);
    assert.ok(imports, 'imports index written');
    assert.ok(imports!.entries['react'], 'react import indexed from App.jsx');
    const reactEntry = imports!.entries['react']!.find((e) => e.path === 'src/App.jsx');
    assert.ok(reactEntry, 'react import attributed to App.jsx');
    assert.deepEqual(reactEntry!.imported, ['default'], 'default import binding captured');
  });
});
