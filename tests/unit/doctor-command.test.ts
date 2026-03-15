import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { archiveCandidate, saveCandidate } from '../../src/core/candidates.js';
import { saveClaim } from '../../src/core/claims.js';
import { loadConfig } from '../../src/core/config.js';
import { writeContextMarker } from '../../src/core/freshness.js';
import { generateMarkdown } from '../../src/core/markdown.js';
import { buildProjectIdentity, saveProjectIdentity } from '../../src/core/project-registry.js';
import { saveRuntimeNote } from '../../src/core/runtime.js';
import { emptyState, saveState } from '../../src/core/state.js';
import { runDoctor } from '../../src/commands/doctor.js';
import type { Candidate, Claim } from '../../src/core/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function iso(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
}

function captureConsole(fn: () => void): { logs: string[]; warns: string[]; errors: string[] } {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const logs: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };

  try {
    fn();
    return { logs, warns, errors };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

function syncProjectArtifacts(workspace: TestWorkspace): void {
  const state = emptyState();
  saveState(state, workspace.dir);
  fs.writeFileSync(
    path.join(workspace.dir, '.brainclaw', 'project.md'),
    generateMarkdown(state, workspace.dir),
    'utf-8',
  );

  const config = loadConfig(workspace.dir);
  saveProjectIdentity(buildProjectIdentity({
    projectName: config.project_name,
    storageDir: config.storage_dir,
    topology: config.topology,
    existing: {
      version: 1,
      project_id: config.project_id ?? 'prj_missing',
      project_name: config.project_name,
      created_at: iso(24),
      storage_dir: config.storage_dir,
      topology: config.topology,
    },
  }), workspace.dir);
}

describe('commands/doctor', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-doctor-',
      projectId: 'prj_doctor_test',
      currentAgent: 'copilot',
      reputationEnabled: true,
    });
    syncProjectArtifacts(workspace);
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('emits a clean JSON dashboard from direct command invocation', () => {
    const copilot = workspace.currentAgent;

    archiveCandidate({
      id: 'cnd_doctor_accepted',
      type: 'decision',
      text: 'Accepted doctor signal',
      created_at: iso(6),
      author: copilot.agent_name,
      author_id: copilot.agent_id,
      project_id: 'prj_doctor_test',
      tags: ['doctor'],
      status: 'accepted',
      star_count: 1,
      starred_by: ['claude'],
      usage_count: 1,
      usage_events: [{ by: 'claude', context: 'doctor', created_at: iso(5) }],
      resolved_at: iso(4),
      resolved_by: copilot.agent_name,
    }, 'accepted', workspace.dir);

    saveRuntimeNote({
      id: 'rtn_doctor',
      agent: copilot.agent_name,
      agent_id: copilot.agent_id,
      project_id: 'prj_doctor_test',
      session_id: 'sess_doctor',
      text: 'Doctor runtime note',
      created_at: iso(3),
      tags: ['doctor'],
      visibility: 'shared',
      note_type: 'observation',
    }, workspace.dir);

    const captured = captureConsole(() => {
      runDoctor({ json: true, cwd: workspace.dir });
    });

    assert.equal(captured.errors.length, 0);
    assert.ok(captured.logs.length >= 1);

    const parsed = JSON.parse(captured.logs.at(-1) as string);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.metrics.pending_candidates, 0);
    assert.equal(parsed.metrics.accepted_candidates, 1);
    assert.equal(parsed.metrics.runtime_notes, 1);
    assert.equal(parsed.metrics.reputation_enabled, true);
    assert.ok(parsed.metrics.reputation_tracked_agents >= 1);
    assert.ok(parsed.metrics.reputation_current_agent_trust > 0);
    assert.ok(parsed.checks.some((check: { name: string; status: string }) => check.name === 'project_identity' && check.status === 'ok'));
    assert.ok(parsed.checks.some((check: { name: string; status: string }) => check.name === 'reputation_summary' && check.status === 'ok'));
  });

  it('surfaces governance and freshness issues in JSON mode', () => {
    workspace.updateConfig((config) => {
      config.project_mode = 'multi-project';
      config.projects.known = [];
    });

    const staleCandidate: Candidate = {
      id: 'cnd_promotion_ready',
      type: 'decision',
      text: 'Promotion-ready candidate',
      created_at: iso(30),
      author: workspace.currentAgent.agent_name,
      author_id: workspace.currentAgent.agent_id,
      project_id: 'prj_doctor_test',
      tags: ['doctor'],
      status: 'pending',
      star_count: 3,
      starred_by: ['a', 'b', 'c'],
      usage_count: 0,
      usage_events: [],
    };
    saveCandidate(staleCandidate, workspace.dir);

    const claims: Claim[] = [
      {
        id: 'clm_duplicate_1',
        agent: workspace.currentAgent.agent_name,
        agent_id: workspace.currentAgent.agent_id,
        project_id: 'prj_doctor_test',
        scope: 'src/auth/',
        description: 'Own auth area',
        created_at: iso(6),
        status: 'active',
      },
      {
        id: 'clm_duplicate_2',
        agent: 'claude',
        project_id: 'prj_doctor_test',
        scope: 'src/auth/',
        description: 'Also owns auth area',
        created_at: iso(5),
        status: 'active',
      },
    ];
    for (const claim of claims) {
      saveClaim(claim, workspace.dir);
    }

    writeContextMarker({
      read_at: new Date().toISOString(),
      memory_version: 'stale-version',
    }, workspace.dir);

    const runtimeDir = path.join(workspace.dir, '.brainclaw', 'runtime', 'openclaw');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, 'doctor-events.json'), JSON.stringify({
      events: [
        {
          id: 'evt_incomplete',
          agent: 'openclaw',
          event_type: 'task_started',
          created_at: new Date().toISOString(),
          text: 'Start workflow',
          tags: ['doctor'],
          metadata: { session: 'sess_incomplete' },
        },
      ],
    }, null, 2), 'utf-8');

    fs.writeFileSync(
      path.join(workspace.dir, '.brainclaw', 'project.md'),
      generateMarkdown(emptyState(), workspace.dir),
      'utf-8',
    );

    const captured = captureConsole(() => {
      runDoctor({ json: true, cwd: workspace.dir });
    });

    const parsed = JSON.parse(captured.logs.at(-1) as string);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.metrics.stale_context, true);
    assert.equal(parsed.metrics.promotion_ready_candidates, 1);
    assert.equal(parsed.metrics.active_claims, 2);
    assert.equal(parsed.metrics.runtime_events, 1);
    assert.ok(parsed.checks.some((check: { name: string; status: string }) => check.name === 'project_mode' && check.status === 'warn'));
    assert.ok(parsed.checks.some((check: { name: string; status: string }) => check.name === 'promotion_signals' && check.status === 'warn'));
    assert.ok(parsed.checks.some((check: { name: string; status: string }) => check.name === 'claim_collisions' && check.status === 'warn'));
    assert.ok(parsed.checks.some((check: { name: string; status: string }) => check.name === 'context_freshness' && check.status === 'warn'));
    assert.ok(parsed.checks.some((check: { name: string; status: string }) => check.name === 'runtime_sessions' && check.status === 'warn'));
  });

  it('reports outdated and invalid documents with migration-check enabled', () => {
    const claimsDir = path.join(workspace.dir, '.brainclaw', 'claims');
    fs.mkdirSync(claimsDir, { recursive: true });
    fs.writeFileSync(path.join(claimsDir, 'clm_legacy.json'), JSON.stringify({
      id: 'clm_legacy',
      agent: workspace.currentAgent.agent_name,
      agent_id: workspace.currentAgent.agent_id,
      project_id: 'prj_doctor_test',
      scope: 'src/migration',
      description: 'Legacy schema claim',
      created_at: iso(4),
      status: 'active',
    }, null, 2), 'utf-8');
    fs.writeFileSync(path.join(claimsDir, 'broken.json'), '{bad-json', 'utf-8');

    const captured = captureConsole(() => {
      runDoctor({ json: true, cwd: workspace.dir, migrationCheck: true });
    });

    const parsed = JSON.parse(captured.logs.at(-1) as string);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.metrics.migration_outdated_documents, 1);
    assert.equal(parsed.metrics.migration_invalid_documents, 1);
    assert.ok(parsed.checks.some((check: { name: string; status: string }) => check.name === 'schema_migrations' && check.status === 'warn'));
    assert.ok(parsed.checks.some((check: { name: string; status: string }) => check.name === 'schema_migration_errors' && check.status === 'error'));
    assert.ok(parsed.migration.entries.some((entry: { documentType: string; status: string }) => entry.documentType === 'claim' && entry.status === 'outdated'));
    assert.ok(parsed.migration.entries.some((entry: { documentType: string; status: string }) => entry.documentType === 'claim' && entry.status === 'invalid'));
  });
});
