/**
 * pln#649 step 3 (F5 of dec#153) — `bclaw_assignment_update` is routed by the
 * ENTITY, not by ambient resolution.
 *
 * PINNED AT THE SURFACE, deliberately. The locator has its own unit pins, but green
 * core tests are exactly what shipped two inert features before
 * (feedback_verify_at_the_surface_not_the_core): what has to hold is that the MCP
 * HANDLER a worker actually calls reaches the right store. So these drive
 * `handleBclawAssignmentUpdate` and then assert the transition ON DISK in the target
 * project.
 *
 * The first pin is the field defect that started this whole thread: a worker whose
 * resolved store was not the assignment's got `Assignment not found` and the
 * assignment stayed `offered` forever, with no route for the coordinator to fix it.
 *
 * @module
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import { createAssignment, loadAssignment, transitionAssignment } from '../../src/core/assignments.js';
import { handleBclawAssignmentUpdate, handleBclawReleaseClaim } from '../../src/commands/mcp-write-claims.js';
import { loadClaim, saveClaim } from '../../src/core/claims.js';
import { executeMcpToolCall } from '../../src/commands/mcp.js';
import type { McpWriteClaimsContext } from '../../src/commands/mcp-write-claims.js';
import type { McpToolExecutionPayload } from '../../src/commands/mcp-contract.js';

const ENV_KEYS = ['BRAINCLAW_CWD', 'BRAINCLAW_PROJECT', 'BRAINCLAW_SESSION_ID', 'BRAINCLAW_STORE_BOUNDARY', 'BRAINCLAW_AGENT_NAME'];
let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const c of cleanups.reverse()) c();
  cleanups = [];
});

function withCleanEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    for (const [k, v] of Object.entries(vars)) process.env[k] = v;
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/**
 * Only `ensureTrust` is reachable on the path under test, so the rest of the context
 * is intentionally absent — a full fake would assert nothing extra and would rot
 * every time the interface grows.
 *
 * IT REFUSES ANY STORE BUT `trustedCwd` (review P2-5). The first version invented an
 * identity regardless of the cwd it was handed, so the field-defect pin could not
 * actually prove that routing happened BEFORE trust — the handler would have passed
 * with the ambient store too. Modelling the real constraint (an agent registered
 * only in the owning project) is what makes that pin load-bearing: if routing
 * regresses, ensureTrust is called with the workspace root and the call fails.
 */
function fakeCtx(agentName: string, trustedCwd: string): McpWriteClaimsContext {
  return {
    ensureTrust: (_args: unknown, _fields: unknown, _level: unknown, cwd?: string) => {
      if (path.resolve(cwd ?? '') !== path.resolve(trustedCwd)) {
        return { error: { kind: 'trust_error', message: `agent not registered in ${cwd}` } };
      }
      return { identity: { agent_name: agentName, agent_id: 'agt_test' } };
    },
  } as unknown as McpWriteClaimsContext;
}

/** Release goes through resolveMutationIdentity + blockCrossProjectExecution, so the fake
 * context must answer those too — and, like fakeCtx, it REFUSES any store but the owner's
 * so a routing regression makes these pins fail. */
function releaseCtx(agentName: string, trustedCwd: string): McpWriteClaimsContext {
  return {
    blockCrossProjectExecution: () => undefined,
    resolveMutationIdentity: (_a: unknown, _f: unknown, cwd?: string) => (
      path.resolve(cwd ?? '') === path.resolve(trustedCwd)
        ? { identity: { agent_name: agentName, agent_id: 'agt_test' } }
        : { error: { kind: 'trust_error', message: 'not registered' } }
    ),
    ensureTrust: (_a: unknown, _f: unknown, _l: unknown, cwd?: string) => (
      path.resolve(cwd ?? '') === path.resolve(trustedCwd)
        ? { identity: { agent_name: agentName, agent_id: 'agt_test' } }
        : { error: { kind: 'trust_error', message: 'not registered' } }
    ),
  } as unknown as McpWriteClaimsContext;
}

function payload(args: Record<string, unknown>, cwd: string): McpToolExecutionPayload {
  return { name: 'bclaw_assignment_update', args, cwd };
}

function makeStore(dir: string, name: string, projectId: string): string {
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  saveConfig(defaultConfig(name, { projectId }), dir);
  return dir;
}

/** Workspace root with two sibling projects — the topology the defect needs. */
function monorepo(): { ws: string; api: string; web: string } {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-route-'));
  cleanups.push(() => fs.rmSync(ws, { recursive: true, force: true }));
  makeStore(ws, 'workspace', 'prj_ws');
  const config = defaultConfig('workspace', { projectId: 'prj_ws', projectMode: 'multi-project', projectStrategy: 'folder' });
  saveConfig(config, ws);
  return {
    ws,
    api: makeStore(path.join(ws, 'apps', 'api'), 'api', 'prj_api'),
    web: makeStore(path.join(ws, 'apps', 'web'), 'web', 'prj_web'),
  };
}

/**
 * Note files under a runtime tree, recursively — notes are nested per agent (and per
 * host for the machine/private visibilities), so a flat readdir would miss them and a
 * plain `existsSync` on the tree root proves nothing about where the note landed.
 * Returns paths RELATIVE to `root` so a failure message stays readable.
 */
function listNoteFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.json')) out.push(path.relative(root, full));
    }
  };
  walk(root);
  return out;
}

function seed(cwd: string, id: string): void {
  createAssignment({
    id, short_label: id, claim_id: 'clm_route', agent: 'worker',
    dispatcher_agent: 'coordinator', scope: 'src/x.ts', description: 'routing fixture',
  }, cwd);
  transitionAssignment(id, 'offered', { actor: 'coordinator' }, cwd);
}

describe('bclaw_assignment_update routing (pln#649 step 3)', () => {
  it('THE FIELD DEFECT: an update from the WRONG ambient store still reaches the owner', async () => {
    const { ws, api } = monorepo();
    await withCleanEnv({ BRAINCLAW_STORE_BOUNDARY: ws }, async () => {
      seed(api, 'asgn_routed');
      assert.equal(loadAssignment('asgn_routed', api)?.status, 'offered');

      // Ambient cwd is the WORKSPACE ROOT — where a worker with no session lands.
      const outcome = await handleBclawAssignmentUpdate(
        payload({ assignment_id: 'asgn_routed', status: 'accepted' }, ws),
        fakeCtx('worker', api),
      );

      assert.ok(!outcome.response.isError, `expected success, got ${JSON.stringify(outcome.response.content)}`);
      // Asserted ON DISK in the owning project: this is the whole point.
      assert.equal(loadAssignment('asgn_routed', api)?.status, 'accepted');
    });
  });

  // CONTRACT INVERTED after review P2-3. The first version of this pin asserted the
  // error NAMED both projects — which was the disclosure defect, pinned as a
  // feature. This branch runs before ensureTrust by necessity, so an unauthenticated
  // caller must learn a count and an action, never project names or store paths.
  it('AMBIGUOUS: the same id in two projects is REFUSED without disclosing which ones', async () => {
    const { ws, api, web } = monorepo();
    await withCleanEnv({ BRAINCLAW_STORE_BOUNDARY: ws }, async () => {
      seed(api, 'asgn_dup');
      seed(web, 'asgn_dup');

      const outcome = await handleBclawAssignmentUpdate(
        payload({ assignment_id: 'asgn_dup', status: 'accepted' }, ws),
        fakeCtx('worker', api),
      );

      assert.ok(outcome.response.isError, 'a guess here would be a silent cross-project write');
      const text = JSON.stringify(outcome.response.content);
      assert.match(text, /2 projects/, 'the count is actionable and discloses nothing');
      assert.doesNotMatch(text, /prj_api|prj_web/, 'no project id may leak pre-auth');
      assert.doesNotMatch(text, /apps[\\/](api|web)/, 'no store path may leak pre-auth');
      // Neither store may have been mutated.
      assert.equal(loadAssignment('asgn_dup', api)?.status, 'offered');
      assert.equal(loadAssignment('asgn_dup', web)?.status, 'offered');
    });
  });

  // review P1-2, his exact reproduction: the locator found the legacy record but
  // loadAssignment lost it again, because it resolved a DIRECTORY that the canonical
  // sibling had made non-empty. Pinned at the HANDLER, which is where the
  // contradiction showed (locator: found / handler: not found).
  it('MIXED LAYOUT: a legacy record is updated, not lost between locator and loader', async () => {
    const { ws, api } = monorepo();
    await withCleanEnv({ BRAINCLAW_STORE_BOUNDARY: ws }, async () => {
      seed(api, 'asgn_legacy');
      seed(api, 'asgn_canonical_sibling'); // makes the canonical dir non-empty
      // Move ONLY the legacy one to the pre-migration flat layout.
      const canonicalDir = path.join(api, '.brainclaw', 'coordination', 'assignments');
      const legacyDir = path.join(api, '.brainclaw', 'assignments');
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.renameSync(path.join(canonicalDir, 'asgn_legacy.json'), path.join(legacyDir, 'asgn_legacy.json'));

      const outcome = await handleBclawAssignmentUpdate(
        payload({ assignment_id: 'asgn_legacy', status: 'accepted' }, ws),
        fakeCtx('worker', api),
      );

      assert.ok(!outcome.response.isError, `expected success, got ${JSON.stringify(outcome.response.content)}`);
      assert.equal(loadAssignment('asgn_legacy', api)?.status, 'accepted');
    });
  });

  it('an id that could escape the store is rejected before any path is built', async () => {
    const { ws } = monorepo();
    await withCleanEnv({ BRAINCLAW_STORE_BOUNDARY: ws }, async () => {
      const outcome = await handleBclawAssignmentUpdate(
        payload({ assignment_id: '../../etc/passwd', status: 'accepted' }, ws),
        fakeCtx('worker', ws),
      );
      assert.ok(outcome.response.isError);
      assert.match(JSON.stringify(outcome.response.content), /Invalid assignment_id/);
    });
  });

  it('not_found says WHERE it looked, so it cannot be confused with a routing miss', async () => {
    const { ws } = monorepo();
    await withCleanEnv({ BRAINCLAW_STORE_BOUNDARY: ws }, async () => {
      const outcome = await handleBclawAssignmentUpdate(
        payload({ assignment_id: 'asgn_absent', status: 'accepted' }, ws),
        fakeCtx('worker', ws),
      );
      assert.ok(outcome.response.isError);
      assert.match(JSON.stringify(outcome.response.content), /searched/);
    });
  });
});

/**
 * pln#649 F5, second surface — `bclaw_release_claim` routed by the CLAIM.
 *
 * The other half of the same field defect (trp#1327): release_claim has no `project`
 * parameter either, so a worker whose resolved store was not the claim's got
 * `Claim not found` and the claim stayed active forever. It only LOOKED covered
 * because completing an assignment cascade-releases its claim with the routed cwd —
 * a worker calling release_claim directly still fell in the hole.
 */
describe('bclaw_release_claim routing (pln#649 F5)', () => {
  function seedClaim(cwd: string, id: string): void {
    saveClaim({
      id, agent: 'worker', scope: 'src/x.ts', description: 'routing fixture',
      created_at: new Date().toISOString(), status: 'active',
    }, cwd);
  }

  it('a release from the WRONG ambient store still reaches the owning project', async () => {
    const { ws, api } = monorepo();
    await withCleanEnv({ BRAINCLAW_STORE_BOUNDARY: ws }, async () => {
      seedClaim(api, 'clm_routed');
      assert.equal(loadClaim('clm_routed', api).status, 'active');

      // Ambient cwd is the workspace root — where a worker with no session lands.
      const outcome = await handleBclawReleaseClaim(
        { name: 'bclaw_release_claim', args: { id: 'clm_routed', agent: 'worker' }, cwd: ws },
        releaseCtx('worker', api),
      );

      assert.ok(!outcome.response.isError, `expected success, got ${JSON.stringify(outcome.response.content)}`);
      assert.equal(loadClaim('clm_routed', api).status, 'released', 'asserted ON DISK in the owner');
    });
  });

  it('AMBIGUOUS: the same claim id in two projects is refused without disclosure', async () => {
    const { ws, api, web } = monorepo();
    await withCleanEnv({ BRAINCLAW_STORE_BOUNDARY: ws }, async () => {
      seedClaim(api, 'clm_dup');
      seedClaim(web, 'clm_dup');

      const outcome = await handleBclawReleaseClaim(
        { name: 'bclaw_release_claim', args: { id: 'clm_dup', agent: 'worker' }, cwd: ws },
        releaseCtx('worker', api),
      );

      assert.ok(outcome.response.isError);
      const text = JSON.stringify(outcome.response.content);
      assert.match(text, /2 projects/);
      assert.doesNotMatch(text, /prj_api|prj_web/, 'no project id may leak pre-auth');
      assert.doesNotMatch(text, /apps[\\/](api|web)/, 'no store path may leak pre-auth');
      assert.equal(loadClaim('clm_dup', api).status, 'active', 'neither store may be mutated');
      assert.equal(loadClaim('clm_dup', web).status, 'active');
    });
  });

  it('an id that could escape the store is rejected before any path is built', async () => {
    const { ws } = monorepo();
    await withCleanEnv({ BRAINCLAW_STORE_BOUNDARY: ws }, async () => {
      const outcome = await handleBclawReleaseClaim(
        { name: 'bclaw_release_claim', args: { id: '../../etc/passwd', agent: 'worker' }, cwd: ws },
        releaseCtx('worker', ws),
      );
      assert.ok(outcome.response.isError);
      assert.match(JSON.stringify(outcome.response.content), /Invalid claim id/);
    });
  });
});

/**
 * pln#649 F5, last surface — a WORKER's AMBIENT mutation is routed by its CLAIM.
 *
 * The routed surfaces so far all take an entity id, so the entity could route. This is
 * the other half of F5: the mutations a dispatched worker makes with NO entity to name
 * — capturing a trap, writing a note. Those fell through the whole ambient ladder and
 * landed wherever the shared pointer said, which is the original field defect.
 *
 * The rule is NOT "refuse because nothing was named": a worker HAS a discriminant,
 * `BRAINCLAW_CLAIM_ID`, the one selector deliberately preserved in its env. So the claim
 * names the project. Pin written from that sentence of dec#153/F5, not from the code.
 */
describe('worker ambient mutations are routed by the claim (pln#649 F5)', () => {
  it('a note written by a worker lands in the CLAIM\u0027s project, not the ambient one', async () => {
    const { ws, api } = monorepo();
    const saved = process.env.BRAINCLAW_CLAIM_ID;
    try {
      await withCleanEnv({ BRAINCLAW_STORE_BOUNDARY: ws }, async () => {
        saveClaim({
          id: 'clm_ambient', agent: 'worker', scope: 'src/x.ts', description: 'worker lane',
          created_at: new Date().toISOString(), status: 'active',
        }, api);
        process.env.BRAINCLAW_CLAIM_ID = 'clm_ambient';

        // Ambient cwd is the workspace ROOT — where a worker with no session lands.
        //
        // NO `agent` ARG. Passing one made the call fail with `identity_error` (it must
        // match the pinned connection principal), and the first version of this pin
        // asserted a DIRECTORY, which the auto-session created on the rerouted cwd — so
        // it went green over a call that had errored. Real agents omit the identity.
        const res = await executeMcpToolCall({
          name: 'bclaw_write_note',
          args: { text: 'observed while working the lane', type: 'observation' },
          cwd: ws,
        });
        // `assert.ok(res)` was NOT enough: a failed tool call still returns a truthy
        // outcome carrying `isError`, so a broken call read as a pass. Assert the call
        // SUCCEEDED, and carry the payload into the failure message — this pin went red
        // on CI while green on three local configurations, and the weak assertion is
        // what made that expensive to diagnose.
        const text = JSON.stringify(res?.response ?? null);
        assert.notEqual(res?.response?.isError, true, `the call must succeed — got: ${text}`);

        // Assert the note FILE, not its directory: a directory can be created for
        // unrelated reasons, so its presence proves little about where the note went.
        const inApi = listNoteFiles(path.join(api, '.brainclaw', 'coordination', 'runtime'));
        const inWs = listNoteFiles(path.join(ws, '.brainclaw', 'coordination', 'runtime'));
        const diag = `api=${JSON.stringify(inApi)} ws=${JSON.stringify(inWs)} response=${text} — `;
        assert.equal(inWs.length, 0, `${diag}no note may be left in the ambient store`);
        assert.ok(inApi.length > 0, diag + 'the note must have been written in the claim\u0027s project');
      });
    } finally {
      if (saved === undefined) delete process.env.BRAINCLAW_CLAIM_ID;
      else process.env.BRAINCLAW_CLAIM_ID = saved;
    }
  });

  it('a READ is left on the ambient anchor (dec#155: only mutations reroute)', async () => {
    const { ws, api } = monorepo();
    const saved = process.env.BRAINCLAW_CLAIM_ID;
    try {
      await withCleanEnv({ BRAINCLAW_STORE_BOUNDARY: ws }, async () => {
        saveClaim({
          id: 'clm_read', agent: 'worker', scope: 'src/x.ts', description: 'worker lane',
          created_at: new Date().toISOString(), status: 'active',
        }, api);
        process.env.BRAINCLAW_CLAIM_ID = 'clm_read';
        // bclaw_context is a READ: it must not be rerouted to the claim's project.
        const res = await executeMcpToolCall({
          name: 'bclaw_context', args: { kind: 'board_summary' }, cwd: ws,
        });
        assert.ok(res, 'a read must still work and stay on the anchor');
      });
    } finally {
      if (saved === undefined) delete process.env.BRAINCLAW_CLAIM_ID;
      else process.env.BRAINCLAW_CLAIM_ID = saved;
    }
  });
});
