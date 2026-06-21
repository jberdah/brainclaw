import { memoryExists } from '../core/io.js';
import { loadState } from '../core/state.js';
import { listCandidates } from '../core/candidates.js';
import { listRuntimeNotes } from '../core/runtime.js';
import { listClaims } from '../core/claims.js';
import { readAuditLog } from '../core/audit.js';
import { loadConfig } from '../core/config.js';

export interface MetricsOptions {
  json?: boolean;
  since?: string;
}

interface MetricsReport {
  snapshot_at: string;
  memory: {
    constraints_active: number;
    decisions_total: number;
    traps_total: number;
    plans_total: number;
    plans_in_progress: number;
    plans_done: number;
    handoffs_open: number;
  };
  reflective: {
    candidates_pending: number;
    candidates_accepted: number;
    candidates_rejected: number;
    oldest_pending_hours: number;
  };
  runtime: {
    notes_total: number;
    notes_shared: number;
    claims_active: number;
  };
  audit: {
    total_events: number;
    events_by_action: Record<string, number>;
    top_actors: Array<{ actor: string; count: number }>;
  };
  health: {
    score: number;
    issues: string[];
  };
}

export function runMetrics(options: MetricsOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const config = loadConfig();
  const slaHours = config.governance?.review_sla_hours ?? 24;
  const report = buildMetricsReport(slaHours, options.since);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Memory Health Dashboard — ${report.snapshot_at}`);
  console.log('');
  console.log('═ Memory');
  console.log(`  Constraints active:  ${report.memory.constraints_active}`);
  console.log(`  Decisions:           ${report.memory.decisions_total}`);
  console.log(`  Traps:               ${report.memory.traps_total}`);
  console.log(`  Plans:               ${report.memory.plans_total} (${report.memory.plans_in_progress} in-progress, ${report.memory.plans_done} done)`);
  console.log(`  Handoffs open:       ${report.memory.handoffs_open}`);
  console.log('');
  console.log('═ Reflective Memory');
  console.log(`  Pending candidates:  ${report.reflective.candidates_pending}`);
  console.log(`  Accepted:            ${report.reflective.candidates_accepted}`);
  console.log(`  Rejected:            ${report.reflective.candidates_rejected}`);
  if (report.reflective.oldest_pending_hours > 0) {
    console.log(`  Oldest pending:      ${report.reflective.oldest_pending_hours}h`);
  }
  console.log('');
  console.log('═ Runtime');
  console.log(`  Notes:               ${report.runtime.notes_total} (${report.runtime.notes_shared} shared)`);
  console.log(`  Active claims:       ${report.runtime.claims_active}`);
  console.log('');
  if (report.audit.total_events > 0) {
    console.log('═ Audit Log');
    console.log(`  Events:              ${report.audit.total_events}`);
    const byAction = Object.entries(report.audit.events_by_action)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    for (const [action, count] of byAction) {
      console.log(`    ${action}: ${count}`);
    }
    const topActors = report.audit.top_actors.slice(0, 3);
    if (topActors.length > 0) {
      console.log(`  Top actors:          ${topActors.map(a => `${a.actor}(${a.count})`).join(', ')}`);
    }
    console.log('');
  }
  console.log('═ Health');
  console.log(`  Score:               ${report.health.score}/100`);
  if (report.health.issues.length === 0) {
    console.log(`  Status:              ✔ No issues detected`);
  } else {
    for (const issue of report.health.issues) {
      console.log(`  ⚠ ${issue}`);
    }
  }
}

function buildMetricsReport(slaHours: number, since?: string): MetricsReport {
  const now = new Date();
  const snapshotAt = now.toISOString();

  let state;
  try { state = loadState(); } catch { state = null; }

  let candidates: ReturnType<typeof listCandidates> = [];
  try { candidates = listCandidates(); } catch { /* empty */ }

  let notes: ReturnType<typeof listRuntimeNotes> = [];
  try { notes = listRuntimeNotes(); } catch { /* empty */ }

  let claims: ReturnType<typeof listClaims> = [];
  try { claims = listClaims(); } catch { /* empty */ }

  let auditEntries: ReturnType<typeof readAuditLog> = [];
  try {
    auditEntries = readAuditLog(since ? { since } : {});
  } catch { /* empty */ }

  // Memory metrics
  const memory = {
    constraints_active: state?.active_constraints.filter(c => c.status === 'active').length ?? 0,
    decisions_total: state?.recent_decisions.length ?? 0,
    traps_total: state?.known_traps.length ?? 0,
    plans_total: state?.plan_items.length ?? 0,
    plans_in_progress: state?.plan_items.filter(p => p.status === 'in_progress').length ?? 0,
    plans_done: state?.plan_items.filter(p => p.status === 'done').length ?? 0,
    handoffs_open: state?.open_handoffs.filter(h => h.status === 'open').length ?? 0,
  };

  // Reflective memory metrics
  const pending = candidates.filter(c => c.status === 'pending');
  const accepted = candidates.filter(c => c.status === 'accepted');
  const rejected = candidates.filter(c => c.status === 'rejected');
  let oldestPendingHours = 0;
  if (pending.length > 0) {
    const oldestMs = Math.min(...pending.map(c => Date.parse(c.created_at)));
    oldestPendingHours = Math.floor((now.getTime() - oldestMs) / (1000 * 60 * 60));
  }

  // Runtime metrics
  const runtime = {
    notes_total: notes.length,
    notes_shared: notes.filter(n => n.visibility === 'shared').length,
    claims_active: claims.filter(c => c.status === 'active').length,
  };

  // Audit metrics
  const eventsByAction: Record<string, number> = {};
  const actorCounts: Record<string, number> = {};
  for (const entry of auditEntries) {
    eventsByAction[entry.action] = (eventsByAction[entry.action] ?? 0) + 1;
    actorCounts[entry.actor] = (actorCounts[entry.actor] ?? 0) + 1;
  }
  const topActors = Object.entries(actorCounts)
    .map(([actor, count]) => ({ actor, count }))
    .sort((a, b) => b.count - a.count);

  // Health score
  const issues: string[] = [];
  let score = 100;

  if (memory.handoffs_open > 5) { score -= 5; issues.push(`${memory.handoffs_open} open handoffs`); }
  if (pending.length > 20) { score -= 10; issues.push(`${pending.length} pending candidates backlog`); }
  if (oldestPendingHours > slaHours * 2) { score -= 10; issues.push(`oldest pending candidate: ${oldestPendingHours}h (SLA: ${slaHours}h)`); }
  if (runtime.claims_active > 10) { score -= 5; issues.push(`${runtime.claims_active} active claims — possible stale locks`); }
  if (memory.constraints_active === 0 && memory.decisions_total === 0) { score -= 5; issues.push('no constraints or decisions recorded yet'); }
  score = Math.max(0, score);

  return {
    snapshot_at: snapshotAt,
    memory,
    reflective: {
      candidates_pending: pending.length,
      candidates_accepted: accepted.length,
      candidates_rejected: rejected.length,
      oldest_pending_hours: oldestPendingHours,
    },
    runtime,
    audit: {
      total_events: auditEntries.length,
      events_by_action: eventsByAction,
      top_actors: topActors,
    },
    health: { score, issues },
  };
}
