import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkerIdentityEnv } from '../../src/core/execution-profile.js';

/**
 * F7 (trp_0e5150d3) — buildWorkerIdentityEnv must turn a coordinator's env into
 * an INDEPENDENT worker env: scrub the coordinator's brainclaw identity
 * (BRAINCLAW_AGENT*, SESSION_ID, PROJECT), set the worker's own agent name, keep
 * the claim routing key, preserve BRAINCLAW_CWD (D1a) and all non-brainclaw env.
 * The scrub runs LAST so extraEnv (git attribution / invoke.env) cannot
 * reintroduce a forbidden key.
 */
describe('buildWorkerIdentityEnv (F7 — worker identity scrub)', () => {
  const coordinatorEnv: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    HOME: '/home/coord',
    BRAINCLAW_CWD: '/srv/monorepo',
    BRAINCLAW_AGENT: 'claude-code',
    BRAINCLAW_AGENT_NAME: 'claude-code',
    BRAINCLAW_AGENT_ID: 'agt_coordinator',
    BRAINCLAW_SESSION_ID: 'sess_coordinator',
    BRAINCLAW_PROJECT: 'apps/api',
  };

  it('scrubs coordinator session / project / agent-id', () => {
    const env = buildWorkerIdentityEnv(coordinatorEnv, { agent: 'codex' });
    assert.equal(env.BRAINCLAW_SESSION_ID, undefined);
    assert.equal(env.BRAINCLAW_PROJECT, undefined);
    assert.equal(env.BRAINCLAW_AGENT_ID, undefined);
  });

  it('sets the worker agent name (truthful identity)', () => {
    const env = buildWorkerIdentityEnv(coordinatorEnv, { agent: 'codex' });
    assert.equal(env.BRAINCLAW_AGENT, 'codex');
    assert.equal(env.BRAINCLAW_AGENT_NAME, 'codex');
  });

  it('preserves safe non-brainclaw env and BRAINCLAW_CWD (D1a)', () => {
    const env = buildWorkerIdentityEnv(coordinatorEnv, { agent: 'codex' });
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.HOME, '/home/coord');
    assert.equal(env.BRAINCLAW_CWD, '/srv/monorepo');
  });

  it('sets BRAINCLAW_CLAIM_ID when provided; ignores dry-run; omits when absent', () => {
    assert.equal(buildWorkerIdentityEnv(coordinatorEnv, { agent: 'codex', claimId: 'clm_x' }).BRAINCLAW_CLAIM_ID, 'clm_x');
    assert.equal(buildWorkerIdentityEnv(coordinatorEnv, { agent: 'codex', claimId: '(dry-run)' }).BRAINCLAW_CLAIM_ID, undefined);
    assert.equal(buildWorkerIdentityEnv({ PATH: '/x' }, { agent: 'codex' }).BRAINCLAW_CLAIM_ID, undefined);
  });

  it('does NOT inherit a parent BRAINCLAW_CLAIM_ID when no real claim is supplied (codev/dry-run)', () => {
    const base: NodeJS.ProcessEnv = { ...coordinatorEnv, BRAINCLAW_CLAIM_ID: 'clm_parent' };
    // codev/codev-rounds call sites pass only { agent } → must not adopt the coordinator's claim
    assert.equal(buildWorkerIdentityEnv(base, { agent: 'codex' }).BRAINCLAW_CLAIM_ID, undefined);
    // dry-run dispatch must not adopt it either
    assert.equal(buildWorkerIdentityEnv(base, { agent: 'codex', claimId: '(dry-run)' }).BRAINCLAW_CLAIM_ID, undefined);
    // a real claim still overrides the inherited one
    assert.equal(buildWorkerIdentityEnv(base, { agent: 'codex', claimId: 'clm_new' }).BRAINCLAW_CLAIM_ID, 'clm_new');
  });

  it('extraEnv CANNOT reintroduce scrubbed coordinator identity (scrub runs last)', () => {
    const env = buildWorkerIdentityEnv(coordinatorEnv, {
      agent: 'codex',
      extraEnv: {
        BRAINCLAW_SESSION_ID: 'sess_sneaky',
        BRAINCLAW_PROJECT: 'apps/web',
        BRAINCLAW_AGENT_ID: 'agt_sneaky',
        GIT_AUTHOR_NAME: 'codex (via brainclaw)',
      },
    });
    assert.equal(env.BRAINCLAW_SESSION_ID, undefined);
    assert.equal(env.BRAINCLAW_PROJECT, undefined);
    assert.equal(env.BRAINCLAW_AGENT_ID, undefined);
    // safe (non-identity) extras survive
    assert.equal(env.GIT_AUTHOR_NAME, 'codex (via brainclaw)');
  });

  it('honours a deliberate BRAINCLAW_CWD override from extraEnv', () => {
    const env = buildWorkerIdentityEnv(coordinatorEnv, {
      agent: 'codex',
      extraEnv: { BRAINCLAW_CWD: '/srv/monorepo/apps/api' },
    });
    assert.equal(env.BRAINCLAW_CWD, '/srv/monorepo/apps/api');
  });

  it('does not leak coordinator agent identity when no target agent is given', () => {
    const env = buildWorkerIdentityEnv(coordinatorEnv, {});
    assert.equal(env.BRAINCLAW_AGENT, undefined);
    assert.equal(env.BRAINCLAW_AGENT_NAME, undefined);
  });

  it('returns only string values (no undefined leaks into the spawn env)', () => {
    const env = buildWorkerIdentityEnv({ PATH: '/x', EMPTY: undefined } as NodeJS.ProcessEnv, { agent: 'codex' });
    assert.equal(env.PATH, '/x');
    assert.ok(!('EMPTY' in env));
    for (const v of Object.values(env)) assert.equal(typeof v, 'string');
  });
});
