import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderBrainclawSection, type InstructionTemplateInput } from '../../src/core/instruction-templates.js';
import { getAgentCapabilityProfile } from '../../src/core/agent-capability.js';
import type { State } from '../../src/core/schema.js';

function makeState(overrides: Partial<State> = {}): State {
  return {
    version: 1,
    write_version: 1,
    active_constraints: [],
    recent_decisions: [],
    known_traps: [],
    open_handoffs: [],
    plan_items: [],
    ...overrides,
  };
}

function makeInput(agentName: string, overrides: Partial<InstructionTemplateInput> = {}): InstructionTemplateInput {
  const profile = getAgentCapabilityProfile(agentName)!;
  return {
    profile,
    state: makeState(),
    projectName: 'test-project',
    brainclawVersion: '0.20.0',
    resolvedInstructions: [],
    ...overrides,
  };
}

describe('instruction-templates', () => {

  describe('tier A (claude-code)', () => {
    it('renders a lightweight section', () => {
      const result = renderBrainclawSection(makeInput('claude-code'));
      assert.equal(result.tier, 'A');
      assert.ok(result.content.includes('brainclaw — why this matters'));
      assert.ok(result.content.includes('session protocol'));
      assert.ok(result.content.includes('injected automatically via hooks'));
      assert.ok(result.content.includes('plans and estimation'));
      assert.ok(result.content.includes('version check'));
    });

    it('does NOT include traps, plans, or decisions', () => {
      const state = makeState({
        known_traps: [
          { id: 'trp_1', text: 'A trap', severity: 'high', visibility: 'shared', tags: [], created_at: '', created_by: '' },
        ] as any,
        plan_items: [
          { id: 'pln_1', text: 'A plan', status: 'todo', tags: [], created_at: '', created_by: '' },
        ] as any,
        recent_decisions: [
          { id: 'dec_1', text: 'A decision', tags: [], created_at: '', created_by: '' },
        ] as any,
      });
      const result = renderBrainclawSection(makeInput('claude-code', { state }));
      assert.ok(!result.sectionsIncluded.includes('traps'));
      assert.ok(!result.sectionsIncluded.includes('plans'));
      assert.ok(!result.sectionsIncluded.includes('decisions'));
    });

    it('includes constraints when present', () => {
      const state = makeState({
        active_constraints: [
          { id: 'cst_1', text: 'No deployments on Friday', status: 'active', tags: [], created_at: '', created_by: '', category: 'process' },
        ] as any,
      });
      const result = renderBrainclawSection(makeInput('claude-code', { state }));
      assert.ok(result.sectionsIncluded.includes('constraints'));
      assert.ok(result.content.includes('No deployments on Friday'));
    });

    it('includes instructions when present', () => {
      const result = renderBrainclawSection(makeInput('claude-code', {
        resolvedInstructions: ['Build with npm run build', 'Test with npm test'],
      }));
      assert.ok(result.sectionsIncluded.includes('instructions'));
      assert.ok(result.content.includes('Build with npm run build'));
    });

    it('does NOT say REQUIRED', () => {
      const result = renderBrainclawSection(makeInput('claude-code'));
      assert.ok(!result.content.includes('REQUIRED'));
      assert.ok(!result.content.includes('You MUST'));
    });
  });

  describe('tier B (cursor)', () => {
    it('renders a directive section', () => {
      const result = renderBrainclawSection(makeInput('cursor'));
      assert.equal(result.tier, 'B');
      assert.ok(result.content.includes('REQUIRED'));
      assert.ok(result.content.includes('You MUST'));
      assert.ok(result.content.includes('bclaw_session_start'));
      assert.ok(result.content.includes('bclaw_get_execution_context'));
    });

    it('includes top traps when present', () => {
      const state = makeState({
        known_traps: [
          { id: 'trp_1', text: 'Flaky test in checkout', severity: 'high', visibility: 'shared', tags: [], created_at: '', created_by: '' },
          { id: 'trp_2', text: 'Machine-only issue', severity: 'medium', visibility: 'machine', tags: [], created_at: '', created_by: '' },
          { id: 'trp_3', text: 'Low prio trap', severity: 'low', visibility: 'shared', tags: [], created_at: '', created_by: '' },
        ] as any,
      });
      const result = renderBrainclawSection(makeInput('cursor', { state }));
      assert.ok(result.sectionsIncluded.includes('traps'));
      assert.ok(result.content.includes('Flaky test in checkout'));
      // machine-visibility traps are excluded from static files
      assert.ok(!result.content.includes('Machine-only issue'));
    });

    it('limits traps to maxTraps', () => {
      const traps = Array.from({ length: 20 }, (_, i) => ({
        id: `trp_${i}`, text: `Trap ${i}`, severity: 'medium', visibility: 'shared', tags: [], created_at: '', created_by: '',
      }));
      const state = makeState({ known_traps: traps as any });
      const result = renderBrainclawSection(makeInput('cursor', { state, maxTraps: 3 }));
      const trapLines = result.content.split('\n').filter(l => l.startsWith('- [medium]'));
      assert.equal(trapLines.length, 3);
    });

    it('does NOT include plans or decisions', () => {
      const state = makeState({
        plan_items: [{ id: 'pln_1', text: 'A plan', status: 'todo', tags: [], created_at: '', created_by: '' }] as any,
        recent_decisions: [{ id: 'dec_1', text: 'A decision', tags: [], created_at: '', created_by: '' }] as any,
      });
      const result = renderBrainclawSection(makeInput('cursor', { state }));
      assert.ok(!result.sectionsIncluded.includes('plans'));
      assert.ok(!result.sectionsIncluded.includes('decisions'));
    });
  });

  describe('tier C (github-copilot)', () => {
    it('renders a rich section', () => {
      const result = renderBrainclawSection(makeInput('github-copilot'));
      assert.equal(result.tier, 'C');
      assert.ok(result.content.includes('brainclaw-context skill'));
      assert.ok(!result.content.includes('REQUIRED'));
    });

    it('includes plans, traps, AND decisions', () => {
      const state = makeState({
        known_traps: [
          { id: 'trp_1', text: 'A trap', severity: 'high', visibility: 'shared', tags: [], created_at: '', created_by: '' },
        ] as any,
        plan_items: [
          { id: 'pln_1', text: 'Auth rollout', status: 'in_progress', tags: [], created_at: '', created_by: '', assignee: 'Pierre' },
          { id: 'pln_2', text: 'DB migration', status: 'todo', priority: 'high', tags: [], created_at: '', created_by: '' },
        ] as any,
        recent_decisions: [
          { id: 'dec_1', text: 'Use PostgreSQL 16', tags: [], created_at: '', created_by: '' },
        ] as any,
      });
      const result = renderBrainclawSection(makeInput('github-copilot', { state }));
      assert.ok(result.sectionsIncluded.includes('traps'));
      assert.ok(result.sectionsIncluded.includes('plans'));
      assert.ok(result.sectionsIncluded.includes('decisions'));
      assert.ok(result.content.includes('Auth rollout'));
      assert.ok(result.content.includes('@Pierre'));
      assert.ok(result.content.includes('Use PostgreSQL 16'));
    });

    it('sorts plans: in_progress first, then by priority', () => {
      const state = makeState({
        plan_items: [
          { id: 'pln_1', text: 'Low todo', status: 'todo', priority: 'low', tags: [], created_at: '', created_by: '' },
          { id: 'pln_2', text: 'In progress', status: 'in_progress', tags: [], created_at: '', created_by: '' },
          { id: 'pln_3', text: 'High todo', status: 'todo', priority: 'high', tags: [], created_at: '', created_by: '' },
        ] as any,
      });
      const result = renderBrainclawSection(makeInput('github-copilot', { state }));
      const planLines = result.content.split('\n').filter(l => l.startsWith('- ['));
      assert.ok(planLines[0].includes('In progress'));
      assert.ok(planLines[1].includes('High todo'));
      assert.ok(planLines[2].includes('Low todo'));
    });

    it('sorts traps by severity (high first)', () => {
      const state = makeState({
        known_traps: [
          { id: 'trp_1', text: 'Low trap', severity: 'low', visibility: 'shared', tags: [], created_at: '', created_by: '' },
          { id: 'trp_2', text: 'High trap', severity: 'high', visibility: 'shared', tags: [], created_at: '', created_by: '' },
          { id: 'trp_3', text: 'Medium trap', severity: 'medium', visibility: 'shared', tags: [], created_at: '', created_by: '' },
        ] as any,
      });
      const result = renderBrainclawSection(makeInput('github-copilot', { state }));
      const trapLines = result.content.split('\n').filter(l => l.match(/^\- \[(high|medium|low)\]/));
      assert.ok(trapLines[0].includes('[high]'));
      assert.ok(trapLines[1].includes('[medium]'));
      assert.ok(trapLines[2].includes('[low]'));
    });

    it('does NOT include version check (no MCP)', () => {
      const result = renderBrainclawSection(makeInput('github-copilot'));
      assert.ok(!result.sectionsIncluded.includes('version-check'));
    });
  });

  describe('cross-tier consistency', () => {
    it('all tiers include header, why, protocol, estimation', () => {
      for (const agent of ['claude-code', 'cursor', 'github-copilot']) {
        const result = renderBrainclawSection(makeInput(agent));
        assert.ok(result.sectionsIncluded.includes('header'), `${agent} missing header`);
        assert.ok(result.sectionsIncluded.includes('why'), `${agent} missing why`);
        assert.ok(result.sectionsIncluded.includes('protocol'), `${agent} missing protocol`);
        assert.ok(result.sectionsIncluded.includes('estimation'), `${agent} missing estimation`);
      }
    });

    it('header includes brainclaw version', () => {
      const result = renderBrainclawSection(makeInput('cursor', { brainclawVersion: '1.2.3' }));
      assert.ok(result.content.includes('v1.2.3'));
    });

    it('empty state produces no optional sections', () => {
      for (const agent of ['claude-code', 'cursor', 'github-copilot']) {
        const result = renderBrainclawSection(makeInput(agent));
        assert.ok(!result.sectionsIncluded.includes('constraints'), `${agent} should not have constraints`);
        assert.ok(!result.sectionsIncluded.includes('instructions'), `${agent} should not have instructions`);
      }
    });
  });
});
