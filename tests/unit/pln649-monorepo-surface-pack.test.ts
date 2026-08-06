/**
 * pln#649 step 6 — THE SURFACE REGRESSION PACK, on a monorepo topology.
 *
 * WHY THE TOPOLOGY IS THE POINT. Every defect in this plan needed a workspace root with
 * sibling child projects to appear at all; the brainclaw repo's own single-project shape
 * masks the entire class. The plan names the bench explicitly for that reason. So this file
 * builds root + apps/api + apps/web + libs/lib-x and drives the REAL surfaces an agent
 * calls, asserting ON DISK — not on a helper's return value (trp#1292: a green core proves
 * nothing about whether the feature fires).
 *
 * IT USES `isolateAgentEnv()`, AND THAT IS A CORRECTION OF MY OWN WORK. That helper already
 * strips the five agent-detection vars (CLAUDECODE, CLAUDE_CODE_VERSION, ...) and fakes HOME
 * — i.e. it already reproduces a CI runner. Earlier in this plan I hand-rolled a weaker
 * `withCleanEnv` that stripped only BRAINCLAW_*, which is exactly why a pin depended on my
 * machine's resolved identity and cost three red CI rounds (trp#1447). The infrastructure
 * existed; a local copy diverged from it. That is the same failure mode the plan is about,
 * one layer up.
 *
 * ONE SCENARIO FROM THE PLAN IS DELIBERATELY NOT IMPLEMENTED AS WRITTEN. Step 6 lists
 * "(c) worker sans discriminant → REFUS bruyant". That refusal does not exist and should
 * not: the discriminant rule shipped as a ROUTING (a worker HAS a discriminant — its claim —
 * so the claim names the project), and the refusal landed on a PROVEN duplicate instead,
 * by operator decision. Pinning the plan's original sentence would pin a behaviour the
 * decision rejected. (c) is re-derived below into the two cases that do exist.
 *
 * @module
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import { isolateAgentEnv } from '../helpers/workspace.js';
import { registerAgentIdentity } from '../../src/core/agent-registry.js';
import { saveCurrentSession } from '../../src/core/identity.js';
import { saveActiveProject } from '../../src/core/active-project.js';
import { saveClaim } from '../../src/core/claims.js';
import { createAssignment, transitionAssignment } from '../../src/core/assignments.js';
import { executeMcpToolCall } from '../../src/commands/mcp.js';
import { runSwitch } from '../../src/commands/switch.js';

interface Bench {
  root: string;
  api: string;
  web: string;
  libx: string;
}

let bench: Bench;
let isolation: { fakeHome: string; restore: () => void } | undefined;

/** One explicit agent for the whole pack. */
const AGENT = 'worker';

/** Every runtime note in a store, recursively — notes nest per agent (and per host). */
function notesIn(root: string, matchText?: string): string[] {
  const base = path.join(root, '.brainclaw', 'coordination', 'runtime');
  if (!fs.existsSync(base)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.json')) continue;
      if (matchText !== undefined) {
        try {
          const doc = JSON.parse(fs.readFileSync(full, 'utf-8')) as { text?: unknown };
          if (doc.text !== matchText) continue;
        } catch { continue; }
      }
      out.push(path.relative(root, full));
    }
  };
  walk(base);
  return out;
}

function makeStore(dir: string, name: string, projectId: string, workspace = false): string {
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  saveConfig(
    defaultConfig(name, {
      projectId,
      ...(workspace ? { projectMode: 'multi-project' as const, projectStrategy: 'folder' as const } : {}),
    }),
    dir,
  );
  if (workspace) {
    // `store_type` is read from the YAML by the store-chain walk but is not part of the
    // typed Config surface — the store-resolution tests append it raw for the same reason.
    fs.appendFileSync(path.join(dir, '.brainclaw', 'config.yaml'), '\nstore_type: workspace\n', 'utf-8');
  }
  return path.resolve(dir);
}

beforeEach(() => {
  isolation = isolateAgentEnv();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-step6-'));
  bench = {
    root: makeStore(root, 'workspace', 'prj_ws', true),
    api: makeStore(path.join(root, 'apps', 'api'), 'api', 'prj_api'),
    web: makeStore(path.join(root, 'apps', 'web'), 'web', 'prj_web'),
    libx: makeStore(path.join(root, 'libs', 'lib-x'), 'lib-x', 'prj_libx'),
  };
  process.env.BRAINCLAW_STORE_BOUNDARY = bench.root;
  // EXPLICIT IDENTITY, never the ambient one. `isolateAgentEnv` strips the agent-detection
  // vars (that is the point), so nothing would resolve an agent — and a session record is
  // matched by AGENT NAME as well as by pid. Registering in every store keeps the pack about
  // ROUTING: an identity failure could otherwise masquerade as a routing failure, which is
  // exactly the confusion that cost three CI rounds earlier in this plan.
  process.env.BRAINCLAW_AGENT_NAME = AGENT;
  for (const store of [bench.root, bench.api, bench.web, bench.libx]) {
    registerAgentIdentity({ agentName: AGENT, kind: 'agent', cwd: store });
  }
});

afterEach(() => {
  try { fs.rmSync(bench.root, { recursive: true, force: true }); } catch { /* best effort */ }
  isolation?.restore();
  isolation = undefined;
});

describe('pln#649 step 6 — surface regression pack (monorepo bench)', () => {
  it('(a) the DISPLAYED project and the WRITTEN project are the same one, against a divergent global pointer', async () => {
    // The shared pointer says web; this agent's own session says api.
    saveActiveProject(bench.root, { path: bench.web, name: 'web', switched_at: new Date().toISOString() });
    saveCurrentSession({
      session_id: 'sess_step6_a',
      started_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      agent: AGENT,
      agent_id: 'agt_step6',
      host_id: 'host-test',
      pid: process.pid,
      active_project: { path: bench.api, name: 'api', switched_at: new Date().toISOString() },
    }, bench.root);

    // THE DISPLAYED PROJECT and THE WRITTEN PROJECT must be the same one (step 5 + the
    // resolver together). This is the coordinator half of the original field defect.
    const shown = JSON.parse(captureLog(() => runSwitch(undefined, { cwd: bench.root, json: true }))) as { scope: string; path: string };
    assert.equal(path.resolve(shown.path), bench.api, 'status must report the session project, not the shared pointer');
    assert.equal(shown.scope, 'session');

    // THE HALF I HAD OMITTED, and the only half that makes this scenario load-bearing. The
    // plan's wording is "l'écriture atterrit dans le projet AFFICHÉ, vérifié SUR DISQUE": the
    // invariant is the AGREEMENT between the two, not either one alone. Asserting the status
    // by itself proved nothing — the pre-#175 reader was already session-first, so it passed
    // this scenario too (found by counter-proving it and watching the pin stay green).
    const TEXT = 'step6 (a) — must land where the status pointed';
    const res = await executeMcpToolCall({ name: 'bclaw_write_note', args: { text: TEXT }, cwd: bench.root });
    assert.notEqual(res.response.isError, true, `the write must succeed — got: ${JSON.stringify(res.response)}`);
    assert.equal(notesIn(bench.api, TEXT).length, 1, 'the write must land in the project the status displayed');
    assert.equal(notesIn(bench.web, TEXT).length, 0, 'and never in the one the shared pointer named');
    assert.equal(
      path.resolve(shown.path), bench.api,
      'display and write must name the SAME store — the divergence is the defect, not either value',
    );
  });

  it("(b) a worker's ambient mutation follows its CLAIM, not the shared pointer — verified on disk", async () => {
    saveActiveProject(bench.root, { path: bench.web, name: 'web', switched_at: new Date().toISOString() });
    saveClaim({
      id: 'clm_step6_worker', agent: AGENT, scope: 'libs/lib-x', description: 'lane in lib-x',
      created_at: new Date().toISOString(), status: 'active',
    }, bench.libx);
    process.env.BRAINCLAW_CLAIM_ID = 'clm_step6_worker';

    const TEXT = 'step6 (b) — routed by the claim';
    const res = await executeMcpToolCall({ name: 'bclaw_write_note', args: { text: TEXT }, cwd: bench.root });
    assert.notEqual(res.response.isError, true, `the call must succeed — got: ${JSON.stringify(res.response)}`);

    assert.equal(notesIn(bench.libx, TEXT).length, 1, "the note must land in the CLAIM's project");
    for (const [label, store] of [['web (the shared pointer)', bench.web], ['api', bench.api], ['root', bench.root]] as const) {
      assert.equal(notesIn(store, TEXT).length, 0, `nothing may be written in ${label}`);
    }
  });

  it('(c1) a worker with NO claim is NOT refused — the plan said refuse; the decision said route', async () => {
    // Step 6's original wording was "worker sans discriminant → REFUS bruyant". That refusal
    // was never built and should not be: the rule shipped as a ROUTING. With no claim there is
    // simply nothing to route BY, so the ambient ladder answers and the call must still work.
    saveActiveProject(bench.root, { path: bench.web, name: 'web', switched_at: new Date().toISOString() });
    delete process.env.BRAINCLAW_CLAIM_ID;

    const TEXT = 'step6 (c1) — no discriminant, no refusal';
    const res = await executeMcpToolCall({ name: 'bclaw_write_note', args: { text: TEXT }, cwd: bench.root });
    assert.notEqual(res.response.isError, true, `a mutation without a claim must NOT be refused — got: ${JSON.stringify(res.response)}`);
    assert.equal(
      notesIn(bench.web, TEXT).length + notesIn(bench.root, TEXT).length, 1,
      'and it must have landed somewhere the ambient ladder points',
    );
  });

  it('(c2) a worker whose claim is AMBIGUOUS is refused, and writes nothing anywhere', async () => {
    // The refusal that DOES exist (operator decision): two reachable stores holding one claim
    // id is a PROVEN divergence, so guessing is refused.
    for (const store of [bench.api, bench.web]) {
      saveClaim({
        id: 'clm_step6_dup', agent: AGENT, scope: 'src/x.ts', description: 'duplicate id',
        created_at: new Date().toISOString(), status: 'active',
      }, store);
    }
    process.env.BRAINCLAW_CLAIM_ID = 'clm_step6_dup';

    const TEXT = 'step6 (c2) — must never be written';
    const res = await executeMcpToolCall({ name: 'bclaw_write_note', args: { text: TEXT }, cwd: bench.root });
    assert.equal(res.response.isError, true, 'a proven duplicate must be refused');
    const payload = JSON.stringify(res.response);
    assert.match(payload, /2 reachable projects/, 'the caller gets a COUNT');
    assert.doesNotMatch(payload, /apps[/\\](api|web)/, 'store paths are operator information — this runs before any trust check');
    for (const [label, store] of [['root', bench.root], ['api', bench.api], ['web', bench.web], ['lib-x', bench.libx]] as const) {
      assert.equal(notesIn(store, TEXT).length, 0, `a refused mutation must leave nothing in ${label}`);
    }
  });

  it('(d) an entity that disagrees with an explicit project= is refused — by whichever guard owns the case', async () => {
    delete process.env.BRAINCLAW_CLAIM_ID;
    // THE ANCHOR IS SET FOR THIS SCENARIO ONLY. Resolving a project by NAME needs the
    // workspace anchor (the same BRAINCLAW_CWD an MCP config injects); without it the ref
    // resolution walks up past the temp root and the name is simply unknown. The other
    // scenarios deliberately run WITHOUT an anchor, because that is the CLI agent's shape and
    // the one the ambient-ladder rungs are about. Two caller shapes, pinned separately.
    process.env.BRAINCLAW_CWD = bench.root;

    // ASSIGNMENT — the divergence guard's live case. `bclaw_transition` routes claim/plan
    // through resolveExecutionWriteTarget, so for THOSE kinds an older boundary answers first
    // (below); for the rest, the dec#153 divergence refusal is the one that fires.
    createAssignment({
      id: 'asgn_step6_d', short_label: 'asgn_step6_d', claim_id: 'clm_step6_d', agent: AGENT,
      dispatcher_agent: 'coordinator', scope: 'src/x.ts', description: 'lives in api',
    }, bench.api);
    transitionAssignment('asgn_step6_d', 'offered', { actor: 'coordinator' }, bench.api);

    const res = await executeMcpToolCall({
      name: 'bclaw_transition',
            // An absolute path rather than the NAME 'web': name resolution needs the workspace
      // children lookup, which is a separate concern — the pin is about the divergence guard,
      // so it must not fail for an unrelated reason.
      args: { entity: 'assignment', id: 'asgn_step6_d', to: 'accepted', project: 'web' },
      // Called from the workspace ROOT — where a coordinator actually stands, and the only
      // vantage point from which sibling names resolve at all.
      cwd: bench.root,
    });
    const payload = JSON.stringify(res.response);
    assert.equal(res.response.isError, true, 'two disagreeing authorities must be refused, not silently resolved');
    assert.match(payload, /does not live in project/, 'the divergence must be NAMED, not reported as not-found — got: ' + payload);
    assert.match(payload, /web/, 'the project the caller typed is already theirs — naming it back is free');
    assert.doesNotMatch(payload, /apps[/\\]api/, 'where it really lives stays a count, never a path');

    // PLAN — a DIFFERENT guard owns this case, and finding that out here corrected a belief:
    // the cross-project signaling boundary (execution entities stay local) refuses before the
    // divergence check can run. My #182 pin used a plan and passed only because its fixture
    // made the named project an auto-localizable workspace sibling. Both refusals are
    // acceptable — what the pack must guarantee is that NEITHER silently writes elsewhere —
    // so the assertion is on the refusal, not on which guard produced it.
    const created = await executeMcpToolCall({
      name: 'bclaw_create', args: { entity: 'plan', data: { text: 'lives in api' } }, cwd: bench.api,
    });
    const sc = created.response.structuredContent as Record<string, unknown> | undefined;
    const planId = String(sc?.plan_id ?? sc?.id ?? '');
    assert.match(planId, /^pln_/, `the fixture plan must be created — got: ${JSON.stringify(created.response)}`);
    const planRes = await executeMcpToolCall({
      name: 'bclaw_transition', args: { entity: 'plan', id: planId, to: 'in_progress', project: 'web' }, cwd: bench.root,
    });
    assert.equal(planRes.response.isError, true, 'a plan named against another project must be refused too');
  });

  it('(e) a record with NO owner is not refused — backward compatibility is explicit', async () => {
    // Step 1 decided a missing owner must trigger NO new behaviour. Pinned at the surface so a
    // future guard cannot start refusing pre-migration records.
    delete process.env.BRAINCLAW_CLAIM_ID;
    const legacyDir = path.join(bench.api, '.brainclaw', 'coordination', 'claims');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'clm_no_owner.json'), JSON.stringify({
      schema_version: 2, id: 'clm_no_owner', agent: AGENT, scope: 'src/legacy.ts',
      description: 'created before project_id existed', created_at: new Date().toISOString(), status: 'active',
    }), 'utf-8');

    process.env.BRAINCLAW_CLAIM_ID = 'clm_no_owner';
    const TEXT = 'step6 (e) — ownerless claim still routes';
    const res = await executeMcpToolCall({ name: 'bclaw_write_note', args: { text: TEXT }, cwd: bench.root });
    assert.notEqual(res.response.isError, true, `an ownerless record must not be refused — got: ${JSON.stringify(res.response)}`);
    assert.equal(notesIn(bench.api, TEXT).length, 1, 'and it still routes by the record that was found');
  });
});

function captureLog(fn: () => void): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { fn(); } finally { console.log = orig; }
  return lines.join('\n');
}
