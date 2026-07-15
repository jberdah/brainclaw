/**
 * Dependency-direction guard (pln#622 PR1).
 *
 * Parses the static relative imports of every src/**\/*.ts file (regex on
 * `from '...'` — covers `import ... from` and `export ... from`) and asserts:
 *   (a) no import cycle passes through commands/mcp.ts (the assembly point);
 *   (b) the extracted boundary modules never import commands/mcp.js;
 *   (c) no src/core/** module imports ../commands/mcp*.js at any depth.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Compiled test lives at dist-test/tests/unit/ → repo root is 3 levels up.
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SRC = path.join(REPO_ROOT, 'src');

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** file (abs .ts path) → set of abs .ts paths it statically imports (relative specifiers only). */
function buildGraph(): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const file of listTsFiles(SRC)) {
    const deps = new Set<string>();
    const source = fs.readFileSync(file, 'utf-8');
    // Matches both `from '...'` clauses and bare side-effect imports
    // (`import '...'`) — checkpoint-2 review: a side-effect import is still a
    // dependency edge and must not slip past the graph.
    for (const match of source.matchAll(/(?:from|import)\s+['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), match[1]!.replace(/\.js$/, '.ts'));
      if (fs.existsSync(target)) deps.add(target);
    }
    graph.set(file, deps);
  }
  return graph;
}

const graph = buildGraph();
const MCP = path.join(SRC, 'commands', 'mcp.ts');

function reachable(from: Set<string>): Set<string> {
  const seen = new Set<string>(from);
  const stack = [...from];
  while (stack.length > 0) {
    for (const dep of graph.get(stack.pop()!) ?? []) {
      if (!seen.has(dep)) { seen.add(dep); stack.push(dep); }
    }
  }
  return seen;
}

describe('MCP dependency direction (pln#622 PR1)', () => {
  it('(a) no import cycle passes through commands/mcp.ts', () => {
    assert.ok(graph.has(MCP), `graph is missing ${MCP}`);
    assert.ok(
      !reachable(graph.get(MCP)!).has(MCP),
      'commands/mcp.ts is reachable from its own dependencies — an import cycle passes through the assembly point',
    );
  });

  it('(b) extracted boundary modules do not import commands/mcp.js', () => {
    for (const name of ['mcp-read-handlers.ts', 'mcp-contract.ts', 'mcp-presentation.ts', 'mcp-catalog.ts']) {
      const file = path.join(SRC, 'commands', name);
      assert.ok(graph.has(file), `graph is missing ${file}`);
      assert.ok(!graph.get(file)!.has(MCP), `${name} imports commands/mcp.js — the assembly point must stay import-free from boundary modules`);
    }
  });

  it('(c) src/core/** does not import ../commands/mcp*.js', () => {
    const offenders: string[] = [];
    for (const [file, deps] of graph) {
      if (!file.startsWith(path.join(SRC, 'core') + path.sep)) continue;
      for (const dep of deps) {
        if (path.dirname(dep) === path.join(SRC, 'commands') && path.basename(dep).startsWith('mcp')) {
          offenders.push(`${path.relative(REPO_ROOT, file)} → ${path.relative(REPO_ROOT, dep)}`);
        }
      }
    }
    assert.deepEqual(offenders, [], `core/ must not import the MCP command layer:\n${offenders.join('\n')}`);
  });
});
