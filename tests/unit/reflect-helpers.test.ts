import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapEventTypeToCandidateType } from '../../src/commands/reflect.js';
import { suggestCandidateTypes } from '../../src/commands/reflect-runtime-note.js';

describe('reflect helpers', () => {
  it('suggests trap first for operational failure notes', () => {
    const suggestions = suggestCandidateTypes('Node is not on PATH on this host', ['windows', 'npm']);

    assert.equal(suggestions[0].type, 'trap');
    assert.ok(suggestions[0].score > suggestions[1].score);
    assert.ok(suggestions.some((item) => item.type === 'decision'));
    assert.ok(suggestions.some((item) => item.type === 'handoff'));
  });

  it('maps runtime events to candidate types', () => {
    assert.equal(mapEventTypeToCandidateType('risk_detected'), 'trap');
    assert.equal(mapEventTypeToCandidateType('handoff_requested'), 'handoff');
    assert.equal(mapEventTypeToCandidateType('task_started'), 'constraint');
    assert.equal(mapEventTypeToCandidateType('task_finished'), 'constraint');
    assert.equal(mapEventTypeToCandidateType('observation'), 'decision');
    assert.equal(mapEventTypeToCandidateType('unknown_event'), 'decision');
  });
});
