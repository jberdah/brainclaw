import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../../src/core/config.js';
import { doctorCheck, scanText } from '../../src/core/security.js';
import type { State } from '../../src/core/schema.js';

function emptyState(): State {
  return {
    version: 1,
    write_version: 1,
    active_constraints: [],
    recent_decisions: [],
    known_traps: [],
    open_handoffs: [],
    plan_items: [],
  };
}

describe('core/security', () => {
  it('warns on sensitive tokens in warn mode', () => {
    const config = defaultConfig('brainclaw');
    const warnings = scanText('Store api_key in config', config);

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].level, 'warn');
  });

  it('blocks on sensitive tokens in strict mode', () => {
    const config = defaultConfig('brainclaw');
    assert.ok(config.security);
    config.security.strict_redaction = true;

    const warnings = scanText('password rotation policy', config);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].level, 'block');
  });

  it('masks user-configured redaction patterns in warning messages', () => {
    // Operators sometimes put the literal secret value itself in
    // redaction.patterns — the warning must never echo it back verbatim.
    const config = defaultConfig('brainclaw');
    const literal = 'hunter2secretvalue42';
    config.redaction.patterns = [literal];

    const warnings = scanText(`the value is ${literal}`, config);
    const patternWarnings = warnings.filter((w) => w.message.includes('redaction pattern #0'));
    assert.equal(patternWarnings.length, 1, 'the configured pattern should fire and be referenced by index');
    for (const w of warnings) {
      assert.ok(!w.message.includes(literal), `warning leaks the configured pattern: ${w.message}`);
    }
  });

  it('never includes the raw secret in warning messages', () => {
    const config = defaultConfig('brainclaw');
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const warnings = scanText(`deploy with ${secret}`, config);

    assert.ok(warnings.length >= 1, 'the token detector should fire');
    for (const w of warnings) {
      assert.ok(!w.message.includes(secret), `warning leaks the secret: ${w.message}`);
    }
  });

  it('warns when a sensitive path is mentioned', () => {
    const config = defaultConfig('brainclaw');
    const warnings = scanText('See .env before starting the server', config);

    assert.ok(warnings.some((warning) => warning.message.includes('.env')));
  });

  it('doctorCheck scans state entries and annotates the source item', () => {
    const config = defaultConfig('brainclaw');
    const state = emptyState();
    state.recent_decisions.push({
      id: 'dec_secret',
      text: 'Token handling currently lives in secrets/',
      created_at: '2026-03-15T10:00:00Z',
      author: 'alice',
      tags: ['security'],
    });

    const warnings = doctorCheck(state, config);
    assert.ok(warnings.some((warning) => warning.message.includes('recent_decisions[0] (dec_secret)')));
  });
});
