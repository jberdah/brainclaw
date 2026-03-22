import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handleMcpReadToolCall } from '../../src/commands/mcp.js';
import { startSession } from '../../src/commands/session-start.js';
import { createInstruction } from '../../src/core/instructions.js';
import { saveClaim } from '../../src/core/claims.js';
import { saveRuntimeNote } from '../../src/core/runtime.js';
import { saveState } from '../../src/core/state.js';
import type { State } from '../../src/core/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function iso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

describe('commands/mcp read tools', () => {
  let workspace: TestWorkspace;
  let previousCodexHome: string | undefined;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-mcp-read-',
      projectId: 'prj_mcp_read_test',
      currentAgent: 'copilot',
      knownProjects: ['auth'],
      reputationEnabled: true,
    });
    const codexHome = path.join(workspace.dir, '.codex-home');
    fs.mkdirSync(path.join(codexHome, 'skills', '.system', 'openai-docs'), { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, 'skills', '.system', 'openai-docs', 'SKILL.md'),
      '# OpenAI Docs\n\nUse when official OpenAI docs are needed.\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      '[mcp_servers.atlassian]\ncommand = "npx"\nargs = ["-y", "mcp-remote", "https://mcp.atlassian.com/v1/sse"]\n',
      'utf-8',
    );
    workspace.updateConfig((config) => {
      config.brainclaw_update_source = {
        type: 'local-pack',
        manifest_path: '.releases/brainclaw-local.json',
      };
    });
    fs.mkdirSync(path.join(workspace.dir, '.releases'), { recursive: true });
    fs.writeFileSync(path.join(workspace.dir, '.releases', 'brainclaw-local.json'), JSON.stringify({
      version: 1,
      channel: 'local-pack',
      package_name: 'brainclaw',
      latest_installable_version: '99.0.0',
      artifact_path: './brainclaw-99.0.0.tgz',
      install_command: 'npm install -g "./.releases/brainclaw-99.0.0.tgz"',
      release_notes: 'Local release ready for upgrade.',
    }, null, 2), 'utf-8');
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(() => {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    workspace.cleanup();
  });

  it('returns structured context through the read-tool handler', () => {
    createInstruction('Always read auth memory first', {
      layer: 'global',
      author: workspace.currentAgent.agent_name,
    }, workspace.dir);

    saveState({
      version: 1,
      write_version: 1,
      active_constraints: [],
      recent_decisions: [
        {
          id: 'dec_mcp_context',
          text: 'OAuth migration now goes through auth-gateway',
          created_at: iso(8),
          author: workspace.currentAgent.agent_name,
          author_id: workspace.currentAgent.agent_id,
          project_id: 'prj_mcp_read_test',
          tags: ['auth'],
        },
      ],
      known_traps: [],
      open_handoffs: [],
      plan_items: [],
    }, workspace.dir);

    saveRuntimeNote({
      id: 'rtn_mcp_context',
      agent: workspace.currentAgent.agent_name,
      agent_id: workspace.currentAgent.agent_id,
      project_id: 'prj_mcp_read_test',
      session_id: 'sess_mcp_context',
      text: 'Auth runtime context',
      created_at: iso(7),
      tags: ['auth'],
      visibility: 'shared',
      note_type: 'observation',
    }, workspace.dir);

    const response = handleMcpReadToolCall('bclaw_get_context', {
      path: 'auth',
      format: 'json',
      maxItems: 5,
      digest: true,
    }, { cwd: workspace.dir });

    assert.ok(response.content[0].text.includes('selected'));
    const structured = response.structuredContent as {
      selected: Array<{ section: string; provenance?: { session_id?: string } }>;
      resolved_instructions: unknown[];
      digest?: string;
      scoped_activity?: { recent_notes: number };
    };
    assert.ok(Array.isArray(structured.selected));
    assert.ok(structured.selected.some((item) => item.section === 'runtime' && item.provenance?.session_id === 'sess_mcp_context'));
    assert.ok(Array.isArray(structured.resolved_instructions));
    assert.ok(structured.resolved_instructions.length >= 1);
    assert.ok(structured.digest?.includes('Recent decision: OAuth migration now goes through auth-gateway'));
    assert.equal(structured.scoped_activity?.recent_notes, 1);
  });

  it('returns agent board and search payloads through the read-tool handler', () => {
    const state: State = {
      version: 1,
      write_version: 1,
      active_constraints: [],
      recent_decisions: [],
      known_traps: [],
      open_handoffs: [
        {
          id: 'hnd_mcp',
          from: 'copilot',
          to: 'claude',
          text: 'Review auth patch',
          created_at: iso(9),
          author: 'copilot',
          author_id: workspace.currentAgent.agent_id,
          project_id: 'prj_mcp_read_test',
          status: 'open',
          project: 'auth',
          tags: ['auth'],
        },
      ],
      plan_items: [
        {
          id: 'pln_mcp',
          text: 'Own auth rollout',
          created_at: iso(10),
          updated_at: iso(8),
          author: 'copilot',
          status: 'in_progress',
          priority: 'high',
          assignee: 'copilot',
          project: 'auth',
          tags: ['auth'],
          depends_on: [],
        },
      ],
    };
    saveState(state, workspace.dir);
    createInstruction('Use auth gateway conventions', {
      layer: 'project',
      scope: 'auth',
      author: workspace.currentAgent.agent_name,
    }, workspace.dir);
    saveClaim({
      id: 'clm_mcp',
      agent: 'copilot',
      agent_id: workspace.currentAgent.agent_id,
      project_id: 'prj_mcp_read_test',
      scope: 'src/auth/',
      description: 'Taking auth rollout',
      created_at: iso(7),
      project: 'auth',
      plan_id: 'pln_mcp',
      status: 'active',
    }, workspace.dir);
    saveRuntimeNote({
      id: 'rtn_mcp_board',
      agent: 'copilot',
      agent_id: workspace.currentAgent.agent_id,
      project_id: 'prj_mcp_read_test',
      session_id: 'sess_mcp_board',
      text: 'Started auth rollout',
      created_at: iso(6),
      project: 'auth',
      plan_id: 'pln_mcp',
      tags: ['auth'],
      visibility: 'shared',
      note_type: 'observation',
    }, workspace.dir);

    const board = handleMcpReadToolCall('bclaw_get_agent_board', {
      agent: 'copilot',
      project: 'auth',
      includeReputation: true,
    }, { cwd: workspace.dir });
    assert.ok(board.content[0].text.includes('Agent board for copilot (auth)'));
    const boardStructured = board.structuredContent as {
      active_plans: Array<{ id: string }>;
      active_claims: Array<{ id: string }>;
      runtime_notes: Array<{ id: string }>;
      reputation_summary?: { enabled: boolean };
    };
    assert.deepEqual(boardStructured.active_plans.map((item) => item.id), ['pln_mcp']);
    assert.deepEqual(boardStructured.active_claims.map((item) => item.id), ['clm_mcp']);
    assert.deepEqual(boardStructured.runtime_notes.map((item) => item.id), ['rtn_mcp_board']);
    assert.equal(boardStructured.reputation_summary?.enabled, true);

    const search = handleMcpReadToolCall('bclaw_search', {
      query: 'auth rollout',
      limit: 5,
    }, { cwd: workspace.dir });
    const searchStructured = search.structuredContent as { results: Array<{ id: string }>; total: number };
    assert.ok(searchStructured.total >= 1);
    assert.ok(searchStructured.results.some((item) => item.id === 'pln_mcp' || item.id === 'hnd_mcp'));
  });

  it('reads handoff details, including diff snapshots, and handles missing handoffs', () => {
    saveState({
      version: 1,
      write_version: 1,
      active_constraints: [],
      recent_decisions: [],
      known_traps: [],
      open_handoffs: [
        {
          id: 'hnd_snapshot',
          from: 'copilot',
          to: 'claude',
          text: 'Review the auth patch',
          created_at: iso(5),
          author: 'copilot',
          author_id: workspace.currentAgent.agent_id,
          project_id: 'prj_mcp_read_test',
          status: 'open',
          tags: ['auth'],
          snapshot: {
            diff: 'diff --git a/src/auth.ts b/src/auth.ts',
          },
        },
      ],
      plan_items: [],
    }, workspace.dir);

    const handoffResponse = handleMcpReadToolCall('bclaw_read_handoff', {
      id: 'hnd_snapshot',
    }, { cwd: workspace.dir });
    assert.ok(handoffResponse.content[0].text.includes('From: copilot'));
    assert.ok(handoffResponse.content[0].text.includes('Review the auth patch'));
    assert.ok(handoffResponse.content[0].text.includes('Uncommitted Git Diff'));

    const missingResponse = handleMcpReadToolCall('bclaw_read_handoff', {
      id: 'hnd_missing',
    }, { cwd: workspace.dir });
    assert.ok(missingResponse.content[0].text.includes('Handoff not found: hnd_missing'));
  });

  it('rejects malformed read-tool calls and reports empty search results', () => {
    const emptySearch = handleMcpReadToolCall('bclaw_search', {
      query: 'nope',
      limit: 3,
    }, { cwd: workspace.dir });
    assert.equal(emptySearch.content[0].text, 'No results found.');

    assert.throws(() => handleMcpReadToolCall('bclaw_search', {}, { cwd: workspace.dir }), /Missing required argument: query/);
    assert.throws(() => handleMcpReadToolCall('bclaw_unknown_tool', {}, { cwd: workspace.dir }), /Unknown read tool/);
  });

  it('returns bootstrap signals and brownfield context fallback through MCP', () => {
    fs.writeFileSync(path.join(workspace.dir, 'README.md'), '# Brownfield Auth\n\n## Test\n\n- npm test\n', 'utf-8');
    fs.writeFileSync(path.join(workspace.dir, 'AGENTS.md'), '# Agent Guide\n\n- Read memory first\n', 'utf-8');
    fs.writeFileSync(path.join(workspace.dir, 'CLAUDE.md'), '# Claude Guidance\n\n- Check native instructions before editing\n', 'utf-8');
    fs.writeFileSync(path.join(workspace.dir, 'package.json'), JSON.stringify({
      scripts: { test: 'npm test' },
    }, null, 2), 'utf-8');

    const bootstrap = handleMcpReadToolCall('bclaw_bootstrap', {
      target: 'src/auth/routes.ts',
    }, { cwd: workspace.dir });
    const bootstrapStructured = bootstrap.structuredContent as {
      seed_count: number;
      seeds: Array<{ seed_kind: string; source_kind: string }>;
      import_plan?: {
        suggestion_count: number;
        suggestions: Array<{ target: string }>;
        interview?: { question_count: number; questions: Array<{ audience: string }> };
      };
      reused_profile: boolean;
    };
    assert.ok(bootstrap.content[0].text.includes('Bootstrap summary'));
    assert.ok(bootstrapStructured.seed_count > 0);
    assert.ok(bootstrapStructured.seeds.some((seed) => seed.source_kind === 'agents_md'));
    assert.ok((bootstrapStructured.import_plan?.suggestion_count ?? 0) > 0);
    assert.ok(bootstrapStructured.import_plan?.suggestions.some((suggestion) => suggestion.target === 'instruction'));
    assert.ok((bootstrapStructured.import_plan?.interview?.question_count ?? 0) > 0);
    assert.ok(bootstrapStructured.import_plan?.interview?.questions.some((question) => question.audience === 'ide_chat'));
    assert.equal(bootstrapStructured.reused_profile, false);

    const context = handleMcpReadToolCall('bclaw_get_context', {
      path: 'src/auth/routes.ts',
      format: 'json',
    }, { cwd: workspace.dir });
    const contextStructured = context.structuredContent as {
      context_schema: string;
      memory_density: string;
      bootstrap_available: boolean;
      derived_signals?: Array<{ seed_kind: string }>;
      agent_tooling?: { agents_rules: string[] };
    };
    assert.equal(contextStructured.context_schema, '1.2');
    assert.equal(contextStructured.memory_density, 'low');
    assert.equal(contextStructured.bootstrap_available, true);
    assert.ok((contextStructured.derived_signals?.length ?? 0) > 0);
    assert.ok(contextStructured.derived_signals?.some((signal) => signal.seed_kind === 'agent_rule'));
    assert.deepEqual(contextStructured.agent_tooling?.agents_rules, ['Read memory first']);

    const disabledContext = handleMcpReadToolCall('bclaw_get_context', {
      path: 'src/auth/routes.ts',
      format: 'json',
      bootstrap: false,
    }, { cwd: workspace.dir });
    const disabledStructured = disabledContext.structuredContent as {
      bootstrap_available: boolean;
      derived_signals?: Array<unknown>;
    };
    assert.equal(disabledStructured.bootstrap_available, true);
    assert.equal(disabledStructured.derived_signals, undefined);
  });

  it('accepts interview answers through MCP bootstrap and applies selective memory imports', () => {
    const bootstrap = handleMcpReadToolCall('bclaw_bootstrap', {}, { cwd: workspace.dir });
    const structured = bootstrap.structuredContent as {
      import_plan: {
        interview?: {
          questions: Array<{ id: string; prompt: string }>;
        };
      };
    };
    const questions = structured.import_plan.interview?.questions ?? [];
    const projectIntent = questions.find((question) => question.prompt.includes('current purpose of this existing project'));
    const workflow = questions.find((question) => question.prompt.includes('Should Brainclaw treat this project as agent-guided'));
    assert.ok(projectIntent && workflow);

    const preview = handleMcpReadToolCall('bclaw_bootstrap', {
      interviewAnswers: [
        {
          question_id: projectIntent!.id,
          response_text: 'Build a local-first coordination layer for coding agents.',
          response_items: [],
          suggestions: [],
        },
        {
          question_id: workflow!.id,
          response_items: [],
          response_boolean: true,
          suggestions: [],
        },
      ],
    }, { cwd: workspace.dir });
    const previewStructured = preview.structuredContent as {
      import_plan: {
        confirmed_suggestion_count?: number;
        suggestions: Array<{ target: string }>;
      };
    };
    assert.ok((previewStructured.import_plan.confirmed_suggestion_count ?? 0) >= 2);
    assert.ok(previewStructured.import_plan.suggestions.some((suggestion) => suggestion.target === 'decision'));
    assert.ok(previewStructured.import_plan.suggestions.filter((suggestion) => suggestion.target === 'decision').length >= 2);

    const applied = handleMcpReadToolCall('bclaw_bootstrap', {
      apply: true,
      interviewAnswers: [
        {
          question_id: projectIntent!.id,
          response_text: 'Build a local-first coordination layer for coding agents.',
          response_items: [],
          suggestions: [],
        },
        {
          question_id: workflow!.id,
          response_items: [],
          response_boolean: true,
          suggestions: [],
        },
      ],
    }, { cwd: workspace.dir });
    const appliedStructured = applied.structuredContent as {
      created_count: number;
      receipt?: { managed_artifacts: Array<unknown> };
    };
    assert.ok(applied.content[0].text.includes('Bootstrap import applied:'));
    assert.ok(appliedStructured.created_count >= 2);
    assert.ok((appliedStructured.receipt?.managed_artifacts.length ?? 0) >= 2);
  });

  it('returns execution context and agent tooling through the dedicated MCP read tool', () => {
    const response = handleMcpReadToolCall('bclaw_get_execution_context', {
      includeAgentTooling: true,
    }, { cwd: workspace.dir });

    assert.match(response.content[0].text, /Platform:/);
    const structured = response.structuredContent as {
      execution_context: { git_status: string; toolchains: Array<unknown> };
      installable_update: { status: string; latest_installable_version?: string };
      agent_tooling: {
        agents_md_present: boolean;
        agents_rules: string[];
        skills: Array<{ name: string; scripts_present: boolean }>;
        mcp_servers: Array<{ name: string; availability: string }>;
      };
    };
    assert.ok(structured.execution_context);
    assert.equal(structured.installable_update.status, 'update_available');
    assert.equal(structured.installable_update.latest_installable_version, '99.0.0');
    assert.ok(Array.isArray(structured.execution_context.toolchains));
    assert.equal(structured.agent_tooling.agents_md_present, false);
    assert.deepEqual(structured.agent_tooling.agents_rules, []);
    assert.equal(structured.agent_tooling.skills[0]?.name, 'openai-docs');
    assert.equal(structured.agent_tooling.skills[0]?.scripts_present, false);
    assert.equal(structured.agent_tooling.mcp_servers[0]?.name, 'atlassian');
    assert.equal(structured.agent_tooling.mcp_servers[0]?.availability, 'remote');
  });

  it('returns session-aware context diffs through the read-tool handler', () => {
    const sessionId = 'sess_mcp_diff';
    process.env.BRAINCLAW_SESSION_ID = sessionId;
    startSession({
      agent: workspace.currentAgent.agent_name,
      context: 'auth',
      cwd: workspace.dir,
    });

    saveState({
      version: 1,
      write_version: 1,
      active_constraints: [],
      recent_decisions: [
        {
          id: 'dec_mcp_diff',
          text: 'Auth requests now go through the gateway',
          created_at: new Date().toISOString(),
          author: workspace.currentAgent.agent_name,
          author_id: workspace.currentAgent.agent_id,
          project_id: 'prj_mcp_read_test',
          tags: ['auth'],
        },
      ],
      known_traps: [],
      open_handoffs: [],
      plan_items: [],
    }, workspace.dir);

    const context = handleMcpReadToolCall('bclaw_get_context', {
      path: 'auth',
      format: 'json',
      since_session: sessionId,
    }, { cwd: workspace.dir });
    const structured = context.structuredContent as {
      context_schema: string;
      context_diff?: { since_session?: string; counts: { decisions: number; total: number } };
    };
    assert.equal(structured.context_schema, '1.2');
    assert.equal(structured.context_diff?.since_session, sessionId);
    assert.equal(structured.context_diff?.counts.decisions, 1);
    assert.equal(structured.context_diff?.counts.total, 1);
  });
});
