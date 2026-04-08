import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CoordinateRequestSchema } from '../../src/core/facade-schema.js';
import { getSpawnableAgents } from '../../src/core/agent-capability.js';

describe('bclaw_coordinate — schema', () => {
  it('parses valid assign params', () => {
    const result = CoordinateRequestSchema.safeParse({
      intent: 'assign',
      task: 'Implement feature X',
      scope: 'src/feature-x',
      targetAgents: ['claude-code', 'codex'],
    });
    assert.ok(result.success);
    assert.equal(result.data.intent, 'assign');
    assert.deepEqual(result.data.targetAgents, ['claude-code', 'codex']);
  });

  it('parses valid consult params without targetAgents', () => {
    const result = CoordinateRequestSchema.safeParse({
      intent: 'consult',
      task: 'What is the best approach for auth?',
    });
    assert.ok(result.success);
    assert.equal(result.data.intent, 'consult');
    assert.equal(result.data.targetAgents, undefined);
  });

  it('parses valid review params with scope', () => {
    const result = CoordinateRequestSchema.safeParse({
      intent: 'review',
      task: 'Review PR #42',
      scope: 'src/auth',
    });
    assert.ok(result.success);
    assert.equal(result.data.intent, 'review');
    assert.equal(result.data.scope, 'src/auth');
  });

  it('parses valid reroute params', () => {
    const result = CoordinateRequestSchema.safeParse({
      intent: 'reroute',
      task: 'Reassign auth work',
      scope: 'src/auth',
      targetAgents: ['opencode'],
    });
    assert.ok(result.success);
    assert.equal(result.data.intent, 'reroute');
  });

  it('parses valid summarize params with threadId', () => {
    const result = CoordinateRequestSchema.safeParse({
      intent: 'summarize',
      task: 'Summarize review discussion',
      threadId: 'thread-abc-123',
    });
    assert.ok(result.success);
    assert.equal(result.data.threadId, 'thread-abc-123');
  });

  it('rejects unknown intent', () => {
    const result = CoordinateRequestSchema.safeParse({
      intent: 'unknown_intent',
      task: 'do something',
    });
    assert.ok(!result.success);
    assert.ok(result.error.message.includes('invalid_enum_value') || result.error.issues.length > 0);
  });

  it('rejects missing task field', () => {
    const result = CoordinateRequestSchema.safeParse({
      intent: 'assign',
    });
    assert.ok(!result.success);
  });

  it('rejects missing intent field', () => {
    const result = CoordinateRequestSchema.safeParse({
      task: 'do something',
    });
    assert.ok(!result.success);
  });

  it('accepts constraints as arbitrary record', () => {
    const result = CoordinateRequestSchema.safeParse({
      intent: 'assign',
      task: 'Deploy backend',
      constraints: { deadline: '2026-04-10', reviewRequired: true },
    });
    assert.ok(result.success);
    assert.deepEqual(result.data.constraints, { deadline: '2026-04-10', reviewRequired: true });
  });
});

describe('bclaw_coordinate — assign without targetAgents uses getSpawnableAgents', () => {
  it('getSpawnableAgents returns CLI-spawnable agents', () => {
    const spawnable = getSpawnableAgents();
    assert.ok(Array.isArray(spawnable));
    assert.ok(spawnable.length > 0, 'at least one spawnable agent must exist');
    for (const entry of spawnable) {
      assert.ok(typeof entry.name === 'string', 'each entry has a name');
      assert.ok(typeof entry.template.command === 'string', 'each entry has a command template');
      assert.ok(typeof entry.template.binary === 'string', 'each entry has a binary');
    }
  });

  it('getSpawnableAgents includes known CLI agents', () => {
    const spawnable = getSpawnableAgents();
    const names = spawnable.map((a) => a.name);
    // claude-code, codex, opencode are CLI-spawnable in profiles
    assert.ok(names.includes('claude-code'), 'claude-code should be spawnable');
    assert.ok(names.includes('codex'), 'codex should be spawnable');
  });

  it('CoordinateRequestSchema without targetAgents signals fallback to getSpawnableAgents', () => {
    const result = CoordinateRequestSchema.safeParse({
      intent: 'assign',
      task: 'Build the widget',
    });
    assert.ok(result.success);
    // targetAgents undefined → handler falls back to getSpawnableAgents()
    assert.equal(result.data.targetAgents, undefined);
    const spawnable = getSpawnableAgents();
    assert.ok(spawnable.length > 0, 'fallback list is non-empty');
  });
});
