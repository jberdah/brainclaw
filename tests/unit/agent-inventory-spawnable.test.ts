import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentInventory, detectSpawnable } from '../../src/core/agent-inventory.js';

// trp#427 — `installed` must be decoupled from the cold-start `--version` probe.
// An agent brainclaw can SPAWN (invoke binary on PATH) is installed even when
// the probe times out. We inject a spawnableResolver for determinism so the
// test does not depend on which CLIs happen to be on the runner's PATH.
//
// `cline` is used as the subject: with an empty home + env its detect() returns
// installed:false WITHOUT launching any CLI (no `--version` probe), so the only
// signal flipping `installed` is the injected spawnable result.

describe('buildAgentInventory — spawnable decoupling (trp#427)', () => {
  it('marks an agent installed when spawnable, even though its detect probe failed', () => {
    const inv = buildAgentInventory('/no/such/home', {}, {
      spawnableResolver: (name) => name === 'cline',
    });
    const cline = inv.agents.find((a) => a.name === 'cline')!;
    assert.equal(cline.spawnable, true, 'spawnable flag set from resolver');
    assert.equal(cline.installed, true, 'spawnable agent is installed even when the probe failed');
    assert.match(cline.detection_method, /spawnable/, 'detection_method explains the spawnable fallback');
  });

  it('does not mark a non-spawnable, undetected agent as installed', () => {
    const inv = buildAgentInventory('/no/such/home', {}, {
      spawnableResolver: () => false,
    });
    const cline = inv.agents.find((a) => a.name === 'cline')!;
    assert.equal(cline.spawnable, false);
    assert.equal(cline.installed, false);
  });

  it('every entry carries an explicit spawnable boolean', () => {
    const inv = buildAgentInventory('/no/such/home', {}, { spawnableResolver: () => false });
    for (const agent of inv.agents) {
      assert.equal(typeof agent.spawnable, 'boolean', `${agent.name} has a spawnable boolean`);
    }
  });
});

describe('detectSpawnable (trp#427)', () => {
  it('returns false for an unknown agent (no capability profile)', () => {
    assert.equal(detectSpawnable('totally-unknown-agent-xyz'), false);
  });

  it('returns a boolean (never throws) for a known agent', () => {
    assert.equal(typeof detectSpawnable('claude-code'), 'boolean');
  });
});
