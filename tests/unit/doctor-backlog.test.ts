import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractBacklogWithoutPlanFindings } from '../../src/commands/doctor.js';
import { emptyState, loadState, saveState } from '../../src/core/state.js';
import type { Handoff } from '../../src/core/schema.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function iso(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
}

function makeOpenHandoff(id: string, createdAtHoursAgo: number, text: string, extra: Partial<Handoff> = {}): Handoff {
  return {
    id,
    short_label: 'test',
    from: 'alice',
    to: 'bob',
    text,
    created_at: iso(createdAtHoursAgo),
    author: 'alice',
    status: 'open',
    tags: [],
    ...extra,
  } as Handoff;
}

describe('doctor backlog_without_plans', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-doctor-backlog-',
      projectId: 'prj_doctor_backlog_test',
      currentAgent: 'copilot',
    });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('warns only for actionable backlog items that lack a formal plan', () => {
    const state = emptyState();
    state.open_handoffs.push(
      makeOpenHandoff('hnd_unplanned_box', 4, '- [ ] Add auth endpoint'),
      makeOpenHandoff('hnd_unplanned_todo', 3, '- TODO finish migration'),
      makeOpenHandoff('hnd_planned_inline', 2, 'next steps: coordinate rollout for pln_abc123'),
      makeOpenHandoff('hnd_planned_linked', 1, 'should do: write docs and clean up notes', {
        plan_id: 'pln_formal_link',
      }),
    );
    saveState(state, workspace.dir);

    const findings = loadState(workspace.dir).open_handoffs.flatMap(extractBacklogWithoutPlanFindings);

    assert.equal(findings.length, 2);
    assert.deepEqual(
      findings.map((finding) => finding.handoff_id),
      ['hnd_unplanned_box', 'hnd_unplanned_todo'],
    );
    assert.deepEqual(
      findings.map((finding) => finding.snippet),
      ['- [ ] Add auth endpoint', '- TODO finish migration'],
    );
    assert.ok(findings.every((finding) => /formal plan/i.test(finding.suggestion)));
    assert.ok(findings.every((finding) => finding.matched_pattern === 'unchecked_task' || finding.matched_pattern === 'todo_line'));
    assert.ok(!findings.some((finding) => finding.handoff_id === 'hnd_planned_inline'));
    assert.ok(!findings.some((finding) => finding.handoff_id === 'hnd_planned_linked'));
  });
});
