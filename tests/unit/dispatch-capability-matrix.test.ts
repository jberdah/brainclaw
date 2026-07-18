import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSandboxedSpawn,
  dispatchHasMcp,
  dispatchCanCommit,
  getCapabilityProfile,
} from '../../src/core/agent-capability.js';

// pln#528 — dispatch-time capability matrix derived from the spawn template.
// pln#628 Focus 4A CORRECTION (dec#133): MCP reachability and commit ability are
// now DECOUPLED. A `--sandbox` spawn no longer implies "no MCP" — the empirical
// probe (codex 0.144.4) showed MCP is reachable from a sandboxed run (separate
// out-of-sandbox process + approval_policy=never). The sandbox's ONLY real effect
// is making `.git` read-only, so codex → hasMcp=true but canCommit=false.

describe('dispatch capability matrix (pln#528 / pln#628 Focus 4A)', () => {
  it('codex (--sandbox) → sandboxed + HAS dispatch MCP, but cannot commit (dec#133)', () => {
    const codex = getCapabilityProfile('codex')!;
    assert.equal(isSandboxedSpawn(codex), true, 'codex invoke_template carries --sandbox');
    // dec#133: sandbox does NOT sever MCP — the server runs out-of-sandbox and
    // approval_policy=never auto-approves every tool call. This flipped from the
    // original (false) pln#528 belief that sandbox blocked MCP.
    assert.equal(dispatchHasMcp(codex), true, 'MCP is reachable from a sandboxed codex run (dec#133)');
    assert.equal(dispatchCanCommit(codex), false, '.git is outside the sandbox root — coordinator commits at harvest');
  });

  it('claude-code → not sandboxed, has dispatch MCP + can commit', () => {
    const cc = getCapabilityProfile('claude-code')!;
    assert.equal(isSandboxedSpawn(cc), false);
    assert.equal(dispatchHasMcp(cc), true);
    assert.equal(dispatchCanCommit(cc), true);
  });

  it('dispatchHasMcp is driven by runtime.mcp_direct alone (sandbox-independent)', () => {
    // A genuinely MCP-less family agent (mcp_direct=false, not sandboxed) is the
    // only case where dispatchHasMcp is false — and it is false BECAUSE of
    // mcp_direct, not because of any sandbox flag.
    const nano = getCapabilityProfile('nanoclaw')!;
    assert.equal(nano.runtime.mcp_direct, false, 'nanoclaw is an MCP-less agent');
    assert.equal(isSandboxedSpawn(nano), false, 'nanoclaw is not sandboxed');
    assert.equal(dispatchHasMcp(nano), false, 'no MCP because mcp_direct=false');
    assert.equal(dispatchCanCommit(nano), true, 'unsandboxed → can commit its own diff');
    // Sanity: the helper never throws on a real profile.
    assert.equal(typeof dispatchHasMcp(getCapabilityProfile('claude-code')!), 'boolean');
  });
});
