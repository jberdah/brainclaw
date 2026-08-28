import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIdeationBrief,
  type BriefMemoryItem,
  type BriefMemoryProvider,
  type LoopArtifact,
  type LoopContextCategory,
  type LoopThread,
} from '../../src/core/loops/index.js';

/**
 * pln#492 phase 2.d.1 — pure-function tests for the critic brief
 * assembler. The dispatch wire-up is phase 2.d.2; here we only check
 * that the brief honours the phase's context_filter, includes the
 * proposal seed and prior loop artifacts, and respects the size cap.
 */

function makeThread(over: Partial<LoopThread> = {}): LoopThread {
  return {
    schema_version: 1,
    id: 'lop_brief123',
    version: 1,
    mutation_id: 'mut_1',
    kind: 'ideation',
    title: 'Should we ship feature X?',
    goal: 'Decide before sprint planning Friday',
    status: 'open',
    phases: [
      {
        name: 'proposal',
        context_filter: ['decisions', 'constraints', 'plans', 'project_vision'],
      },
      {
        name: 'critique',
        context_filter: ['traps', 'feedback', 'runtime_notes', 'critique_history'],
      },
      { name: 'revision', context_filter: ['*'] },
      { name: 'synthesis', context_filter: ['*'] },
    ],
    current_phase: 'critique',
    iteration_count: 0,
    open_questions: [],
    slots: [],
    artifacts: [
      {
        artifact_id: 'art_proposal',
        phase: 'proposal',
        type: 'proposal',
        body: 'Ship feature X next sprint, prioritising velocity over polish.',
        produced_at: '2026-05-06T12:00:00.000Z',
        iteration: 0,
      },
    ],
    created_at: '2026-05-06T12:00:00.000Z',
    updated_at: '2026-05-06T12:00:00.000Z',
    created_by: 'agt_test',
    ...over,
  };
}

function makeMemoryItem(category: LoopContextCategory, id: string, text: string): BriefMemoryItem {
  return { id, category, text };
}

class FakeMemoryProvider implements BriefMemoryProvider {
  public calls: Array<{ category: LoopContextCategory; query: string; topK: number }> = [];
  constructor(private readonly byCategory: Partial<Record<LoopContextCategory, BriefMemoryItem[]>>) {}
  fetch(category: LoopContextCategory, query: string, topK: number): BriefMemoryItem[] {
    this.calls.push({ category, query, topK });
    const items = this.byCategory[category] ?? [];
    return items.slice(0, topK);
  }
}

describe('buildIdeationBrief — header & proposal seed (pln#492 phase 2.d.1)', () => {
  it('header carries loop id, phase, iteration, slot, title, goal', () => {
    const thread = makeThread();
    const provider = new FakeMemoryProvider({});
    const result = buildIdeationBrief({ thread, slotRole: 'critic', memoryProvider: provider });
    assert.match(result.text, /loop: lop_brief123/);
    assert.match(result.text, /phase: critique/);
    assert.match(result.text, /iteration: 0/);
    assert.match(result.text, /slot: critic/);
    assert.match(result.text, /title: Should we ship feature X\?/);
    assert.match(result.text, /goal: Decide before sprint planning Friday/);
  });

  it('proposal seed text appears verbatim in the brief', () => {
    const thread = makeThread();
    const provider = new FakeMemoryProvider({});
    const result = buildIdeationBrief({ thread, slotRole: 'critic', memoryProvider: provider });
    assert.match(result.text, /Ship feature X next sprint, prioritising velocity over polish/);
  });

  it('falls back to a placeholder when no proposal artifact present', () => {
    const thread = makeThread({ artifacts: [] });
    const provider = new FakeMemoryProvider({});
    const result = buildIdeationBrief({ thread, slotRole: 'critic', memoryProvider: provider });
    assert.match(result.text, /no proposal seed found/);
  });

  it('requires critique findings to verify memory against concrete worktree evidence', () => {
    const thread = makeThread({ current_phase: 'critique' });
    const provider = new FakeMemoryProvider({
      traps: [makeMemoryItem('traps', 'trp_stale', 'A historical failure that may now be fixed')],
    });
    const result = buildIdeationBrief({ thread, slotRole: 'critic', memoryProvider: provider });

    assert.match(result.text, /investigation leads, never as proof/);
    assert.match(result.text, /Verify every finding .* against the worktree/);
    assert.match(result.text, /file path plus a line, symbol, assertion, or test\/command result/);
    assert.match(result.text, /unverified question instead of reporting it as a finding/);
  });
});

describe('buildIdeationBrief — context_filter honoured (pln#492 phase 2.d.1)', () => {
  it("critic phase fetches only adversarial categories (traps + feedback + runtime_notes)", () => {
    const thread = makeThread({ current_phase: 'critique' });
    const provider = new FakeMemoryProvider({
      traps: [makeMemoryItem('traps', 'trp_1', 'duplicate dispatch path')],
      feedback: [makeMemoryItem('feedback', 'fb_1', 'avoid premature abstraction')],
      runtime_notes: [makeMemoryItem('runtime_notes', 'rn_1', 'last release wedged on Friday')],
      decisions: [makeMemoryItem('decisions', 'dec_1', 'we use TypeScript')],
      project_vision: [makeMemoryItem('project_vision', 'pv_1', 'best multi-agent UX')],
    });

    buildIdeationBrief({ thread, slotRole: 'critic', memoryProvider: provider });

    const fetchedCategories = provider.calls.map((c) => c.category).sort();
    // The critic phase asks for traps + feedback + runtime_notes, plus the
    // loop-internal critique_history (handled internally, never sent to
    // the provider).
    assert.deepEqual(fetchedCategories, ['feedback', 'runtime_notes', 'traps']);
    // Positive-context categories MUST NOT be queried.
    assert.ok(!fetchedCategories.includes('decisions'), 'decisions leaked into critic brief');
    assert.ok(!fetchedCategories.includes('project_vision'), 'project_vision leaked into critic brief');
  });

  it("the '*' wildcard expands to every user-facing category (revision phase)", () => {
    const thread = makeThread({ current_phase: 'revision' });
    const provider = new FakeMemoryProvider({});
    buildIdeationBrief({ thread, slotRole: 'champion', memoryProvider: provider });
    const fetchedCategories = new Set(provider.calls.map((c) => c.category));
    // Every user-facing category requested. Loop-internal categories are
    // never sent to the provider.
    for (const cat of [
      'traps',
      'feedback',
      'runtime_notes',
      'decisions',
      'constraints',
      'handoffs',
      'plans',
      'candidates',
      'project_vision',
    ] as const) {
      assert.ok(fetchedCategories.has(cat), `wildcard should request "${cat}"`);
    }
    assert.ok(!fetchedCategories.has('critique_history'));
    assert.ok(!fetchedCategories.has('synthesis_artifact'));
  });

  it('falls back to wildcard when a phase has no context_filter', () => {
    const thread = makeThread({
      phases: [{ name: 'critique' }],
      current_phase: 'critique',
    });
    const provider = new FakeMemoryProvider({});
    buildIdeationBrief({ thread, slotRole: 'critic', memoryProvider: provider });
    // No filter declared → assembler should pull the wildcard set.
    const fetchedCategories = new Set(provider.calls.map((c) => c.category));
    assert.ok(fetchedCategories.has('decisions'), 'no-filter falls back to full bundle');
    assert.ok(fetchedCategories.has('traps'));
  });
});

describe('buildIdeationBrief — memory bundle rendering (pln#492 phase 2.d.1)', () => {
  it('keeps project-wide memory but excludes memories scoped to another implementation lane', () => {
    const thread = makeThread({ kind: 'implementation', phases: [{ name: 'execute', context_filter: ['traps'] }], current_phase: 'execute' });
    const provider = new FakeMemoryProvider({
      traps: [
        { ...makeMemoryItem('traps', 'trp_api', 'API trap'), relatedPaths: ['src/api'] },
        { ...makeMemoryItem('traps', 'trp_ui', 'UI trap'), relatedPaths: ['src/ui'] },
        makeMemoryItem('traps', 'trp_global', 'Project-wide trap'),
      ],
    });
    const result = buildIdeationBrief({
      thread, slotRole: 'implementer', memoryProvider: provider, seedText: 'Change API', scopeHints: ['src/api'],
    });
    assert.match(result.text, /# implementation_loop brief/);
    assert.match(result.text, /trp_api/);
    assert.match(result.text, /trp_global/);
    assert.ok(!result.text.includes('trp_ui'));
  });

  it('renders a per-category section with item ids and text', () => {
    const thread = makeThread({ current_phase: 'critique' });
    const provider = new FakeMemoryProvider({
      traps: [
        makeMemoryItem('traps', 'trp_alpha', 'trap alpha description'),
        makeMemoryItem('traps', 'trp_beta', 'trap beta description'),
      ],
      feedback: [makeMemoryItem('feedback', 'fb_x', 'feedback x advice')],
    });
    const result = buildIdeationBrief({ thread, slotRole: 'critic', memoryProvider: provider });

    assert.match(result.text, /### traps/);
    assert.match(result.text, /\[trp_alpha\] trap alpha description/);
    assert.match(result.text, /\[trp_beta\] trap beta description/);
    assert.match(result.text, /### feedback/);
    assert.match(result.text, /\[fb_x\] feedback x advice/);
    assert.equal(result.includedItems, 3);
    assert.equal(result.droppedItems, 0);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.categoriesUsed.sort(), ['feedback', 'traps']);
  });

  it('skips empty categories silently (no header for zero items)', () => {
    const thread = makeThread({ current_phase: 'critique' });
    const provider = new FakeMemoryProvider({
      traps: [makeMemoryItem('traps', 'trp_only', 'sole trap')],
      // feedback empty
      // runtime_notes empty
    });
    const result = buildIdeationBrief({ thread, slotRole: 'critic', memoryProvider: provider });
    assert.match(result.text, /### traps/);
    assert.ok(!result.text.includes('### feedback'), 'no header for empty category');
    assert.deepEqual(result.categoriesUsed, ['traps']);
  });
});

describe('buildIdeationBrief — prior loop artifacts (pln#492 phase 2.d.1)', () => {
  it('iteration > 0: includes prior critique artifacts when context_filter has critique_history', () => {
    const priorCritique: LoopArtifact = {
      artifact_id: 'art_crit_iter0',
      phase: 'critique',
      type: 'critique',
      body: 'Critique from a previous round about scope creep',
      produced_at: '2026-05-06T12:00:00.000Z',
      iteration: 0,
    };
    const thread = makeThread({
      current_phase: 'critique',
      iteration_count: 1,
      artifacts: [
        ...makeThread().artifacts,
        priorCritique,
      ],
    });
    const provider = new FakeMemoryProvider({});
    const result = buildIdeationBrief({ thread, slotRole: 'critic', memoryProvider: provider });
    assert.match(result.text, /## prior loop artifacts/);
    assert.match(result.text, /### critique_history \(conversation so far\)/);
    assert.match(result.text, /\[art_crit_iter0\]/);
    assert.match(result.text, /scope creep/);
  });

  it('includes the current iteration\'s earlier critiques so the next participant can challenge them', () => {
    const currentCritique: LoopArtifact = {
      artifact_id: 'art_crit_now',
      phase: 'critique',
      type: 'critique',
      body: 'Must appear: earlier contribution in the same round',
      produced_at: '2026-05-06T12:00:00.000Z',
      iteration: 1,
    };
    const thread = makeThread({
      current_phase: 'critique',
      iteration_count: 1,
      artifacts: [...makeThread().artifacts, currentCritique],
    });
    const provider = new FakeMemoryProvider({});
    const result = buildIdeationBrief({ thread, slotRole: 'critic', memoryProvider: provider });
    assert.match(result.text, /art_crit_now/);
    assert.match(result.text, /earlier contribution in the same round/);
  });

  it('iteration = 0: no prior loop artifacts block (nothing to include)', () => {
    const thread = makeThread({ current_phase: 'critique', iteration_count: 0 });
    const provider = new FakeMemoryProvider({});
    const result = buildIdeationBrief({ thread, slotRole: 'critic', memoryProvider: provider });
    assert.ok(
      !result.text.includes('## prior loop artifacts'),
      'iteration=0 should not render the prior artifacts header',
    );
  });
});

describe('buildIdeationBrief — size cap (pln#492 phase 2.d.1)', () => {
  it('truncates the memory bundle to fit maxChars and reports the truncation', () => {
    const thread = makeThread({ current_phase: 'critique' });
    const oneTrap = (i: number): BriefMemoryItem => ({
      id: `trp_${i}`,
      category: 'traps',
      text: 'x'.repeat(500),
    });
    const provider = new FakeMemoryProvider({
      traps: Array.from({ length: 50 }, (_, i) => oneTrap(i)),
    });
    const result = buildIdeationBrief({
      thread,
      slotRole: 'critic',
      memoryProvider: provider,
      maxChars: 2000,
      topKPerCategory: 50,
    });
    assert.equal(result.truncated, true);
    assert.ok(result.droppedItems > 0, 'some items should be dropped');
    assert.ok(result.text.length <= 2000 + 50, 'text length within budget tolerance');
    assert.match(result.text, /memory bundle truncated/);
  });

  it('stays well under the default 48 000 char budget for a normal-sized bundle', () => {
    const thread = makeThread({ current_phase: 'critique' });
    const provider = new FakeMemoryProvider({
      traps: [
        makeMemoryItem('traps', 'trp_1', 'trap 1'),
        makeMemoryItem('traps', 'trp_2', 'trap 2'),
      ],
      feedback: [makeMemoryItem('feedback', 'fb_1', 'feedback 1')],
    });
    const result = buildIdeationBrief({ thread, slotRole: 'critic', memoryProvider: provider });
    assert.equal(result.truncated, false);
    assert.ok(result.text.length < 48_000);
  });
});

describe('buildIdeationBrief — top-K is honoured (pln#492 phase 2.d.1)', () => {
  it('passes topKPerCategory to the provider', () => {
    const thread = makeThread({ current_phase: 'critique' });
    const provider = new FakeMemoryProvider({
      traps: Array.from({ length: 20 }, (_, i) => makeMemoryItem('traps', `trp_${i}`, `trap ${i}`)),
    });
    buildIdeationBrief({
      thread,
      slotRole: 'critic',
      memoryProvider: provider,
      topKPerCategory: 4,
    });
    const trapsCall = provider.calls.find((c) => c.category === 'traps');
    assert.ok(trapsCall, 'provider was queried for traps');
    assert.equal(trapsCall.topK, 4);
  });
});

describe('buildIdeationBrief — closing instructions (pln#492 phase 2.d.1)', () => {
  it('includes phase-specific instructions and references the slot role', () => {
    const thread = makeThread({ current_phase: 'critique' });
    const provider = new FakeMemoryProvider({});
    const result = buildIdeationBrief({ thread, slotRole: 'critic', memoryProvider: provider });
    assert.match(result.text, /## what to produce/);
    assert.match(result.text, /Phase "critique"/);
    assert.match(result.text, /role "critic"/);
    assert.match(result.text, /bclaw_loop intent='complete_turn' or 'add_artifact'/);
  });
});
