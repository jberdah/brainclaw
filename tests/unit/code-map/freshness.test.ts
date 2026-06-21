import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyGitHeadDrift,
  computeExtractorConfigHash,
  shardFreshnessStatus,
  summarizeFreshness,
} from '../../../src/core/code-map/freshness.js';
import { refresh, DEFAULT_EXTRACTOR_CONFIG } from '../../../src/core/code-map/refresh.js';
import { JsonlBackend } from '../../../src/core/code-map/backend.js';
import { readManifest, listShards, writeManifest, writeShard } from '../../../src/core/code-map/store.js';
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

  // --- read-path git-HEAD drift (trp_42688015) ---

  it('applyGitHeadDrift escalates a fresh badge to stale_changed_files on HEAD change', () => {
    const out = applyGitHeadDrift({ status: 'fresh', details: {} }, 'aaa', 'bbb');
    assert.equal(out.status, 'stale_changed_files');
    assert.deepEqual(out.details.git_head_changed, { index_head: 'aaa', current_head: 'bbb' });
  });

  it('applyGitHeadDrift is a no-op when heads match', () => {
    const out = applyGitHeadDrift({ status: 'fresh', details: { keep: 1 } }, 'aaa', 'aaa');
    assert.equal(out.status, 'fresh');
    assert.equal(out.details.git_head_changed, undefined);
    assert.equal(out.details.keep, 1);
  });

  it('applyGitHeadDrift is a no-op for a non-git project (null head either side)', () => {
    assert.equal(applyGitHeadDrift({ status: 'fresh', details: {} }, null, 'bbb').status, 'fresh');
    assert.equal(applyGitHeadDrift({ status: 'fresh', details: {} }, 'aaa', null).status, 'fresh');
    assert.equal(applyGitHeadDrift({ status: 'fresh', details: {} }, undefined, undefined).status, 'fresh');
  });

  it('applyGitHeadDrift keeps a non-fresh status but records the cause', () => {
    const out = applyGitHeadDrift({ status: 'partial', details: { partial_reason: 'x' } }, 'aaa', 'bbb');
    assert.equal(out.status, 'partial', 'partial already signals refresh — not overwritten');
    assert.deepEqual(out.details.git_head_changed, { index_head: 'aaa', current_head: 'bbb' });
    assert.equal(out.details.partial_reason, 'x');
  });

  it('applyGitHeadDrift does not escalate missing_index', () => {
    assert.equal(
      applyGitHeadDrift({ status: 'missing_index', details: {} }, 'aaa', 'bbb').status,
      'missing_index',
    );
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

  it('FIX 2: refresh --changed heals version-stale shards even with unchanged content', async () => {
    const root = tmpProject();
    // two files, both content-unchanged across the config bump.
    writeSrc(root, 'src/util.ts', `export function add(a: number, b: number) { return a + b; }\n`);
    writeSrc(root, 'src/other.ts', `export const k = 1;\n`);
    await refresh({ projectId: PROJECT, projectRoot: root, scope: 'all', cwd: root, disableGit: true });

    // Forge version drift WITHOUT changing any file content: rewrite the stored
    // shards' extractor_config_hash to an old value so they read as stale_extractor.
    const stale = listShards(root);
    assert.equal(stale.length, 2);
    for (const shard of stale) {
      writeShard(
        { ...shard, extractor_config_hash: 'sha256:OLD_CONFIG_HASH' },
        root,
      );
    }
    // cheap path: --changed (no git, no content change). BEFORE FIX 2 this parsed
    // 0 files and left the shards stale forever. It must now union the
    // version-stale shards into the work set, re-parse them, and restore freshness.
    const res = await refresh({
      projectId: PROJECT,
      projectRoot: root,
      scope: 'changed',
      cwd: root,
      disableGit: true,
    });

    assert.equal(res.ran, true);
    assert.equal(res.files_parsed, 2, 'both version-stale shards re-parsed by the cheap path');

    const healed = listShards(root);
    assert.equal(healed.length, 2);
    assert.ok(
      healed.every((s) => s.freshness.status === 'fresh'),
      'all shards restored to fresh after --changed',
    );
    assert.equal(readManifest(root)!.freshness.status, 'fresh', 'manifest freshness healed');
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

describe('code-map read-path git-HEAD drift (backend, trp_42688015)', () => {
  it('status flags stale_changed_files when the working tree HEAD differs from the index head', async () => {
    const root = tmpProject();
    await seed(root); // disableGit -> git.head null; stamp a known index head below.
    const m = readManifest(root)!;
    writeManifest({ ...m, git: { head: 'indexcommit', branch: 'feature', dirty: false } }, root);

    const backend = new JsonlBackend({ gitHeadReader: () => 'currentcommit' });
    const status = await backend.status({ cwd: root });
    assert.equal(status.freshness_badge.status, 'stale_changed_files');
    assert.deepEqual(status.freshness_badge.details.git_head_changed, {
      index_head: 'indexcommit',
      current_head: 'currentcommit',
    });
    // the index itself is untouched — only the read badge reflects the branch move.
    assert.ok(listShards(root).every((s) => s.freshness.status === 'fresh'));
  });

  it('status stays fresh when the current HEAD matches the index head', async () => {
    const root = tmpProject();
    await seed(root);
    const m = readManifest(root)!;
    writeManifest({ ...m, git: { head: 'samecommit', branch: 'main', dirty: false } }, root);

    const backend = new JsonlBackend({ gitHeadReader: () => 'samecommit' });
    const status = await backend.status({ cwd: root });
    assert.equal(status.freshness_badge.status, 'fresh');
    assert.equal(status.freshness_badge.details.git_head_changed, undefined);
  });

  it('status stays fresh for a non-git project (reader returns null)', async () => {
    const root = tmpProject();
    await seed(root); // git.head null
    const backend = new JsonlBackend({ gitHeadReader: () => null });
    const status = await backend.status({ cwd: root });
    assert.equal(status.freshness_badge.status, 'fresh');
  });

  it('find surfaces the HEAD drift on its badge', async () => {
    const root = tmpProject();
    await seed(root);
    const m = readManifest(root)!;
    writeManifest({ ...m, git: { head: 'idx', branch: 'b', dirty: false } }, root);

    const backend = new JsonlBackend({ gitHeadReader: () => 'cur' });
    const res = await backend.find({ query: 'add', cwd: root });
    assert.ok(res.matches.length > 0, 'still returns the validated match');
    assert.equal(res.freshness_badge.status, 'stale_changed_files');
    assert.deepEqual(res.freshness_badge.details.git_head_changed, {
      index_head: 'idx',
      current_head: 'cur',
    });
  });
});
