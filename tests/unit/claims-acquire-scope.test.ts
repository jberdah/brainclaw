import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  acquireClaimScope,
  generateClaimId,
  listClaims,
  saveClaim,
} from '../../src/core/claims.js';
import { nowISO } from '../../src/core/ids.js';
import { acquireBootstrapLoop } from '../../src/core/loops/bootstrap-acquire.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

describe('acquireClaimScope', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-claim-acquire-' });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('acquires a fresh scope in an empty store', () => {
    const result = acquireClaimScope({
      scope: 'src/core/fresh.ts',
      agent: 'codex',
      description: 'fresh scope claim',
    }, workspace.dir);

    assert.equal(result.acquired, true);
    assert.ok(result.claim);
    assert.equal(result.claim.scope, 'src/core/fresh.ts');
    assert.equal(result.claim.status, 'active');
    assert.equal(result.conflicting_claim, undefined);
  });

  it('returns the existing active claim as a conflict for the same scope', () => {
    const existing = {
      id: generateClaimId(),
      agent: 'worker-a',
      scope: 'src/core/claimed.ts',
      description: 'existing claim',
      created_at: nowISO(),
      status: 'active' as const,
    };
    saveClaim(existing, workspace.dir);

    const result = acquireClaimScope({
      scope: 'src/core/claimed.ts',
      agent: 'worker-b',
      description: 'contending claim',
    }, workspace.dir);

    assert.equal(result.acquired, false);
    assert.equal(result.claim, undefined);
    assert.equal(result.conflicting_claim?.id, existing.id);
  });

  it('does not treat released claims as blockers', () => {
    saveClaim({
      id: generateClaimId(),
      agent: 'worker-a',
      scope: 'src/core/released.ts',
      description: 'released claim',
      created_at: nowISO(),
      status: 'released',
      released_at: nowISO(),
    }, workspace.dir);

    const result = acquireClaimScope({
      scope: 'src/core/released.ts',
      agent: 'worker-b',
      description: 'new claim after release',
    }, workspace.dir);

    assert.equal(result.acquired, true);
    assert.equal(result.claim?.scope, 'src/core/released.ts');
    assert.equal(result.claim?.status, 'active');
  });

  it('serializes same-process contenders through the mutation mutex', async () => {
    const contenders = await Promise.all([
      Promise.resolve().then(() => acquireClaimScope({
        scope: 'src/core/concurrent.ts',
        agent: 'worker-a',
        description: 'first contender',
      }, workspace.dir)),
      Promise.resolve().then(() => acquireClaimScope({
        scope: 'src/core/concurrent.ts',
        agent: 'worker-b',
        description: 'second contender',
      }, workspace.dir)),
    ]);

    assert.equal(
      contenders.filter((result) => result.acquired).length,
      1,
      'single-process contenders should be serialized by mutate()',
    );
    assert.equal(
      contenders.filter((result) => !result.acquired).length,
      1,
      'the losing contender should observe the active claim created by the winner',
    );
  });

  it('is used end-to-end by bootstrap acquisition and releases the lock after open', () => {
    const result = acquireBootstrapLoop({ actor: 'codex', session_id: 'sess_bootstrap' }, workspace.dir);

    assert.equal(result.action, 'opened');
    assert.match(result.loop.id, /^lop_/);

    const lockScope = `bootstrap-coordination-lock:${workspace.dir}`;
    const lockClaims = listClaims(workspace.dir).filter((claim) => claim.scope === lockScope);
    assert.equal(lockClaims.length, 1);
    assert.equal(lockClaims[0].session_id, 'sess_bootstrap');
    assert.equal(lockClaims[0].status, 'released');
  });
});
