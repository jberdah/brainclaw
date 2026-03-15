import { buildContextDiff, resolveContextDiffSince } from '../core/context-diff.js';
import { memoryExists } from '../core/io.js';

export interface ContextDiffOptions {
  since?: string;
  session?: string;
  json?: boolean;
  cwd?: string;
}

export function runContextDiff(options: ContextDiffOptions = {}): void {
  if (!memoryExists(options.cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const resolved = resolveContextDiffSince(options);
  if (!resolved.since) {
    if (options.session) {
      console.error(`Error: session '${options.session}' not found in session snapshots or audit log.`);
      process.exit(1);
    }
    console.error('Error: provide --since <ISO date> or --session <id>, or run `brainclaw context` first to seed a marker.');
    process.exit(1);
  }

  const diff = buildContextDiff({ ...options, includeItems: true });
  if (!diff) {
    console.error('Error: unable to build context diff.');
    process.exit(1);
  }

  if (options.json) {
    console.log(JSON.stringify(diff, null, 2));
    return;
  }

  if (diff.counts.total === 0) {
    console.log(`${diff.summary} since ${diff.since}.`);
    return;
  }

  console.log(`${diff.summary} since ${diff.since}.`);
}
