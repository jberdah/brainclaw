import { execSync } from 'node:child_process';
import { memoryExists, memoryPath, withStoreLock, writeFileAtomic } from '../core/io.js';
import { listClaims, releaseClaim } from '../core/claims.js';
import { generateMarkdown } from '../core/markdown.js';
import { loadState, saveState } from '../core/state.js';

export interface ReleaseClaimsOptions {
  fromGitDiff?: boolean;
  ref1?: string;
  ref2?: string;
  cwd?: string;
}

function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function scopeMatchesFile(scope: string, file: string): boolean {
  const f = normPath(file);
  return scope.split(/\s+/).some((s) => {
    const sp = normPath(s).replace(/\/$/, '');
    return f === sp || f.startsWith(sp + '/');
  });
}

export function runReleaseClaims(options: ReleaseClaimsOptions = {}): void {
  if (!memoryExists(options.cwd)) {
    process.exit(0); // silent — called from git hook
  }

  let changedFiles: string[] = [];

  if (options.fromGitDiff) {
    const ref1 = options.ref1 ?? 'ORIG_HEAD';
    const ref2 = options.ref2 ?? 'HEAD';
    try {
      const output = execSync(`git diff --name-only ${ref1} ${ref2}`, { encoding: 'utf-8' });
      changedFiles = output.split('\n').map((f) => f.trim()).filter(Boolean);
    } catch {
      process.exit(0); // not in git or no diff — skip silently
    }
  }

  if (changedFiles.length === 0) process.exit(0);

  const claims = listClaims(options.cwd).filter((c) => c.status === 'active');
  const toRelease = claims.filter((c) =>
    changedFiles.some((f) => scopeMatchesFile(c.scope, f))
  );

  if (toRelease.length === 0) process.exit(0);

  let released = 0;

  withStoreLock(options.cwd, () => {
    let state = loadState(options.cwd);

    for (const claim of toRelease) {
      try {
        releaseClaim(claim.id, options.cwd);
        released++;
        if (claim.plan_id) {
          state = loadState(options.cwd);
          const plan = state.plan_items.find((p) => p.id === claim.plan_id);
          if (plan) {
            const remaining = listClaims(options.cwd).filter(
              (c) => c.status === 'active' && c.plan_id === claim.plan_id
            );
            if (remaining.length === 0 && plan.status === 'in_progress') {
              plan.status = 'todo';
              plan.updated_at = new Date().toISOString();
              saveState(state, options.cwd);
            }
          }
        }
        console.log(`✔ Auto-released claim [${claim.id}]: ${claim.scope}`);
      } catch { /* skip individual failures */ }
    }

    state = loadState(options.cwd);
    writeFileAtomic(memoryPath('project.md', options.cwd), generateMarkdown(state, options.cwd));
  });

  if (released > 0) {
    console.log(`brainclaw: ${released} claim(s) auto-released after merge.`);
  }
}
