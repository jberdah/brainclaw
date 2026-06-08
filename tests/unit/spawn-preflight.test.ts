/**
 * pln#533 — pre-flight spawn gate.
 *
 * The pass/block policy + boot-signature enrichment are tested through the pure
 * mapper (preflightResultFromEntry) with synthetic SpawnCheckEntry values, and
 * the BRAINCLAW_NO_SPAWN skip + dedupe/aggregation through the async helpers.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  preflightResultFromEntry,
  preflightAgentSpawn,
  preflightAgents,
  type SpawnCheckEntry,
} from '../../src/core/spawn-check.js';

function entry(overrides: Partial<SpawnCheckEntry> & { status: SpawnCheckEntry['status'] }): SpawnCheckEntry {
  return {
    agent: 'codex',
    binary: 'codex',
    delivered: false,
    completed: false,
    duration_ms: 100,
    detail: 'detail',
    ...overrides,
  };
}

describe('preflightResultFromEntry — pass/block policy', () => {
  it('passes on ok (ack + completed)', () => {
    const r = preflightResultFromEntry(entry({ status: 'ok', delivered: true, completed: true }));
    assert.equal(r.ok, true);
    assert.equal(r.status, 'ok');
  });

  it('passes on delivered_no_completion — an ack proves spawn works; a boot death never acks', () => {
    const r = preflightResultFromEntry(entry({ status: 'delivered_no_completion', delivered: true }));
    assert.equal(r.ok, true, 'a slow-but-alive probe must not block the loop');
  });

  it('blocks not_installed with a clear reason', () => {
    const r = preflightResultFromEntry(entry({ agent: 'gemini', status: 'not_installed' }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /not on PATH/);
    assert.ok(r.recommended_next_action);
  });

  it('blocks no_template (IDE-only agent) with a clear reason', () => {
    const r = preflightResultFromEntry(entry({ agent: 'cursor', status: 'no_template' }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /no CLI spawn template/);
  });

  it('blocks a generic failure with the doctor remediation pointer', () => {
    const r = preflightResultFromEntry(entry({ status: 'failed', detail: 'no ack within 8000ms — delivery failed' }));
    assert.equal(r.ok, false);
    assert.match(r.recommended_next_action!, /doctor --spawn-check/);
  });

  it('enriches a failure with a recognized boot signature (codex service_tier)', () => {
    const r = preflightResultFromEntry(entry({
      status: 'failed',
      stderr_tail: ['Error: unsupported service_tier "flex"', 'exit 1'],
    }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /service_tier/);
    assert.match(r.recommended_next_action!, /config\.toml/);
  });
});

describe('preflightAgentSpawn / preflightAgents — async behaviour', () => {
  const prevNoSpawn = process.env.BRAINCLAW_NO_SPAWN;
  afterEach(() => {
    if (prevNoSpawn === undefined) delete process.env.BRAINCLAW_NO_SPAWN;
    else process.env.BRAINCLAW_NO_SPAWN = prevNoSpawn;
  });

  it('skips (ok) when BRAINCLAW_NO_SPAWN is set — never spawns in tests/CI', async () => {
    process.env.BRAINCLAW_NO_SPAWN = '1';
    const r = await preflightAgentSpawn('codex');
    assert.equal(r.ok, true);
    assert.equal(r.status, 'skipped');
  });

  it('dedupes agents and reports all_ok when none are blocked (NO_SPAWN skip path)', async () => {
    process.env.BRAINCLAW_NO_SPAWN = '1';
    const { results, blocked, all_ok } = await preflightAgents(['codex', 'codex', 'claude-code']);
    assert.equal(results.length, 2, 'deduped to 2 distinct agents');
    assert.equal(blocked.length, 0);
    assert.equal(all_ok, true);
  });
});
