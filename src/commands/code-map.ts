/**
 * `brainclaw code-map <subcommand>` — CLI surface over the Code Map backend
 * (spec §9). Mirrors plan-resource.ts: a switch over the subcommand delegating
 * to a JsonlBackend (status | refresh | find | brief). The backend owns all
 * query logic; this file only adapts it to argv + stdout (text or --json), and
 * every output carries the freshness_badge.
 */
import { JsonlBackend } from '../core/code-map/backend.js';
import type { CodeBrief, CodeFindResult, CodeRefreshResult, CodeStatus } from '../core/code-map/backend.js';
import type { FreshnessBadge } from '../core/code-map/types.js';

interface CodeMapOptions {
  json?: boolean;
  all?: boolean;
  changed?: boolean;
  limit?: number;
  cwd?: string;
  /** Multi-project cascade for refresh/status (DGX Finding 2). */
  cascade?: boolean;
}

const KNOWN_SUBCOMMANDS = new Set(['status', 'refresh', 'find', 'brief']);

function backend(): JsonlBackend {
  return new JsonlBackend();
}

function badgeLine(badge: FreshnessBadge): string {
  const detailKeys = Object.keys(badge.details ?? {}).filter(
    (k) => (badge.details as Record<string, unknown>)[k] !== null && (badge.details as Record<string, unknown>)[k] !== undefined,
  );
  const detail = detailKeys.length
    ? ` (${detailKeys.map((k) => `${k}=${JSON.stringify((badge.details as Record<string, unknown>)[k])}`).join(', ')})`
    : '';
  // pln#601 — lead with the coarse rollup (uniform across all read surfaces), then
  // the precise status + details. `coarse` may be absent on legacy/hand-built badges.
  const coarse = badge.coarse ? `${badge.coarse} · ` : '';
  return `Freshness: ${coarse}${badge.status}${detail}`;
}

export async function runCodeMap(
  subcommand: string,
  args: string[],
  options: CodeMapOptions = {},
): Promise<void> {
  const normalized = (subcommand ?? '').trim().toLowerCase();
  const be = backend();
  const cwd = options.cwd;

  if (normalized === 'status') {
    const status = await be.status({ cwd, cascade: options.cascade });
    printStatus(status, options);
    return;
  }

  if (normalized === 'refresh') {
    const scope: 'all' | 'changed' = options.all ? 'all' : 'changed';
    const result = await be.refresh({ scope, cwd, cascade: options.cascade });
    printRefresh(result, options);
    return;
  }

  if (normalized === 'find') {
    const query = args.join(' ').trim();
    if (!query) {
      console.error('Error: code-map find requires <query>.');
      console.error('  Usage: brainclaw code-map find <query>');
      process.exit(1);
    }
    const result = await be.find({ query, limit: options.limit, cwd });
    printFind(result, options);
    return;
  }

  if (normalized === 'brief') {
    const target = args.join(' ').trim();
    if (!target) {
      console.error('Error: code-map brief requires <symbol-or-path>.');
      console.error('  Usage: brainclaw code-map brief <symbol-or-path>');
      process.exit(1);
    }
    const result = await be.brief({ target, limit: options.limit, cwd });
    printBrief(result, options);
    return;
  }

  console.error(`Error: unknown code-map subcommand "${subcommand}".`);
  console.error(`  Available: ${[...KNOWN_SUBCOMMANDS].join(', ')}`);
  process.exit(1);
}

function printStatus(status: CodeStatus, options: CodeMapOptions): void {
  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log('Code Map status');
  console.log(`  Store:    ${status.store_exists ? 'present' : 'absent'}`);
  console.log(`  ${badgeLine(status.freshness_badge)}`);
  if (status.stats) {
    console.log(`  Files:    ${status.stats.files_indexed}`);
    console.log(`  Nodes:    ${status.stats.nodes}`);
    console.log(`  Edges:    ${status.stats.edges}`);
  } else {
    console.log('  Stats:    (none — index not built)');
  }
  if (status.cascade) {
    console.log(`  Workspace: ${status.cascade.indexed_children}/${status.cascade.total_children} child project(s) indexed`);
    for (const child of status.cascade.children) {
      const files = child.files_indexed === null ? '' : ` (${child.files_indexed} files)`;
      console.log(`    [${child.freshness}] ${child.path}${files}`);
    }
  }
}

function printRefresh(result: CodeRefreshResult, options: CodeMapOptions): void {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Code Map refresh [${result.scope}]`);
  console.log(`  Ran:      ${result.ran}`);
  console.log(`  Lock:     ${result.lock_acquired ? 'acquired' : 'not acquired'}`);
  if (result.lock_status) console.log(`  Status:   ${result.lock_status}`);
  console.log(`  ${badgeLine(result.freshness_badge)}`);
  if (result.cascade) {
    const c = result.cascade;
    console.log(`  Cascade:  ${c.children_refreshed} child project(s) + root (scoped)`);
    console.log(`    [root] . — ${c.root_result.files_parsed} files parsed`);
    for (const child of c.children) {
      console.log(`    ${child.path} — ${child.files_parsed} files parsed (${child.freshness})`);
    }
  }
}

function printFind(result: CodeFindResult, options: CodeMapOptions): void {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Code Map find: "${result.query}"`);
  console.log(`  ${badgeLine(result.freshness_badge)}`);
  if (result.matches.length === 0) {
    console.log('  (no matches)');
    return;
  }
  for (const m of result.matches) {
    const sub = m.subtype ? ` ${m.subtype}` : '';
    console.log(`  [${m.score.toFixed(1)}] ${m.name}${sub} — ${m.path}`);
  }
}

function printBrief(result: CodeBrief, options: CodeMapOptions): void {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Code Map brief: "${result.target}"`);
  console.log(`  ${badgeLine(result.freshness_badge)}`);
  if (result.suggested_files_to_read.length === 0) {
    console.log('  Suggested files: (none)');
  } else {
    console.log('  Suggested files to read:');
    for (const f of result.suggested_files_to_read) {
      console.log(`    [${f.score.toFixed(1)}] ${f.path} — ${f.reason}`);
    }
  }
  if (result.related_memory.length > 0) {
    console.log('  Related memory:');
    for (const mem of result.related_memory) {
      console.log(`    ${mem.id} (${mem.kind}): ${mem.text.slice(0, 80)}`);
    }
  }
}
