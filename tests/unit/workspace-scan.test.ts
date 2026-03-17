import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanWorkspaceBoundaries } from '../../src/core/repo-analysis.js';
import { ensureMemoryDir } from '../../src/core/io.js';

function makeTmpDir(prefix = 'bclaw-scan-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('scanWorkspaceBoundaries', () => {
  it('returns empty when no service markers exist', () => {
    const root = makeTmpDir();
    try {
      const result = scanWorkspaceBoundaries(root);
      assert.equal(result.suggestions.length, 0);
      assert.equal(result.alreadyInitialised.length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects a subdirectory with package.json as a suggestion', () => {
    const root = makeTmpDir();
    try {
      const svc = path.join(root, 'service-a');
      fs.mkdirSync(svc, { recursive: true });
      fs.writeFileSync(path.join(svc, 'package.json'), '{}', 'utf-8');

      const result = scanWorkspaceBoundaries(root);
      assert.equal(result.suggestions.length, 1);
      assert.equal(result.suggestions[0]!.relativePath, 'service-a');
      assert.ok(result.suggestions[0]!.markers.includes('package.json'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects a subdirectory with Dockerfile as a suggestion', () => {
    const root = makeTmpDir();
    try {
      const svc = path.join(root, 'api');
      fs.mkdirSync(svc, { recursive: true });
      fs.writeFileSync(path.join(svc, 'Dockerfile'), '', 'utf-8');

      const result = scanWorkspaceBoundaries(root);
      assert.equal(result.suggestions.length, 1);
      assert.ok(result.suggestions[0]!.markers.includes('Dockerfile'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('puts already-initialised dirs in alreadyInitialised, not suggestions', () => {
    const root = makeTmpDir();
    try {
      const svc = path.join(root, 'app');
      fs.mkdirSync(svc, { recursive: true });
      fs.writeFileSync(path.join(svc, 'package.json'), '{}', 'utf-8');
      ensureMemoryDir(svc);

      const result = scanWorkspaceBoundaries(root);
      assert.equal(result.suggestions.length, 0);
      assert.equal(result.alreadyInitialised.length, 1);
      assert.equal(result.alreadyInitialised[0]!.relativePath, 'app');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips node_modules and .git directories', () => {
    const root = makeTmpDir();
    try {
      const nm = path.join(root, 'node_modules', 'some-pkg');
      fs.mkdirSync(nm, { recursive: true });
      fs.writeFileSync(path.join(nm, 'package.json'), '{}', 'utf-8');

      const git = path.join(root, '.git', 'hooks');
      fs.mkdirSync(git, { recursive: true });
      fs.writeFileSync(path.join(git, 'package.json'), '{}', 'utf-8');

      const result = scanWorkspaceBoundaries(root);
      assert.equal(result.suggestions.length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects multiple services at the same level', () => {
    const root = makeTmpDir();
    try {
      for (const name of ['api', 'worker', 'frontend']) {
        const svc = path.join(root, name);
        fs.mkdirSync(svc, { recursive: true });
        fs.writeFileSync(path.join(svc, 'package.json'), '{}', 'utf-8');
      }

      const result = scanWorkspaceBoundaries(root);
      assert.equal(result.suggestions.length, 3);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not recurse into matched service boundaries', () => {
    const root = makeTmpDir();
    try {
      // svc/package.json → boundary found, stop recursing
      const svc = path.join(root, 'svc');
      fs.mkdirSync(svc, { recursive: true });
      fs.writeFileSync(path.join(svc, 'package.json'), '{}', 'utf-8');
      // nested sub — should not appear since parent already matched
      const nested = path.join(svc, 'nested');
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, 'package.json'), '{}', 'utf-8');

      const result = scanWorkspaceBoundaries(root);
      assert.equal(result.suggestions.length, 1);
      assert.equal(result.suggestions[0]!.relativePath, 'svc');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('respects maxDepth — does not recurse beyond limit', () => {
    const root = makeTmpDir();
    try {
      const deep = path.join(root, 'a', 'b', 'c', 'd');
      fs.mkdirSync(deep, { recursive: true });
      fs.writeFileSync(path.join(deep, 'package.json'), '{}', 'utf-8');

      const result = scanWorkspaceBoundaries(root, 2);
      assert.equal(result.suggestions.length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
