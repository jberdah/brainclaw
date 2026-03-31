import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SecurityCache } from '../../src/core/security-cache.js';
import type { PackageScores } from '../../src/core/socket-client.js';

function makeScores(overrides: Partial<PackageScores> = {}): PackageScores {
  return {
    purl: 'pkg:npm/test-pkg',
    version: '1.0.0',
    supplyChain: 90,
    vulnerability: 100,
    quality: 90,
    maintenance: 90,
    license: 100,
    ...overrides,
  };
}

describe('SecurityCache', () => {
  let tmpDir: string;
  let cachePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brainclaw-cache-test-'));
    cachePath = path.join(tmpDir, 'cache.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null for missing entry', () => {
    const cache = new SecurityCache(cachePath);
    assert.equal(cache.get('npm', 'express', '4.18.0'), null);
  });

  it('stores and retrieves entry', () => {
    const cache = new SecurityCache(cachePath);
    const scores = makeScores({ purl: 'pkg:npm/express', version: '4.18.0' });
    cache.set('npm', 'express', '4.18.0', scores);

    const result = cache.get('npm', 'express', '4.18.0');
    assert.ok(result);
    assert.equal(result.supplyChain, 90);
  });

  it('persists to disk on flush', () => {
    const cache = new SecurityCache(cachePath);
    cache.set('npm', 'express', '4.18.0', makeScores());
    cache.flush();

    // Create new cache instance from same file
    const cache2 = new SecurityCache(cachePath);
    const result = cache2.get('npm', 'express', '4.18.0');
    assert.ok(result);
  });

  it('returns null for expired entry', () => {
    // Write a cache file with an entry dated 1 day ago
    fs.writeFileSync(cachePath, JSON.stringify({
      version: 1,
      entries: {
        'npm/express@4.18.0': {
          scores: makeScores(),
          fetched_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        },
      },
    }));

    const cache = new SecurityCache(cachePath, 1); // 1 hour TTL
    const result = cache.get('npm', 'express', '4.18.0');
    assert.equal(result, null);
  });

  it('prunes expired entries', () => {
    // Write a cache file with an old entry
    fs.writeFileSync(cachePath, JSON.stringify({
      version: 1,
      entries: {
        'npm/old-pkg@1.0.0': {
          scores: makeScores(),
          fetched_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        },
        'npm/fresh-pkg@1.0.0': {
          scores: makeScores(),
          fetched_at: new Date().toISOString(),
        },
      },
    }));

    const cache = new SecurityCache(cachePath, 24); // 24h TTL
    const pruned = cache.prune();
    assert.equal(pruned, 1);
    assert.equal(cache.size(), 1);
  });

  it('handles corrupt cache file gracefully', () => {
    fs.writeFileSync(cachePath, 'not json at all');
    const cache = new SecurityCache(cachePath);
    assert.equal(cache.size(), 0);
    assert.equal(cache.get('npm', 'anything', '1.0.0'), null);
  });

  it('handles missing cache file gracefully', () => {
    const cache = new SecurityCache(path.join(tmpDir, 'nonexistent', 'cache.json'));
    assert.equal(cache.size(), 0);
  });

  it('differentiates ecosystems', () => {
    const cache = new SecurityCache(cachePath);
    const npmScores = makeScores({ purl: 'pkg:npm/requests', supplyChain: 99 });
    const pypiScores = makeScores({ purl: 'pkg:pypi/requests', supplyChain: 96 });

    cache.set('npm', 'requests', '1.0.0', npmScores);
    cache.set('pypi', 'requests', '2.32.0', pypiScores);

    const npmResult = cache.get('npm', 'requests', '1.0.0');
    const pypiResult = cache.get('pypi', 'requests', '2.32.0');
    assert.equal(npmResult?.supplyChain, 99);
    assert.equal(pypiResult?.supplyChain, 96);
  });
});
