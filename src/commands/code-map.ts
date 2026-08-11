/**
 * `brainclaw code-map <subcommand>` — CLI surface over the Code Map backend
 * (spec §9). Mirrors plan-resource.ts: a switch over the subcommand delegating
 * to a JsonlBackend (status | refresh | find | brief | impact | export | outline). The backend owns
 * query logic; this file only adapts it to argv + stdout (text or --json), and
 * every output carries the freshness_badge.
 */
import { JsonlBackend } from '../core/code-map/backend.js';
import type { CodeBrief, CodeExportResult, CodeFindResult, CodeImpactResult, CodeOutlineResult, CodeRefreshResult, CodeStatus } from '../core/code-map/backend.js';
import type { FreshnessBadge } from '../core/code-map/types.js';
import type { CodeGraphDirection, CodeGraphFormat, CodeGraphTargetKind } from '../core/code-map/export.js';

interface CodeMapOptions {
  json?: boolean;
  all?: boolean;
  changed?: boolean;
  limit?: number;
  /** Maximum graph depth for impact (1 = direct only; transitives require 2+). */
  depth?: number;
  /** Subgraph export traversal direction. */
  direction?: CodeGraphDirection;
  /** Subgraph export projection format. */
  format?: CodeGraphFormat;
  /** Strict subgraph export caps (also bounded by library hard caps). */
  maxNodes?: number;
  maxEdges?: number;
  minConfidence?: number;
  targetKind?: CodeGraphTargetKind;
  cwd?: string;
  /** Multi-project cascade for refresh/status (DGX Finding 2). */
  cascade?: boolean;
}

const KNOWN_SUBCOMMANDS = new Set(['status', 'refresh', 'find', 'brief', 'impact', 'export', 'outline']);

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
  return `Freshness: ${badge.freshness}${detail}`;
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

  if (normalized === 'impact') {
    const target = args.join(' ').trim();
    if (!target) {
      console.error('Error: code-map impact requires <symbol-or-path>.');
      console.error('  Usage: brainclaw code-map impact <symbol-or-path> [--depth 2]');
      process.exit(1);
    }
    const result = await be.impact({ target, depth: options.depth, limit: options.limit, cwd });
    printImpact(result, options);
    return;
  }

  if (normalized === 'export') {
    const target = args.join(' ').trim();
    if (!target) {
      console.error('Error: code-map export requires <symbol-or-path>.');
      console.error('  Usage: brainclaw code-map export <symbol-or-path> [--direction both] [--depth 1] [--max-nodes 100] [--max-edges 200]');
      process.exit(1);
    }
    const result = await be.exportGraph({
      target,
      targetKind: options.targetKind,
      direction: options.direction,
      depth: options.depth,
      maxNodes: options.maxNodes,
      maxEdges: options.maxEdges,
      minConfidence: options.minConfidence,
      format: options.format,
      cwd,
    });
    printExport(result, options);
    return;
  }

  if (normalized === 'outline') {
    const target = args.join(' ').trim();
    if (!target) {
      console.error('Error: code-map outline requires <file>.');
      console.error('  Usage: brainclaw code-map outline <file>');
      process.exit(1);
    }
    const result = await be.outline({ path: target, limit: options.limit, cwd });
    printOutline(result, options);
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

function printImpact(result: CodeImpactResult, options: CodeMapOptions): void {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const cause = (row: { causes: Array<{ kind: string; module?: string; source_line?: number | null }> }): string =>
    row.causes.map((item) => `${item.kind}${item.module ? ` ${item.module}` : ''}${item.source_line ? `:${item.source_line}` : ''}`).join(', ');
  console.log(`Code Map impact: "${result.target}"`);
  console.log(`  ${badgeLine(result.freshness_badge)}`);
  console.log(`  Definition: ${result.definition.entries.length} (${result.definition.match_kind})`);
  for (const entry of result.definition.entries) console.log(`    ${entry.name} — ${entry.path}`);
  console.log(`  Direct dependents: ${result.direct_dependents.length}${result.limits.direct_truncated ? '+' : ''}`);
  for (const dependent of result.direct_dependents) console.log(`    ${dependent.path} — ${cause(dependent)}`);
  if (result.limits.max_depth > 1) {
    console.log(`  Transitive dependents: ${result.transitive_dependents.length}${result.limits.transitive_truncated ? '+' : ''}`);
    for (const dependent of result.transitive_dependents) console.log(`    [depth ${dependent.depth}] ${dependent.path} — ${cause(dependent)}`);
  }
  console.log(`  Tests: ${result.risk.counters.resolved_test_files} resolved, ${result.risk.counters.suggested_test_files} naming suggestion(s)`);
  for (const test of result.tests_for) console.log(`    [${test.relation}, confidence=${test.confidence}] ${test.path} — ${test.reason}`);
  console.log(`  Risk: ${result.risk.score} (${result.risk.formula}; direct=${result.risk.counters.direct_dependents}, transitive=${result.risk.counters.transitive_dependents})`);
}

function printExport(result: CodeExportResult, options: CodeMapOptions): void {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Code Map export: "${result.target}" (${result.target_kind})`);
  console.log(`  ${badgeLine(result.freshness_badge)}`);
  console.log(`  Roots: ${result.root_node_ids.length}; nodes=${result.nodes.length}/${result.limits.max_nodes}; edges=${result.edges.length}/${result.limits.max_edges}; depth=${result.limits.max_depth}; direction=${result.limits.direction}; min-confidence=${result.limits.min_confidence}`);
  const truncation = Object.entries(result.truncated).filter(([, value]) => value).map(([key]) => key);
  if (truncation.length > 0) console.log(`  Truncated: ${truncation.join(', ')}`);
  if (result.format === 'mermaid' && result.mermaid) {
    console.log(result.mermaid);
    return;
  }
  for (const edge of result.edges) {
    const source = edge.source ? ` @ ${edge.source.path}${edge.source.line === null || edge.source.line === undefined ? '' : `:${edge.source.line}`}` : '';
    console.log(`  ${edge.from} -[${edge.kind}, confidence=${edge.confidence}${source}]-> ${edge.to}`);
  }
}

function printOutline(result: CodeOutlineResult, options: CodeMapOptions): void {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Code Map outline: "${result.path}"`);
  console.log(`  Index:    ${result.index_status}`);
  console.log(`  ${badgeLine(result.freshness_badge)}`);
  if (!result.file_indexed) {
    console.log('  Symbols:  (file not indexed)');
    return;
  }
  console.log(`  Parse:    ${result.parse_status}`);
  if (result.symbols.length === 0) {
    console.log('  Symbols:  (none)');
  } else {
    for (const symbol of result.symbols) {
      const subtype = symbol.subtype ? ` ${symbol.subtype}` : '';
      const span = symbol.span ? `${symbol.span.start_line}:${symbol.span.start_col}` : 'unknown';
      const exported = symbol.exported ? ' export' : '';
      console.log(`  [${span}] ${symbol.kind}${subtype} ${symbol.name}${exported} confidence=${symbol.confidence}`);
    }
  }
  if (result.truncated) console.log(`  … ${result.symbol_count - result.symbols.length} more indexed symbol(s)`);
  if (result.diagnostics.length > 0) {
    console.log(`  Diagnostics: ${result.diagnostics.length}${result.diagnostics_truncated ? '+' : ''}`);
  }
}
