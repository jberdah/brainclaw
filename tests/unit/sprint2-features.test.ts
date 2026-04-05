/**
 * Tests for sprint 2 features that were shipped without dedicated tests:
 * - stale-branch warning (detectCommitsBehindMain via execution-context)
 * - worker-integrator contract (handoff_mode on claims)
 * - scope-briefing (renderContextBriefing)
 * - doctor effective tier (assessAgentIntegrationReadiness)
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// --- Stale-branch warning ---

import { buildExecutionContext, compactExecutionContext } from '../../src/core/execution-context.js';

describe('stale-branch warning', () => {
  function makeRunner(branch: string, behindCounts: Record<string, number>) {
    return (command: string, args: string[], _cwd: string) => {
      const key = `${command} ${args.join(' ')}`;
      if (key === 'git rev-parse --show-toplevel') return { status: 0, stdout: '/repo\n', stderr: '' };
      if (key === 'git rev-parse --abbrev-ref HEAD') return { status: 0, stdout: `${branch}\n`, stderr: '' };
      if (key === 'git status --porcelain') return { status: 0, stdout: '', stderr: '' };
      if (key === 'git remote') return { status: 0, stdout: 'origin\n', stderr: '' };
      // rev-list for stale branch detection
      for (const [mainBranch, count] of Object.entries(behindCounts)) {
        if (key === `git rev-list --count ${branch}..${mainBranch}`) {
          return { status: 0, stdout: `${count}\n`, stderr: '' };
        }
      }
      return { status: 1, stdout: '', stderr: 'not found' };
    };
  }

  it('detects commits behind master', () => {
    const snapshot = buildExecutionContext({
      cwd: '/repo', env: {}, runner: makeRunner('feat/my-branch', { master: 5 }),
    });
    assert.equal(snapshot.commits_behind_main, 5);
  });

  it('detects commits behind main when master does not exist', () => {
    const snapshot = buildExecutionContext({
      cwd: '/repo', env: {}, runner: makeRunner('feat/my-branch', { main: 3 }),
    });
    assert.equal(snapshot.commits_behind_main, 3);
  });

  it('returns highest count when both master and main exist', () => {
    const snapshot = buildExecutionContext({
      cwd: '/repo', env: {}, runner: makeRunner('feat/my-branch', { master: 2, main: 7 }),
    });
    assert.equal(snapshot.commits_behind_main, 7);
  });

  it('returns undefined when on master', () => {
    const snapshot = buildExecutionContext({
      cwd: '/repo', env: {}, runner: makeRunner('master', { master: 0 }),
    });
    assert.equal(snapshot.commits_behind_main, undefined);
  });

  it('returns 0 when branch is up to date', () => {
    const snapshot = buildExecutionContext({
      cwd: '/repo', env: {}, runner: makeRunner('feat/up-to-date', { master: 0 }),
    });
    assert.equal(snapshot.commits_behind_main, 0);
  });

  it('propagates commits_behind_main to compact snapshot', () => {
    const snapshot = buildExecutionContext({
      cwd: '/repo', env: {}, runner: makeRunner('feat/stale', { master: 10 }),
    });
    const compact = compactExecutionContext(snapshot);
    assert.equal(compact.commits_behind_main, 10);
  });
});

// --- Worker-integrator contract (handoff_mode) ---

import { ClaimSchema } from '../../src/core/schema.js';

describe('worker-integrator contract', () => {
  it('ClaimSchema accepts self-commit handoff_mode', () => {
    const claim = ClaimSchema.parse({
      id: 'clm_test', agent: 'claude', scope: 'src/', description: 'test',
      created_at: new Date().toISOString(), status: 'active', handoff_mode: 'self-commit',
    });
    assert.equal(claim.handoff_mode, 'self-commit');
  });

  it('ClaimSchema accepts integrator handoff_mode', () => {
    const claim = ClaimSchema.parse({
      id: 'clm_test', agent: 'codex', scope: 'src/', description: 'test',
      created_at: new Date().toISOString(), status: 'active', handoff_mode: 'integrator',
    });
    assert.equal(claim.handoff_mode, 'integrator');
  });

  it('ClaimSchema rejects invalid handoff_mode', () => {
    assert.throws(() => {
      ClaimSchema.parse({
        id: 'clm_test', agent: 'claude', scope: 'src/', description: 'test',
        created_at: new Date().toISOString(), status: 'active', handoff_mode: 'banana',
      });
    });
  });

  it('ClaimSchema allows undefined handoff_mode (backward compat)', () => {
    const claim = ClaimSchema.parse({
      id: 'clm_test', agent: 'claude', scope: 'src/', description: 'test',
      created_at: new Date().toISOString(), status: 'active',
    });
    assert.equal(claim.handoff_mode, undefined);
  });
});

// --- Scope-briefing ---

import { renderContextBriefing, type ContextResult } from '../../src/core/context.js';

describe('scope-briefing', () => {
  function makeContextResult(overrides: Partial<ContextResult> = {}): ContextResult {
    return {
      context_schema: '1.2',
      profile: 'briefing',
      project_mode: 'auto',
      project_strategy: 'manual',
      current_host: 'test',
      all_hosts: false,
      memory_version: 'abc',
      target: 'src/core/foo.ts',
      memory_density: 'high' as const,
      bootstrap_available: false,
      resolved_instructions: [],
      selected: [],
      ...overrides,
    };
  }

  it('renders scope and confidence', () => {
    const result = renderContextBriefing(makeContextResult());
    assert.ok(result.includes('scope: src/core/foo.ts'));
    assert.ok(result.includes('confidence:'));
  });

  it('shows low confidence with no items', () => {
    const result = renderContextBriefing(makeContextResult());
    assert.ok(result.includes('confidence: low'));
  });

  it('shows traps when present', () => {
    const result = renderContextBriefing(makeContextResult({
      selected: [
        { id: 'trp_1', section: 'trap', text: 'Watch out for race condition', tags: [], score: 5, reasons: [], extra: 'high' },
        { id: 'trp_2', section: 'trap', text: 'Flaky test', tags: [], score: 3, reasons: [], extra: 'medium' },
      ],
    }));
    assert.ok(result.includes('race condition'));
    assert.ok(result.includes('Flaky test'));
  });

  it('shows claim conflicts', () => {
    const result = renderContextBriefing(makeContextResult({
      claim_conflicts: [{
        my_claim_id: 'clm_1', my_scope: 'src/', other_claim_id: 'clm_2', other_agent: 'codex', other_scope: 'src/core/', overlap_reason: 'prefix match',
      }],
    }));
    assert.ok(result.includes('conflict'));
    assert.ok(result.includes('codex'));
  });

  it('shows no conflict when none', () => {
    const result = renderContextBriefing(makeContextResult());
    assert.ok(result.includes('claims: no conflict'));
  });

  it('is under 500 chars with typical content', () => {
    const result = renderContextBriefing(makeContextResult({
      selected: [
        { id: 'trp_1', section: 'trap', text: 'Short trap', tags: [], score: 5, reasons: [], extra: 'high' },
        { id: 'dec_1', section: 'decision', text: 'Use postgres', tags: [], score: 3, reasons: [] },
      ],
    }));
    assert.ok(result.length < 500, `Briefing is ${result.length} chars, should be < 500`);
  });
});

// --- Doctor effective tier ---

import { assessAgentIntegrationReadiness } from '../../src/core/agent-integrations.js';

describe('doctor effective tier', () => {
  function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'brainclaw-test-'));
  }

  it('returns tier-a for claude-code when all surfaces exist', () => {
    const dir = tmpDir();
    try {
      // Create the expected surface files
      fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'test');
      fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({
        mcpServers: { brainclaw: { command: 'npx', args: ['brainclaw', 'mcp'] } }
      }));

      const config = {
        agent_integrations: {
          declarations: [{
            agent_name: 'claude-code' as const,
            declaration_source: 'manual' as const,
            surfaces: [
              { kind: 'instructions' as const, location: 'workspace' as const, path: 'CLAUDE.md' },
              { kind: 'mcp' as const, location: 'workspace' as const, path: '.mcp.json' },
            ],
          }],
        },
      };

      const results = assessAgentIntegrationReadiness(config as any, dir);
      assert.equal(results.length, 1);
      assert.equal(results[0]!.effective_tier, 'tier-a');
      assert.equal(results[0]!.self_healing_guidance.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('degrades to tier-b when MCP surface is missing for a tier-a agent', () => {
    const dir = tmpDir();
    try {
      fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'test');
      // .mcp.json does NOT exist

      const config = {
        agent_integrations: {
          declarations: [{
            agent_name: 'claude-code' as const,
            declaration_source: 'manual' as const,
            surfaces: [
              { kind: 'instructions' as const, location: 'workspace' as const, path: 'CLAUDE.md' },
              { kind: 'mcp' as const, location: 'workspace' as const, path: '.mcp.json' },
            ],
          }],
        },
      };

      const results = assessAgentIntegrationReadiness(config as any, dir);
      assert.equal(results[0]!.effective_tier, 'tier-b');
      assert.ok(results[0]!.self_healing_guidance.length > 0);
      assert.ok(results[0]!.self_healing_guidance[0]!.includes('degraded'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns tier-c when all surfaces are missing', () => {
    const dir = tmpDir();
    try {
      fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });

      const config = {
        agent_integrations: {
          declarations: [{
            agent_name: 'roo' as const,
            declaration_source: 'manual' as const,
            surfaces: [
              { kind: 'instructions' as const, location: 'workspace' as const, path: '.roo/rules/brainclaw.md' },
              { kind: 'mcp' as const, location: 'workspace' as const, path: '.roo/mcp.json' },
            ],
          }],
        },
      };

      const results = assessAgentIntegrationReadiness(config as any, dir);
      assert.equal(results[0]!.effective_tier, 'tier-c');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
