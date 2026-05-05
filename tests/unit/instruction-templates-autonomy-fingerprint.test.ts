import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderBrainclawSection, type InstructionTemplateInput } from '../../src/core/instruction-templates.js';
import { getAgentCapabilityProfile } from '../../src/core/agent-capability.js';
import type { State } from '../../src/core/schema.js';

/**
 * Surface fingerprint for the brainclaw autonomy contract (pln#496 Phase 1).
 *
 * The contract was added because, in May 2026, multi-agent review threads
 * systematically stalled at protocol-defined transitions ("should I send
 * this reply?", "should I merge?", "should I release the claim?"). The
 * block in instruction-templates.ts is the canonical source the agent
 * surfaces lean on at session start. If a future refactor ever drops it
 * for any tier, agents revert to asking the human at every step and
 * brainclaw's orchestration promise breaks again.
 *
 * This fingerprint test asserts the canonical phrases survive across all
 * tiers (A / B / C) and across a representative set of agents. It is
 * intentionally redundant with `instruction-templates.test.ts` so a
 * future delete of the autonomy block fails this file with a focused,
 * obviously-named error rather than a vague section count mismatch
 * elsewhere.
 *
 * If you legitimately want to change the contract (e.g. add a new
 * MUST-execute transition), update both the renderer and the canonical
 * markers below in the same commit.
 */

function makeInput(agentName: string): InstructionTemplateInput {
  const profile = getAgentCapabilityProfile(agentName)!;
  const state: State = {
    version: 1,
    write_version: 1,
    active_constraints: [],
    recent_decisions: [],
    known_traps: [],
    open_handoffs: [],
    plan_items: [],
  };
  return {
    profile,
    state,
    projectName: 'test-project',
    brainclawVersion: '0.20.0',
    resolvedInstructions: [],
  };
}

const CANONICAL_MARKERS = [
  // The section header — drift here means a different section title leaked.
  '## brainclaw — autonomous workflow contract',
  // The thesis statement — drift here means the contract semantics changed.
  'execute it. Do not ask for permission.',
  // The five MUST-execute transitions, identified by their bclaw call so
  // adding parameters or rewording the prose still passes.
  'bclaw_send_message(type="reply"',
  'bclaw_release_claim(id=…',
  'bclaw_assignment_update(assignment_id=…',
  // The legitimate-pause clause — drift here means the carve-out semantics
  // were reordered or weakened.
  'destructive AND irreversible AND outside the',
  // The empirical justification — drift here means the lesson was lost.
  'multi-agent review',
] as const;

const REPRESENTATIVE_AGENTS = [
  'claude-code',     // tier A — primary canonical surface
  'codex',           // tier A — sandboxed CLI, also relies on AGENTS.md content
  'github-copilot',  // tier B — copilot-instructions.md
  'cursor',          // tier C — .cursor/rules/, IDE-only path
  'opencode',        // tier B — alt code-agent
  'mistral-vibe',    // tier B — recently added, regression target
];

describe('instruction-templates autonomy contract fingerprint (pln#496)', () => {
  for (const agentName of REPRESENTATIVE_AGENTS) {
    it(`${agentName} surface includes the autonomy contract block`, () => {
      const result = renderBrainclawSection(makeInput(agentName));

      assert.ok(
        result.sectionsIncluded.includes('autonomy-contract'),
        `${agentName}: 'autonomy-contract' missing from sectionsIncluded — the renderer skipped renderAutonomyContract() for this tier`,
      );

      for (const marker of CANONICAL_MARKERS) {
        assert.ok(
          result.content.includes(marker),
          `${agentName}: canonical autonomy marker missing from rendered content: ${JSON.stringify(marker)}`,
        );
      }
    });
  }

  it('contract appears AFTER the user-workflow section, not before', () => {
    // Ordering matters: the user-workflow section describes WHAT to do,
    // the autonomy contract describes HOW to execute it without asking.
    // Inverting the order makes the contract feel like a preface that
    // can be skimmed away; placing it after anchors it in the workflow.
    const result = renderBrainclawSection(makeInput('claude-code'));
    const userWorkflowIdx = result.content.indexOf('## brainclaw — user workflow');
    const contractIdx = result.content.indexOf('## brainclaw — autonomous workflow contract');
    assert.ok(userWorkflowIdx >= 0, 'user-workflow section should be present');
    assert.ok(contractIdx >= 0, 'autonomy-contract section should be present');
    assert.ok(
      contractIdx > userWorkflowIdx,
      `autonomy-contract (idx ${contractIdx}) must appear after user-workflow (idx ${userWorkflowIdx})`,
    );
  });
});
