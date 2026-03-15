import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handleMcpReadToolCall } from '../../src/commands/mcp.js';
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

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-mcp-read-',
      projectId: 'prj_mcp_read_test',
      currentAgent: 'copilot',
      knownProjects: ['auth'],
      reputationEnabled: true,
    });
  });

  afterEach(() => {
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
    fs.writeFileSync(path.join(workspace.dir, 'package.json'), JSON.stringify({
      scripts: { test: 'npm test' },
    }, null, 2), 'utf-8');

    const bootstrap = handleMcpReadToolCall('bclaw_bootstrap', {
      target: 'src/auth/routes.ts',
    }, { cwd: workspace.dir });
    const bootstrapStructured = bootstrap.structuredContent as {
      seed_count: number;
      seeds: Array<{ seed_kind: string; source_kind: string }>;
      reused_profile: boolean;
    };
    assert.ok(bootstrap.content[0].text.includes('Bootstrap summary'));
    assert.ok(bootstrapStructured.seed_count > 0);
    assert.ok(bootstrapStructured.seeds.some((seed) => seed.source_kind === 'agents_md'));
    assert.equal(bootstrapStructured.reused_profile, false);

    const context = handleMcpReadToolCall('bclaw_get_context', {
      path: 'src/auth/routes.ts',
      format: 'json',
    }, { cwd: workspace.dir });
    const contextStructured = context.structuredContent as {
      memory_density: string;
      bootstrap_available: boolean;
      derived_signals?: Array<{ seed_kind: string }>;
    };
    assert.equal(contextStructured.memory_density, 'low');
    assert.equal(contextStructured.bootstrap_available, true);
    assert.ok((contextStructured.derived_signals?.length ?? 0) > 0);
    assert.ok(contextStructured.derived_signals?.some((signal) => signal.seed_kind === 'agent_rule'));

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
});
