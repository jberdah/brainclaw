import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { searchCorpus, type SearchCorpusDocument } from '../../src/core/search.js';

function corpus(): SearchCorpusDocument[] {
  return [
    {
      id: 'dec_auth',
      section: 'decisions',
      text: 'OAuth migration now goes through auth gateway',
      author: 'alice',
      created_at: '2026-03-15T10:00:00Z',
      tags: ['auth'],
      related_paths: ['src/auth/gateway.ts'],
    },
    {
      id: 'trp_auth',
      section: 'traps',
      text: 'Auth refresh token flow is flaky on Windows',
      author: 'bob',
      created_at: '2026-03-15T09:00:00Z',
      tags: ['auth', 'windows'],
      related_paths: ['src/auth'],
    },
    {
      id: 'pln_payments',
      section: 'plans',
      text: 'Coordinate payments freeze rollout',
      author: 'carol',
      created_at: '2026-03-14T12:00:00Z',
      tags: ['payments'],
      related_paths: ['src/payments'],
    },
  ];
}

describe('core/search', () => {
  it('ranks relevant documents ahead of weaker matches', () => {
    const results = searchCorpus(corpus(), { query: 'auth gateway', maxResults: 5 });
    assert.ok(results.length >= 2);
    assert.equal(results[0].id, 'dec_auth');
    assert.ok(results[0].score >= results[1].score);
  });

  it('returns recent documents when the query is empty', () => {
    const results = searchCorpus(corpus(), { query: '', maxResults: 2 });
    assert.equal(results.length, 2);
    assert.equal(results[0].id, 'dec_auth');
    assert.equal(results[1].id, 'trp_auth');
    assert.equal(results[0].score, 0);
  });

  it('applies section, tag and since filters', () => {
    const results = searchCorpus(corpus(), {
      query: 'auth',
      section: 'traps',
      tags: ['windows'],
      since: '2026-03-15T00:00:00Z',
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'trp_auth');
  });

  it('returns no result when no document contains the query terms', () => {
    const results = searchCorpus(corpus(), { query: 'graphql' });
    assert.deepEqual(results, []);
  });
});
