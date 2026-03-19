import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { loadConfig, saveConfig } from '../../src/core/config.js';
import { loadCurrentSession, saveCurrentSession } from '../../src/core/identity.js';
import { MigrationError, migrateVersionedDocument, scanMigrationStatus } from '../../src/core/migration.js';
import type { Claim } from '../../src/core/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

describe('core/migration', () => {
  let workspace: TestWorkspace | undefined;

  afterEach(() => {
    workspace?.cleanup();
    workspace = undefined;
  });

  it('loads legacy config in memory without rewriting it implicitly', () => {
    workspace = createTestWorkspace({ prefix: 'bclaw-migration-config-' });

    const configPath = path.join(workspace.dir, '.brainclaw', 'config.yaml');
    const legacyConfig = {
      version: 1,
      project_name: 'legacy-project',
      project_id: 'prj_legacy',
      storage_dir: '.brainclaw',
      topology: 'embedded',
      ignore_strategy: 'none',
      project_mode: 'auto',
      projects: { strategy: 'manual', known: [] },
      profile: 'dev',
      target_audience: 'human',
      openclaw_bridge: false,
      telemetry: false,
      allow_network: false,
      redaction: { enabled: true, patterns: ['secret'] },
      sensitive_paths: ['.env'],
      security: { mode: 'warn', strict_redaction: false, block_sensitive_paths: true },
      markdown: { max_items_per_section: 20, compact_mode: false },
      reflective_memory: {
        enabled: true,
        auto_accept: false,
        max_pending: 50,
        promotion_stars_threshold: 3,
        promotion_uses_threshold: 2,
        prune_rejected_after_days: 30,
        auto_promote_trusted: false,
        auto_promote_score_threshold: 5,
      },
      governance: { approval_policy: 'review', curators: [], review_sla_hours: 24 },
      reputation: {
        enabled: false,
        visibility: 'internal-only',
        decay_days: 30,
        ranking_weight: 0.15,
        resume_weight: 0.35,
        mcp_exposure: false,
      },
      implicit_session_ttl: '4h',
      auto_reflect_notes: false,
    };
    fs.writeFileSync(configPath, YAML.stringify(legacyConfig, { lineWidth: 0 }), 'utf-8');

    const beforeLoad = fs.readFileSync(configPath, 'utf-8');
    const loaded = loadConfig(workspace.dir);
    const afterLoad = fs.readFileSync(configPath, 'utf-8');

    assert.equal(loaded.schema_version, 2);
    assert.equal(loaded.project_id, 'prj_legacy');
    assert.equal(afterLoad, beforeLoad);

    saveConfig(loaded, workspace.dir);
    const rewritten = YAML.parse(fs.readFileSync(configPath, 'utf-8')) as { schema_version?: number };
    assert.equal(rewritten.schema_version, 2);
  });

  it('migrates legacy current sessions and persists schema_version on save', () => {
    workspace = createTestWorkspace({ prefix: 'bclaw-migration-session-' });

    const sessionPath = path.join(workspace.dir, '.brainclaw', '.current-session');
    fs.writeFileSync(sessionPath, JSON.stringify({
      session_id: 'sess_legacy',
      started_at: '2026-03-15T09:00:00.000Z',
      last_seen_at: '2026-03-15T09:10:00.000Z',
      agent: 'legacy-agent',
      agent_id: 'agt_legacy',
      host_id: 'host_legacy',
    }, null, 2), 'utf-8');

    const loaded = loadCurrentSession(workspace.dir);
    assert.equal(loaded?.schema_version, 2);
    assert.equal(loaded?.session_id, 'sess_legacy');

    saveCurrentSession(loaded!, workspace.dir);
    const persisted = JSON.parse(fs.readFileSync(sessionPath, 'utf-8')) as { schema_version?: number };
    assert.equal(persisted.schema_version, 2);
  });

  it('reports outdated and invalid versioned documents during scanning', () => {
    workspace = createTestWorkspace({ prefix: 'bclaw-migration-scan-' });

    const claimsDir = path.join(workspace.dir, '.brainclaw', 'coordination', 'claims');
    fs.mkdirSync(claimsDir, { recursive: true });
    const legacyClaim: Claim = {
      id: 'clm_legacy',
      agent: 'copilot',
      scope: 'src/auth',
      description: 'Legacy claim',
      created_at: '2026-03-15T09:00:00.000Z',
      status: 'active',
    };
    fs.writeFileSync(path.join(claimsDir, 'clm_legacy.json'), JSON.stringify(legacyClaim, null, 2), 'utf-8');
    fs.writeFileSync(path.join(claimsDir, 'broken.json'), '{bad-json', 'utf-8');

    const entries = scanMigrationStatus(workspace.dir);
    assert.ok(entries.some((entry) => entry.documentType === 'claim' && entry.status === 'outdated' && entry.detectedVersion === 1));
    assert.ok(entries.some((entry) => entry.documentType === 'claim' && entry.status === 'invalid'));
  });

  it('rejects unsupported newer schema versions', () => {
    assert.throws(
      () => migrateVersionedDocument('claim', {
        schema_version: 99,
        id: 'clm_future',
        agent: 'copilot',
        scope: 'src/auth',
        description: 'Future claim',
        created_at: '2026-03-15T09:00:00.000Z',
        status: 'active',
      }),
      (error: unknown) => error instanceof MigrationError && error.kind === 'unknown_version',
    );
  });
});

