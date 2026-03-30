import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { saveClaim, generateClaimId } from '../../src/core/claims.js';
import { loadState, saveState } from '../../src/core/state.js';
import { createInstruction } from '../../src/core/instructions.js';
import { checkPolicy } from '../../src/core/policy.js';
import { nowISO } from '../../src/core/ids.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import type { Claim } from '../../src/core/schema.js';

describe('checkPolicy', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-policy-',
      projectId: 'prj_policy_test',
      currentAgent: 'test-agent',
    });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('blocks when agent has no claim on scope', () => {
    const result = checkPolicy({
      scope: 'src/core/foo.ts',
      agent: 'test-agent',
      cwd: workspace.dir,
    });

    assert.equal(result.allowed, false);
    assert.equal(result.blocks.length, 1);
    assert.equal(result.blocks[0]!.kind, 'no_claim');
  });

  it('allows when agent has a valid claim on scope', () => {
    saveClaim({
      id: generateClaimId(),
      agent: 'test-agent',
      scope: 'src/core/foo.ts',
      description: 'Working on foo',
      created_at: nowISO(),
      status: 'active',
    }, workspace.dir);

    const result = checkPolicy({
      scope: 'src/core/foo.ts',
      agent: 'test-agent',
      cwd: workspace.dir,
    });

    assert.equal(result.allowed, true);
    assert.equal(result.blocks.length, 0);
  });

  it('blocks when scope is claimed by another agent', () => {
    saveClaim({
      id: generateClaimId(),
      agent: 'other-agent',
      scope: 'src/core/foo.ts',
      description: 'Other agent working',
      created_at: nowISO(),
      status: 'active',
    }, workspace.dir);

    const result = checkPolicy({
      scope: 'src/core/foo.ts',
      agent: 'test-agent',
      cwd: workspace.dir,
    });

    assert.equal(result.allowed, false);
    assert.equal(result.blocks.length, 1);
    assert.equal(result.blocks[0]!.kind, 'claim_conflict');
  });

  it('allows when agent has claim on parent directory', () => {
    saveClaim({
      id: generateClaimId(),
      agent: 'test-agent',
      scope: 'src/core',
      description: 'Working on core',
      created_at: nowISO(),
      status: 'active',
    }, workspace.dir);

    const result = checkPolicy({
      scope: 'src/core/foo.ts',
      agent: 'test-agent',
      cwd: workspace.dir,
    });

    assert.equal(result.allowed, true);
    assert.equal(result.blocks.length, 0);
  });

  it('allows when agent has claim on child file and checking parent dir', () => {
    saveClaim({
      id: generateClaimId(),
      agent: 'test-agent',
      scope: 'src/core/foo.ts',
      description: 'Working on foo',
      created_at: nowISO(),
      status: 'active',
    }, workspace.dir);

    const result = checkPolicy({
      scope: 'src/core',
      agent: 'test-agent',
      cwd: workspace.dir,
    });

    assert.equal(result.allowed, true);
    assert.equal(result.blocks.length, 0);
  });

  it('warns on matching constraint with related_paths', () => {
    const state = loadState(workspace.dir);
    state.active_constraints.push({
      id: 'cst_test001',
      text: 'ESM imports must use .js extension',
      created_at: nowISO(),
      author: 'human',
      status: 'active',
      category: 'process',
      tags: [],
      related_paths: ['src/core'],
    });
    saveState(state, workspace.dir);

    // Give the agent a claim so it's not blocked
    saveClaim({
      id: generateClaimId(),
      agent: 'test-agent',
      scope: 'src/core/foo.ts',
      description: 'Working on foo',
      created_at: nowISO(),
      status: 'active',
    }, workspace.dir);

    const result = checkPolicy({
      scope: 'src/core/foo.ts',
      agent: 'test-agent',
      cwd: workspace.dir,
    });

    assert.equal(result.allowed, true);
    const constraintWarns = result.warnings.filter(w => w.kind === 'constraint');
    assert.equal(constraintWarns.length, 1);
    assert.ok(constraintWarns[0]!.message.includes('ESM imports'));
  });

  it('warns on matching trap with related_paths', () => {
    const state = loadState(workspace.dir);
    state.known_traps.push({
      id: 'trp_test001',
      text: 'Do not import from index.ts — causes circular dependency',
      created_at: nowISO(),
      author: 'human',
      status: 'active',
      severity: 'high',
      tags: [],
      related_paths: ['src/core/index.ts'],
      visibility: 'shared',
    });
    saveState(state, workspace.dir);

    saveClaim({
      id: generateClaimId(),
      agent: 'test-agent',
      scope: 'src/core',
      description: 'Working on core',
      created_at: nowISO(),
      status: 'active',
    }, workspace.dir);

    const result = checkPolicy({
      scope: 'src/core/index.ts',
      agent: 'test-agent',
      cwd: workspace.dir,
    });

    assert.equal(result.allowed, true);
    const trapWarns = result.warnings.filter(w => w.kind === 'trap');
    assert.equal(trapWarns.length, 1);
    assert.ok(trapWarns[0]!.message.includes('circular dependency'));
  });

  it('returns governance context with active instructions', () => {
    createInstruction('No external dependencies without discussion', {
      layer: 'global',
      author: 'human',
    }, workspace.dir);

    saveClaim({
      id: generateClaimId(),
      agent: 'test-agent',
      scope: 'src/core/foo.ts',
      description: 'Working on foo',
      created_at: nowISO(),
      status: 'active',
    }, workspace.dir);

    const result = checkPolicy({
      scope: 'src/core/foo.ts',
      agent: 'test-agent',
      cwd: workspace.dir,
    });

    assert.equal(result.allowed, true);
    assert.ok(result.governance_context.active_instructions.length >= 1);
    const found = result.governance_context.active_instructions.find(
      i => i.text.includes('No external dependencies')
    );
    assert.ok(found, 'Should include global instruction in governance context');
  });

  it('warns about expired claims', () => {
    const pastDate = new Date(Date.now() - 3600_000).toISOString();
    saveClaim({
      id: generateClaimId(),
      agent: 'test-agent',
      scope: 'src/core/foo.ts',
      description: 'Old work',
      created_at: new Date(Date.now() - 7200_000).toISOString(),
      status: 'active',
      expires_at: pastDate,
    }, workspace.dir);

    const result = checkPolicy({
      scope: 'src/core/foo.ts',
      agent: 'test-agent',
      cwd: workspace.dir,
    });

    assert.equal(result.allowed, false);
    const expiredWarns = result.warnings.filter(w => w.kind === 'claim_expired');
    assert.equal(expiredWarns.length, 1);
  });

  it('without agent returns warn instead of block for missing claim', () => {
    const result = checkPolicy({
      scope: 'src/core/foo.ts',
      cwd: workspace.dir,
    });

    // Without agent, it's a warning, not a block
    assert.equal(result.allowed, true);
    assert.equal(result.blocks.length, 0);
    const noClaimWarns = result.warnings.filter(w => w.kind === 'no_claim');
    assert.equal(noClaimWarns.length, 1);
  });

  it('normalises Windows backslashes in scope matching', () => {
    saveClaim({
      id: generateClaimId(),
      agent: 'test-agent',
      scope: 'src\\core\\foo.ts',
      description: 'Working on foo',
      created_at: nowISO(),
      status: 'active',
    }, workspace.dir);

    const result = checkPolicy({
      scope: 'src/core/foo.ts',
      agent: 'test-agent',
      cwd: workspace.dir,
    });

    assert.equal(result.allowed, true);
    assert.equal(result.blocks.length, 0);
  });
});
