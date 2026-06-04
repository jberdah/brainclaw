import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
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
  // pln#458: wording moved from bare "bclaw_coordinate(intent)" to a
  // parameterized decision tree ("bclaw_coordinate(intent=review|consult|assign)")
  // so agents know which intent fits which goal. Accept either form.
  assert.ok(/bclaw_coordinate\(intent/.test(content));
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

    it('includes a curated facade-first available tools section', () => {
      const result = renderBrainclawSection(makeInput('claude-code'));
      assert.ok(result.sectionsIncluded.includes('available-tools'), 'should include available-tools section');
      assert.ok(result.content.includes('## brainclaw — available tools'));
      // Tools actually rendered by renderAvailableTools() in v1.0 — the post-cut
      // canonical grammar plus the retained session/plan/inbox/notes/setup
      // helpers and the escalation facades. Legacy names (bclaw_list_plans,
      // bclaw_accept, bclaw_get_context, bclaw_dispatch_review) are present
      // only inside the retirement sentence and are still substring-findable.
      const toolNames = [
        'bclaw_work',
        'bclaw_context',
        'bclaw_find',
        'bclaw_get',
        'bclaw_create',
        'bclaw_update',
        'bclaw_remove',
        'bclaw_transition',
        'bclaw_coordinate',
        'bclaw_dispatch',
        'bclaw_loop',
        'bclaw_session_start',
        'bclaw_session_end',
        'bclaw_claim',
        'bclaw_release_claim',
        'bclaw_add_step',
        'bclaw_complete_step',
        'bclaw_update_step',
        'bclaw_delete_step',
        'bclaw_list_sequences',
        'bclaw_create_sequence',
        'bclaw_update_sequence',
        'bclaw_delete_sequence',
        'bclaw_read_inbox',
        'bclaw_ack_message',
        'bclaw_send_message',
        'bclaw_correct_handoff',
        'bclaw_write_note',
        'bclaw_quick_capture',
        'bclaw_search',
        'bclaw_bootstrap',
        'bclaw_release_notes',
        'bclaw_switch',
        'bclaw_setup',
      ];
      for (const tool of toolNames) {
        assert.ok(result.content.includes(tool), `available tools should mention ${tool}`);
      }
      assert.ok(result.content.includes('Item shape: `{ planId, stepId?, rank'));
      assert.ok(result.content.includes('bclaw_dispatch(intent=analysis)'));
      assert.ok(!result.content.includes('57 tools are available via MCP'));
    });

    it('renderLiveSection returns undefined for tier A', () => {
      const live = renderLiveSection(makeInput('claude-code'));
      assert.equal(live, undefined, 'Tier A should not have a live companion');
    });
  });

  describe('hook-capable agents keep lightweight stable instructions', () => {
    for (const agent of ['cursor', 'windsurf', 'cline', 'codex', 'github-copilot']) {
      it(`${agent} is now tier A`, () => {
        const result = renderBrainclawSection(makeInput(agent));
        assert.equal(result.tier, 'A', `${agent} should be tier A`);
        assert.ok(!result.sectionsIncluded.includes('traps'), `${agent} tier A should not have static traps`);
        assert.ok(!result.sectionsIncluded.includes('working-rules'), `${agent} tier A should not have working rules`);
      });
    }
  });

  describe('live companions for hook-capable parity agents', () => {
    for (const agent of ['cursor', 'windsurf', 'cline', 'github-copilot']) {
      it(`${agent} gets a Tier B-shaped live companion`, () => {
        const state = makeState({
          known_traps: [{ id: 'trp_1', text: 'Trap', severity: 'high', visibility: 'shared', tags: [], created_at: '', created_by: '' }] as any,
          plan_items: [{ id: 'pln_1', text: 'Plan', status: 'todo', tags: [], created_at: '', created_by: '' }] as any,
          open_handoffs: [{ id: 'hnd_1', from: 'alice', to: 'bob', text: 'Review auth flow', status: 'open', tags: [], created_at: '', author: 'alice' }] as any,
        });
        const live = renderLiveSection(makeInput(agent, { state }));
        assert.ok(live, `${agent} should get a live companion`);
        assert.equal(live!.tier, 'B');
        assert.ok(live!.sectionsIncluded.includes('handoffs'));
        assert.ok(live!.content.includes('Review auth flow'));
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

    it('live companion includes traps, plans, and open handoffs; excludes machine-visibility', () => {
      const state = makeState({
        known_traps: [
          { id: 'trp_1', text: 'Flaky test', severity: 'high', visibility: 'shared', tags: [], created_at: '', created_by: '' },
          { id: 'trp_2', text: 'Machine-only', severity: 'medium', visibility: 'machine', tags: [], created_at: '', created_by: '' },
        ] as any,
        plan_items: [{ id: 'pln_1', text: 'Plan', status: 'todo', tags: [], created_at: '', created_by: '' }] as any,
        open_handoffs: [{ id: 'hnd_1', from: 'alice', to: 'bob', text: 'Review auth flow', status: 'open', tags: [], created_at: '', author: 'alice' }] as any,
      });
      const live = renderLiveSection(makeInput('roo', { state }));
      assert.ok(live, 'Tier B should have a live companion');
      assert.ok(live!.content.includes('Flaky test'));
      assert.ok(!live!.content.includes('Machine-only'));
      assert.ok(live!.sectionsIncluded.includes('plans'));
      assert.ok(live!.sectionsIncluded.includes('handoffs'));
      assert.ok(live!.content.includes('Review auth flow'));
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

  describe('user workflow', () => {
    it('is included on all tiers', () => {
      for (const agent of ['claude-code', 'roo', 'openclaw']) {
        const result = renderBrainclawSection(makeInput(agent));
        assert.ok(
          result.sectionsIncluded.includes('user-workflow'),
          `${agent} missing user-workflow section`,
        );
        assert.ok(result.content.includes('## brainclaw — user workflow'));
      }
    });

    it('describes the canonical flow keywords', () => {
      const result = renderBrainclawSection(makeInput('claude-code'));
      for (const keyword of [
        'ideation',
        'plan',
        'sequence',
        'claim',
        'implement',
        'release claim',
        'review',
        'merge',
      ]) {
        assert.ok(
          result.content.includes(keyword),
          `user workflow should mention "${keyword}"`,
        );
      }
    });

    it('maps core entities to their role in the flow', () => {
      const result = renderBrainclawSection(makeInput('claude-code'));
      for (const entity of ['plan', 'step', 'sequence', 'claim', 'handoff', 'candidate']) {
        assert.ok(
          result.content.includes(`\`${entity}\``),
          `entity cheatsheet should mention \`${entity}\``,
        );
      }
    });

    it('marks Review & Fix Loop as implemented and other loops as planned', () => {
      const result = renderBrainclawSection(makeInput('claude-code'));
      assert.ok(result.content.includes('Review & Fix Loop'));
      // pln#458: the section now describes the loop as the multi-turn
      // delegation pattern and points at the right entry tool instead of
      // flagging it with an italic "*implemented*" marker. Assert the
      // operative content (entry tool + drive tool + anti-pattern) is
      // present — that's the semantic contract for agents.
      assert.ok(
        result.content.includes('bclaw_coordinate(intent=review, open_loop=true'),
        'Review & Fix Loop must name bclaw_coordinate(intent=review, open_loop=true) as the start entry',
      );
      assert.ok(
        /bclaw_loop\(intent=turn\|complete_turn\|advance\|close\)/.test(result.content),
        'Review & Fix Loop must point at bclaw_loop for driving turns',
      );
      assert.ok(
        /Ideation.*planned/i.test(result.content),
        'Ideation loop must be marked planned',
      );
    });

    it('escalation path is goal-oriented (pln#458) — no bare bclaw_loop(intent=open) recommendation', () => {
      const result = renderBrainclawSection(makeInput('claude-code')).content;
      // Anti-pattern: an agent should never be told to call bclaw_loop(intent=open)
      // directly — that opens a loop structure without dispatch, so no reviewer
      // ever picks up the work. The surface must either not mention this form
      // or explicitly flag it as an anti-pattern.
      const mentionsOpenIntent = /bclaw_loop\(intent=open\)/.test(result);
      if (mentionsOpenIntent) {
        assert.match(
          result,
          /anti-pattern|do not call.*bclaw_loop\(intent=open\)|NOT.*bclaw_loop\(intent=open\)/i,
          'If bclaw_loop(intent=open) is mentioned, it must be flagged as an anti-pattern',
        );
      }
      // The goal-tree must mention the three entry tools by goal
      assert.match(result, /bclaw_coordinate\(intent=review\|consult\|assign\)|bclaw_coordinate\(intent=(review|consult|assign)/, 'escalation path must route review/consult/assign → bclaw_coordinate');
      assert.match(result, /bclaw_dispatch\(intent=execute\)/, 'escalation path must route sequence-lane execute → bclaw_dispatch(intent=execute)');
      assert.match(result, /bclaw_loop\(intent=turn/, 'escalation path must route "drive your turn" → bclaw_loop(intent=turn|…)');
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

  describe('pln#458 — MCP bclaw_dispatch description warns against misuse for new reviews', () => {
    // Source-level check on src/commands/mcp.ts: the `bclaw_dispatch` tool
    // description must tell agents this intent routes EXISTING reviewable
    // handoffs, not opens new reviews — otherwise agents repeat my mistake of
    // calling `bclaw_dispatch(intent=review)` and getting 0 targets when they
    // really wanted `bclaw_coordinate(intent=review, open_loop=true)`.
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const mcpSrc = fs.readFileSync(
      path.resolve(thisDir, '../../../src/commands/mcp.ts'),
      'utf-8',
    );

    it('description for bclaw_dispatch references bclaw_coordinate as the entry for new reviews', () => {
      const match = mcpSrc.match(/name: 'bclaw_dispatch',\s*description: '([^']+)'/);
      assert.ok(match, 'bclaw_dispatch tool definition not found');
      const description = match![1];
      assert.match(description, /NOT for opening new reviews|not for opening new reviews/i, 'description must flag that dispatch(intent=review) is NOT for opening new reviews');
      assert.match(description, /bclaw_coordinate/, 'description must point agents at bclaw_coordinate');
    });
  });
});
