import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { listIdeationRounds } from './ideation.js';

export interface PlanGenerationResult {
  plans: Array<{ id: string; text: string }>;
  skipped: string[];
}

export function generatePlansFromConvergence(threadSlug: string, cwd?: string): PlanGenerationResult {
  const root = cwd ?? process.cwd();
  const rounds = listIdeationRounds(threadSlug, root);
  const lastRound = rounds[rounds.length - 1];
  if (!lastRound?.convergences.length) {
    return { plans: [], skipped: [] };
  }

  const plans: Array<{ id: string; text: string }> = [];
  const skipped: string[] = [];
  for (const text of lastRound.convergences) {
    try {
      const out = execFileSync(
        'node',
        [path.join(root, 'dist/cli.js'), 'plan', 'create', text, '--tag', 'codev', 'auto-generated', '--type', 'feat'],
        { cwd: root, encoding: 'utf-8' }
      );
      const id = /\[(pln_[^\]]+)\]/.exec(out)?.[1];
      if (!id) {
        skipped.push(text);
        continue;
      }
      plans.push({ id, text });
    } catch {
      skipped.push(text);
    }
  }

  return { plans, skipped };
}

export function generateSummaryNote(threadSlug: string, result: PlanGenerationResult, cwd?: string): void {
  const root = cwd ?? process.cwd();
  const ids = result.plans.map((p) => p.id).join(', ') || 'none';
  const note = `CoDev session ${threadSlug} generated ${result.plans.length} plan(s): ${ids}. Skipped: ${result.skipped.length}.`;
  execFileSync('node', [path.join(root, 'dist/cli.js'), 'note', note], { cwd: root, encoding: 'utf-8' });
}
