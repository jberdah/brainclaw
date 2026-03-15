import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../../src/core/config.js';
import { buildProjectIdentity } from '../../src/core/project-registry.js';

describe('core/config + project identity', () => {
  it('builds a default config aligned on .brainclaw', () => {
    const config = defaultConfig('shared-agent-memory-mvp');

    assert.equal(config.storage_dir, '.brainclaw');
    assert.equal(config.topology, 'embedded');
    assert.equal(config.project_mode, 'auto');
    assert.equal(config.projects.strategy, 'manual');
    assert.ok(config.reputation);
    assert.equal(config.reputation.enabled, false);
  });

  it('preserves an existing project identity when rebuilding it', () => {
    const existing = {
      version: 1 as const,
      project_id: 'prj_existing',
      project_name: 'old-name',
      created_at: '2026-03-15T10:00:00Z',
      storage_dir: '.brainclaw',
      topology: 'embedded' as const,
    };

    const identity = buildProjectIdentity({
      existing,
      projectName: 'new-name',
      storageDir: '.brainclaw',
      topology: 'sidecar',
    });

    assert.equal(identity.project_id, 'prj_existing');
    assert.equal(identity.created_at, existing.created_at);
    assert.equal(identity.project_name, 'new-name');
    assert.equal(identity.storage_dir, '.brainclaw');
    assert.equal(identity.topology, 'sidecar');
  });
});
