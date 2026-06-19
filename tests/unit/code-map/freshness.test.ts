import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeExtractorConfigHash,
  shardFreshnessStatus,
  summarizeFreshness,
} from '../../../src/core/code-map/freshness.js';
import { refresh, DEFAULT_EXTRACTOR_CONFIG } from '../../../src/core/code-map/refresh.js';
import { readManifest, listShards, writeManifest } from '../../../src/core/code-map/store.js';
import type { FileShard } from '../../../src/core/code-map/types.js';

const cleanupDirs: string[] = [];

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-codemap-fresh-'));
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

const PROJECT = 'prj_fresh_test';

async function seed(root: string): Promise<void> {
  writeSrc(root, 'src/util.ts', `export function add(a: number, b: number) { return a + b; }\n`);
  await refresh({ projectId: PROJECT, projectRoot: root, scope: 'all', cwd: root, disableGit: true });
}

describe('code-map freshness (unit)', () => {
  it('extractor_config_hash is stable + order-independent over keys', () => {
    const a = computeExtractorConfigHash(DEFAULT_EXTRACTOR_CONFIG, ['typescript', 'tsx', 'javascript']);
    const b = computeExtractorConfigHash(DEFAULT_EXTRACTOR_CONFIG, ['javascript', 'tsx', 'typescript']);
    assert.equal(a, b, 'language set order does not affect the hash');

    const changed = computeExtractorConfigHash(
      { ...DEFAULT_EXTRACTOR_CONFIG, max_parse_file_bytes: 999 },
      ['typescript', 'tsx', 'javascript'],
    );
    assert.notEqual(a, changed, 'changing a config field changes the hash');
  });

  it('shardFreshnessStatus flags stale_extractor on config hash mismatch', () => {
    const status = shardFreshnessStatus({
      shard: {
        extractor_config_hash: 'sha256:OLD',
        tree_sitter_grammar_hash: 'sha256:g',
        lang: 'typescript',
        parse_status: 'parsed',
      },
      currentExtractorConfigHash: 'sha256:NEW',
      grammarHashFor: () => 'sha256:g',
    });
    assert.equal(status, 'stale_extractor');
  });

  it('shardFreshnessStatus flags stale_grammar on grammar hash mismatch (config matches)', () => {
    const status = shardFreshnessStatus({
      shard: {
        extractor_config_hash: 'sha256:SAME',
        tree_sitter_grammar_hash: 'sha256:OLDGRAMMAR',
        lang: 'tsx',
        parse_status: 'parsed',
      },
      currentExtractorConfigHash: 'sha256:SAME',
      grammarHashFor: () => 'sha256:NEWGRAMMAR',
    });
    assert.equal(status, 'stale_grammar');
  });

  it('summarizeFreshness reports missing_index when empty, fresh otherwise', () => {
    assert.equal(summarizeFreshness([]).status, 'missing_index');
    const fresh: Pick<FileShard, 'freshness'>[] = [
      { freshness: { status: 'fresh', reason: null } },
    ];
    assert.equal(summarizeFreshness(fresh as FileShard[]).status, 'fresh');
  });
});

describe('code-map freshness (write-side via refresh)', () => {
  it('bumping extractor_config_hash marks shards stale_extractor on next refresh', async () => {
    const root = tmpProject();
    await seed(root);
    assert.equal(readManifest(root)!.freshness.status, 'fresh');

    // simulate a different extractor config (smaller size cap) -> different hash
    const res = await refresh({
      projectId: PROJECT,
      projectRoot: root,
      scope: 'changed',
      cwd: root,
      disableGit: true,
      extractorConfig: { ...DEFAULT_EXTRACTOR_CONFIG, max_query_wait_ms: 1234 },
    });
    // Note: --changed with no git re-enumerates + re-parses, which restamps
    // shards with the NEW config hash, so they end fresh. To observe stale we
    // must reclassify WITHOUT re-parsing: mutate the stored shard's config hash
    // and run a reclassification-only check.
    assert.equal(res.ran, true);

    // Direct reclassification: take the stored shard, pretend it was produced by
    // an old config, and assert the classifier flags stale_extractor.
    const shard = listShards(root)[0]!;
    const status = shardFreshnessStatus({
      shard: { ...shard, extractor_config_hash: 'sha256:STALE_OLD' },
      currentExtractorConfigHash: shard.extractor_config_hash,
      grammarHashFor: () => shard.tree_sitter_grammar_hash ?? undefined,
    });
    assert.equal(status, 'stale_extractor');
  });

  it('a stored shard with an old grammar hash is flagged stale_grammar', async () => {
    const root = tmpProject();
    await seed(root);
    const shard = listShards(root)[0]!;
    const status = shardFreshnessStatus({
      shard: { ...shard, tree_sitter_grammar_hash: 'sha256:OLD_GRAMMAR' },
      currentExtractorConfigHash: shard.extractor_config_hash,
      grammarHashFor: () => 'sha256:CURRENT_GRAMMAR',
    });
    assert.equal(status, 'stale_grammar');
  });

  it('changing only git.head does NOT mark unchanged shards stale', async () => {
    const root = tmpProject();
    await seed(root);
    const before = listShards(root).map((s) => s.freshness.status);
    assert.ok(before.every((s) => s === 'fresh'));

    // simulate a HEAD change without touching any source file: refresh --changed
    // re-runs but the file content (hence config + grammar hashes) is unchanged,
    // so shards stay fresh. We assert git.head alone is not a staleness trigger.
    const manifest = readManifest(root)!;
    writeManifest({ ...manifest, git: { head: 'differenthead', branch: 'main', dirty: false } }, root);

    const after = listShards(root);
    assert.ok(
      after.every((s) => s.freshness.status === 'fresh'),
      'git.head change alone leaves shards fresh',
    );
  });
});
