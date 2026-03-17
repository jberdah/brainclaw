import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { saveState } from '../../src/core/state.js';
import { createInstruction } from '../../src/core/instructions.js';
import { getTriggeredItems, renderTriggeredItems } from '../../src/core/lifecycle.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import type { State } from '../../src/core/schema.js';

const BASE_STATE: State = {
  version: 1,
  write_version: 1,
  active_constraints: [],
  recent_decisions: [],
  known_traps: [],
  open_handoffs: [],
  plan_items: [],
};

describe('lifecycle hooks', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-lifecycle-',
      projectId: 'prj_lifecycle_test',
      currentAgent: 'copilot',
    });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('returns empty array when no items match the trigger tag', () => {
    saveState(BASE_STATE, workspace.dir);
    const items = getTriggeredItems('trigger:post-claim', workspace.dir);
    assert.deepEqual(items, []);
  });

  it('returns traps tagged with the trigger tag', () => {
    saveState({
      ...BASE_STATE,
      known_traps: [
        {
          id: 'trp_test01',
          text: 'Create a git branch before editing',
          created_at: new Date().toISOString(),
          author: 'copilot',
          author_id: 'agt_test',
          project_id: 'prj_lifecycle_test',
          severity: 'medium',
          tags: ['git', 'trigger:post-claim'],
          visibility: 'shared',
          host_id: 'host_test',
        },
        {
          id: 'trp_test02',
          text: 'Unrelated trap',
          created_at: new Date().toISOString(),
          author: 'copilot',
          author_id: 'agt_test',
          project_id: 'prj_lifecycle_test',
          severity: 'low',
          tags: ['other'],
          visibility: 'shared',
          host_id: 'host_test',
        },
      ],
    }, workspace.dir);

    const items = getTriggeredItems('trigger:post-claim', workspace.dir);
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'trp_test01');
    assert.equal(items[0].type, 'trap');
    assert.equal(items[0].text, 'Create a git branch before editing');
  });

  it('returns constraints and decisions tagged with the trigger tag', () => {
    saveState({
      ...BASE_STATE,
      active_constraints: [
        {
          id: 'cst_test01',
          text: 'Release claims before ending session',
          created_at: new Date().toISOString(),
          author: 'copilot',
          author_id: 'agt_test',
          project_id: 'prj_lifecycle_test',
          tags: ['trigger:pre-session-end'],
          status: 'active',
        },
      ],
      recent_decisions: [
        {
          id: 'dec_test01',
          text: 'Always summarize what was done',
          created_at: new Date().toISOString(),
          author: 'copilot',
          author_id: 'agt_test',
          project_id: 'prj_lifecycle_test',
          tags: ['trigger:pre-session-end'],
        },
      ],
    }, workspace.dir);

    const items = getTriggeredItems('trigger:pre-session-end', workspace.dir);
    assert.equal(items.length, 2);
    assert.ok(items.some((i) => i.type === 'constraint' && i.id === 'cst_test01'));
    assert.ok(items.some((i) => i.type === 'decision' && i.id === 'dec_test01'));
  });

  it('returns instructions tagged with the trigger tag', () => {
    saveState(BASE_STATE, workspace.dir);
    createInstruction('Check for open handoffs before ending session', { layer: 'global', author: 'copilot', tags: ['trigger:pre-session-end'] }, workspace.dir);

    const items = getTriggeredItems('trigger:pre-session-end', workspace.dir);
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'instruction');
    assert.ok(items[0].text.includes('open handoffs'));
  });

  it('renderTriggeredItems returns empty string for empty array', () => {
    assert.equal(renderTriggeredItems([]), '');
  });

  it('renderTriggeredItems formats items with type prefix', () => {
    const items = [
      { type: 'trap' as const, id: 'trp_x', text: 'Create a branch' },
      { type: 'constraint' as const, id: 'cst_x', text: 'Do not work on master' },
    ];
    const rendered = renderTriggeredItems(items);
    assert.ok(rendered.includes('⚡ [trap] Create a branch'));
    assert.ok(rendered.includes('⚡ [constraint] Do not work on master'));
  });
});
