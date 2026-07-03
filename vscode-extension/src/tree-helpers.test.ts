/**
 * Unit tests for the extension's pure tree helpers (pln#393 stp_92cd2775).
 *
 * These exercise candidate classification, staleness thresholds, freshness
 * classification, and time formatting. The functions have no vscode deps so
 * they run under plain `node --test` against the compiled output.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  FIND_MAX_PAGES,
  STALE_MS,
  agentFreshness,
  formatRelativeAge,
  isAutoCandidate,
  isStale,
  paginatedFind,
  timeAgo,
} from './tree-helpers';

function isoMinutesAgo(m: number): string {
  return new Date(Date.now() - m * 60_000).toISOString();
}
function isoHoursAgo(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString();
}
function isoDaysAgo(d: number): string {
  return new Date(Date.now() - d * 86_400_000).toISOString();
}

describe('tree-helpers — timeAgo', () => {
  it('returns "just now" for timestamps under a minute', () => {
    assert.equal(timeAgo(new Date().toISOString()), 'just now');
  });
  it('returns minute precision under an hour', () => {
    assert.equal(timeAgo(isoMinutesAgo(30)), '30m ago');
  });
  it('returns hour precision under a day', () => {
    assert.equal(timeAgo(isoHoursAgo(5)), '5h ago');
  });
  it('returns day precision beyond a day', () => {
    assert.equal(timeAgo(isoDaysAgo(3)), '3d ago');
  });
});

describe('tree-helpers — formatRelativeAge', () => {
  it('clamps future timestamps to 0m', () => {
    const future = new Date(Date.now() + 10_000).toISOString();
    assert.equal(formatRelativeAge(future), '0m');
  });
  it('uses "d ago" beyond 14 days', () => {
    assert.equal(formatRelativeAge(isoDaysAgo(30)), '30d ago');
  });
  it('uses "d" without suffix for 1–13 days', () => {
    assert.equal(formatRelativeAge(isoDaysAgo(5)), '5d');
  });
});

describe('tree-helpers — isStale', () => {
  it('returns false for undefined date', () => {
    assert.equal(isStale(undefined, STALE_MS.claim), false);
  });
  it('returns false when age is below threshold', () => {
    assert.equal(isStale(isoHoursAgo(1), STALE_MS.claim), false);
  });
  it('returns true when age exceeds threshold', () => {
    assert.equal(isStale(isoHoursAgo(5), STALE_MS.claim), true);
  });
  it('assignment threshold is 30 minutes', () => {
    assert.equal(isStale(isoMinutesAgo(31), STALE_MS.assignment), true);
    assert.equal(isStale(isoMinutesAgo(29), STALE_MS.assignment), false);
  });
});

describe('tree-helpers — agentFreshness', () => {
  // pln#559 step 5 — agentFreshness is now evidence-based: open sessions and
  // claim_count alone no longer force 'active'. A crashed worker with a
  // dangling claim must NOT show a green dot (2026-06-10 calibration).
  it('is "stale" when last_active is decades old, even with an open session', () => {
    assert.equal(
      agentFreshness({ has_open_session: true, last_active: isoDaysAgo(30) }),
      'stale',
    );
  });
  it('is "stale" when last_active is decades old, even with held claims (crashed worker pattern)', () => {
    assert.equal(
      agentFreshness({ claim_count: 2, last_active: isoDaysAgo(30) }),
      'stale',
    );
  });
  it('is "stale" when last_active is missing and no session/claims', () => {
    assert.equal(agentFreshness({}), 'stale');
  });
  it('is "stale" when last_active is missing even with an open session (no liveness evidence)', () => {
    assert.equal(agentFreshness({ has_open_session: true }), 'stale');
  });
  it('is "active" when last_active is under an hour old', () => {
    assert.equal(agentFreshness({ last_active: isoMinutesAgo(30) }), 'active');
  });
  it('is "idle" between 1h and 6h', () => {
    assert.equal(agentFreshness({ last_active: isoHoursAgo(3) }), 'idle');
  });
  it('is "stale" beyond 6h', () => {
    assert.equal(agentFreshness({ last_active: isoHoursAgo(12) }), 'stale');
  });
});

describe('tree-helpers — isAutoCandidate', () => {
  it('matches server-side source=auto (authoritative signal)', () => {
    assert.equal(isAutoCandidate({ source: 'auto' }), true);
  });
  it('does not match source=agent', () => {
    assert.equal(isAutoCandidate({ source: 'agent' }), false);
  });
  it('does not match source=human', () => {
    assert.equal(isAutoCandidate({ source: 'human' }), false);
  });
  it('falls back to legacy origin=session-end-* for candidates predating source', () => {
    assert.equal(isAutoCandidate({ origin: 'session-end-auto' }), true);
    assert.equal(isAutoCandidate({ origin: 'session-end' }), true);
  });
  it('returns false for candidates with no source and non-session-end origin', () => {
    assert.equal(isAutoCandidate({ origin: 'agent-handoff' }), false);
  });
  it('returns false for empty candidate (legacy default is human)', () => {
    assert.equal(isAutoCandidate({}), false);
  });
});

describe('tree-helpers — paginatedFind (trp#925)', () => {
  // The board tree used to make a single bclaw_find call and drop has_more,
  // so a size-bounded page (~40k chars) truncated the Backlog/Sprints/Live
  // sections silently — oldest-first plans hid the recent ones. paginatedFind
  // now walks has_more/next_offset with a hard MAX_PAGES safety cap.
  type Page = { items: unknown[]; has_more?: boolean; next_offset?: number };

  function mockClient(pages: Page[]): {
    client: { callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> };
    calls: Array<{ name: string; args: Record<string, unknown> }>;
  } {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const remaining = [...pages];
    return {
      calls,
      client: {
        async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
          calls.push({ name, args });
          const next = remaining.shift();
          if (!next) throw new Error(`unexpected extra callTool: ${name}`);
          return next as unknown as Record<string, unknown>;
        },
      },
    };
  }

  it('concatenates items across three pages while has_more=true', async () => {
    const { client, calls } = mockClient([
      { items: ['a', 'b'], has_more: true, next_offset: 2 },
      { items: ['c', 'd'], has_more: true, next_offset: 4 },
      { items: ['e'], has_more: false },
    ]);
    const out = await paginatedFind<string>(client, 'plan', { status: 'todo', limit: 50 });
    assert.deepEqual(out, ['a', 'b', 'c', 'd', 'e']);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].name, 'bclaw_find');
    // Initial call carries no offset; subsequent calls thread next_offset.
    assert.equal((calls[0].args.filter as Record<string, unknown>).offset, undefined);
    assert.equal((calls[1].args.filter as Record<string, unknown>).offset, 2);
    assert.equal((calls[2].args.filter as Record<string, unknown>).offset, 4);
    // Original filter fields must be preserved across pages.
    assert.equal((calls[2].args.filter as Record<string, unknown>).status, 'todo');
    assert.equal((calls[2].args.filter as Record<string, unknown>).limit, 50);
    assert.equal((calls[0].args as Record<string, unknown>).entity, 'plan');
  });

  it('stops after FIND_MAX_PAGES even when the server keeps advertising has_more', async () => {
    // Force one more page than MAX_PAGES to prove we never fetch it.
    const runaway: Page[] = Array.from({ length: FIND_MAX_PAGES + 3 }, (_, i) => ({
      items: [`p${i}`],
      has_more: true,
      next_offset: (i + 1) * 10,
    }));
    const { client, calls } = mockClient(runaway);
    const out = await paginatedFind<string>(client, 'plan');
    assert.equal(out.length, FIND_MAX_PAGES);
    assert.equal(calls.length, FIND_MAX_PAGES);
  });

  it('stops when has_more=true but next_offset is missing (defensive)', async () => {
    const { client, calls } = mockClient([
      { items: [1], has_more: true /* next_offset omitted — malformed server response */ },
    ]);
    const out = await paginatedFind<number>(client, 'plan');
    assert.deepEqual(out, [1]);
    assert.equal(calls.length, 1);
  });

  it('returns the single page unchanged when has_more=false', async () => {
    const { client, calls } = mockClient([
      { items: [{ id: 'pln#1' }, { id: 'pln#2' }], has_more: false },
    ]);
    const out = await paginatedFind<{ id: string }>(client, 'plan');
    assert.deepEqual(out.map((p) => p.id), ['pln#1', 'pln#2']);
    assert.equal(calls.length, 1);
  });
});
