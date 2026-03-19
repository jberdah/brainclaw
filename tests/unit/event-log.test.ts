import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import {
  appendEvent,
  readAllEvents,
  readUnseenEvents,
  buildNotificationSummary,
  rotateEventLogIfNeeded,
} from '../../src/core/event-log.js';

describe('event-log', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-eventlog-',
      projectId: 'prj_eventlog_test',
      currentAgent: 'testuser',
    });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('appends events to events.jsonl', () => {
    appendEvent({ action: 'create', item_type: 'decision', item_id: 'dec_test', agent: 'alice' }, workspace.dir);
    appendEvent({ action: 'update', item_type: 'plan', item_id: 'pln_test', agent: 'bob' }, workspace.dir);

    const events = readAllEvents(workspace.dir);
    assert.equal(events.length, 2);
    assert.equal(events[0].agent, 'alice');
    assert.equal(events[0].action, 'create');
    assert.equal(events[1].agent, 'bob');
  });

  it('readUnseenEvents returns only events from other agents', () => {
    appendEvent({ action: 'create', item_type: 'decision', agent: 'alice' }, workspace.dir);
    appendEvent({ action: 'create', item_type: 'trap', agent: 'bob' }, workspace.dir);
    appendEvent({ action: 'update', item_type: 'plan', agent: 'alice' }, workspace.dir);

    const unseen = readUnseenEvents('alice', workspace.dir);
    assert.equal(unseen.length, 1);
    assert.equal(unseen[0].agent, 'bob');
  });

  it('cursor advances — second read returns empty', () => {
    appendEvent({ action: 'create', item_type: 'decision', agent: 'alice' }, workspace.dir);

    const first = readUnseenEvents('bob', workspace.dir);
    assert.equal(first.length, 1);

    const second = readUnseenEvents('bob', workspace.dir);
    assert.equal(second.length, 0);
  });

  it('cursor picks up new events after advance', () => {
    appendEvent({ action: 'create', item_type: 'decision', agent: 'alice' }, workspace.dir);
    readUnseenEvents('bob', workspace.dir);

    appendEvent({ action: 'update', item_type: 'trap', agent: 'alice' }, workspace.dir);
    const unseen = readUnseenEvents('bob', workspace.dir);
    assert.equal(unseen.length, 1);
    assert.equal(unseen[0].action, 'update');
  });

  it('buildNotificationSummary groups by action:type', () => {
    const events = [
      { ts: '', agent: 'a', action: 'create' as const, item_type: 'decision' as const },
      { ts: '', agent: 'a', action: 'create' as const, item_type: 'decision' as const },
      { ts: '', agent: 'b', action: 'update' as const, item_type: 'plan' as const },
    ];
    const summary = buildNotificationSummary(events);
    assert.deepEqual(summary, { 'create:decision': 2, 'update:plan': 1 });
  });

  it('buildNotificationSummary returns undefined for empty', () => {
    assert.equal(buildNotificationSummary([]), undefined);
  });

  it('rotateEventLogIfNeeded is a no-op under threshold', () => {
    appendEvent({ action: 'create', item_type: 'decision', agent: 'test' }, workspace.dir);
    assert.equal(rotateEventLogIfNeeded(workspace.dir), false);

    const events = readAllEvents(workspace.dir);
    assert.equal(events.length, 1);
  });
});
