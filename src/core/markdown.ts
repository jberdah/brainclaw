import type { State } from './schema.js';
import { listClaims } from './claims.js';
import { loadInstructions } from './instructions.js';

export function generateMarkdown(state: State, cwd?: string): string {
  const lines: string[] = ['# Project Memory', ''];
  const instructions = loadInstructions(cwd).filter((entry) => entry.active);
  const claims = listClaims(cwd).filter((claim) => claim.status === 'active');

  lines.push('## Shared instructions');
  if (instructions.length === 0) {
    lines.push('- (none)');
  } else {
    for (const entry of instructions) {
      const scope = entry.scope ? `:${entry.scope}` : '';
      const tags = entry.tags.length ? ` [${entry.tags.join(', ')}]` : '';
      lines.push(`- **[${entry.id}]** <${entry.layer}${scope}> ${entry.text}${tags}`);
    }
  }
  lines.push('');

  lines.push('## Active claims');
  if (claims.length === 0) {
    lines.push('- (none)');
  } else {
    for (const claim of claims) {
      const meta: string[] = [claim.scope];
      if (claim.plan_id) meta.push(`plan: ${claim.plan_id}`);
      if (claim.project) meta.push(`project: ${claim.project}`);
      lines.push(`- **[${claim.id}]** ${claim.agent} → ${claim.description} _(${meta.join(', ')})_`);
    }
  }
  lines.push('');

  lines.push('## Shared plan');
  const activePlans = state.plan_items.filter((plan) => plan.status !== 'done' && plan.status !== 'dropped');
  if (activePlans.length === 0) {
    lines.push('- (none)');
  } else {
    for (const plan of activePlans) {
      const meta: string[] = [plan.status, plan.priority];
      if (plan.assignee) meta.push(`assignee: ${plan.assignee}`);
      if (plan.project) meta.push(`project: ${plan.project}`);
      if (plan.steps && plan.steps.length > 0) {
        const done = plan.steps.filter((s) => s.status === 'done').length;
        meta.push(`${done}/${plan.steps.length} steps`);
      }
      const tags = plan.tags.length ? ` [${plan.tags.join(', ')}]` : '';
      const paths = plan.related_paths?.length ? ` → ${plan.related_paths.join(', ')}` : '';
      lines.push(`- **[${plan.id}]** ${plan.text} _(${meta.join(', ')})_${paths}${tags}`);
      if (plan.steps && plan.steps.length > 0) {
        for (const step of plan.steps) {
          const check = step.status === 'done' ? 'x' : ' ';
          const assign = step.assignee ? ` _(${step.assignee})_` : '';
          lines.push(`  - [${check}] [${step.id}] ${step.text}${assign}`);
        }
      }
    }
  }
  lines.push('');

  lines.push('## Active constraints');
  if (state.active_constraints.length === 0) {
    lines.push('- (none)');
  } else {
    for (const c of state.active_constraints) {
      const tags = c.tags.length ? ` [${c.tags.join(', ')}]` : '';
      const paths = c.related_paths?.length ? ` → ${c.related_paths.join(', ')}` : '';
      lines.push(`- **[${c.id}]** ${c.text} _(${c.status})_${paths}${tags}`);
    }
  }
  lines.push('');

  lines.push('## Recent decisions');
  if (state.recent_decisions.length === 0) {
    lines.push('- (none)');
  } else {
    for (const d of state.recent_decisions) {
      const tags = d.tags.length ? ` [${d.tags.join(', ')}]` : '';
      const paths = d.related_paths?.length ? ` → ${d.related_paths.join(', ')}` : '';
      lines.push(`- **[${d.id}]** ${d.text}${paths}${tags}`);
    }
  }
  lines.push('');

  lines.push('## Known traps');
  if (state.known_traps.length === 0) {
    lines.push('- (none)');
  } else {
    for (const t of state.known_traps) {
      const tags = t.tags.length ? ` [${t.tags.join(', ')}]` : '';
      const paths = t.related_paths?.length ? ` → ${t.related_paths.join(', ')}` : '';
      lines.push(`- **[${t.id}]** ${t.text} _(${t.severity})_${paths}${tags}`);
    }
  }
  lines.push('');

  lines.push('## Open handoffs');
  if (state.open_handoffs.length === 0) {
    lines.push('- (none)');
  } else {
    for (const h of state.open_handoffs) {
      const tags = h.tags.length ? ` [${h.tags.join(', ')}]` : '';
      const paths = h.related_paths?.length ? ` → ${h.related_paths.join(', ')}` : '';
      const meta: string[] = [h.status];
      if (h.plan_id) meta.push(`plan: ${h.plan_id}`);
      if (h.project) meta.push(`project: ${h.project}`);
      lines.push(`- **[${h.id}]** ${h.from} → ${h.to}: ${h.text} _(${meta.join(', ')})_${paths}${tags}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}
