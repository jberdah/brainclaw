import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectStaleness,
  detectStalePlans,
  detectExpiredTraps,
  detectStaleHandoffs,
  detectStaleCandidates,
  staleSummary,
  STALENESS_THRESHOLDS,
} from '../../src/core/staleness.js';
import type { PlanItem, Trap, Handoff, Candidate } from '../../src/core/schema.js';

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString();
}

const basePlan: PlanItem = {
  id: 'pln_test',
  text: 'Test plan',
  created_at: daysAgo(10),
  updated_at: daysAgo(10),
  author: 'test-agent',
  status: 'in_progress',
  priority: 'medium',
  tags: [],
  depends_on: [],
};

const baseTrap: Trap = {
  id: 'trp_test',
  text: 'Test trap',
  created_at: daysAgo(20),
  author: 'test-agent',
  severity: 'medium',
  status: 'active',
  visibility: 'shared',
  tags: [],
};

const baseHandoff: Handoff = {
  id: 'hof_test',
  from: 'agent-a',
  to: 'agent-b',
  text: 'Test handoff',
  created_at: daysAgo(20),
  status: 'open',
  author: 'agent-a',
  tags: [],
};

const baseCandidate: Candidate = {
  id: 'cnd_test',
  type: 'decision',
  text: 'Test candidate',
  created_at: daysAgo(30),
  author: 'test-agent',
  status: 'pending',
  star_count: 0,
  starred_by: [],
  usage_count: 0,
  usage_events: [],
  tags: [],
};

describe('core/staleness', () => {
  describe('detectStalePlans', () => {
    it('returns no warnings for fresh in_progress plans', () => {
      const plan: PlanItem = { ...basePlan, updated_at: daysAgo(1) };
      assert.deepEqual(detectStalePlans([plan]), []);
    });

    it('warns on in_progress plan with no activity for threshold days', () => {
      const plan: PlanItem = {
        ...basePlan,
        status: 'in_progress',
        updated_at: daysAgo(STALENESS_THRESHOLDS.plan_in_progress_days + 1),
        created_at: daysAgo(STALENESS_THRESHOLDS.plan_in_progress_days + 1),
      };
      const warnings = detectStalePlans([plan]);
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0]!.entity, 'plan');
      assert.equal(warnings[0]!.id, 'pln_test');
      assert.ok(warnings[0]!.reason.includes('in_progress'));
      assert.ok(warnings[0]!.suggested_action.includes('brainclaw plan update'));
    });

    it('warns on todo plan idle for threshold days', () => {
      const plan: PlanItem = {
        ...basePlan,
        status: 'todo',
        updated_at: daysAgo(STALENESS_THRESHOLDS.plan_idle_days + 1),
        created_at: daysAgo(STALENESS_THRESHOLDS.plan_idle_days + 1),
      };
      const warnings = detectStalePlans([plan]);
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0]!.reason.includes('todo'));
    });

    it('skips done and dropped plans', () => {
      const done: PlanItem = { ...basePlan, status: 'done', updated_at: daysAgo(60) };
      const dropped: PlanItem = { ...basePlan, id: 'pln_2', status: 'dropped', updated_at: daysAgo(60) };
      assert.deepEqual(detectStalePlans([done, dropped]), []);
    });

    it('uses the most recent step updated_at for activity detection', () => {
      const plan: PlanItem = {
        ...basePlan,
        status: 'in_progress',
        updated_at: daysAgo(STALENESS_THRESHOLDS.plan_in_progress_days + 5),
        created_at: daysAgo(STALENESS_THRESHOLDS.plan_in_progress_days + 5),
        steps: [
          {
            id: 'stp_1',
            text: 'A step',
            status: 'in_progress',
            // Recently updated step — should suppress the stale warning
            created_at: daysAgo(2),
            updated_at: daysAgo(1),
          },
        ],
      };
      assert.deepEqual(detectStalePlans([plan]), []);
    });

    it('uses short_label in suggested_action when available', () => {
      const plan: PlanItem = {
        ...basePlan,
        short_label: 'pln#42',
        status: 'in_progress',
        updated_at: daysAgo(STALENESS_THRESHOLDS.plan_in_progress_days + 1),
        created_at: daysAgo(STALENESS_THRESHOLDS.plan_in_progress_days + 1),
      };
      const warnings = detectStalePlans([plan]);
      assert.ok(warnings[0]!.suggested_action.includes('pln#42'));
    });
  });

  describe('detectExpiredTraps', () => {
    it('returns no warnings for active traps with future expiry', () => {
      const trap: Trap = { ...baseTrap, expires_at: daysFromNow(5) };
      assert.deepEqual(detectExpiredTraps([trap]), []);
    });

    it('returns no warnings for traps without expires_at', () => {
      assert.deepEqual(detectExpiredTraps([baseTrap]), []);
    });

    it('warns on active trap with past expiry', () => {
      const trap: Trap = { ...baseTrap, expires_at: daysAgo(3) };
      const warnings = detectExpiredTraps([trap]);
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0]!.entity, 'trap');
      assert.ok(warnings[0]!.reason.includes('expired'));
      assert.ok(warnings[0]!.suggested_action.includes('brainclaw trap resolve'));
    });

    it('skips already-resolved traps', () => {
      const trap: Trap = { ...baseTrap, status: 'resolved', expires_at: daysAgo(3) };
      assert.deepEqual(detectExpiredTraps([trap]), []);
    });
  });

  describe('detectStaleHandoffs', () => {
    it('returns no warnings for recently created open handoffs', () => {
      const handoff: Handoff = { ...baseHandoff, created_at: daysAgo(1) };
      assert.deepEqual(detectStaleHandoffs([handoff]), []);
    });

    it('warns on open handoff older than threshold', () => {
      const handoff: Handoff = {
        ...baseHandoff,
        created_at: daysAgo(STALENESS_THRESHOLDS.handoff_open_days + 1),
      };
      const warnings = detectStaleHandoffs([handoff]);
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0]!.entity, 'handoff');
      assert.ok(warnings[0]!.reason.includes('open'));
      assert.ok(warnings[0]!.suggested_action.includes('brainclaw update-handoff'));
    });

    it('skips accepted and closed handoffs', () => {
      const accepted: Handoff = { ...baseHandoff, status: 'accepted', created_at: daysAgo(30) };
      const closed: Handoff = { ...baseHandoff, id: 'hof_2', status: 'closed', created_at: daysAgo(30) };
      assert.deepEqual(detectStaleHandoffs([accepted, closed]), []);
    });
  });

  describe('detectStaleCandidates', () => {
    it('returns no warnings for recently created pending candidates', () => {
      const c: Candidate = { ...baseCandidate, created_at: daysAgo(1) };
      assert.deepEqual(detectStaleCandidates([c]), []);
    });

    it('warns on pending candidate older than threshold', () => {
      const c: Candidate = {
        ...baseCandidate,
        created_at: daysAgo(STALENESS_THRESHOLDS.candidate_pending_days + 1),
      };
      const warnings = detectStaleCandidates([c]);
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0]!.entity, 'candidate');
      assert.ok(warnings[0]!.suggested_action.includes('brainclaw accept'));
    });

    it('uses a longer threshold for auto-generated candidates', () => {
      const autoCandidate: Candidate = {
        ...baseCandidate,
        id: 'cnd_auto',
        source: 'auto',
        created_at: daysAgo(STALENESS_THRESHOLDS.candidate_pending_days + 5),
      };
      assert.deepEqual(detectStaleCandidates([autoCandidate]), []);

      const staleAutoCandidate: Candidate = {
        ...autoCandidate,
        created_at: daysAgo(STALENESS_THRESHOLDS.candidate_auto_pending_days + 1),
      };
      const warnings = detectStaleCandidates([staleAutoCandidate]);
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0]!.reason.includes('Auto-generated'));
    });

    it('skips accepted and rejected candidates', () => {
      const accepted: Candidate = { ...baseCandidate, status: 'accepted', created_at: daysAgo(60) };
      const rejected: Candidate = { ...baseCandidate, id: 'cnd_2', status: 'rejected', created_at: daysAgo(60) };
      assert.deepEqual(detectStaleCandidates([accepted, rejected]), []);
    });
  });

  describe('detectStaleness (combined)', () => {
    it('returns empty report for clean memory', () => {
      const report = detectStaleness(
        [{ ...basePlan, status: 'in_progress', updated_at: daysAgo(1) }],
        [baseTrap], // no expires_at
        [{ ...baseHandoff, created_at: daysAgo(1) }],
        [{ ...baseCandidate, created_at: daysAgo(1) }],
      );
      assert.equal(report.warnings.length, 0);
      assert.equal(report.plan_count, 0);
      assert.equal(report.trap_count, 0);
      assert.equal(report.handoff_count, 0);
      assert.equal(report.candidate_count, 0);
    });

    it('aggregates all entity warnings and sorts by age descending', () => {
      const stalePlan: PlanItem = {
        ...basePlan,
        id: 'pln_stale',
        status: 'in_progress',
        updated_at: daysAgo(STALENESS_THRESHOLDS.plan_in_progress_days + 2),
        created_at: daysAgo(STALENESS_THRESHOLDS.plan_in_progress_days + 2),
      };
      const expiredTrap: Trap = {
        ...baseTrap,
        id: 'trp_expired',
        expires_at: daysAgo(5),
      };
      const staleHandoff: Handoff = {
        ...baseHandoff,
        id: 'hof_stale',
        created_at: daysAgo(STALENESS_THRESHOLDS.handoff_open_days + 1),
      };
      const staleCandidate: Candidate = {
        ...baseCandidate,
        id: 'cnd_stale',
        created_at: daysAgo(STALENESS_THRESHOLDS.candidate_pending_days + 1),
      };

      const report = detectStaleness([stalePlan], [expiredTrap], [staleHandoff], [staleCandidate]);
      assert.equal(report.plan_count, 1);
      assert.equal(report.trap_count, 1);
      assert.equal(report.handoff_count, 1);
      assert.equal(report.candidate_count, 1);
      assert.equal(report.warnings.length, 4);
      // Sorted by age descending — oldest first
      for (let i = 1; i < report.warnings.length; i++) {
        assert.ok(report.warnings[i - 1]!.age_days >= report.warnings[i]!.age_days);
      }
    });
  });

  describe('staleSummary', () => {
    it('returns "No stale items detected" for empty report', () => {
      const report = detectStaleness([], [], [], []);
      assert.equal(staleSummary(report), 'No stale items detected');
    });

    it('includes entity counts in summary string', () => {
      const stalePlan: PlanItem = {
        ...basePlan,
        id: 'pln_s',
        status: 'in_progress',
        updated_at: daysAgo(STALENESS_THRESHOLDS.plan_in_progress_days + 1),
        created_at: daysAgo(STALENESS_THRESHOLDS.plan_in_progress_days + 1),
      };
      const report = detectStaleness([stalePlan], [], [], []);
      const summary = staleSummary(report);
      assert.ok(summary.includes('plan'));
    });
  });
});
