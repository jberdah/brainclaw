import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderBrainclawSection, renderLiveSection, type InstructionTemplateInput } from '../../src/core/instruction-templates.js';
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

function assertMinimalProtocol(content: string): void {
  assert.ok(content.includes('## brainclaw — session protocol'));
  assert.ok(content.includes('bclaw_work(intent)'));
  assert.ok(content.includes('bclaw_coordinate(intent)'));
  // bclaw_get_context may appear in the available-tools catalog, but the
  // protocol section itself must not instruct agents to call it directly.
  const protocolSection = content.split('## brainclaw — session protocol')[1]?.split('## brainclaw')[0] ?? '';
  assert.ok(!protocolSection.includes('bclaw_get_context'), 'protocol section must not reference bclaw_get_context');
}

describe('instruction-templates', () => {

  describe('tier A (claude-code)', () => {
    it('renders a lightweight section', () => {
      const result = renderBrainclawSection(makeInput('claude-code'));
      assert.equal(result.tier, 'A');
      assertMinimalProtocol(result.content);
    });

    it('uses the unified facades instead of legacy session tools', () => {
      const result = renderBrainclawSection(makeInput('claude-code'));
      assertMinimalProtocol(result.content);
    });

    it('does NOT include traps, plans, decisions, or constraints', () => {
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
        active_constraints: [
          { id: 'cst_1', text: 'A constraint', status: 'active', tags: [], created_at: '', created_by: '', category: 'process' },
        ] as any,
      });
      const result = renderBrainclawSection(makeInput('claude-code', { state }));
      assert.ok(!result.sectionsIncluded.includes('traps'));
      assert.ok(!result.sectionsIncluded.includes('plans'));
      assert.ok(!result.sectionsIncluded.includes('decisions'));
      assert.ok(!result.sectionsIncluded.includes('working-rules'));
      assert.ok(!result.sectionsIncluded.includes('architecture'));
    });

    it('includes instructions when present', () => {
      const result = renderBrainclawSection(makeInput('claude-code', {
        resolvedInstructions: ['Build with npm run build'],
      }));
      assert.ok(result.sectionsIncluded.includes('instructions'));
      assert.ok(result.content.includes('Build with npm run build'));
    });

    it('does NOT say REQUIRED', () => {
      const result = renderBrainclawSection(makeInput('claude-code'));
      assert.ok(!result.content.includes('REQUIRED'));
    });

    it('includes available tools section with categorized tool names', () => {
      const result = renderBrainclawSection(makeInput('claude-code'));
      assert.ok(result.sectionsIncluded.includes('available-tools'), 'should include available-tools section');
      assert.ok(result.content.includes('## brainclaw — available tools'));
      // Verify tool categories and key tools are present
      const toolNames = [
        // Context
        'bclaw_get_context', 'bclaw_get_execution_context', 'bclaw_bootstrap',
        // Session
        'bclaw_session_start', 'bclaw_session_end', 'bclaw_claim', 'bclaw_release_claim',
        // Memory
        'bclaw_search', 'bclaw_write_note', 'bclaw_quick_capture', 'bclaw_update_memory', 'bclaw_compact',
        // Plans & Sequences
        'bclaw_create_plan', 'bclaw_list_plans', 'bclaw_update_plan', 'bclaw_add_step', 'bclaw_complete_step',
        'bclaw_create_sequence', 'bclaw_list_sequences', 'bclaw_update_sequence',
        // Dispatch & Messaging
        'bclaw_dispatch', 'bclaw_dispatch_analysis', 'bclaw_send_message', 'bclaw_read_inbox', 'bclaw_get_thread',
        // Review
        'bclaw_create_candidate', 'bclaw_accept', 'bclaw_reject',
        // Awareness
        'bclaw_get_agent_board', 'bclaw_list_claims', 'bclaw_who', 'bclaw_conflict_check',
        // Navigate & Governance
        'bclaw_switch', 'bclaw_get_discovery', 'bclaw_check_policy', 'bclaw_audit', 'bclaw_doctor',
      ];
      for (const tool of toolNames) {
        assert.ok(result.content.includes(tool), `available tools should mention ${tool}`);
      }
    });

    it('renderLiveSection returns undefined for tier A', () => {
      const live = renderLiveSection(makeInput('claude-code'));
      assert.equal(live, undefined, 'Tier A should not have a live companion');
    });
  });

  describe('tier A agents reclassified from B', () => {
    for (const agent of ['cursor', 'windsurf', 'cline', 'codex', 'github-copilot']) {
      it(`${agent} is now tier A`, () => {
        const result = renderBrainclawSection(makeInput(agent));
        assert.equal(result.tier, 'A', `${agent} should be tier A`);
        assert.ok(!result.sectionsIncluded.includes('traps'), `${agent} tier A should not have static traps`);
        assert.ok(!result.sectionsIncluded.includes('working-rules'), `${agent} tier A should not have working rules`);
      });
    }
  });

  describe('tier B (roo — MCP, no hooks)', () => {
    it('renders the shared minimal protocol', () => {
      const result = renderBrainclawSection(makeInput('roo'));
      assert.equal(result.tier, 'B');
      assertMinimalProtocol(result.content);
      assert.ok(!result.content.includes('REQUIRED'));
    });

    it('splits constraints into working-rules and architecture', () => {
      const state = makeState({
        active_constraints: [
          { id: 'cst_1', text: 'No Friday deploys', status: 'active', tags: [], created_at: '', created_by: '', category: 'process' },
          { id: 'cst_2', text: 'TypeScript ESM', status: 'active', tags: [], created_at: '', created_by: '', category: 'architecture' },
        ] as any,
      });
      const result = renderBrainclawSection(makeInput('roo', { state }));
      assert.ok(result.sectionsIncluded.includes('working-rules'));
      assert.ok(result.sectionsIncluded.includes('architecture'));
      assert.ok(result.content.includes('brainclaw — working rules'));
      assert.ok(result.content.includes('brainclaw — architecture'));
    });

    it('stable output does NOT include traps, plans, or decisions', () => {
      const state = makeState({
        known_traps: [{ id: 'trp_1', text: 'Flaky test', severity: 'high', visibility: 'shared', tags: [], created_at: '', created_by: '' }] as any,
        plan_items: [{ id: 'pln_1', text: 'Plan', status: 'todo', tags: [], created_at: '', created_by: '' }] as any,
        recent_decisions: [{ id: 'dec_1', text: 'Decision', tags: [], created_at: '', created_by: '' }] as any,
      });
      const result = renderBrainclawSection(makeInput('roo', { state }));
      assert.ok(!result.sectionsIncluded.includes('traps'));
      assert.ok(!result.sectionsIncluded.includes('plans'));
      assert.ok(!result.sectionsIncluded.includes('decisions'));
    });

    it('live companion includes traps and plans, excludes machine-visibility', () => {
      const state = makeState({
        known_traps: [
          { id: 'trp_1', text: 'Flaky test', severity: 'high', visibility: 'shared', tags: [], created_at: '', created_by: '' },
          { id: 'trp_2', text: 'Machine-only', severity: 'medium', visibility: 'machine', tags: [], created_at: '', created_by: '' },
        ] as any,
        plan_items: [{ id: 'pln_1', text: 'Plan', status: 'todo', tags: [], created_at: '', created_by: '' }] as any,
      });
      const live = renderLiveSection(makeInput('roo', { state }));
      assert.ok(live, 'Tier B should have a live companion');
      assert.ok(live!.content.includes('Flaky test'));
      assert.ok(!live!.content.includes('Machine-only'));
      assert.ok(live!.sectionsIncluded.includes('plans'));
    });

    it('live companion limits traps to maxTraps', () => {
      const traps = Array.from({ length: 20 }, (_, i) => ({
        id: `trp_${i}`, text: `Trap ${i}`, severity: 'medium', visibility: 'shared', tags: [], created_at: '', created_by: '',
      }));
      const live = renderLiveSection(makeInput('roo', { state: makeState({ known_traps: traps as any }), maxTraps: 3 }));
      assert.ok(live);
      const trapLines = live!.content.split('\n').filter(l => l.startsWith('- [medium]'));
      assert.equal(trapLines.length, 3);
    });
  });

  describe('tier B (openclaw — MCP enabled)', () => {
    it('renders a tier B section with protocol', () => {
      const result = renderBrainclawSection(makeInput('openclaw'));
      assert.equal(result.tier, 'B');
      assertMinimalProtocol(result.content);
    });

    it('stable output does NOT include traps, plans, or decisions', () => {
      const state = makeState({
        known_traps: [{ id: 'trp_1', text: 'Trap', severity: 'high', visibility: 'shared', tags: [], created_at: '', created_by: '' }] as any,
        plan_items: [{ id: 'pln_1', text: 'Auth rollout', status: 'in_progress', tags: [], created_at: '', created_by: '' }] as any,
        recent_decisions: [{ id: 'dec_1', text: 'Use PostgreSQL 16', tags: [], created_at: '', created_by: '' }] as any,
      });
      const result = renderBrainclawSection(makeInput('openclaw', { state }));
      assert.ok(!result.sectionsIncluded.includes('traps'));
      assert.ok(!result.sectionsIncluded.includes('plans'));
      assert.ok(!result.sectionsIncluded.includes('decisions'));
    });

    it('live companion includes traps and plans', () => {
      const state = makeState({
        known_traps: [{ id: 'trp_1', text: 'Trap', severity: 'high', visibility: 'shared', tags: [], created_at: '', created_by: '' }] as any,
        plan_items: [{ id: 'pln_1', text: 'Auth rollout', status: 'in_progress', tags: [], created_at: '', created_by: '', assignee: 'Pierre' }] as any,
        recent_decisions: [{ id: 'dec_1', text: 'Use PostgreSQL 16', tags: [], created_at: '', created_by: '' }] as any,
      });
      const live = renderLiveSection(makeInput('openclaw', { state }));
      assert.ok(live, 'Tier B should have a live companion');
      assert.ok(live!.sectionsIncluded.includes('traps'));
      assert.ok(live!.sectionsIncluded.includes('plans'));
    });

    it('live companion sorts plans: in_progress first, then by priority', () => {
      const state = makeState({
        plan_items: [
          { id: 'pln_1', text: 'Low todo', status: 'todo', priority: 'low', tags: [], created_at: '', created_by: '' },
          { id: 'pln_2', text: 'In progress', status: 'in_progress', tags: [], created_at: '', created_by: '' },
          { id: 'pln_3', text: 'High todo', status: 'todo', priority: 'high', tags: [], created_at: '', created_by: '' },
        ] as any,
      });
      const live = renderLiveSection(makeInput('openclaw', { state }));
      assert.ok(live);
      const planLines = live!.content.split('\n').filter(l => l.startsWith('- ['));
      assert.ok(planLines[0]!.includes('In progress'));
      assert.ok(planLines[1]!.includes('High todo'));
      assert.ok(planLines[2]!.includes('Low todo'));
    });
  });

  describe('PROJECT.md vision', () => {
    it('replaces "why this matters" when projectVision is provided', () => {
      const result = renderBrainclawSection(makeInput('claude-code', {
        projectVision: 'Brainclaw: multi-agent coordination tool.',
      }));
      assert.ok(result.sectionsIncluded.includes('vision'));
      assert.ok(!result.sectionsIncluded.includes('why'));
      assert.ok(result.content.includes('brainclaw — this project'));
      assert.ok(result.content.includes('multi-agent coordination tool'));
    });

    it('shows no vision section when projectVision is absent', () => {
      const result = renderBrainclawSection(makeInput('roo'));
      assert.ok(!result.sectionsIncluded.includes('vision'));
    });

    it('works for all tiers', () => {
      for (const agent of ['claude-code', 'roo', 'openclaw']) {
        const result = renderBrainclawSection(makeInput(agent, {
          projectVision: 'Test vision text',
        }));
        assert.ok(result.sectionsIncluded.includes('vision'), `${agent} should include vision`);
        assert.ok(result.content.includes('Test vision text'), `${agent} should render vision`);
      }
    });
  });

  describe('constraint categorization', () => {
    const state = makeState({
      active_constraints: [
        { id: 'cst_1', text: 'No Co-Authored-By', status: 'active', tags: [], created_at: '', created_by: '', category: 'process' },
        { id: 'cst_2', text: 'TypeScript Node16 + ESM', status: 'active', tags: [], created_at: '', created_by: '', category: 'architecture' },
        { id: 'cst_3', text: 'Coverage gates 55%', status: 'active', tags: [], created_at: '', created_by: '', category: 'reliability' },
        { id: 'cst_4', text: 'Uncategorized', status: 'active', tags: [], created_at: '', created_by: '' },
      ] as any,
    });

    it('Tier B splits into working-rules and architecture', () => {
      const result = renderBrainclawSection(makeInput('roo', { state }));
      assert.ok(result.content.includes('brainclaw — working rules'));
      assert.ok(result.content.includes('brainclaw — architecture'));
      assert.ok(result.content.includes('No Co-Authored-By'));
      assert.ok(result.content.includes('Coverage gates 55%'));
      assert.ok(result.content.includes('Uncategorized'));
      assert.ok(result.content.includes('TypeScript Node16 + ESM'));
    });

    it('Tier A does NOT include any constraints', () => {
      const result = renderBrainclawSection(makeInput('claude-code', { state }));
      assert.ok(!result.content.includes('No Co-Authored-By'));
      assert.ok(!result.content.includes('TypeScript Node16'));
    });

    it('Tier C includes both working-rules and architecture', () => {
      const result = renderBrainclawSection(makeInput('openclaw', { state }));
      assert.ok(result.sectionsIncluded.includes('working-rules'));
      assert.ok(result.sectionsIncluded.includes('architecture'));
    });
  });

  describe('cross-tier consistency', () => {
    it('all tiers include header and protocol', () => {
      for (const agent of ['claude-code', 'roo', 'openclaw']) {
        const result = renderBrainclawSection(makeInput(agent));
        assert.ok(result.sectionsIncluded.includes('header'), `${agent} missing header`);
        assert.ok(result.sectionsIncluded.includes('protocol'), `${agent} missing protocol`);
      }
    });

    it('header includes brainclaw version', () => {
      const result = renderBrainclawSection(makeInput('roo', { brainclawVersion: '1.2.3' }));
      assert.ok(result.content.includes('v1.2.3'));
    });

    it('empty state produces no optional sections', () => {
      for (const agent of ['claude-code', 'roo', 'openclaw']) {
        const result = renderBrainclawSection(makeInput(agent));
        assert.ok(!result.sectionsIncluded.includes('working-rules'), `${agent} should not have working-rules`);
        assert.ok(!result.sectionsIncluded.includes('architecture'), `${agent} should not have architecture`);
        assert.ok(!result.sectionsIncluded.includes('instructions'), `${agent} should not have instructions`);
      }
    });
  });
});
