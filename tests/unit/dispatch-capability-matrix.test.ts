import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSandboxedSpawn,
  dispatchHasMcp,
  dispatchCanCommit,
  getCapabilityProfile,
} from '../../src/core/agent-capability.js';

// pln#528 — dispatch-time capability matrix derived from the spawn template.
// codex runs `--sandbox workspace-write` → no MCP, no git commit, despite a
// nominal runtime.mcp_direct=true. claude-code runs unsandboxed → both.

describe('dispatch capability matrix (pln#528)', () => {
  it('codex (--sandbox) → sandboxed, no dispatch MCP, no commit', () => {
    const codex = getCapabilityProfile('codex')!;
    assert.equal(isSandboxedSpawn(codex), true, 'codex invoke_template carries --sandbox');
    assert.equal(dispatchHasMcp(codex), false, 'sandbox blocks MCP at dispatch time');
    assert.equal(dispatchCanCommit(codex), false, '.git is outside the sandbox root');
  });

  it('claude-code → not sandboxed, has dispatch MCP + can commit', () => {
    const cc = getCapabilityProfile('claude-code')!;
    assert.equal(isSandboxedSpawn(cc), false);
    assert.equal(dispatchHasMcp(cc), true);
    assert.equal(dispatchCanCommit(cc), true);
  });

  it('dispatchHasMcp respects runtime.mcp_direct even when not sandboxed', () => {
    // A profile with mcp_direct=false (e.g. an MCP-less family agent) has no
    // dispatch MCP regardless of sandboxing.
    const gemini = getCapabilityProfile('gemini');
    if (gemini && !gemini.runtime.mcp_direct) {
      assert.equal(dispatchHasMcp(gemini), false);
    }
    // Sanity: the helper never throws on a real profile.
    assert.equal(typeof dispatchHasMcp(getCapabilityProfile('claude-code')!), 'boolean');
  });
});
