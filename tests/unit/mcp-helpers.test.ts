import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildContext } from '../../src/core/context.js';
import { saveState } from '../../src/core/state.js';
import {
  normaliseFormat,
  parseTtl,
  renderContextForMcp,
} from '../../src/commands/mcp.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

describe('commands/mcp helpers', () => {
  let workspace: TestWorkspace;

  it('normalises supported context formats with markdown fallback', () => {
    assert.equal(normaliseFormat('json'), 'json');
    assert.equal(normaliseFormat('template'), 'template');
    assert.equal(normaliseFormat('markdown'), 'markdown');
    assert.equal(normaliseFormat('anything-else'), 'markdown');
    assert.equal(normaliseFormat(undefined), 'markdown');
  });

  it('renders context for markdown, template, and json modes', () => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-mcp-helper-',
      projectId: 'prj_mcp_helper_test',
      currentAgent: 'openclaw',
      reputationEnabled: true,
    });

    try {
      saveState({
        version: 1,
        write_version: 1,
        active_constraints: [],
        recent_decisions: [
          {
            id: 'dec_mcp',
            text: 'Auth gateway routes OAuth',
            created_at: new Date().toISOString(),
            author: workspace.currentAgent.agent_name,
            author_id: workspace.currentAgent.agent_id,
            project_id: 'prj_mcp_helper_test',
            tags: ['auth'],
          },
        ],
        known_traps: [],
        open_handoffs: [],
        plan_items: [],
      }, workspace.dir);

      const restore = workspace.useCwd();
      try {
        const result = buildContext({ target: 'auth', profile: 'openclaw' });

        const markdown = renderContextForMcp(result, 'markdown', { explain: true });
        assert.match(markdown, /# Agent Context/);
        assert.match(markdown, /\{why:/);

        const template = renderContextForMcp(result, 'template', {});
        assert.match(template, /```memory-context/);
        assert.match(template, /p=openclaw/);

        const json = renderContextForMcp(result, 'json', {});
        const parsed = JSON.parse(json);
        assert.equal(parsed.profile, 'openclaw');
        assert.ok(Array.isArray(parsed.selected));
      } finally {
        restore();
      }
    } finally {
      workspace.cleanup();
    }
  });

  it('parses TTL values in minutes, hours, and days', () => {
    const now = Date.now();

    const minutes = parseTtl('30m');
    const hours = parseTtl('2h');
    const days = parseTtl('7d');

    assert.ok(minutes);
    assert.ok(hours);
    assert.ok(days);
    assert.ok(Date.parse(minutes as string) > now);
    assert.ok(Date.parse(hours as string) > Date.parse(minutes as string));
    assert.ok(Date.parse(days as string) > Date.parse(hours as string));
    assert.equal(parseTtl('bad'), undefined);
  });
});
