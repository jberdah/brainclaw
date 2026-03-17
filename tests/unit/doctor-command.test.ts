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
import { upsertAgentIntegrationDeclaration } from '../../src/core/agent-integrations.js';
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
  let previousCodexHome: string | undefined;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-doctor-',
      projectId: 'prj_doctor_test',
      currentAgent: 'copilot',
      reputationEnabled: true,
    });
    syncProjectArtifacts(workspace);
    previousCodexHome = process.env.CODEX_HOME;
  });

  afterEach(() => {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
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

  it('reports local agent tooling issues in doctor json output', () => {
    fs.writeFileSync(path.join(workspace.dir, 'AGENTS.md'), '# Agent Guide\n\nThis file has no actionable bullets.\n', 'utf-8');
    const codexHome = path.join(workspace.dir, '.codex-home');
    fs.mkdirSync(path.join(codexHome, 'skills', '.system', 'thin-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, 'skills', '.system', 'thin-skill', 'SKILL.md'),
      '# Thin Skill\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      '[mcp_servers.local_missing]\ncommand = "definitely-missing-brainclaw-command"\n',
      'utf-8',
    );
    process.env.CODEX_HOME = codexHome;

    const captured = captureConsole(() => {
      runDoctor({ json: true, cwd: workspace.dir });
    });

    const parsed = JSON.parse(captured.logs.at(-1) as string);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.metrics.agent_rules, 0);
    assert.equal(parsed.metrics.incomplete_skills, 1);
    assert.equal(parsed.metrics.missing_mcp_commands, 1);
    assert.ok(parsed.checks.some((check: { name: string; status: string }) => check.name === 'agent_rules' && check.status === 'warn'));
    assert.ok(parsed.checks.some((check: { name: string; status: string }) => check.name === 'agent_skills' && check.status === 'warn'));
    assert.ok(parsed.checks.some((check: { name: string; status: string }) => check.name === 'agent_mcp' && check.status === 'warn'));
  });

  it('reports declared integrations that are not activated on the current machine', () => {
    workspace.updateConfig((config) => {
      upsertAgentIntegrationDeclaration(config, 'github-copilot', 'manual');
    });

    const captured = captureConsole(() => {
      runDoctor({ json: true, cwd: workspace.dir });
    });

    const parsed = JSON.parse(captured.logs.at(-1) as string);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.metrics.declared_agent_integrations, 1);
    assert.equal(parsed.metrics.integration_activation_gaps, 1);
    assert.ok(parsed.checks.some((check: { name: string; status: string }) => check.name === 'agent_integrations' && check.status === 'warn'));
  });

  it('reports when the installed CLI is older than the project minimum version', () => {
    workspace.updateConfig((config) => {
      config.minimum_brainclaw_version = '99.0.0';
      config.recommended_brainclaw_version = '99.1.0';
      config.brainclaw_upgrade_message = 'Includes late-agent activation and upgrade signaling.';
      config.brainclaw_upgrade_command = 'npm pack && npm i -g ./brainclaw-99.1.0.tgz';
    });

    const captured = captureConsole(() => {
      runDoctor({ json: true, cwd: workspace.dir });
    });

    const parsed = JSON.parse(captured.logs.at(-1) as string);
    const check = parsed.checks.find((entry: { name: string }) => entry.name === 'brainclaw_version');
    assert.equal(check?.status, 'warn');
    assert.equal(parsed.metrics.required_brainclaw_version, '99.0.0');
    assert.equal(parsed.metrics.recommended_brainclaw_version, '99.1.0');
  });

  it('includes scored contradiction details in doctor json output', () => {
    saveState({
      version: 1,
      write_version: 1,
      active_constraints: [
        {
          id: 'cst_doctor_a',
          text: 'Auth gateway must allow refresh tokens',
          created_at: iso(2),
          author: workspace.currentAgent.agent_name,
          author_id: workspace.currentAgent.agent_id,
          project_id: 'prj_doctor_test',
          status: 'active',
          tags: ['auth'],
          related_paths: ['src/auth/**'],
        },
        {
          id: 'cst_doctor_b',
          text: 'Auth gateway must not allow refresh tokens',
          created_at: iso(1),
          author: workspace.currentAgent.agent_name,
          author_id: workspace.currentAgent.agent_id,
          project_id: 'prj_doctor_test',
          status: 'active',
          tags: ['auth'],
          related_paths: ['src/auth/**'],
        },
      ],
      recent_decisions: [],
      known_traps: [],
      open_handoffs: [],
      plan_items: [],
    }, workspace.dir);

    const captured = captureConsole(() => {
      runDoctor({ json: true, cwd: workspace.dir });
    });

    const parsed = JSON.parse(captured.logs.at(-1) as string);
    const contradictionCheck = parsed.checks.find((check: { name: string }) => check.name === 'contradictions');
    assert.ok(contradictionCheck);
    assert.equal(contradictionCheck.status, 'warn');
    assert.ok(Array.isArray(contradictionCheck.details));
    assert.equal(contradictionCheck.details[0].severity, 'high');
    assert.ok(contradictionCheck.details[0].score >= 10);
  });
});

describe('doctor — handoff backlog check', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-doctor-backlog-' });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('reports ok when no open handoffs exist', () => {
    const captured = captureConsole(() => {
      runDoctor({ json: true, cwd: workspace.dir });
    });
    const parsed = JSON.parse(captured.logs.at(-1) as string);
    const check = parsed.checks.find((c: { name: string }) => c.name === 'handoff_backlog');
    assert.ok(check);
    assert.equal(check.status, 'ok');
  });

  it('warns when an open handoff without plan_id contains bullet-list backlog', () => {
    const state = emptyState();
    state.open_handoffs.push({
      id: 'hnd_test01', short_label: 'test', from: 'alice', to: 'bob',
      text: 'Session done.\n- Add auth endpoint\n- Write tests\n- Deploy staging',
      created_at: new Date().toISOString(), author: 'alice', status: 'open', tags: [],
    });
    saveState(state, workspace.dir);

    const captured = captureConsole(() => {
      runDoctor({ json: true, cwd: workspace.dir });
    });
    const parsed = JSON.parse(captured.logs.at(-1) as string);
    const check = parsed.checks.find((c: { name: string }) => c.name === 'handoff_backlog');
    assert.ok(check);
    assert.equal(check.status, 'warn');
    assert.ok(check.message.includes('hnd_test01'));
  });

  it('warns when an open handoff without plan_id contains TODO keyword', () => {
    const state = emptyState();
    state.open_handoffs.push({
      id: 'hnd_test02', short_label: 'test', from: 'alice', to: 'bob',
      text: 'TODO: finish the migration before release',
      created_at: new Date().toISOString(), author: 'alice', status: 'open', tags: [],
    });
    saveState(state, workspace.dir);

    const captured = captureConsole(() => {
      runDoctor({ json: true, cwd: workspace.dir });
    });
    const parsed = JSON.parse(captured.logs.at(-1) as string);
    const check = parsed.checks.find((c: { name: string }) => c.name === 'handoff_backlog');
    assert.equal(check.status, 'warn');
  });

  it('reports ok when open handoff with backlog patterns has a plan_id', () => {
    const state = emptyState();
    state.open_handoffs.push({
      id: 'hnd_test03', short_label: 'test', from: 'alice', to: 'bob',
      text: '- Add auth endpoint\n- Write tests',
      plan_id: 'pln_covered',
      created_at: new Date().toISOString(), author: 'alice', status: 'open', tags: [],
    });
    saveState(state, workspace.dir);

    const captured = captureConsole(() => {
      runDoctor({ json: true, cwd: workspace.dir });
    });
    const parsed = JSON.parse(captured.logs.at(-1) as string);
    const check = parsed.checks.find((c: { name: string }) => c.name === 'handoff_backlog');
    assert.equal(check.status, 'ok');
  });

  it('reports ok when open handoff is plain prose with no backlog patterns', () => {
    const state = emptyState();
    state.open_handoffs.push({
      id: 'hnd_test04', short_label: 'test', from: 'alice', to: 'bob',
      text: 'Session ended cleanly. Auth is done and deployed.',
      created_at: new Date().toISOString(), author: 'alice', status: 'open', tags: [],
    });
    saveState(state, workspace.dir);

    const captured = captureConsole(() => {
      runDoctor({ json: true, cwd: workspace.dir });
    });
    const parsed = JSON.parse(captured.logs.at(-1) as string);
    const check = parsed.checks.find((c: { name: string }) => c.name === 'handoff_backlog');
    assert.equal(check.status, 'ok');
  });
});
