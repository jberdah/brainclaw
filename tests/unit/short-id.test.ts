import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getNextShortLabel, generateIdWithLabel } from '../../src/core/ids.js';
import { generateCandidateIdWithLabel, resolveIdOrAlias, saveCandidate } from '../../src/core/candidates.js';
import { createTestWorkspace } from '../helpers/workspace.js';
import type { TestWorkspace } from '../helpers/workspace.js';
import type { Candidate } from '../../src/core/schema.js';
import { nowISO } from '../../src/core/ids.js';

function makeCandidate(id: string, short_label: string, author = 'testuser'): Candidate {
  return {
    id,
    short_label,
    type: 'decision',
    text: 'Some test decision text',
    created_at: nowISO(),
    author,
    tags: [],
    status: 'pending',
    star_count: 0,
    starred_by: [],
    usage_count: 0,
    usage_events: [],
  };
}

describe('core/ids — getNextShortLabel', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-short-id-' });
  });

  it('returns prefix#1 on first call', () => {
    const label = getNextShortLabel('dec', workspace.dir);
    assert.equal(label, 'dec#1');
  });

  it('increments on successive calls', () => {
    const l1 = getNextShortLabel('dec', workspace.dir);
    const l2 = getNextShortLabel('dec', workspace.dir);
    const l3 = getNextShortLabel('dec', workspace.dir);
    assert.equal(l1, 'dec#1');
    assert.equal(l2, 'dec#2');
    assert.equal(l3, 'dec#3');
  });

  it('tracks prefixes independently', () => {
    const dec1 = getNextShortLabel('dec', workspace.dir);
    const cst1 = getNextShortLabel('cst', workspace.dir);
    const dec2 = getNextShortLabel('dec', workspace.dir);
    assert.equal(dec1, 'dec#1');
    assert.equal(cst1, 'cst#1');
    assert.equal(dec2, 'dec#2');
  });

  it('persists counter across calls', () => {
    for (let i = 0; i < 5; i++) {
      getNextShortLabel('trp', workspace.dir);
    }
    const next = getNextShortLabel('trp', workspace.dir);
    assert.equal(next, 'trp#6');
  });
});

describe('core/ids — generateIdWithLabel', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-id-label-' });
  });

  it('returns id in hex format with correct prefix', () => {
    const { id, short_label } = generateIdWithLabel('recent_decisions', workspace.dir);
    assert.match(id, /^dec_[a-f0-9]{8}$/);
    assert.equal(short_label, 'dec#1');
  });

  it('id and short_label use the same type prefix', () => {
    const { id, short_label } = generateIdWithLabel('active_constraints', workspace.dir);
    assert.match(id, /^cst_/);
    assert.match(short_label, /^cst#/);
  });

  it('generates unique IDs for successive calls', () => {
    const r1 = generateIdWithLabel('plan_items', workspace.dir);
    const r2 = generateIdWithLabel('plan_items', workspace.dir);
    assert.notEqual(r1.id, r2.id);
    assert.equal(r1.short_label, 'pln#1');
    assert.equal(r2.short_label, 'pln#2');
  });
});

describe('core/candidates — generateCandidateIdWithLabel', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-cand-label-' });
  });

  it('returns cnd_ id and cnd#N short_label', () => {
    const { id, short_label } = generateCandidateIdWithLabel(workspace.dir);
    assert.match(id, /^cnd_[a-f0-9]{8}$/);
    assert.equal(short_label, 'cnd#1');
  });

  it('increments short_label on successive calls', () => {
    const r1 = generateCandidateIdWithLabel(workspace.dir);
    const r2 = generateCandidateIdWithLabel(workspace.dir);
    assert.equal(r1.short_label, 'cnd#1');
    assert.equal(r2.short_label, 'cnd#2');
    assert.notEqual(r1.id, r2.id);
  });
});

describe('core/candidates — resolveIdOrAlias', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-resolve-' });
  });

  it('returns hash ID unchanged when input is already a hash', () => {
    const id = 'cnd_aabbccdd';
    assert.equal(resolveIdOrAlias(id, workspace.dir), id);
  });

  it('returns non-alias string unchanged', () => {
    assert.equal(resolveIdOrAlias('some-random-string', workspace.dir), 'some-random-string');
  });

  it('resolves cnd#1 to the correct hash ID', () => {
    const { id, short_label } = generateCandidateIdWithLabel(workspace.dir);
    const candidate = makeCandidate(id, short_label);
    saveCandidate(candidate, workspace.dir);

    const resolved = resolveIdOrAlias('cnd#1', workspace.dir);
    assert.equal(resolved, id);
  });

  it('resolves correct candidate when multiple exist', () => {
    const r1 = generateCandidateIdWithLabel(workspace.dir);
    const r2 = generateCandidateIdWithLabel(workspace.dir);
    saveCandidate(makeCandidate(r1.id, r1.short_label), workspace.dir);
    saveCandidate(makeCandidate(r2.id, r2.short_label), workspace.dir);

    assert.equal(resolveIdOrAlias('cnd#1', workspace.dir), r1.id);
    assert.equal(resolveIdOrAlias('cnd#2', workspace.dir), r2.id);
  });

  it('throws when alias not found', () => {
    assert.throws(
      () => resolveIdOrAlias('cnd#99', workspace.dir),
      /No pending candidate found with alias/,
    );
  });
});
