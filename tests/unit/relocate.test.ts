import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import { createEntity, getEntity } from '../../src/core/entity-operations.js';
import { saveClaim } from '../../src/core/claims.js';
import { relocateEntity } from '../../src/core/operations/relocate.js';
import { executeMcpToolCall } from '../../src/commands/mcp.js';

/**
 * pln#595 — `bclaw move` / relocateEntity: id-preserving cross-project
 * relocation. The guards (collision, not-found, execution-local, same-project,
 * live-claim) are the safety surface, so each gets a case.
 */
const cleanup: string[] = [];
const ENV_KEYS = ['BRAINCLAW_CWD', 'BRAINCLAW_PROJECT', 'BRAINCLAW_SESSION_ID'];
let savedEnv: Record<string, string | undefined> = {};
afterEach(() => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  savedEnv = {};
  while (cleanup.length > 0) fs.rmSync(cleanup.pop() as string, { recursive: true, force: true });
});

function makeStore(dir: string, name: string, opts: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  saveConfig(defaultConfig(name, { projectId: `prj_${name}`, ...opts }), dir);
}
function planFile(projectDir: string, id: string): string {
  return path.join(projectDir, '.brainclaw', 'coordination', 'plans', `${id}.json`);
}
function makeWorkspace(): { root: string; a: string; b: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-move-'));
  cleanup.push(root);
  makeStore(root, 'global', { projectMode: 'multi-project', projectStrategy: 'folder' });
  const a = path.join(root, 'applications', 'app_a');
  fs.mkdirSync(a, { recursive: true }); makeStore(a, 'app_a');
  const b = path.join(root, 'applications', 'app_b');
  fs.mkdirSync(b, { recursive: true }); makeStore(b, 'app_b');
  // Anchor resolution to this workspace (mirrors the MCP BRAINCLAW_CWD anchor) so
  // project-ref resolution doesn't walk up past the temp root to a stray store.
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.BRAINCLAW_CWD = root;
  delete process.env.BRAINCLAW_PROJECT;
  delete process.env.BRAINCLAW_SESSION_ID;
  return { root, a, b };
}
function mkPlan(cwd: string, text = 'misplaced'): string {
  return createEntity('plan', { text, author: 'tester', type: 'feat', priority: 'low' }, cwd).id as string;
}

describe('relocateEntity (pln#595 — bclaw move)', () => {
  it('moves a plan A→B preserving its id + content, and removes it from the source', () => {
    const { a, b } = makeWorkspace();
    const id = mkPlan(a, 'created in the wrong store');
    assert.ok(fs.existsSync(planFile(a, id)), 'plan starts in A');

    const res = relocateEntity({ entity: 'plan', id, toProject: 'app_b', cwd: a, actor: 'tester' });
    assert.equal(res.to, path.resolve(b));
    assert.equal(res.from, path.resolve(a));
    assert.equal(fs.existsSync(planFile(a, id)), false, 'gone from source');
    assert.ok(fs.existsSync(planFile(b, id)), 'present in target with the SAME id');
    const moved = getEntity('plan', id, b) as { text?: string };
    assert.equal(moved.text, 'created in the wrong store', 'content preserved');
  });

  it('refuses to overwrite an id that already exists in the target', () => {
    const { a, b } = makeWorkspace();
    const id = mkPlan(a);
    const bDir = path.dirname(planFile(b, id));
    fs.mkdirSync(bDir, { recursive: true });
    fs.copyFileSync(planFile(a, id), planFile(b, id)); // simulate a colliding id
    assert.throws(() => relocateEntity({ entity: 'plan', id, toProject: 'app_b', cwd: a }), /already exists/);
    assert.ok(fs.existsSync(planFile(a, id)), 'source untouched on refusal');
  });

  it('throws when the item is not in the source project', () => {
    const { a } = makeWorkspace();
    assert.throws(() => relocateEntity({ entity: 'plan', id: 'pln_does_not_exist', toProject: 'app_b', cwd: a }), /not found/);
  });

  it('rejects execution-local entities (claim/assignment/agent_run/session)', () => {
    const { a } = makeWorkspace();
    for (const entity of ['claim', 'assignment', 'agent_run', 'session'] as const) {
      assert.throws(() => relocateEntity({ entity, id: 'x', toProject: 'app_b', cwd: a }), /relocatable/);
    }
  });

  it('refuses a no-op move to the same project', () => {
    const { a } = makeWorkspace();
    assert.throws(() => relocateEntity({ entity: 'plan', id: 'pln_any', toProject: 'app_a', cwd: a }), /same project/);
  });

  it('refuses to move a plan under an active claim, unless force (which warns)', () => {
    const { a, b } = makeWorkspace();
    const id = mkPlan(a);
    saveClaim({
      id: 'clm_live', agent: 'tester', scope: 'x', description: 'd',
      created_at: new Date().toISOString(), status: 'active', plan_id: id,
    }, a);

    assert.throws(() => relocateEntity({ entity: 'plan', id, toProject: 'app_b', cwd: a }), /active claim/);
    assert.ok(fs.existsSync(planFile(a, id)), 'not moved while refused');

    const res = relocateEntity({ entity: 'plan', id, toProject: 'app_b', cwd: a, force: true });
    assert.ok(res.warnings.some((w) => /active claim/.test(w)), 'force surfaces a warning');
    assert.ok(fs.existsSync(planFile(b, id)), 'moved with force');
  });

  it('moves non-plan knowledge entities (decision, shared trap) preserving id + store subdir', () => {
    const { a, b } = makeWorkspace();
    const decId = createEntity('decision', { text: 'a decision', author: 'tester', outcome: 'pending' }, a).id as string;
    const trapId = createEntity('trap', { text: 'a trap', author: 'tester', severity: 'medium' }, a).id as string;

    relocateEntity({ entity: 'decision', id: decId, toProject: 'app_b', cwd: a, actor: 'tester' });
    relocateEntity({ entity: 'trap', id: trapId, toProject: 'app_b', cwd: a, actor: 'tester' });

    assert.ok(fs.existsSync(path.join(b, '.brainclaw', 'memory', 'decisions', `${decId}.json`)), 'decision in target');
    assert.equal(fs.existsSync(path.join(a, '.brainclaw', 'memory', 'decisions', `${decId}.json`)), false, 'decision gone from source');
    assert.ok(fs.existsSync(path.join(b, '.brainclaw', 'memory', 'traps', `${trapId}.json`)), 'shared trap in target/traps');
    assert.equal((getEntity('decision', decId, b) as { text?: string }).text, 'a decision', 'decision content preserved');
  });

  it('relocates end-to-end through the bclaw_move MCP verb', async () => {
    const { a, b } = makeWorkspace();
    const id = mkPlan(a, 'via mcp');
    // Establish identity the way a real caller does — a session before the write.
    const start = await executeMcpToolCall({ name: 'bclaw_session_start', args: { agent: 'tester' }, cwd: a, connectionSessionId: 'sess_move' });
    const sid = start.nextConnectionSessionId ?? 'sess_move';
    const out = await executeMcpToolCall({
      name: 'bclaw_move',
      args: { entity: 'plan', id, to_project: 'app_b' },
      cwd: a,
      connectionSessionId: sid,
    });
    const sc = out.response?.structuredContent as { to?: string } | undefined;
    assert.equal(sc?.to, path.resolve(b));
    assert.equal(fs.existsSync(planFile(a, id)), false, 'gone from source via MCP');
    assert.ok(fs.existsSync(planFile(b, id)), 'present in target via MCP');
  });
});
