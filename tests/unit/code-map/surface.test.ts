import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isolateAgentEnv } from '../../helpers/workspace.js';
import { refresh } from '../../../src/core/code-map/refresh.js';
import { JsonlBackend, OUTLINE_SYMBOL_CAP } from '../../../src/core/code-map/backend.js';
import { runCodeMap } from '../../../src/commands/code-map.js';
import { executeMcpToolCall } from '../../../src/commands/mcp.js';
import { codeMapWorkSection, codeMapRefreshNextActions, WORK_SECTION_MAX_WAIT_MS } from '../../../src/core/code-map/work-section.js';
import type { CodeMapWorkSection } from '../../../src/core/code-map/work-section.js';
import { readManifest, writeManifest } from '../../../src/core/code-map/store.js';
import { codeMapDir, lockPath } from '../../../src/core/code-map/paths.js';

const cleanupDirs: string[] = [];

// Isolate HOME + agent/BRAINCLAW_* env so the MCP resolution path (executeMcpToolCall
// → resolveEffectiveCwdInfo) cannot walk up to a real user-level ~/.brainclaw store.
// A stale global active-project there made these MCP tests environment-dependent —
// green on clean CI, but failing on a dev machine. Each test gets a fresh fake home.
let restoreEnv: (() => void) | undefined;
beforeEach(() => {
  restoreEnv = isolateAgentEnv().restore;
});
afterEach(() => {
  restoreEnv?.();
  restoreEnv = undefined;
});

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-codemap-surface-'));
  cleanupDirs.push(dir);
  return dir;
}

function writeSrc(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    fs.rmSync(cleanupDirs.pop() as string, { recursive: true, force: true });
  }
});

const PROJECT = 'prj_surface_test';

function fixture(root: string): void {
  writeSrc(
    root,
    'src/app/App.tsx',
    `import React from 'react';
export const App = () => <div>app</div>;
export default App;
`,
  );
  writeSrc(
    root,
    'src/hooks/useAuth.ts',
    `import { useState } from 'react';
export function useAuth() {
  const [user] = useState(null);
  return user;
}
`,
  );
}

async function refreshAll(root: string) {
  return refresh({ projectId: PROJECT, projectRoot: root, scope: 'all', cwd: root, disableGit: true });
}

/** Capture console.log output for a CLI invocation. */
async function captureCli(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.join('\n');
}

// ───────────────────────── CLI surface (runCodeMap) ─────────────────────────

describe('runCodeMap CLI surface', () => {
  it('status prints freshness + stats (text and --json carry the badge)', async () => {
    const root = tmpProject();
    fixture(root);
    await refreshAll(root);

    const text = await captureCli(() => runCodeMap('status', [], { cwd: root }));
    assert.match(text, /Freshness: fresh/);
    assert.match(text, /Files:\s+2/);

    const jsonOut = await captureCli(() => runCodeMap('status', [], { cwd: root, json: true }));
    const parsed = JSON.parse(jsonOut);
    assert.equal(parsed.store_exists, true);
    assert.equal(parsed.freshness_badge.status, 'fresh');
    assert.equal(parsed.stats.files_indexed, 2);
  });

  it('status on a missing store reports missing_index', async () => {
    const root = tmpProject();
    const jsonOut = await captureCli(() => runCodeMap('status', [], { cwd: root, json: true }));
    const parsed = JSON.parse(jsonOut);
    assert.equal(parsed.freshness_badge.status, 'missing_index');
    assert.equal(parsed.stats, null);
  });

  it('refresh --all returns a result with a freshness_badge', async () => {
    const root = tmpProject();
    fixture(root);
    // refresh needs an explicit project root; runCodeMap resolves it via cwd.
    const jsonOut = await captureCli(() => runCodeMap('refresh', [], { cwd: root, all: true, json: true }));
    const parsed = JSON.parse(jsonOut);
    assert.equal(parsed.scope, 'all');
    assert.ok(parsed.freshness_badge, 'freshness_badge present');
    assert.equal(typeof parsed.freshness_badge.status, 'string');
  });

  it('find prints ranked matches with a badge (text + json)', async () => {
    const root = tmpProject();
    fixture(root);
    await refreshAll(root);

    const text = await captureCli(() => runCodeMap('find', ['App'], { cwd: root }));
    assert.match(text, /Freshness: fresh/);
    assert.match(text, /App/);
    assert.match(text, /src\/app\/App\.tsx/);

    const jsonOut = await captureCli(() => runCodeMap('find', ['useAuth'], { cwd: root, json: true }));
    const parsed = JSON.parse(jsonOut);
    assert.equal(parsed.query, 'useAuth');
    assert.equal(parsed.freshness_badge.status, 'fresh');
    assert.ok(parsed.matches.some((m: { name: string }) => m.name === 'useAuth'));
  });

  it('brief prints suggested_files_to_read with a badge', async () => {
    const root = tmpProject();
    fixture(root);
    await refreshAll(root);

    const jsonOut = await captureCli(() => runCodeMap('brief', ['App'], { cwd: root, json: true }));
    const parsed = JSON.parse(jsonOut);
    assert.equal(parsed.target, 'App');
    assert.equal(parsed.freshness_badge.status, 'fresh');
    assert.ok(parsed.suggested_files_to_read.length > 0);
    assert.ok(parsed.suggested_files_to_read.length <= 12);
    assert.equal(parsed.suggested_files_to_read[0].path, 'src/app/App.tsx');
  });
  it('impact exposes direct resolved dependents through the CLI JSON surface', async () => {
    const root = tmpProject();
    fixture(root);
    writeSrc(root, 'src/impact-consumer.ts', "import { useAuth } from './hooks/useAuth';\nexport const useIt = useAuth;\n");
    await refreshAll(root);

    const jsonOut = await captureCli(() => runCodeMap('impact', ['useAuth'], { cwd: root, depth: 2, json: true }));
    const parsed = JSON.parse(jsonOut);
    assert.equal(parsed.target, 'useAuth');
    assert.equal(parsed.freshness_badge.status, 'fresh');
    assert.ok(parsed.direct_dependents.some((dependent: { path: string }) => dependent.path === 'src/impact-consumer.ts'));
    assert.equal(parsed.risk.score, parsed.risk.counters.direct_dependents + parsed.risk.counters.transitive_dependents);
  });

  it('outline returns the indexed file structure with a freshness badge', async () => {
    const root = tmpProject();
    fixture(root);
    await refreshAll(root);

    const jsonOut = await captureCli(() => runCodeMap('outline', ['src/app/App.tsx'], { cwd: root, json: true }));
    const parsed = JSON.parse(jsonOut);
    assert.equal(parsed.path, 'src/app/App.tsx');
    assert.equal(parsed.index_status, 'indexed');
    assert.equal(parsed.file_indexed, true);
    assert.equal(parsed.freshness_badge.status, 'fresh');
    assert.ok(parsed.symbols.some((symbol: { name: string }) => symbol.name === 'App'));
  });
});


describe('JsonlBackend outline contract', () => {
  it('reads only the indexed shard in source order and separates index states', async () => {
    const root = tmpProject();
    writeSrc(root, 'src/outline.ts', [
      'export function first() { return 1; }',
      'export class Second {}',
      'export const third = () => 3;',
    ].join('\n'));
    writeSrc(root, 'src/empty.ts', '// intentionally no symbols\n');
    await refreshAll(root);

    const backend = new JsonlBackend();
    const outline = await backend.outline({ path: 'src/outline.ts', cwd: root });
    assert.equal(outline.index_status, 'indexed');
    assert.equal(outline.file_indexed, true);
    assert.equal(outline.parse_status, 'parsed');
    assert.ok(outline.symbol_count >= 3);
    assert.ok(outline.symbols.every((symbol) => symbol.kind === 'symbol' && symbol.span !== null));
    assert.ok(outline.symbols.every((symbol, index) => index === 0 || (
      symbol.span!.start_line > outline.symbols[index - 1]!.span!.start_line
      || (symbol.span!.start_line === outline.symbols[index - 1]!.span!.start_line
        && symbol.span!.start_col >= outline.symbols[index - 1]!.span!.start_col)
    )));
    assert.ok(outline.symbols.some((symbol) => symbol.name === 'first' && symbol.exported && symbol.confidence === 1));
    assert.equal(Array.isArray(outline.diagnostics), true);

    const noSymbols = await backend.outline({ path: 'src/empty.ts', cwd: root });
    assert.equal(noSymbols.index_status, 'indexed');
    assert.equal(noSymbols.file_indexed, true);
    assert.equal(noSymbols.symbol_count, 0);

    const notIndexed = await backend.outline({ path: 'src/not-indexed.ts', cwd: root });
    assert.equal(notIndexed.index_status, 'file_not_indexed');
    assert.equal(notIndexed.file_indexed, false);

    const noStore = await backend.outline({ path: 'src/outline.ts', cwd: tmpProject() });
    assert.equal(noStore.index_status, 'missing_index');
    assert.equal(noStore.file_indexed, false);
    assert.equal(noStore.freshness_badge.status, 'missing_index');
  });

  it('enforces caller and hard response caps without reparsing', async () => {
    const root = tmpProject();
    writeSrc(
      root,
      'src/large.ts',
      Array.from({ length: OUTLINE_SYMBOL_CAP + 1 }, (_, index) => `export function symbol${index}() { return ${index}; }`).join('\n'),
    );
    await refreshAll(root);

    const backend = new JsonlBackend();
    const hardCapped = await backend.outline({ path: 'src/large.ts', cwd: root, limit: OUTLINE_SYMBOL_CAP + 50 });
    assert.equal(hardCapped.symbol_count, OUTLINE_SYMBOL_CAP + 1);
    assert.equal(hardCapped.symbols.length, OUTLINE_SYMBOL_CAP);
    assert.equal(hardCapped.truncated, true);

    const callerCapped = await backend.outline({ path: 'src/large.ts', cwd: root, limit: 1 });
    assert.equal(callerCapped.symbols.length, 1);
    assert.equal(callerCapped.truncated, true);
  });
});
// ───────────────────────── MCP tool handlers ─────────────────────────

describe('MCP code-map tool handlers', () => {
  it('bclaw_code_status returns a toolResponse with freshness_badge', async () => {
    const root = tmpProject();
    fixture(root);
    await refreshAll(root);

    const out = await executeMcpToolCall({ name: 'bclaw_code_status', args: {}, cwd: root });
    assert.equal(out.response.isError, false);
    const sc = out.response.structuredContent as Record<string, unknown>;
    assert.ok(sc.freshness_badge, 'freshness_badge in structured payload');
    assert.equal((sc.freshness_badge as { status: string }).status, 'fresh');
  });

  it('bclaw_code_find returns ranked matches + freshness_badge', async () => {
    const root = tmpProject();
    fixture(root);
    await refreshAll(root);

    const out = await executeMcpToolCall({ name: 'bclaw_code_find', args: { query: 'App' }, cwd: root });
    assert.equal(out.response.isError, false);
    const sc = out.response.structuredContent as Record<string, unknown>;
    assert.equal((sc.freshness_badge as { status: string }).status, 'fresh');
    assert.ok((sc.matches as Array<{ name: string }>).some((m) => m.name === 'App'));
  });

  it('bclaw_code_find rejects an empty query', async () => {
    const root = tmpProject();
    const out = await executeMcpToolCall({ name: 'bclaw_code_find', args: { query: '' }, cwd: root });
    assert.equal(out.response.isError, true);
  });
  it('bclaw_code_outline returns an indexed source outline and validates path', async () => {
    const root = tmpProject();
    fixture(root);
    await refreshAll(root);

    const out = await executeMcpToolCall({ name: 'bclaw_code_outline', args: { path: 'src/app/App.tsx' }, cwd: root });
    assert.equal(out.response.isError, false);
    const sc = out.response.structuredContent as Record<string, unknown>;
    assert.equal(sc.index_status, 'indexed');
    assert.equal((sc.freshness_badge as { status: string }).status, 'fresh');
    assert.ok((sc.symbols as Array<{ name: string }>).some((symbol) => symbol.name === 'App'));

    const invalid = await executeMcpToolCall({ name: 'bclaw_code_outline', args: { path: '' }, cwd: root });
    assert.equal(invalid.response.isError, true);
  });

  it('bclaw_code_brief returns suggested_files_to_read + freshness_badge', async () => {
    const root = tmpProject();
    fixture(root);
    await refreshAll(root);

    const out = await executeMcpToolCall({ name: 'bclaw_code_brief', args: { target: 'App' }, cwd: root });
    assert.equal(out.response.isError, false);
    const sc = out.response.structuredContent as Record<string, unknown>;
    assert.equal((sc.freshness_badge as { status: string }).status, 'fresh');
    assert.ok((sc.suggested_files_to_read as unknown[]).length > 0);
  });

  it('bclaw_code_impact returns direct causes and a count-based risk score', async () => {
    const root = tmpProject();
    fixture(root);
    writeSrc(root, 'src/impact-consumer.ts', "import { useAuth } from './hooks/useAuth';\nexport const useIt = useAuth;\n");
    await refreshAll(root);

    const out = await executeMcpToolCall({ name: 'bclaw_code_impact', args: { target: 'useAuth', depth: 2 }, cwd: root });
    assert.equal(out.response.isError, false);
    const sc = out.response.structuredContent as Record<string, any>;
    assert.equal(sc.target, 'useAuth');
    assert.ok(sc.direct_dependents.some((dependent: { path: string; causes: unknown[] }) => dependent.path === 'src/impact-consumer.ts' && dependent.causes.length > 0));
    assert.equal(sc.risk.score, sc.risk.counters.direct_dependents + sc.risk.counters.transitive_dependents);

    const invalid = await executeMcpToolCall({ name: 'bclaw_code_impact', args: { target: '' }, cwd: root });
    assert.equal(invalid.response.isError, true);
  });

  it('bclaw_code_refresh returns a result with freshness_badge', async () => {
    const root = tmpProject();
    fixture(root);

    const out = await executeMcpToolCall({ name: 'bclaw_code_refresh', args: { scope: 'all' }, cwd: root });
    assert.equal(out.response.isError, false);
    const sc = out.response.structuredContent as Record<string, unknown>;
    assert.equal(sc.scope, 'all');
    assert.ok(sc.freshness_badge, 'freshness_badge present');
  });
});

// ───────────────────────── code_map_enabled integration (spec §10) ─────────────────────────

describe('codeMapWorkSection (bclaw_work integration, spec §10)', () => {
  it('OFF: no store -> returns null (no work, no refresh)', async () => {
    const root = tmpProject();
    const section = await codeMapWorkSection(root, { query: 'App' });
    assert.equal(section, null);
  });

  it('OFF: store present but code_map_enabled=false -> returns null', async () => {
    const root = tmpProject();
    fixture(root);
    await refreshAll(root);
    const manifest = readManifest(root)!;
    writeManifest({ ...manifest, code_map_enabled: false }, root);

    const section = await codeMapWorkSection(root, { query: 'App' });
    assert.equal(section, null);
  });

  it('OFF path does not parse/refresh and is cheap (returns promptly)', async () => {
    const root = tmpProject();
    fixture(root);
    // No store at all -> off path. Should be a single manifest stat.
    const start = Date.now();
    const section = await codeMapWorkSection(root, { query: 'App' });
    assert.equal(section, null);
    assert.ok(Date.now() - start < 500, 'off path is fast');
    // confirm no store was created as a side effect.
    assert.equal(fs.existsSync(codeMapDir(root)), false, 'off path created no store');
  });

  it('ON + missing index -> missing_index hint, no matches', async () => {
    const root = tmpProject();
    fixture(root);
    // Refresh creates an enabled manifest; then force freshness back to
    // missing_index to simulate an enabled-but-unbuilt index.
    await refreshAll(root);
    const manifest = readManifest(root)!;
    writeManifest(
      { ...manifest, code_map_enabled: true, freshness: { status: 'missing_index', stale_file_count: 0, partial_reason: null } },
      root,
    );

    const section = await codeMapWorkSection(root, { query: 'App' });
    assert.ok(section, 'section present when enabled');
    assert.equal(section!.enabled, true);
    assert.ok(section!.missing_index, 'missing_index hint present');
    assert.equal(section!.matches.length, 0);
    assert.equal(section!.freshness_badge.status, 'missing_index');
  });

  it('ON + fresh index -> serves matches with the fresh badge', async () => {
    const root = tmpProject();
    fixture(root);
    await refreshAll(root); // manifest is enabled + fresh by default

    const section = await codeMapWorkSection(root, { query: 'App' });
    assert.ok(section);
    assert.equal(section!.freshness_badge.status, 'fresh');
    assert.ok(section!.matches.some((m) => m.name === 'App'));
  });

  it('ON + active live lock -> degrades to partial within the bounded wait, never blocks', async () => {
    const root = tmpProject();
    fixture(root);
    await refreshAll(root);

    // Plant a live lock owned by THIS process (so the default pid-alive check
    // sees it as alive) with a fresh heartbeat -> not abandoned -> blocks.
    const now = Date.now();
    fs.mkdirSync(codeMapDir(root), { recursive: true });
    fs.writeFileSync(
      lockPath(root),
      JSON.stringify({
        schema_version: 1,
        lock_id: 'lock_test',
        project_id: PROJECT,
        pid: process.pid,
        operation: 'refresh',
        scope: 'all',
        created_at: new Date(now).toISOString(),
        heartbeat_at: new Date(now).toISOString(),
        stale_after_ms: 60000,
      }),
      'utf-8',
    );

    // Use a fake clock + instant sleep so the bounded wait does not actually
    // burn 2500ms of wall time, but still proves the loop terminates and
    // returns partial (lock never clears here).
    let virtual = now;
    const section = await codeMapWorkSection(root, {
      query: 'App',
      now: () => virtual,
      sleep: async (ms: number) => {
        virtual += ms;
      },
    });
    assert.ok(section);
    assert.equal(section!.freshness_badge.status, 'partial');
    assert.equal((section!.freshness_badge.details.spot_check as { partial_reason: string }).partial_reason, 'code_map_lock_active');
    assert.ok(typeof section!.lock_wait_ms === 'number');
    assert.ok(section!.lock_wait_ms! <= WORK_SECTION_MAX_WAIT_MS);
  });

  it('ON + abandoned lock (dead pid) -> not blocked, serves results', async () => {
    const root = tmpProject();
    fixture(root);
    await refreshAll(root);

    fs.writeFileSync(
      lockPath(root),
      JSON.stringify({
        schema_version: 1,
        lock_id: 'lock_dead',
        project_id: PROJECT,
        pid: 999999, // not alive
        operation: 'refresh',
        scope: 'all',
        created_at: new Date(Date.now() - 120000).toISOString(),
        heartbeat_at: new Date(Date.now() - 120000).toISOString(),
        stale_after_ms: 60000,
      }),
      'utf-8',
    );

    const section = await codeMapWorkSection(root, {
      query: 'App',
      isPidAlive: () => false,
    });
    assert.ok(section);
    // Abandoned lock does not force partial; serves the fresh index.
    assert.equal(section!.freshness_badge.status, 'fresh');
    assert.ok(section!.matches.some((m) => m.name === 'App'));
  });
});

describe('codeMapRefreshNextActions (bclaw_work onboarding nudge, pln#588)', () => {
  const base = (over: Partial<CodeMapWorkSection>): CodeMapWorkSection => ({
    enabled: true,
    matches: [],
    freshness_badge: { freshness: 'fresh', status: 'fresh', details: {} },
    ...over,
  });

  it('null section -> no next_actions', () => {
    assert.deepEqual(codeMapRefreshNextActions(null), []);
  });

  it('missing_index -> bclaw_code_refresh scope=all', () => {
    const out = codeMapRefreshNextActions(
      base({ missing_index: 'empty', freshness_badge: { freshness: 'missing', status: 'missing_index', details: {} } }),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]!.tool, 'bclaw_code_refresh');
    assert.equal((out[0]!.args as { scope?: string }).scope, 'all');
  });

  it('stale_changed_files -> bclaw_code_refresh scope=changed', () => {
    const out = codeMapRefreshNextActions(base({ freshness_badge: { freshness: 'stale', status: 'stale_changed_files', details: {} } }));
    assert.equal(out.length, 1);
    assert.equal(out[0]!.tool, 'bclaw_code_refresh');
    assert.equal((out[0]!.args as { scope?: string }).scope, 'changed');
  });

  it('stale_git_head -> bclaw_code_refresh scope=changed (HEAD drift nudges refresh)', () => {
    const out = codeMapRefreshNextActions(base({ freshness_badge: { freshness: 'stale', status: 'stale_git_head', details: {} } }));
    assert.equal(out.length, 1);
    assert.equal(out[0]!.tool, 'bclaw_code_refresh');
    assert.equal((out[0]!.args as { scope?: string }).scope, 'changed');
  });

  it('fresh -> no nudge (do not nag a usable index)', () => {
    assert.deepEqual(codeMapRefreshNextActions(base({ freshness_badge: { freshness: 'fresh', status: 'fresh', details: {} } })), []);
  });

  it('partial (transient lock) -> no nudge', () => {
    assert.deepEqual(codeMapRefreshNextActions(base({ freshness_badge: { freshness: 'partial', status: 'partial', details: {} } })), []);
  });
});
