import { execSync } from 'node:child_process';
import { loadState } from '../core/state.js';
import { memoryExists } from '../core/io.js';

export interface CheckConstraintsOptions {
  staged?: boolean;
  files?: string[];
  json?: boolean;
}

/** Normalise a path to forward slashes and strip leading ./ */
function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Returns true if any staged file matches a related_path (prefix or exact). */
function pathMatches(stagedFile: string, relatedPath: string): boolean {
  const f = normPath(stagedFile);
  const r = normPath(relatedPath).replace(/\/$/, '');
  return f === r || f.startsWith(r + '/');
}

export interface ConstraintViolation {
  constraintId: string;
  constraintText: string;
  matchedFiles: string[];
}

export function runCheckConstraints(options: CheckConstraintsOptions = {}): void {
  if (!memoryExists()) {
    // Silent exit — hook context, not interactive
    process.exit(0);
  }

  let filesToCheck: string[] = options.files ?? [];

  if (options.staged) {
    try {
      const output = execSync('git diff --cached --name-only', { encoding: 'utf-8' });
      filesToCheck = output.split('\n').map((f) => f.trim()).filter(Boolean);
    } catch {
      // Not in a git repo or no staged files — silent pass
      process.exit(0);
    }
  }

  if (filesToCheck.length === 0) {
    process.exit(0);
  }

  const state = loadState();
  const violations: ConstraintViolation[] = [];

  for (const constraint of state.active_constraints) {
    if (!constraint.related_paths || constraint.related_paths.length === 0) continue;
    const matched = filesToCheck.filter((f) =>
      constraint.related_paths!.some((rp) => pathMatches(f, rp))
    );
    if (matched.length > 0) {
      violations.push({
        constraintId: constraint.id,
        constraintText: constraint.text,
        matchedFiles: matched,
      });
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ violations, staged_files: filesToCheck }, null, 2));
    process.exit(violations.length > 0 ? 1 : 0);
  }

  if (violations.length === 0) {
    process.exit(0);
  }

  process.stderr.write('\nbrainclaw: active constraint(s) cover staged files — commit blocked.\n\n');
  for (const v of violations) {
    process.stderr.write(`  ⚠  [${v.constraintId}] ${v.constraintText}\n`);
    process.stderr.write(`     Files: ${v.matchedFiles.join(', ')}\n\n`);
  }
  process.stderr.write('  Review constraints: brainclaw status\n');
  process.stderr.write('  To bypass (not recommended): git commit --no-verify\n\n');
  process.exit(1);
}
