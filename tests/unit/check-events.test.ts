import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { appendEvent, readUnseenEvents } from '../../src/core/event-log.js';
import { runCheckEvents } from '../../src/commands/check-events.js';

describe('check-events command', () => {
  let workspace: TestWorkspace;
  let restoreCwd: () => void;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-check-events-',
      projectId: 'prj_check_events_test',
      currentAgent: 'testuser',
    });
    restoreCwd = workspace.useCwd();
  });

  afterEach(() => {
    restoreCwd();
    workspace.cleanup();
  });

  it('runs without error when no events exist', () => {
    // Should not throw
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
    try {
      runCheckEvents({ agent: 'testuser' });
      assert.ok(logs.some(l => l.includes('No unseen events')));
    } finally {
      console.log = origLog;
    }
  });

  it('displays unseen events from other agents', () => {
    appendEvent({ action: 'create', item_type: 'decision', agent: 'alice', item_id: 'dec_abc123' }, workspace.dir);
    appendEvent({ action: 'update', item_type: 'plan', agent: 'bob', item_id: 'pln_xyz456' }, workspace.dir);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
    try {
      runCheckEvents({ agent: 'testuser' });
      const output = logs.join('\n');
      assert.ok(output.includes('2 unseen event(s)'));
      assert.ok(output.includes('create:decision'));
      assert.ok(output.includes('update:plan'));
    } finally {
      console.log = origLog;
    }
  });

  it('outputs JSON when --json flag is set', () => {
    appendEvent({ action: 'claim', item_type: 'claim', agent: 'alice' }, workspace.dir);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
    try {
      runCheckEvents({ agent: 'testuser', json: true });
      const parsed = JSON.parse(logs[0]) as { agent: string; unseen: number; summary: Record<string, number> };
      assert.equal(parsed.agent, 'testuser');
      assert.equal(parsed.unseen, 1);
      assert.equal(parsed.summary['claim:claim'], 1);
    } finally {
      console.log = origLog;
    }
  });

  it('excludes self-events', () => {
    appendEvent({ action: 'create', item_type: 'decision', agent: 'testuser' }, workspace.dir);
    appendEvent({ action: 'create', item_type: 'trap', agent: 'alice' }, workspace.dir);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(' '));
    try {
      runCheckEvents({ agent: 'testuser' });
      const output = logs.join('\n');
      assert.ok(output.includes('1 unseen event(s)'));
      assert.ok(output.includes('alice'));
      assert.ok(!output.includes('testuser'));
    } finally {
      console.log = origLog;
    }
  });

  it('advances cursor — second call shows no events', () => {
    appendEvent({ action: 'create', item_type: 'decision', agent: 'alice' }, workspace.dir);

    const logs1: string[] = [];
    const logs2: string[] = [];
    const origLog = console.log;

    console.log = (...args: unknown[]) => logs1.push(args.join(' '));
    runCheckEvents({ agent: 'testuser' });

    console.log = (...args: unknown[]) => logs2.push(args.join(' '));
    runCheckEvents({ agent: 'testuser' });

    console.log = origLog;

    assert.ok(logs1.join('\n').includes('1 unseen event(s)'));
    assert.ok(logs2.some(l => l.includes('No unseen events')));
  });
});
