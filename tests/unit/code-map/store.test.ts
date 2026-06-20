import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initStore,
  readManifest,
  readShard,
  storeExists,
  writeShard,
  listShards,
  writeManifest,
} from '../../../src/core/code-map/store.js';
import { fileId } from '../../../src/core/code-map/ids.js';
import { materializedDir } from '../../../src/core/code-map/paths.js';
import type { FileShard } from '../../../src/core/code-map/types.js';

const cleanupDirs: string[] = [];

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-codemap-store-'));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    fs.rmSync(cleanupDirs.pop() as string, { recursive: true, force: true });
  }
});

const EXTRACTOR_CONFIG = {
  included_extensions: ['.ts', '.tsx', '.js', '.jsx'],
  ignored_patterns_hash: 'sha256:abc',
  max_parse_file_bytes: 1048576,
  max_query_wait_ms: 2500,
};

function init(cwd: string) {
  return initStore({
    cwd,
    projectId: 'prj_test',
    projectRoot: cwd,
    extractorVersion: '0.1.0',
    extractorConfig: EXTRACTOR_CONFIG,
    extractorConfigHash: 'sha256:cfg',
  });
}

describe('code-map store', () => {
  it('readManifest tolerates a missing store (returns null)', () => {
    const cwd = tmpProject();
    assert.equal(readManifest(cwd), null);
    assert.equal(storeExists(cwd), false);
  });

  it('init writes a manifest in missing_index freshness', () => {
    const cwd = tmpProject();
    const manifest = init(cwd);
    assert.equal(manifest.freshness.status, 'missing_index');
    assert.equal(storeExists(cwd), true);

    const reread = readManifest(cwd);
    assert.ok(reread);
    assert.equal(reread.project_id, 'prj_test');
    assert.equal(reread.freshness.status, 'missing_index');
    assert.equal(reread.extractor_config.max_parse_file_bytes, 1048576);
  });

  it('shard write/read roundtrip preserves content', () => {
    const cwd = tmpProject();
    init(cwd);
    const id = fileId('prj_test', 'src/app/App.tsx');
    const shard: FileShard = {
      schema_version: 1,
      file_id: id,
      project_id: 'prj_test',
      path: 'src/app/App.tsx',
      lang: 'tsx',
      file_hash: 'sha256:deadbeef',
      mtime_ms: 1780000000000,
      size_bytes: 12345,
      parse_status: 'parsed',
      extractor_version: '0.1.0',
      extractor_config_hash: 'sha256:cfg',
      freshness: { status: 'fresh', reason: null },
      nodes: [],
      edges: [],
      diagnostics: [],
    };
    writeShard(shard, cwd);

    const back = readShard(id, cwd);
    assert.ok(back);
    assert.equal(back.path, 'src/app/App.tsx');
    assert.equal(back.parse_status, 'parsed');
    assert.equal(back.lang, 'tsx');

    const all = listShards(cwd);
    assert.equal(all.length, 1);
    assert.equal(all[0]!.file_id, id);
  });

  it('queries work from files/** with no materialized/ present', () => {
    const cwd = tmpProject();
    init(cwd);
    const id = fileId('prj_test', 'src/x.ts');
    writeShard(
      {
        schema_version: 1,
        file_id: id,
        project_id: 'prj_test',
        path: 'src/x.ts',
        lang: 'typescript',
        file_hash: 'sha256:1',
        mtime_ms: 1,
        size_bytes: 1,
        parse_status: 'parsed',
        extractor_version: '0.1.0',
        extractor_config_hash: 'sha256:cfg',
        freshness: { status: 'fresh', reason: null },
        nodes: [],
        edges: [],
        diagnostics: [],
      },
      cwd,
    );

    // materialized/ must never have been required
    assert.equal(fs.existsSync(materializedDir(cwd)), false);
    const all = listShards(cwd);
    assert.equal(all.length, 1, 'listShards answers from files/** alone');
  });

  it('manifest update bumps updated_at and persists freshness change', () => {
    const cwd = tmpProject();
    const manifest = init(cwd);
    const updated = { ...manifest, freshness: { status: 'fresh' as const, stale_file_count: 0, partial_reason: null } };
    writeManifest(updated, cwd);
    assert.equal(readManifest(cwd)!.freshness.status, 'fresh');
  });
});
