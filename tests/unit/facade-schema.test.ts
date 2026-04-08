import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkRequestSchema,
  CoordinateRequestSchema,
  FacadeResponseSchema,
} from '../../src/core/facade-schema.js';

describe('WorkRequestSchema', () => {
  it('parses minimal valid input: intent only', () => {
    const result = WorkRequestSchema.safeParse({ intent: 'execute' });
    assert.ok(result.success);
    assert.equal(result.data.intent, 'execute');
    assert.equal(result.data.scope, undefined);
  });

  it('parses valid input with all optional fields', () => {
    const result = WorkRequestSchema.safeParse({
      intent: 'review',
      scope: 'src/foo.ts',
      planId: 'plan-42',
      task: 'Review the auth module',
      messageId: 'msg-001',
      contextTarget: 'auth-context',
    });
    assert.ok(result.success);
    assert.equal(result.data.intent, 'review');
    assert.equal(result.data.scope, 'src/foo.ts');
    assert.equal(result.data.planId, 'plan-42');
    assert.equal(result.data.task, 'Review the auth module');
    assert.equal(result.data.messageId, 'msg-001');
    assert.equal(result.data.contextTarget, 'auth-context');
  });

  it('accepts all valid intent values', () => {
    for (const intent of ['execute', 'consult', 'resume', 'review'] as const) {
      const result = WorkRequestSchema.safeParse({ intent });
      assert.ok(result.success, `intent '${intent}' should be valid`);
    }
  });

  it('rejects missing intent', () => {
    const result = WorkRequestSchema.safeParse({ scope: 'src/foo.ts' });
    assert.ok(!result.success);
  });

  it('rejects unknown intent value', () => {
    const result = WorkRequestSchema.safeParse({ intent: 'deploy' });
    assert.ok(!result.success);
    assert.ok(result.error.issues.length > 0);
  });

  it('rejects empty string intent', () => {
    const result = WorkRequestSchema.safeParse({ intent: '' });
    assert.ok(!result.success);
  });
});

describe('CoordinateRequestSchema', () => {
  it('parses minimal valid input: intent + task', () => {
    const result = CoordinateRequestSchema.safeParse({
      intent: 'assign',
      task: 'Review X',
    });
    assert.ok(result.success);
    assert.equal(result.data.intent, 'assign');
    assert.equal(result.data.task, 'Review X');
    assert.equal(result.data.targetAgents, undefined);
  });

  it('parses valid input with all optional fields', () => {
    const result = CoordinateRequestSchema.safeParse({
      intent: 'reroute',
      task: 'Reassign auth work',
      scope: 'src/auth',
      targetAgents: ['claude-code', 'codex'],
      constraints: { deadline: '2026-04-10', reviewRequired: true },
      threadId: 'thread-abc',
    });
    assert.ok(result.success);
    assert.deepEqual(result.data.targetAgents, ['claude-code', 'codex']);
    assert.equal(result.data.threadId, 'thread-abc');
  });

  it('rejects missing task field', () => {
    const result = CoordinateRequestSchema.safeParse({ intent: 'assign' });
    assert.ok(!result.success);
  });

  it('rejects missing intent field', () => {
    const result = CoordinateRequestSchema.safeParse({ task: 'do something' });
    assert.ok(!result.success);
  });

  it('rejects unknown intent value', () => {
    const result = CoordinateRequestSchema.safeParse({
      intent: 'delegate',
      task: 'do something',
    });
    assert.ok(!result.success);
    assert.ok(result.error.issues.length > 0);
  });

  it('accepts all valid coordinate intent values', () => {
    for (const intent of ['assign', 'consult', 'review', 'reroute', 'summarize'] as const) {
      const result = CoordinateRequestSchema.safeParse({ intent, task: 'task description' });
      assert.ok(result.success, `intent '${intent}' should be valid`);
    }
  });
});

describe('FacadeResponseSchema', () => {
  it('parses valid response with all fields', () => {
    const result = FacadeResponseSchema.safeParse({
      status: 'ok',
      intent: 'execute',
      result: { success: true },
      artifacts: [{ type: 'file', id: 'art-1', path: 'src/out.ts' }],
      side_effects: [{ action: 'claim_created', entity: 'claim', id: 'claim-1' }],
      error: undefined,
      duration_ms: 123,
      claim_status: 'created',
      session_id: 'sess-abc',
      warnings: ['low disk space'],
    });
    assert.ok(result.success);
    assert.equal(result.data.status, 'ok');
    assert.equal(result.data.duration_ms, 123);
    assert.equal(result.data.claim_status, 'created');
    assert.deepEqual(result.data.warnings, ['low disk space']);
  });

  it('parses minimal valid response with empty artifacts and warnings', () => {
    const result = FacadeResponseSchema.safeParse({
      status: 'ok',
      intent: 'execute',
      result: null,
      artifacts: [],
      side_effects: [],
      warnings: [],
    });
    assert.ok(result.success);
    assert.deepEqual(result.data.artifacts, []);
    assert.deepEqual(result.data.warnings, []);
    assert.equal(result.data.error, undefined);
    assert.equal(result.data.claim_status, undefined);
  });

  it('parses error status response', () => {
    const result = FacadeResponseSchema.safeParse({
      status: 'error',
      intent: 'execute',
      result: null,
      artifacts: [],
      side_effects: [],
      warnings: [],
      error: 'Something went wrong',
    });
    assert.ok(result.success);
    assert.equal(result.data.status, 'error');
    assert.equal(result.data.error, 'Something went wrong');
  });

  it('parses partial status response', () => {
    const result = FacadeResponseSchema.safeParse({
      status: 'partial',
      intent: 'review',
      result: { completedSteps: 2 },
      artifacts: [],
      side_effects: [],
      warnings: ['step 3 timed out'],
    });
    assert.ok(result.success);
    assert.equal(result.data.status, 'partial');
  });

  it('rejects unknown status value', () => {
    const result = FacadeResponseSchema.safeParse({
      status: 'pending',
      intent: 'execute',
      result: null,
      artifacts: [],
      side_effects: [],
      warnings: [],
    });
    assert.ok(!result.success);
    assert.ok(result.error.issues.length > 0);
  });

  it('rejects missing required fields', () => {
    const result = FacadeResponseSchema.safeParse({
      status: 'ok',
      intent: 'execute',
      // result, artifacts, side_effects, warnings missing
    });
    assert.ok(!result.success);
  });

  it('accepts all valid claim_status values', () => {
    for (const claim_status of ['created', 'existing', 'none'] as const) {
      const result = FacadeResponseSchema.safeParse({
        status: 'ok',
        intent: 'execute',
        result: null,
        artifacts: [],
        side_effects: [],
        warnings: [],
        claim_status,
      });
      assert.ok(result.success, `claim_status '${claim_status}' should be valid`);
    }
  });
});
