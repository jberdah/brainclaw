import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runRuntimeNote } from '../../src/commands/runtime-note.js';
import { listCandidates } from '../../src/core/candidates.js';
import { setAgentTrustLevel } from '../../src/core/agent-registry.js';
import { listRuntimeNotes } from '../../src/core/runtime.js';
import { loadState } from '../../src/core/state.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

describe('commands/runtime-note', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-runtime-note-',
      projectId: 'prj_runtime_note_test',
      currentAgent: 'copilot',
    });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('creates a runtime note without auto-reflect by default', () => {
    const result = runRuntimeNote('Auth runtime context', {
      tag: ['auth'],
      cwd: workspace.dir,
    });

    assert.equal(result.autoReflectAttempted, false);
    assert.equal(listRuntimeNotes(undefined, workspace.dir).length, 1);
    assert.equal(listCandidates('pending', workspace.dir).length, 0);
  });

  it('creates a pending candidate for contributor auto-reflect flows', () => {
    const result = runRuntimeNote('Use auth gateway convention for new routes', {
      tag: ['auth'],
      autoReflect: true,
      cwd: workspace.dir,
    });

    assert.equal(result.autoReflectAttempted, true);
    assert.equal(result.detectedType, 'decision');
    assert.ok(result.candidateId);
    assert.equal(result.promotedItemId, undefined);

    const pending = listCandidates('pending', workspace.dir);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].source, `runtime-note:${workspace.currentAgent.agent_name}:${result.noteId}`);
    assert.equal(pending[0].session_id, result.sessionId);
  });

  it('promotes directly for trusted agents when auto-reflect is enabled in config', () => {
    setAgentTrustLevel(workspace.currentAgent.agent_name, 'trusted', workspace.dir);
    workspace.updateConfig((config) => {
      config.auto_reflect_notes = true;
    });

    const result = runRuntimeNote('Use auth gateway conventions for rollout', {
      tag: ['auth'],
      cwd: workspace.dir,
    });

    assert.equal(result.autoReflectAttempted, true);
    assert.equal(result.detectedType, 'decision');
    assert.ok(result.candidateId);
    assert.ok(result.promotedItemId);
    assert.equal(listCandidates('pending', workspace.dir).length, 0);
    assert.ok(loadState(workspace.dir).recent_decisions.some((item) => item.id === result.promotedItemId));

    const markdown = fs.readFileSync(path.join(workspace.dir, '.brainclaw', 'project.md'), 'utf-8');
    assert.ok(markdown.includes('Use auth gateway conventions for rollout'));
  });

  it('skips auto-reflect on low confidence notes', () => {
    const result = runRuntimeNote('Heads up', {
      autoReflect: true,
      cwd: workspace.dir,
    });

    assert.equal(result.autoReflectAttempted, true);
    assert.equal(result.candidateId, undefined);
    assert.equal(result.skipReason, 'low_confidence');
  });
});
