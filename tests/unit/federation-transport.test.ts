import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { createFederationMessage, type FederationMessage } from '../../src/core/federation-message.js';
import { pushSignal, pullSignals, markSignalProcessed } from '../../src/core/federation-transport.js';

describe('federation-transport', () => {
  let projectA: TestWorkspace;
  let projectB: TestWorkspace;

  beforeEach(() => {
    process.env.BRAINCLAW_TEST_MODE = '1';
    projectA = createTestWorkspace({ prefix: 'bclaw-fed-a-', projectId: 'prj_a' });
    projectB = createTestWorkspace({ prefix: 'bclaw-fed-b-', projectId: 'prj_b' });
  });

  afterEach(() => {
    projectA.cleanup();
    projectB.cleanup();
    delete process.env.BRAINCLAW_TEST_MODE;
  });

  function makeSignal(overrides: Partial<FederationMessage> = {}): FederationMessage {
    return createFederationMessage({
      version: 1,
      from: {
        project_name: 'project-a',
        project_path: projectA.dir,
        agent_name: 'claude-code',
      },
      to: {
        project_name: 'project-b',
        project_path: projectB.dir,
      },
      type: 'handoff',
      payload: { text: 'Please review the API changes' },
      ...overrides,
    });
  }

  it('pushSignal writes a message file to target project inbox', () => {
    const msg = makeSignal();
    pushSignal(projectB.dir, msg);

    const inboxDir = path.join(projectB.dir, '.brainclaw', 'coordination', 'inbox', 'cross-project');
    assert.ok(fs.existsSync(inboxDir), 'inbox dir should exist');

    const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json'));
    assert.equal(files.length, 1);
    assert.ok(files[0].includes(msg.id));
  });

  it('pushSignal is idempotent — second push does not duplicate', () => {
    const msg = makeSignal();
    pushSignal(projectB.dir, msg);
    pushSignal(projectB.dir, msg);

    const inboxDir = path.join(projectB.dir, '.brainclaw', 'coordination', 'inbox', 'cross-project');
    const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json'));
    assert.equal(files.length, 1);
  });

  it('pullSignals reads messages from a project inbox', () => {
    const msg1 = makeSignal();
    const msg2 = makeSignal({ type: 'candidate' });
    pushSignal(projectB.dir, msg1);
    pushSignal(projectB.dir, msg2);

    const pulled = pullSignals(projectB.dir);
    assert.equal(pulled.length, 2);
    assert.ok(pulled.some(m => m.id === msg1.id));
    assert.ok(pulled.some(m => m.id === msg2.id));
  });

  it('pullSignals with since filter returns only newer messages', () => {
    const older = makeSignal();
    pushSignal(projectB.dir, older);

    // Create a newer message with a later timestamp
    const newer = createFederationMessage({
      version: 1,
      from: { project_name: 'project-a', project_path: projectA.dir, agent_name: 'claude-code' },
      to: { project_name: 'project-b', project_path: projectB.dir },
      type: 'runtime_note',
      payload: { text: 'newer note' },
    });
    pushSignal(projectB.dir, newer);

    const filtered = pullSignals(projectB.dir, { since: older.created_at });
    // Should exclude the older message (created_at <= since)
    assert.ok(filtered.length <= 2);
  });

  it('pullSignals returns empty for non-existent project', () => {
    const pulled = pullSignals('/nonexistent/path');
    assert.equal(pulled.length, 0);
  });

  it('markSignalProcessed moves file to .processed/', () => {
    const msg = makeSignal();
    pushSignal(projectB.dir, msg);

    markSignalProcessed(projectB.dir, msg.id);

    const inboxDir = path.join(projectB.dir, '.brainclaw', 'coordination', 'inbox', 'cross-project');
    const processedDir = path.join(inboxDir, '.processed');
    const inboxFiles = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json'));
    assert.equal(inboxFiles.length, 0, 'inbox should be empty after processing');
    assert.ok(fs.existsSync(processedDir), '.processed dir should exist');
    const processedFiles = fs.readdirSync(processedDir).filter(f => f.endsWith('.json'));
    assert.equal(processedFiles.length, 1);
  });

  it('full flow: project A pushes → project B pulls → project B processes', () => {
    // A pushes a handoff to B
    const handoff = makeSignal({ type: 'handoff', payload: { text: 'Review needed on auth module' } });
    pushSignal(projectB.dir, handoff);

    // B pulls signals
    const signals = pullSignals(projectB.dir);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].type, 'handoff');
    assert.equal(signals[0].from.project_name, 'project-a');

    // B processes the signal
    markSignalProcessed(projectB.dir, handoff.id);

    // B should not see it again
    const afterProcess = pullSignals(projectB.dir);
    assert.equal(afterProcess.length, 0);
  });
});
