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

/**
 * pln#649 — `bclaw move` and the pre-migration flat layout.
 *
 * Both cases below come from a Fable audit that ranked this the most serious of the
 * remaining by-id sites, and both are the same directory-vs-file confusion already
 * fixed in the entity locator and the by-id loaders: `resolveEntityDir(…, 'read')`
 * picks the canonical directory as soon as it holds ANY file, which is the wrong
 * question when you are looking for ONE record.
 */
describe('relocateEntity across storage layouts (pln#649)', () => {
  /** Move a record from the canonical layout to the legacy flat one. */
  function demoteToLegacy(projectDir: string, id: string): string {
    const legacyDir = path.join(projectDir, '.brainclaw', 'plans');
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacy = path.join(legacyDir, `${id}.json`);
    fs.renameSync(planFile(projectDir, id), legacy);
    return legacy;
  }

  it('finds a source record that still sits in the LEGACY layout', () => {
    const { a, b } = makeWorkspace();
    const legacyId = mkPlan(a, 'legacy record');
    mkPlan(a, 'canonical sibling');       // makes the canonical dir non-empty
    demoteToLegacy(a, legacyId);

    const result = relocateEntity({ entity: 'plan', id: legacyId, toProject: 'app_b', cwd: a, actor: 'tester' });
    assert.equal(result.id, legacyId);
    assert.ok(fs.existsSync(planFile(b, legacyId)), 'the record must land in the target');
    assert.ok(!fs.existsSync(path.join(a, '.brainclaw', 'plans', `${legacyId}.json`)), 'source removed');
  });

  // The dangerous one: the guard passed because it only looked at the canonical dir,
  // so the move wrote a canonical copy BESIDE a legacy one — manufacturing the very
  // duplicate id that the entity locator refuses as `ambiguous`, leaving the entity
  // permanently unroutable.
  it('REFUSES to create a second copy when the target holds the id in the LEGACY layout', () => {
    const { a, b } = makeWorkspace();
    const id = mkPlan(a, 'source');
    const decoy = mkPlan(b, 'already there under the old layout');
    // Give the target a legacy record with the SAME id as the one being moved.
    const legacyDir = path.join(b, '.brainclaw', 'plans');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.renameSync(planFile(b, decoy), path.join(legacyDir, `${id}.json`));

    assert.throws(
      () => relocateEntity({ entity: 'plan', id, toProject: 'app_b', cwd: a, actor: 'tester' }),
      /already exists in the target project/,
      'a canonical-only guard would have created an intra-store duplicate id',
    );
    // And nothing moved: the source is intact, the target gained no canonical copy.
    assert.ok(fs.existsSync(planFile(a, id)), 'source must be untouched by a refused move');
    assert.ok(!fs.existsSync(planFile(b, id)), 'no canonical copy may be created');
  });
});

/**
 * pln#649 / dec#153 — ENTITY vs EXPLICIT PROJECT on `bclaw_transition`.
 *
 * The only canonical-grammar surface that takes both authorities at once (an entity id
 * AND `project=`), and the very call documented in trp#1327 as the coordinator's
 * workaround for a stuck assignment — so operators reach it. A divergence used to
 * produce a misleading `not found in <B>`: the record exists, just not where the caller
 * named. dec#153 requires the divergence be REFUSED and NAMED, so the caller learns
 * which of their two statements was wrong instead of doubting the id.
 *
 * Pin written from the DECISION text rather than from the implemented behaviour —
 * the discipline whose absence produced two defects pinned as features earlier.
 */
describe('bclaw_transition — entity vs explicit project (dec#153)', () => {
  it('REFUSES when the named project is not where the entity lives, and names the project back', async () => {
    const { a } = makeWorkspace();
    const id = mkPlan(a, 'lives in app_a');

    // Caller names app_b while the plan is in app_a: two authorities, disagreeing.
    const res = await executeMcpToolCall({ name: 'bclaw_transition', cwd: a, args: {
      entity: 'plan', id, to: 'in_progress', project: 'app_b', agent: 'tester' } });

    const text = JSON.stringify(res);
    assert.match(text, /does not live in project/, 'the divergence must be named, not reported as not-found');
    assert.match(text, /app_b/, 'the project the caller typed is theirs already — naming it back is free');
    assert.doesNotMatch(text, /app_a/, 'WHERE it really lives is new information: a count, not a name');
  });

  it('still works when the named project IS the owner (no false refusal)', async () => {
    const { a } = makeWorkspace();
    const id = mkPlan(a, 'lives in app_a');
    const res = await executeMcpToolCall({ name: 'bclaw_transition', cwd: a, args: {
      entity: 'plan', id, to: 'in_progress', project: 'app_a', agent: 'tester' } });
    assert.doesNotMatch(JSON.stringify(res), /does not live in project/, 'agreement must not be refused');
  });
});
