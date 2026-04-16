/**
 * Lightweight staleness detection for brainclaw memory entities.
 *
 * Staleness is a soft signal — items are warned, not auto-archived.
 * Users choose to dismiss, resolve, or archive via explicit commands.
 */

import type { Candidate, PlanItem, Trap } from './schema.js';
import type { Handoff } from './schema.js';
import { resolvedSource } from './candidates.js';

export type StalenessEntity = 'plan' | 'trap' | 'handoff' | 'candidate';

export interface StalenessWarning {
  /** Entity ID */
  id: string;
  entity: StalenessEntity;
  /** Short label or first 80 chars of text */
  text: string;
  /** Age in days relative to the reference time */
  age_days: number;
  /** Human-readable reason this item is flagged */
  reason: string;
  /** CLI command the user can run to resolve */
  suggested_action: string;
}

export interface StalenessReport {
  warnings: StalenessWarning[];
  plan_count: number;
  trap_count: number;
  handoff_count: number;
  candidate_count: number;
}

/** Thresholds in days. Adjust via config in the future. */
export const STALENESS_THRESHOLDS = {
  /** in_progress plan with no update in N days */
  plan_in_progress_days: 7,
  /** todo/blocked plan not started in N days */
  plan_idle_days: 30,
  /** open handoff older than N days */
  handoff_open_days: 14,
  /** pending candidate older than N days */
  candidate_pending_days: 21,
  /** auto-generated pending candidate older than N days */
  candidate_auto_pending_days: 30,
} as const;

function ageDays(isoDate: string, nowMs: number): number {
  return Math.floor((nowMs - Date.parse(isoDate)) / 86_400_000);
}

function truncate(text: string, max = 80): string {
  return text.length > max ? text.slice(0, max - 3) + '...' : text;
}

/**
 * Detect stale plans based on status and last-update age.
 * Returns one warning per stale plan.
 */
export function detectStalePlans(
  plans: PlanItem[],
  nowMs = Date.now(),
  thresholds = STALENESS_THRESHOLDS,
): StalenessWarning[] {
  const warnings: StalenessWarning[] = [];

  for (const plan of plans) {
    if (plan.status === 'done' || plan.status === 'dropped') continue;

    // Use most recent step update, fall back to plan updated_at, then created_at
    const lastActivity = getLastPlanActivity(plan);
    const age = ageDays(lastActivity, nowMs);

    if (plan.status === 'in_progress' && age >= thresholds.plan_in_progress_days) {
      warnings.push({
        id: plan.id,
        entity: 'plan',
        text: truncate(plan.text),
        age_days: age,
        reason: `Plan in_progress for ${age} day${age === 1 ? '' : 's'} without recent activity`,
        suggested_action: `brainclaw plan update ${plan.short_label ?? plan.id} --status done  # or --status dropped`,
      });
    } else if ((plan.status === 'todo' || plan.status === 'blocked') && age >= thresholds.plan_idle_days) {
      warnings.push({
        id: plan.id,
        entity: 'plan',
        text: truncate(plan.text),
        age_days: age,
        reason: `Plan ${plan.status} for ${age} day${age === 1 ? '' : 's'} without progress`,
        suggested_action: `brainclaw plan update ${plan.short_label ?? plan.id} --status in_progress  # or --status dropped`,
      });
    }
  }

  return warnings;
}

function getLastPlanActivity(plan: PlanItem): string {
  // If steps exist, find the most recently updated step
  if (plan.steps && plan.steps.length > 0) {
    const stepDates = plan.steps.map((s) => s.updated_at).filter(Boolean);
    if (stepDates.length > 0) {
      const latest = stepDates.reduce((a, b) => (a > b ? a : b));
      // Only use step date if it's more recent than plan.updated_at
      if (latest > plan.updated_at) return latest;
    }
  }
  return plan.updated_at;
}

/**
 * Detect traps that have passed their expiry date but are still marked active.
 */
export function detectExpiredTraps(
  traps: Trap[],
  nowIso = new Date().toISOString(),
  nowMs = Date.now(),
): StalenessWarning[] {
  const warnings: StalenessWarning[] = [];

  for (const trap of traps) {
    if (trap.status !== 'active') continue;
    if (!trap.expires_at || trap.expires_at > nowIso) continue;

    const age = ageDays(trap.expires_at, nowMs);
    warnings.push({
      id: trap.id,
      entity: 'trap',
      text: truncate(trap.text),
      age_days: age,
      reason: `Trap expired ${age} day${age === 1 ? '' : 's'} ago (expires_at: ${trap.expires_at.slice(0, 10)})`,
      suggested_action: `brainclaw trap resolve ${trap.short_label ?? trap.id}`,
    });
  }

  return warnings;
}

/**
 * Detect open handoffs that have not been acted on for a long time.
 */
export function detectStaleHandoffs(
  handoffs: Handoff[],
  nowMs = Date.now(),
  thresholds = STALENESS_THRESHOLDS,
): StalenessWarning[] {
  const warnings: StalenessWarning[] = [];

  for (const handoff of handoffs) {
    if (handoff.status !== 'open') continue;

    const age = ageDays(handoff.created_at, nowMs);
    if (age >= thresholds.handoff_open_days) {
      warnings.push({
        id: handoff.id,
        entity: 'handoff',
        text: truncate(handoff.text),
        age_days: age,
        reason: `Open handoff from ${handoff.from} → ${handoff.to} has been open for ${age} day${age === 1 ? '' : 's'}`,
        suggested_action: `brainclaw update-handoff ${handoff.short_label ?? handoff.id} --status closed  # or accept the handoff`,
      });
    }
  }

  return warnings;
}

/**
 * Detect candidates that have been pending without a decision for a long time.
 */
export function detectStaleCandidates(
  candidates: Candidate[],
  nowMs = Date.now(),
  thresholds = STALENESS_THRESHOLDS,
): StalenessWarning[] {
  const warnings: StalenessWarning[] = [];

  for (const candidate of candidates) {
    if (candidate.status !== 'pending') continue;

    const age = ageDays(candidate.created_at, nowMs);
    const source = resolvedSource(candidate);
    const threshold = source === 'auto'
      ? thresholds.candidate_auto_pending_days
      : thresholds.candidate_pending_days;
    if (age >= threshold) {
      const sourceLabel = source === 'auto' ? 'Auto-generated' : 'Pending';
      warnings.push({
        id: candidate.id,
        entity: 'candidate',
        text: truncate(candidate.text),
        age_days: age,
        reason: `${sourceLabel} ${candidate.type} candidate for ${age} day${age === 1 ? '' : 's'} — no accept/reject decision`,
        suggested_action: `brainclaw accept ${candidate.short_label ?? candidate.id}  # or: brainclaw reject ${candidate.short_label ?? candidate.id}`,
      });
    }
  }

  return warnings;
}

/**
 * Run all staleness detectors and return a combined report.
 * Warnings are sorted by age (oldest first) so the most urgent surface first.
 *
 * @param plans Active (non-done/non-dropped) plans
 * @param traps All known traps (active)
 * @param handoffs Open handoffs
 * @param candidates Pending candidates
 * @param nowMs Optional timestamp override (for testing)
 */
export function detectStaleness(
  plans: PlanItem[],
  traps: Trap[],
  handoffs: Handoff[],
  candidates: Candidate[],
  nowMs = Date.now(),
): StalenessReport {
  const nowIso = new Date(nowMs).toISOString();

  const planWarnings = detectStalePlans(plans, nowMs);
  const trapWarnings = detectExpiredTraps(traps, nowIso, nowMs);
  const handoffWarnings = detectStaleHandoffs(handoffs, nowMs);
  const candidateWarnings = detectStaleCandidates(candidates, nowMs);

  const warnings = [
    ...planWarnings,
    ...trapWarnings,
    ...handoffWarnings,
    ...candidateWarnings,
  ].sort((a, b) => b.age_days - a.age_days);

  return {
    warnings,
    plan_count: planWarnings.length,
    trap_count: trapWarnings.length,
    handoff_count: handoffWarnings.length,
    candidate_count: candidateWarnings.length,
  };
}

/** Total warning count across all entity types. */
export function staleSummary(report: StalenessReport): string {
  if (report.warnings.length === 0) return 'No stale items detected';

  const parts: string[] = [];
  if (report.plan_count > 0) parts.push(`${report.plan_count} plan${report.plan_count > 1 ? 's' : ''}`);
  if (report.trap_count > 0) parts.push(`${report.trap_count} expired trap${report.trap_count > 1 ? 's' : ''}`);
  if (report.handoff_count > 0) parts.push(`${report.handoff_count} open handoff${report.handoff_count > 1 ? 's' : ''}`);
  if (report.candidate_count > 0) parts.push(`${report.candidate_count} pending candidate${report.candidate_count > 1 ? 's' : ''}`);
  return parts.join(', ');
}
