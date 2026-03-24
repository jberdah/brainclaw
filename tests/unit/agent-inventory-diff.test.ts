import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diffInventory, type AgentInventory } from '../../src/core/agent-inventory.js';

function makeInventory(agents: Array<{ name: string; installed: boolean; version?: string }>): AgentInventory {
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    agents: agents.map(a => ({
      name: a.name,
      installed: a.installed,
      detection_method: 'test',
      version: a.version,
      models: [],
      native_tools: [],
      mcp_support: false,
      skills_support: false,
      rules_support: false,
      hooks_support: false,
    })),
  };
}

describe('diffInventory', () => {
  it('returns empty diff when both inventories are identical', () => {
    const inv = makeInventory([
      { name: 'claude-code', installed: true, version: '1.0.0' },
      { name: 'cursor', installed: true, version: '2.0.0' },
    ]);
    const diff = diffInventory(inv, inv);
    assert.deepEqual(diff.appeared, []);
    assert.deepEqual(diff.disappeared, []);
    assert.deepEqual(diff.version_changed, []);
  });

  it('detects appeared agents', () => {
    const prev = makeInventory([
      { name: 'claude-code', installed: true },
    ]);
    const curr = makeInventory([
      { name: 'claude-code', installed: true },
      { name: 'cursor', installed: true },
    ]);
    const diff = diffInventory(prev, curr);
    assert.deepEqual(diff.appeared, ['cursor']);
    assert.deepEqual(diff.disappeared, []);
  });

  it('detects disappeared agents', () => {
    const prev = makeInventory([
      { name: 'claude-code', installed: true },
      { name: 'codex', installed: true },
    ]);
    const curr = makeInventory([
      { name: 'claude-code', installed: true },
      { name: 'codex', installed: false },
    ]);
    const diff = diffInventory(prev, curr);
    assert.deepEqual(diff.appeared, []);
    assert.deepEqual(diff.disappeared, ['codex']);
  });

  it('detects version changes', () => {
    const prev = makeInventory([
      { name: 'claude-code', installed: true, version: '1.0.0' },
    ]);
    const curr = makeInventory([
      { name: 'claude-code', installed: true, version: '1.1.0' },
    ]);
    const diff = diffInventory(prev, curr);
    assert.deepEqual(diff.appeared, []);
    assert.deepEqual(diff.version_changed, [{ name: 'claude-code', from: '1.0.0', to: '1.1.0' }]);
  });

  it('handles undefined previous inventory (first run)', () => {
    const curr = makeInventory([
      { name: 'claude-code', installed: true },
      { name: 'cursor', installed: true },
      { name: 'codex', installed: false },
    ]);
    const diff = diffInventory(undefined, curr);
    assert.deepEqual(diff.appeared, ['claude-code', 'cursor']);
    assert.deepEqual(diff.disappeared, []);
    assert.deepEqual(diff.version_changed, []);
  });

  it('ignores non-installed agents in diff', () => {
    const prev = makeInventory([
      { name: 'claude-code', installed: true },
      { name: 'windsurf', installed: false },
    ]);
    const curr = makeInventory([
      { name: 'claude-code', installed: true },
      { name: 'windsurf', installed: false },
      { name: 'cursor', installed: false },
    ]);
    const diff = diffInventory(prev, curr);
    assert.deepEqual(diff.appeared, []);
    assert.deepEqual(diff.disappeared, []);
  });

  it('does not report version change when both versions are undefined', () => {
    const prev = makeInventory([
      { name: 'claude-code', installed: true },
    ]);
    const curr = makeInventory([
      { name: 'claude-code', installed: true },
    ]);
    const diff = diffInventory(prev, curr);
    assert.deepEqual(diff.version_changed, []);
  });
});
