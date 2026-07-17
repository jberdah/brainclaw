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
import fs from 'node:fs';
import path from 'node:path';
import { executeMcpToolCall } from '../../src/commands/mcp.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { createEntity, transitionEntity } from '../../src/core/entity-operations.js';
import { createAgentRun } from '../../src/core/agentruns.js';
import { loadState, saveState } from '../../src/core/state.js';

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

  describe('provenance filter diagnostics', () => {
    it('reports legacy records excluded by the default read filter', async () => {
      const legacy = createEntity('constraint', {
        text: 'Legacy-scoped constraint',
        author: 'claude-code',
        category: 'process',
      }, workspace.dir);
      const state = loadState(workspace.dir);
      const item = state.active_constraints.find((constraint) => constraint.id === legacy.id);
      assert.ok(item);
      item.provenance = { kind: 'legacy' };
      saveState(state, workspace.dir);

      const hidden = await find(workspace, 'constraint');
      const hiddenResult = hidden.content as FindResult & {
        excluded_legacy?: number;
        total_before_provenance_filter?: number;
      };
      assert.equal(hiddenResult.total, 0);
      assert.equal(hiddenResult.excluded_legacy, 1);
      assert.equal(hiddenResult.total_before_provenance_filter, 1);

      const visible = await find(workspace, 'constraint', { includeLegacy: true });
      const visibleResult = visible.content as FindResult & { excluded_legacy?: number };
      assert.equal(visibleResult.total, 1);
      assert.equal(visibleResult.excluded_legacy, 0);
      assert.equal(visibleResult.items[0].id, legacy.id);
    });

    it('reports low-confidence auto_reflect records excluded by the default read filter', async () => {
      const autoReflect = createEntity('constraint', {
        text: 'Auto-reflect scoped constraint',
        author: 'claude-code',
        category: 'process',
      }, workspace.dir);
      const state = loadState(workspace.dir);
      const item = state.active_constraints.find((constraint) => constraint.id === autoReflect.id);
      assert.ok(item);
      item.provenance = { kind: 'auto_reflect', confidence: 0.2 };
      saveState(state, workspace.dir);

      const hidden = await find(workspace, 'constraint');
      const hiddenResult = hidden.content as FindResult & {
        excluded_low_confidence_auto_reflect?: number;
        total_before_provenance_filter?: number;
      };
      assert.equal(hiddenResult.total, 0);
      assert.equal(hiddenResult.excluded_low_confidence_auto_reflect, 1);
      assert.equal(hiddenResult.total_before_provenance_filter, 1);

      const visible = await find(workspace, 'constraint', { minAutoReflectConfidence: 0.1 });
      const visibleResult = visible.content as FindResult;
      assert.equal(visibleResult.total, 1);
      assert.equal(visibleResult.items[0].id, autoReflect.id);
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

    it('filter={tags:["security","perf"]} returns entities with any listed tag', async () => {
      const secPlan = createEntity('plan', { text: 'security thing', author: 'claude-code', tags: ['security'] }, workspace.dir);
      const perfPlan = createEntity('plan', { text: 'perf thing', author: 'claude-code', tags: ['perf'] }, workspace.dir);
      createEntity('plan', { text: 'docs thing', author: 'claude-code', tags: ['docs'] }, workspace.dir);

      const { content } = await find(workspace, 'plan', { tags: ['security', 'perf'] });
      const result = content as FindResult;
      assert.equal(result.total, 2);
      assert.deepEqual(new Set(result.items.map((i) => i.id)), new Set([secPlan.id, perfPlan.id]));
    });
  });

  describe('agent_run first-class field filters', () => {
    it('accepts assignment_id, claim_id, and message_id for entity=agent_run', async () => {
      const match = createAgentRun({
        assignment_id: 'asgn_filter_match',
        claim_id: 'clm_filter_match',
        message_id: 'msg_filter_match',
        agent: 'codex',
        transport: 'manual_command',
        scope: 'src/filter',
        description: 'matching run',
      }, workspace.dir);
      createAgentRun({
        assignment_id: 'asgn_filter_other',
        claim_id: 'clm_filter_other',
        message_id: 'msg_filter_other',
        agent: 'codex',
        transport: 'manual_command',
        scope: 'src/filter',
        description: 'other run',
      }, workspace.dir);

      const { isError, content } = await find(workspace, 'agent_run', {
        assignment_id: 'asgn_filter_match',
        claim_id: 'clm_filter_match',
        message_id: 'msg_filter_match',
      });
      assert.equal(isError, false, `expected success, got ${JSON.stringify(content)}`);
      const result = content as FindResult;
      assert.equal(result.total, 1);
      assert.equal(result.items[0].id, match.id);
    });

    it('lazy-reconcile does NOT cancel a young running agent_run with a dead pid (pln#520)', async () => {
      // Before pln#520 the read path cancelled any dead-pid `running` run on
      // sight (status_reason 'pid_dead_at_read'). But on Windows the tracked
      // pid is the untrusted cmd.exe shell-wrapper, not the real worker, so a
      // dead pid does not prove death — 6 workers were cancelled here yet
      // committed minutes later. The read reconciler now leaves a YOUNG
      // dead-pid run `running` (non-destructive); genuine silent deaths
      // converge to `failed` only past the stale window (unit-tested in
      // agentrun-reconciler.test.ts).
      const run = createAgentRun({
        assignment_id: 'asgn_dead_pid',
        claim_id: 'clm_dead_pid',
        agent: 'codex',
        transport: 'cli_spawn',
        status: 'running',
        scope: 'src/filter',
        description: 'dead pid run',
        pid: 99999999,
      }, workspace.dir);

      const { isError, content } = await find(workspace, 'agent_run', { assignment_id: 'asgn_dead_pid' });
      assert.equal(isError, false, `expected success, got ${JSON.stringify(content)}`);
      const result = content as FindResult;
      assert.equal(result.total, 1);
      assert.equal(result.items[0].id, run.id);
      assert.equal(result.items[0].status, 'running');
      assert.notEqual(result.items[0].status_reason, 'pid_dead_at_read');

      const getOutcome = await executeMcpToolCall({
        name: 'bclaw_get',
        args: { entity: 'agent_run', id: run.id },
        cwd: workspace.dir,
      });
      const getResult = getOutcome.response.structuredContent as unknown as { item?: { status?: string; status_reason?: string } };
      assert.equal(getResult.item?.status, 'running');
    });
  });

  describe('load-validation warnings', () => {
    it('surfaces invalid decision files via bclaw_find warnings and bclaw_get validation_failed', async () => {
      const dir = path.join(workspace.dir, '.brainclaw', 'memory', 'decisions');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'dec_invalid_fixture.json'), JSON.stringify({
        schema_version: 2,
        id: 'dec_invalid_fixture',
        text: 'invalid decision missing required fields',
      }, null, 2));

      const findOutcome = await executeMcpToolCall({
        name: 'bclaw_find',
        args: { entity: 'decision' },
        cwd: workspace.dir,
      });
      assert.equal(findOutcome.response.isError, false);
      const findResult = findOutcome.response.structuredContent as unknown as FindResult & {
        warnings?: Array<{ entity_id?: string; validation_errors?: string[]; path?: string }>;
      };
      assert.ok(Array.isArray(findResult.warnings));
      const warning = findResult.warnings.find((w) => w.entity_id === 'dec_invalid_fixture');
      assert.ok(warning, `expected warning for invalid fixture, got ${JSON.stringify(findResult.warnings)}`);
      assert.ok(warning.validation_errors?.length);
      assert.ok(warning.path?.endsWith('dec_invalid_fixture.json'));

      const getOutcome = await executeMcpToolCall({
        name: 'bclaw_get',
        args: { entity: 'decision', id: 'dec_invalid_fixture' },
        cwd: workspace.dir,
      });
      assert.equal(getOutcome.response.isError, true);
      const getResult = getOutcome.response.structuredContent as unknown as {
        ok?: boolean;
        error?: string;
        entity_id?: string;
        validation_errors?: string[];
      };
      assert.equal(getResult.ok, false);
      assert.equal(getResult.error, 'validation_failed');
      assert.equal(getResult.entity_id, 'dec_invalid_fixture');
      assert.ok(getResult.validation_errors?.length);
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

  describe('entity-scoped filter keys (trp#928)', () => {
    // trp#928 doc-vs-facts (pln#599): the schema says assignment_id / claim_id /
    // message_id are entity="agent_run" only. Before this landing the rejection
    // classified them as "unknown" for other entities — misleading. The
    // rejection now names the constraint AND points at the entity that DOES
    // accept the key (executable path).
    it('assignment_id on entity=plan is rejected with an entity-scoping error, not an "unknown key" error', async () => {
      createEntity('plan', { text: 'one', author: 'claude-code' }, workspace.dir);

      const { isError, content } = await find(workspace, 'plan', { assignment_id: 'asgn_test' });
      assert.equal(isError, true);
      const errorEnvelope = content as unknown as {
        error?: { message?: string; details?: { mis_scoped_keys?: string[]; agent_run_only_keys?: string[] } };
      };
      const message = errorEnvelope.error?.message ?? '';
      assert.match(message, /only valid for entity="agent_run"/i, `error must name the constraint: ${message}`);
      assert.match(message, /entity="plan"/i, `error must name the caller's entity: ${message}`);
      assert.match(message, /assignment_id/i, `error must name the mis-scoped key: ${message}`);
      // Machine-readable details.
      const details = errorEnvelope.error?.details;
      assert.ok(details?.mis_scoped_keys?.includes('assignment_id'));
      assert.ok(details?.agent_run_only_keys?.includes('assignment_id'));
    });

    it('claim_id on entity=agent_run still passes (positive baseline)', async () => {
      const { isError } = await find(workspace, 'agent_run', { claim_id: 'clm_test' });
      assert.equal(isError, false, 'agent_run must still accept the scoped keys');
    });
  });

  describe('boolean-typed filter keys (Codex review of #83)', () => {
    it('includeReputation with a non-boolean value is rejected (not silently coerced to a no-op)', async () => {
      const { isError, content } = await find(workspace, 'agent', { includeReputation: 'true' });
      assert.equal(isError, true, 'a stringy includeReputation must be rejected, not silently ignored');
      const errorEnvelope = content as unknown as {
        error?: { message?: string; details?: { non_boolean_keys?: string[] } };
      };
      const message = errorEnvelope.error?.message ?? '';
      assert.match(message, /includeReputation/i, `error must name the key: ${message}`);
      assert.match(message, /boolean/i, `error must say it must be boolean: ${message}`);
      assert.ok(errorEnvelope.error?.details?.non_boolean_keys?.includes('includeReputation'));
    });

    it('includeReputation:true is accepted (agent-scoped boolean)', async () => {
      const { isError } = await find(workspace, 'agent', { includeReputation: true });
      assert.equal(isError, false, 'a proper boolean includeReputation must pass');
    });

    it('a numeric includeReputation is also rejected', async () => {
      const { isError } = await find(workspace, 'agent', { includeReputation: 1 });
      assert.equal(isError, true, 'a numeric includeReputation must be rejected');
    });
  });
});
