/**
 * Governance posture report.
 *
 * Aggregates claims, constraints, traps, instructions, and audit entries
 * into a structured governance snapshot. No scores, no synthetic metrics —
 * only verifiable facts.
 *
 * @module
 */

import { listClaims, isClaimExpired } from './claims.js';
import { loadState } from './state.js';
import { loadInstructions, resolveInstructions } from './instructions.js';
import { readAuditLog, type AuditEntry } from './audit.js';
import type { Claim, Constraint, Trap, InstructionEntry } from './schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GovernanceReport {
  generated_at: string;
  scope_filter?: string;
  agent_filter?: string;

  constitution: {
    global_instructions: InstructionEntry[];
    total: number;
  };

  red_lines: {
    constraints_by_category: Record<string, Constraint[]>;
    high_severity_count: number;
    total: number;
  };

  claims: {
    active: ClaimSummary[];
    expired_unreleased: ClaimSummary[];
    by_agent: Record<string, number>;
    total_active: number;
    total_expired_unreleased: number;
  };

  traps: {
    open: TrapSummary[];
    by_severity: Record<string, number>;
    total_open: number;
  };

  recent_activity: {
    claims_last_24h: number;
    releases_last_24h: number;
    actions_without_claim: AuditEntry[];
  };

  recommendations: string[];
}

export interface ClaimSummary {
  id: string;
  agent: string;
  scope: string;
  description: string;
  created_at: string;
  expires_at?: string;
  plan_id?: string;
}

export interface TrapSummary {
  id: string;
  text: string;
  severity: string;
  related_paths?: string[];
}

export interface GovernanceReportOptions {
  scope?: string;
  agent?: string;
  since?: string;
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

export function buildGovernanceReport(options: GovernanceReportOptions = {}): GovernanceReport {
  const cwd = options.cwd;
  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  // --- Constitution (global instructions) ---
  const allInstructions = loadInstructions(cwd);
  const activeInstructions = resolveInstructions(allInstructions, {});
  const globalInstructions = activeInstructions.filter(i => i.layer === 'global');

  // --- Red Lines (constraints) ---
  const state = loadState(cwd);
  const activeConstraints = state.active_constraints.filter(c => c.status === 'active');
  const constraintsByCategory: Record<string, Constraint[]> = {};
  for (const c of activeConstraints) {
    const cat = c.category ?? 'other';
    (constraintsByCategory[cat] ??= []).push(c);
  }
  const highSeverityCount = activeConstraints.filter(c =>
    c.tags?.includes('high') || c.category === 'security'
  ).length;

  // --- Claims ---
  const allClaims = listClaims(cwd);
  const activeClaims = allClaims.filter(c => c.status === 'active' && !isClaimExpired(c));
  const expiredUnreleased = allClaims.filter(c => c.status === 'active' && isClaimExpired(c));

  const claimsByAgent: Record<string, number> = {};
  for (const c of activeClaims) {
    claimsByAgent[c.agent] = (claimsByAgent[c.agent] ?? 0) + 1;
  }

  // Apply filters
  let filteredActiveClaims = activeClaims;
  let filteredExpired = expiredUnreleased;
  if (options.agent) {
    const agentLower = options.agent.toLowerCase();
    filteredActiveClaims = activeClaims.filter(c =>
      c.agent.toLowerCase() === agentLower || c.agent_id?.toLowerCase() === agentLower
    );
    filteredExpired = expiredUnreleased.filter(c =>
      c.agent.toLowerCase() === agentLower || c.agent_id?.toLowerCase() === agentLower
    );
  }

  // --- Traps (shared visibility only — machine/private traps are environment-specific) ---
  const openTraps = state.known_traps.filter(t =>
    t.status === 'active' && (t.visibility === 'shared' || !t.visibility)
  );
  const trapsBySeverity: Record<string, number> = {};
  for (const t of openTraps) {
    trapsBySeverity[t.severity] = (trapsBySeverity[t.severity] ?? 0) + 1;
  }

  // --- Recent activity ---
  const recentEntries = readAuditLog({ since: last24h }, cwd);
  const claimsLast24h = recentEntries.filter(e => e.action === 'claim').length;
  const releasesLast24h = recentEntries.filter(e => e.action === 'release_claim').length;

  // Detect mutations without claim — check creates/updates that aren't claim/release/session actions
  const mutationActions = new Set(['create', 'update', 'delete', 'promote_direct']);
  const sessionTypes = new Set(['session', 'claim']);
  const actionsWithoutClaim = recentEntries.filter(e => {
    if (!mutationActions.has(e.action)) return false;
    if (sessionTypes.has(e.item_type ?? '')) return false;
    // Check if the actor had any active claim at that time
    const actorClaims = activeClaims.filter(c => c.agent === e.actor);
    return actorClaims.length === 0;
  });

  // --- Recommendations ---
  const recommendations: string[] = [];
  if (expiredUnreleased.length > 0) {
    recommendations.push(`${expiredUnreleased.length} expired claim(s) need release. Run: bclaw release-claims --expired`);
  }
  if (openTraps.length > 0) {
    const highTraps = openTraps.filter(t => t.severity === 'high');
    if (highTraps.length > 0) {
      recommendations.push(`${highTraps.length} high-severity trap(s) open. Review before editing related files.`);
    }
  }
  if (actionsWithoutClaim.length > 0) {
    recommendations.push(`${actionsWithoutClaim.length} mutation(s) detected without active claim in last 24h.`);
  }
  if (globalInstructions.length === 0) {
    recommendations.push('No global instructions set. Consider adding governance rules via: bclaw instruction add --layer global');
  }

  return {
    generated_at: now.toISOString(),
    scope_filter: options.scope,
    agent_filter: options.agent,
    constitution: {
      global_instructions: globalInstructions,
      total: globalInstructions.length,
    },
    red_lines: {
      constraints_by_category: constraintsByCategory,
      high_severity_count: highSeverityCount,
      total: activeConstraints.length,
    },
    claims: {
      active: filteredActiveClaims.map(toClaimSummary),
      expired_unreleased: filteredExpired.map(toClaimSummary),
      by_agent: claimsByAgent,
      total_active: filteredActiveClaims.length,
      total_expired_unreleased: filteredExpired.length,
    },
    traps: {
      open: openTraps.map(toTrapSummary),
      by_severity: trapsBySeverity,
      total_open: openTraps.length,
    },
    recent_activity: {
      claims_last_24h: claimsLast24h,
      releases_last_24h: releasesLast24h,
      actions_without_claim: actionsWithoutClaim,
    },
    recommendations,
  };
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

export function renderGovernanceMarkdown(report: GovernanceReport): string {
  const lines: string[] = [];
  const ts = report.generated_at.slice(0, 16).replace('T', ' ');

  lines.push(`# Governance Posture Report`);
  lines.push(`Generated: ${ts} UTC`);
  if (report.scope_filter) lines.push(`Scope: ${report.scope_filter}`);
  if (report.agent_filter) lines.push(`Agent: ${report.agent_filter}`);
  lines.push('');

  // --- Summary ---
  lines.push('## Summary');
  lines.push(`- Active claims: ${report.claims.total_active}`);
  lines.push(`- Expired (unreleased): ${report.claims.total_expired_unreleased}`);
  lines.push(`- Active constraints: ${report.red_lines.total}`);
  lines.push(`- Open traps: ${report.traps.total_open}`);
  lines.push(`- Global instructions: ${report.constitution.total}`);
  lines.push(`- Claims (24h): ${report.recent_activity.claims_last_24h} created, ${report.recent_activity.releases_last_24h} released`);
  if (report.recent_activity.actions_without_claim.length > 0) {
    lines.push(`- **Mutations without claim (24h): ${report.recent_activity.actions_without_claim.length}**`);
  }
  lines.push('');

  // --- Constitution ---
  if (report.constitution.total > 0) {
    lines.push('## Constitution (Global Instructions)');
    for (const ins of report.constitution.global_instructions) {
      lines.push(`- ${ins.text}`);
    }
    lines.push('');
  }

  // --- Red Lines ---
  if (report.red_lines.total > 0) {
    lines.push('## Red Lines (Active Constraints)');
    for (const [category, constraints] of Object.entries(report.red_lines.constraints_by_category)) {
      lines.push(`### ${category} (${constraints.length})`);
      for (const c of constraints) {
        const paths = c.related_paths?.length ? ` — ${c.related_paths.join(', ')}` : '';
        lines.push(`- [${c.id}] ${c.text}${paths}`);
      }
    }
    lines.push('');
  }

  // --- Claims ---
  if (report.claims.total_active > 0) {
    lines.push('## Active Claims');
    const agentEntries = Object.entries(report.claims.by_agent).sort((a, b) => b[1] - a[1]);
    if (agentEntries.length > 1) {
      lines.push(`By agent: ${agentEntries.map(([a, n]) => `${a} (${n})`).join(', ')}`);
      lines.push('');
    }
    for (const c of report.claims.active) {
      const planNote = c.plan_id ? ` [${c.plan_id}]` : '';
      const expiryNote = c.expires_at ? ` (expires ${c.expires_at.slice(0, 16).replace('T', ' ')})` : '';
      lines.push(`- [${c.id}] ${c.agent} → ${c.scope}: ${c.description}${planNote}${expiryNote}`);
    }
    lines.push('');
  }

  if (report.claims.total_expired_unreleased > 0) {
    lines.push('## Expired Claims (Need Release)');
    for (const c of report.claims.expired_unreleased) {
      lines.push(`- [${c.id}] ${c.agent} → ${c.scope}: ${c.description} (expired ${c.expires_at?.slice(0, 16).replace('T', ' ') ?? '?'})`);
    }
    lines.push('');
  }

  // --- Traps ---
  if (report.traps.total_open > 0) {
    lines.push('## Open Traps');
    const sevEntries = Object.entries(report.traps.by_severity);
    if (sevEntries.length > 0) {
      lines.push(`By severity: ${sevEntries.map(([s, n]) => `${s} (${n})`).join(', ')}`);
      lines.push('');
    }
    for (const t of report.traps.open) {
      const paths = t.related_paths?.length ? ` — ${t.related_paths.join(', ')}` : '';
      lines.push(`- [${t.id}] [${t.severity}] ${t.text}${paths}`);
    }
    lines.push('');
  }

  // --- Mutations without claim ---
  if (report.recent_activity.actions_without_claim.length > 0) {
    lines.push('## Mutations Without Claim (Last 24h)');
    for (const e of report.recent_activity.actions_without_claim.slice(0, 20)) {
      const scope = e.scope ? ` → ${e.scope}` : '';
      lines.push(`- ${e.timestamp.slice(0, 16).replace('T', ' ')} [${e.actor}] ${e.action} ${e.item_type ?? ''}${scope}`);
    }
    if (report.recent_activity.actions_without_claim.length > 20) {
      lines.push(`  ... and ${report.recent_activity.actions_without_claim.length - 20} more`);
    }
    lines.push('');
  }

  // --- Recommendations ---
  if (report.recommendations.length > 0) {
    lines.push('## Recommendations');
    for (const r of report.recommendations) {
      lines.push(`- ${r}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toClaimSummary(c: Claim): ClaimSummary {
  return {
    id: c.id,
    agent: c.agent,
    scope: c.scope,
    description: c.description,
    created_at: c.created_at,
    expires_at: c.expires_at,
    plan_id: c.plan_id,
  };
}

function toTrapSummary(t: Trap): TrapSummary {
  return {
    id: t.id,
    text: t.text,
    severity: t.severity,
    related_paths: t.related_paths,
  };
}
