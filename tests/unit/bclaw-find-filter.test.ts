/**
 * Regression coverage for pln#460 — bclaw_find(filter) must honor filter keys.
 *
 * Observed in session sess_4fd7e926: a call to bclaw_find with
 * filter={status:'todo'} on entity=plan returned all 105 plans instead of
 * the 13 that were actually in 'todo' status. Same pattern on entity=trap
 * with filter={status:'active'} (returned a resolved trap).
 *
 * The underlying applyFilter() code (src/core/entity-operations.ts:205) DOES
 * honor `status`, `tag`, `author`, `plan_id`, `source`, `auto_generated`.
 * This test pins the round-trip contract: filter args sent through the MCP
 * tool entry must actually reach applyFilter() and be applied.
 *
 * Also covers the fail-loudly requirement: an unknown filter key (e.g.
 * `banana`) must not silently pass (that's what let me mis-read 50 mixed-
 * status plans as "50 todo plans" in the first place).
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeMcpToolCall } from '../../src/commands/mcp.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { createEntity, updateEntity, transitionEntity } from '../../src/core/entity-operations.js';

interface FindResult {
  entity: string;
  total: number;
  items: Array<Record<string, unknown>>;
}

async function find(
  workspace: TestWorkspace,
  entity: string,
  filter?: Record<string, unknown>,
): Promise<{ isError: boolean; content: FindResult | { code?: string; message?: string } }> {
  const outcome = await executeMcpToolCall({
    name: 'bclaw_find',
    args: filter === undefined ? { entity } : { entity, filter },
    cwd: workspace.dir,
  });
  return {
    isError: outcome.response.isError === true,
    content: outcome.response.structuredContent as unknown as FindResult,
  };
}

describe('bclaw_find — filter honored end-to-end (pln#460)', () => {
  let workspace: TestWorkspace;
  let previousTestMode: string | undefined;
  let restoreCwd: (() => void) | undefined;

  beforeEach(() => {
    previousTestMode = process.env.BRAINCLAW_TEST_MODE;
    process.env.BRAINCLAW_TEST_MODE = '1';
    workspace = createTestWorkspace({
      prefix: 'bclaw-find-filter-',
      currentAgent: 'claude-code',
    });
    restoreCwd = workspace.useCwd();
  });

  afterEach(() => {
    restoreCwd?.();
    workspace.cleanup();
    if (previousTestMode === undefined) delete process.env.BRAINCLAW_TEST_MODE;
    else process.env.BRAINCLAW_TEST_MODE = previousTestMode;
  });

  describe('status filter', () => {
    it('filter={status:"todo"} on entity=plan returns only todo plans', async () => {
      // Three plans, three different statuses.
      const planTodo = createEntity('plan', { text: 'A todo plan', author: 'claude-code' }, workspace.dir);
      const planInProgress = createEntity('plan', { text: 'An in-progress plan', author: 'claude-code' }, workspace.dir);
      transitionEntity('plan', planInProgress.id, 'in_progress', workspace.dir);
      const planDone = createEntity('plan', { text: 'A done plan', author: 'claude-code' }, workspace.dir);
      transitionEntity('plan', planDone.id, 'in_progress', workspace.dir);
      transitionEntity('plan', planDone.id, 'done', workspace.dir);

      const { isError, content } = await find(workspace, 'plan', { status: 'todo' });
      assert.equal(isError, false, `tool must not error: ${JSON.stringify(content)}`);
      const result = content as FindResult;
      assert.equal(result.total, 1, `expected 1 todo plan, got ${result.total} (items statuses: ${result.items.map((i) => i.status).join(', ')})`);
      assert.equal(result.items[0].id, planTodo.id);
      assert.equal(result.items[0].status, 'todo');
    });

    it('filter={status:"done"} on entity=plan returns only done plans', async () => {
      createEntity('plan', { text: 'todo-1', author: 'claude-code' }, workspace.dir);
      const doneA = createEntity('plan', { text: 'done-A', author: 'claude-code' }, workspace.dir);
      transitionEntity('plan', doneA.id, 'in_progress', workspace.dir);
      transitionEntity('plan', doneA.id, 'done', workspace.dir);
      const doneB = createEntity('plan', { text: 'done-B', author: 'claude-code' }, workspace.dir);
      transitionEntity('plan', doneB.id, 'in_progress', workspace.dir);
      transitionEntity('plan', doneB.id, 'done', workspace.dir);

      const { content } = await find(workspace, 'plan', { status: 'done' });
      const result = content as FindResult;
      assert.equal(result.total, 2);
      assert.ok(result.items.every((i) => i.status === 'done'));
    });

    it('filter={status:"pending"} on entity=candidate returns only pending candidates', async () => {
      // Note: candidates only have "pending" in the live bucket. Accepted /
      // rejected are archived on transition (listCandidates() reads pending
      // only). So the meaningful filter contract for candidate is "is the
      // status key honored at all on this entity type?"
      const a = createEntity('candidate', { text: 'cand A', type: 'decision', author: 'claude-code' }, workspace.dir);
      const b = createEntity('candidate', { text: 'cand B', type: 'decision', author: 'claude-code' }, workspace.dir);

      const { content } = await find(workspace, 'candidate', { status: 'pending' });
      const result = content as FindResult;
      assert.equal(result.total, 2, `expected 2 pending candidates, got ${result.total}`);
      const ids = result.items.map((i) => i.id);
      assert.ok(ids.includes(a.id));
      assert.ok(ids.includes(b.id));
    });
  });

  describe('author filter', () => {
    it('filter={author:"codex"} on entity=plan returns only codex-authored plans', async () => {
      createEntity('plan', { text: 'alice plan', author: 'alice' }, workspace.dir);
      const codexPlan = createEntity('plan', { text: 'codex plan', author: 'codex' }, workspace.dir);
      createEntity('plan', { text: 'bob plan', author: 'bob' }, workspace.dir);

      const { content } = await find(workspace, 'plan', { author: 'codex' });
      const result = content as FindResult;
      assert.equal(result.total, 1);
      assert.equal(result.items[0].id, codexPlan.id);
    });
  });

  describe('tag filter', () => {
    it('filter={tag:"security"} on entity=plan returns only plans tagged security', async () => {
      createEntity('plan', { text: 'unrelated', author: 'claude-code' }, workspace.dir);
      const secPlan = createEntity('plan', { text: 'security thing', author: 'claude-code', tags: ['security', 'hardening'] }, workspace.dir);
      createEntity('plan', { text: 'also unrelated', author: 'claude-code', tags: ['perf'] }, workspace.dir);

      const { content } = await find(workspace, 'plan', { tag: 'security' });
      const result = content as FindResult;
      assert.equal(result.total, 1);
      assert.equal(result.items[0].id, secPlan.id);
    });
  });

  describe('combined filters', () => {
    it('filter={status:"todo", tag:"security"} intersects both', async () => {
      createEntity('plan', { text: 'todo no tag', author: 'claude-code' }, workspace.dir);
      createEntity('plan', { text: 'todo perf tag', author: 'claude-code', tags: ['perf'] }, workspace.dir);
      const match = createEntity('plan', { text: 'todo security tag', author: 'claude-code', tags: ['security'] }, workspace.dir);
      const done = createEntity('plan', { text: 'done security', author: 'claude-code', tags: ['security'] }, workspace.dir);
      transitionEntity('plan', done.id, 'in_progress', workspace.dir);
      transitionEntity('plan', done.id, 'done', workspace.dir);

      const { content } = await find(workspace, 'plan', { status: 'todo', tag: 'security' });
      const result = content as FindResult;
      assert.equal(result.total, 1);
      assert.equal(result.items[0].id, match.id);
    });
  });

  describe('no filter', () => {
    it('calling bclaw_find without filter returns every item of the entity', async () => {
      createEntity('plan', { text: 'one', author: 'claude-code' }, workspace.dir);
      createEntity('plan', { text: 'two', author: 'claude-code' }, workspace.dir);
      createEntity('plan', { text: 'three', author: 'claude-code' }, workspace.dir);

      const { content } = await find(workspace, 'plan');
      const result = content as FindResult;
      assert.equal(result.total, 3);
    });

    it('calling bclaw_find with empty filter {} returns every item', async () => {
      createEntity('plan', { text: 'one', author: 'claude-code' }, workspace.dir);
      createEntity('plan', { text: 'two', author: 'claude-code' }, workspace.dir);

      const { content } = await find(workspace, 'plan', {});
      const result = content as FindResult;
      assert.equal(result.total, 2);
    });
  });

  describe('MCP transport quirk — filter arriving as a JSON string (pln#460 follow-up)', () => {
    // Live-session observation: Claude Code's MCP client stringifies the
    // filter object before shipping it over stdio when the tool schema
    // declares `filter: { type: 'object' }` without a sub-property schema.
    // The handler must parse string-typed filters defensively so the whole
    // filter facility doesn't silently break for those clients.

    it('parses a JSON-string filter back into an object before validation', async () => {
      const planTodo = createEntity('plan', { text: 'todo', author: 'claude-code' }, workspace.dir);
      const planDone = createEntity('plan', { text: 'done', author: 'claude-code' }, workspace.dir);
      transitionEntity('plan', planDone.id, 'in_progress', workspace.dir);
      transitionEntity('plan', planDone.id, 'done', workspace.dir);

      // Pass filter as a string (same shape Claude Code sends over stdio).
      const outcome = await executeMcpToolCall({
        name: 'bclaw_find',
        args: { entity: 'plan', filter: '{"status":"todo"}' as unknown as object },
        cwd: workspace.dir,
      });
      assert.equal(outcome.response.isError, false, `expected success, got ${JSON.stringify(outcome.response.structuredContent)}`);
      const result = outcome.response.structuredContent as unknown as FindResult;
      assert.equal(result.total, 1);
      assert.equal(result.items[0].id, planTodo.id);
    });

    it('rejects filter string that is not valid JSON', async () => {
      const outcome = await executeMcpToolCall({
        name: 'bclaw_find',
        args: { entity: 'plan', filter: 'not-json-at-all' as unknown as object },
        cwd: workspace.dir,
      });
      assert.equal(outcome.response.isError, true);
      const envelope = outcome.response.structuredContent as unknown as { error?: { message?: string } };
      assert.match(envelope.error?.message ?? '', /not valid JSON/i);
    });

    it('rejects filter string whose JSON is not an object (e.g. array, number)', async () => {
      const outcome = await executeMcpToolCall({
        name: 'bclaw_find',
        args: { entity: 'plan', filter: '[1, 2, 3]' as unknown as object },
        cwd: workspace.dir,
      });
      assert.equal(outcome.response.isError, true);
      const envelope = outcome.response.structuredContent as unknown as { error?: { message?: string } };
      assert.match(envelope.error?.message ?? '', /must be a JSON object/i);
    });
  });

  describe('unknown filter keys fail loudly (pln#460 stp_c6125ee5)', () => {
    it('filter={banana:"split"} returns a validation_error instead of silently ignoring', async () => {
      createEntity('plan', { text: 'one', author: 'claude-code' }, workspace.dir);

      const { isError, content } = await find(workspace, 'plan', { banana: 'split' });
      assert.equal(
        isError,
        true,
        `unknown filter key must be rejected, not silently ignored (got ${JSON.stringify(content)})`,
      );
      const errorEnvelope = content as unknown as { error?: { kind?: string; message?: string } };
      const errMsg = errorEnvelope.error?.message;
      assert.ok(
        errMsg && /banana|unknown|unsupported filter/i.test(errMsg),
        `error message should name the unknown key; got "${errMsg}"`,
      );
    });

    it('filter with a mix of valid and unknown keys rejects on the unknown one', async () => {
      createEntity('plan', { text: 'one', author: 'claude-code' }, workspace.dir);

      const { isError } = await find(workspace, 'plan', { status: 'todo', banana: 'split' });
      assert.equal(isError, true, 'an unknown key anywhere in filter must be rejected');
    });
  });
});
