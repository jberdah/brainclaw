/**
 * pln#520 step 3 — concurrency is a resolvable execution-config value,
 * decoupled from agent identity (can_dc4e4a11).
 *
 * Covers the resolution chain + host-binary resource keying:
 *   - parallelizable CLI agents default to UNLIMITED (no arbitrary throttle)
 *   - non-spawnable IDE agents keep a structural floor (can't run N windows)
 *   - explicit override and env cap take precedence
 *   - a cap pools per host-binary (claude-code + claude-sonnet share `claude`)
 *   - JSON-safe serialization (Infinity → null)
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveConcurrencyLimit,
  resolveResourceKey,
  serializeConcurrencyLimit,
  getCapabilityProfile,
} from '../../src/core/agent-capability.js';

describe('resolveConcurrencyLimit (pln#520 step 3)', () => {
  const savedEnv = process.env.BRAINCLAW_MAX_CONCURRENCY;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.BRAINCLAW_MAX_CONCURRENCY;
    else process.env.BRAINCLAW_MAX_CONCURRENCY = savedEnv;
  });

  it('parallelizable CLI agents are unlimited by default (no arbitrary throttle)', () => {
    delete process.env.BRAINCLAW_MAX_CONCURRENCY;
    // claude-code and codex are CLI-spawnable → no per-identity cap.
    assert.equal(resolveConcurrencyLimit('claude-code'), Infinity);
    assert.equal(resolveConcurrencyLimit('codex'), Infinity);
  });

  it('non-spawnable IDE agents keep a structural floor (cannot parallelize headlessly)', () => {
    delete process.env.BRAINCLAW_MAX_CONCURRENCY;
    // cursor / github-copilot are IDE agents (canBeSpawnedCli=false) → capped at
    // their structural max_concurrent_tasks (typically 1).
    const cursor = getCapabilityProfile('cursor');
    if (cursor && !cursor.runtime.canBeSpawnedCli) {
      const limit = resolveConcurrencyLimit('cursor');
      assert.ok(Number.isFinite(limit), 'IDE agent limit must be finite');
      assert.equal(limit, cursor.max_concurrent_tasks);
    }
  });

  it('explicit override wins over everything', () => {
    process.env.BRAINCLAW_MAX_CONCURRENCY = '2';
    assert.equal(resolveConcurrencyLimit('claude-code', { override: 5 }), 5);
  });

  it('env cap applies when no override is given', () => {
    process.env.BRAINCLAW_MAX_CONCURRENCY = '4';
    assert.equal(resolveConcurrencyLimit('claude-code'), 4);
    assert.equal(resolveConcurrencyLimit('codex'), 4);
  });

  it('ignores a non-positive / non-numeric env cap', () => {
    process.env.BRAINCLAW_MAX_CONCURRENCY = 'nope';
    assert.equal(resolveConcurrencyLimit('claude-code'), Infinity);
    process.env.BRAINCLAW_MAX_CONCURRENCY = '0';
    assert.equal(resolveConcurrencyLimit('claude-code'), Infinity);
  });
});

describe('resolveResourceKey (pln#520 step 3)', () => {
  it('pools model-variant identities of one binary under a shared key', () => {
    // The core can_dc4e4a11 bug: claude-code (max 3) and claude-sonnet (max 6)
    // are the SAME `claude` binary but were counted separately.
    assert.equal(resolveResourceKey('claude-code'), 'claude');
    assert.equal(resolveResourceKey('claude-sonnet'), 'claude');
    assert.equal(resolveResourceKey('claude-code'), resolveResourceKey('claude-sonnet'));
  });

  it('distinct binaries get distinct keys', () => {
    assert.notEqual(resolveResourceKey('claude-code'), resolveResourceKey('codex'));
    assert.equal(resolveResourceKey('codex'), 'codex');
  });

  it('resolves aliases before keying (copilot → github-copilot)', () => {
    assert.equal(resolveResourceKey('copilot'), resolveResourceKey('github-copilot'));
  });
});

describe('serializeConcurrencyLimit (pln#520 step 3)', () => {
  it('maps Infinity (unlimited) to null and keeps finite numbers', () => {
    assert.equal(serializeConcurrencyLimit(Infinity), null);
    assert.equal(serializeConcurrencyLimit(4), 4);
    assert.equal(serializeConcurrencyLimit(1), 1);
  });

  it('the unlimited sentinel survives JSON round-trip as null', () => {
    const payload = JSON.stringify({ max_tasks: serializeConcurrencyLimit(Infinity) });
    assert.equal(JSON.parse(payload).max_tasks, null);
  });
});
