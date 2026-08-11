import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refresh } from '../../../src/core/code-map/refresh.js';
import { readShard, readSymbolsIndex } from '../../../src/core/code-map/store.js';
import { JsonlBackend } from '../../../src/core/code-map/backend.js';
import {
  attachRelatedMemory,
  type MemoryReader,
  type RelatedMemoryItem,
} from '../../../src/core/code-map/query.js';

const cleanupDirs: string[] = [];

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-codemap-query-'));
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

const PROJECT = 'prj_query_test';

/** A small React fixture: a component App.tsx + a useAuth hook + helpers. */
function fixture(root: string): void {
  writeSrc(
    root,
    'src/app/App.tsx',
    `import React from 'react';
import { useAuth } from '../hooks/useAuth';
export const App = () => {
  const auth = useAuth();
  return <div>{auth ? 'in' : 'out'}</div>;
};
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
  writeSrc(
    root,
    'src/app/Header.tsx',
    `import React from 'react';
export const Header = () => <header>hi</header>;
`,
  );
  writeSrc(
    root,
    'src/util/math.ts',
    `export function add(a: number, b: number) { return a + b; }
export function subtract(a: number, b: number) { return a - b; }
`,
  );
  // ignored — must never appear in results.
  writeSrc(root, 'node_modules/pkg/index.js', `export const App = 1;`);
}

async function refreshAll(root: string) {
  return refresh({ projectId: PROJECT, projectRoot: root, scope: 'all', cwd: root, disableGit: true });
}

/** Backend pinned to a fixed project root for query freshness stats. */
function backend(root: string, memoryReader?: MemoryReader): JsonlBackend {
  void root;
  return new JsonlBackend(memoryReader ? { memoryReader } : {});
}

describe('code-map find()', () => {
  it('find("App") returns the component file; find("useAuth") returns the hook', async () => {
    const root = tmpProject();
    fixture(root);
    await refreshAll(root);
    const be = backend(root);

    const app = await be.find({ query: 'App', cwd: root });
    assert.ok(app.matches.length > 0, 'App matched');
    const top = app.matches[0]!;
    assert.equal(top.name, 'App');
    assert.equal(top.path, 'src/app/App.tsx');
    assert.equal(top.subtype, 'component');
    assert.equal(app.freshness_badge.status, 'fresh');
    assert.ok(!app.matches.some((m) => m.path.includes('node_modules')), 'ignored file absent');

    const hook = await be.find({ query: 'useAuth', cwd: root });
    assert.ok(hook.matches.length > 0, 'useAuth matched');
    const hookTop = hook.matches[0]!;
    assert.equal(hookTop.name, 'useAuth');
    assert.equal(hookTop.path, 'src/hooks/useAuth.ts');
    assert.equal(hookTop.subtype, 'hook');
  });

  it('honors a result limit', async () => {
    const root = tmpProject();
    fixture(root);
    await refreshAll(root);
    const be = backend(root);
    // a broad token that hits several symbols
    const res = await be.find({ query: 'a', cwd: root, limit: 1 });
    assert.ok(res.matches.length <= 1, 'limit respected');
  });

  it('missing index -> missing_index badge, no matches', async () => {
    const root = tmpProject();
    const be = backend(root);
    const res = await be.find({ query: 'App', cwd: root });
    assert.equal(res.matches.length, 0);
    assert.equal(res.freshness_badge.status, 'missing_index');
  });
});

describe('code-map brief()', () => {
  it('brief("App") ranks App.tsx top, caps the reading list, carries a badge', async () => {
    const root = tmpProject();
    fixture(root);
    await refreshAll(root);
    const be = backend(root);

    const brief = await be.brief({ target: 'App', cwd: root });
    assert.ok(brief.suggested_files_to_read.length > 0, 'reading list non-empty');
    assert.ok(brief.suggested_files_to_read.length <= 12, 'cap 12 respected');
    const top = brief.suggested_files_to_read[0]!;
    assert.equal(top.path, 'src/app/App.tsx', 'defining file ranked first');
    assert.ok(/defines matching symbol App/.test(top.reason), 'reason explains the rank');
    assert.equal(brief.freshness_badge.status, 'fresh');
  });

  it('explicit limit cannot exceed the spec cap of 12', async () => {
    const root = tmpProject();
    fixture(root);
    await refreshAll(root);
    const be = backend(root);
    const brief = await be.brief({ target: 'App', cwd: root, limit: 100 });
    assert.ok(brief.suggested_files_to_read.length <= 12);
  });
});

describe('code-map P1d brief graph signals (resolution surfaced)', () => {
  // fixture: src/app/App.tsx  `import { useAuth } from '../hooks/useAuth'`
  //          src/hooks/useAuth.ts  `export function useAuth()`
  it('brief("useAuth") surfaces App.tsx as a DEPENDENT (reverse / blast radius)', async () => {
    const root = tmpProject();
    fixture(root);
    await refreshAll(root);
    const be = backend(root);
    const brief = await be.brief({ target: 'useAuth', cwd: root });
    const app = brief.suggested_files_to_read.find((f) => f.path === 'src/app/App.tsx');
    assert.ok(app, 'App.tsx (importer of useAuth) appears in the reading list');
    // reverse (+5) outranks the import-specifier heuristic (+3): the graph reason wins.
    assert.match(app!.reason, /imports the matching symbol useAuth/);
  });

  it('brief("App") surfaces useAuth.ts as a FORWARD dependency (resolved)', async () => {
    const root = tmpProject();
    fixture(root);
    await refreshAll(root);
    const be = backend(root);
    const brief = await be.brief({ target: 'App', cwd: root });
    assert.equal(brief.suggested_files_to_read[0]!.path, 'src/app/App.tsx', 'defining still top');
    const dep = brief.suggested_files_to_read.find((f) => f.path === 'src/hooks/useAuth.ts');
    assert.ok(dep, 'useAuth.ts (a resolved dependency of App) appears');
    assert.match(dep!.reason, /imported by the matching symbol \(resolved\): useAuth/);
  });

  it('a deleted importer is not surfaced as a stale graph dependent', async () => {
    const root = tmpProject();
    fixture(root);
    await refreshAll(root);
    // delete App.tsx on disk AFTER refresh (reverse index still lists it).
    fs.rmSync(path.join(root, 'src/app/App.tsx'));
    const be = backend(root);
    const brief = await be.brief({ target: 'useAuth', cwd: root });
    assert.ok(
      !brief.suggested_files_to_read.some((f) => f.path === 'src/app/App.tsx'),
      'deleted importer suppressed (no silent stale graph hint)',
    );
  });

  it('prefers an EXACT symbol match as the defining file (not same-token siblings)', async () => {
    const root = tmpProject();
    // parseConfig and parseConfigFile share tokens (parse, config) but only one is exact.
    writeSrc(root, 'src/a.ts', `export function parseConfig() { return 1; }\n`);
    writeSrc(root, 'src/b.ts', `export function parseConfigFile() { return 2; }\n`);
    await refreshAll(root);
    const be = backend(root);
    const brief = await be.brief({ target: 'parseConfig', cwd: root });
    const a = brief.suggested_files_to_read.find((f) => f.path === 'src/a.ts');
    assert.ok(a, 'the exact-match file is present');
    assert.match(a!.reason, /defines matching symbol parseConfig\b/, 'a.ts is the defining file');
    // b.ts (parseConfigFile) must NOT be presented as a defining match for parseConfig.
    const b = brief.suggested_files_to_read.find((f) => f.path === 'src/b.ts');
    if (b) assert.doesNotMatch(b.reason, /defines matching symbol/, 'same-token sibling is not "defining"');
  });
});

describe('code-map lazy read-path freshness (spec §6.1)', () => {
  it('records a modified candidate in spot_check without changing the index freshness', async () => {
    const root = tmpProject();
    fixture(root);
    await refreshAll(root);
    const be = backend(root);

    // modify App.tsx on disk WITHOUT refreshing.
    writeSrc(
      root,
      'src/app/App.tsx',
      `import React from 'react';
export const App = () => <div>CHANGED CONTENT THAT ALTERS SIZE AND HASH</div>;
export default App;
`,
    );

    const res = await be.find({ query: 'App', cwd: root });
    assert.equal(res.freshness_badge.freshness, 'fresh', 'top-line remains the index state');
    const details = res.freshness_badge.details as Record<string, Record<string, unknown>>;
    assert.ok(
      (details.spot_check.stale_changed_files as string[] | undefined)?.includes('src/app/App.tsx'),
      'stale file named in badge',
    );
    // the stale shard is not served as a confident match.
    assert.ok(!res.matches.some((m) => m.path === 'src/app/App.tsx'), 'stale shard excluded');
  });

  it('a deleted file is excluded from results and flagged', async () => {
    const root = tmpProject();
    fixture(root);
    await refreshAll(root);
    const be = backend(root);

    fs.rmSync(path.join(root, 'src/app/App.tsx'));

    const res = await be.find({ query: 'App', cwd: root });
    assert.ok(!res.matches.some((m) => m.path === 'src/app/App.tsx'), 'deleted file excluded');
    assert.equal(res.freshness_badge.freshness, 'fresh');
    const details = res.freshness_badge.details as Record<string, Record<string, unknown>>;
    assert.ok(
      (details.spot_check.deleted_files as string[] | undefined)?.includes('src/app/App.tsx'),
      'deletion flagged in badge',
    );
  });

  it('a same-size content change is still detected via hash (not size-only)', async () => {
    const root = tmpProject();
    fixture(root);
    await refreshAll(root);
    const be = backend(root);

    // Replace text with an EQUAL-length run so size is identical; only mtime +
    // content hash differ. A size-only check would falsely report fresh here.
    const p = path.join(root, 'src/app/App.tsx');
    const orig = fs.readFileSync(p, 'utf-8');
    const mutated = orig.replace("'in' : 'out'", "'ON' : 'of_'");
    assert.equal(mutated.length, orig.length, 'mutation preserves byte length');
    fs.writeFileSync(p, mutated, 'utf-8');

    const res = await be.find({ query: 'App', cwd: root });
    assert.equal(res.freshness_badge.freshness, 'fresh', 'top-line remains the index state');
    assert.ok(!res.matches.some((m) => m.path === 'src/app/App.tsx'), 'stale shard excluded');
  });

  it('an identical-content rewrite (mtime touch only) stays fresh — no false churn', async () => {
    const root = tmpProject();
    fixture(root);
    await refreshAll(root);
    const be = backend(root);

    const p = path.join(root, 'src/app/App.tsx');
    const orig = fs.readFileSync(p, 'utf-8');
    fs.writeFileSync(p, orig, 'utf-8'); // identical bytes, new mtime
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(p, future, future);

    const res = await be.find({ query: 'App', cwd: root });
    assert.equal(res.freshness_badge.status, 'fresh', 'identical hash stays fresh despite mtime touch');
    assert.ok(res.matches.some((m) => m.path === 'src/app/App.tsx'), 'still served as confident');
  });

  it('an oversized unchecked file is NOT mislabeled as budget exhaustion (§6.1.4 vs §6.1.6)', async () => {
    const root = tmpProject();
    writeSrc(root, 'src/big/Big.tsx', `import React from 'react';\nexport const Big = () => <div/>;\n`);
    // Refresh under a small parse cap so the file can later become "oversized" on
    // the read path without being huge.
    await refresh({
      projectId: PROJECT,
      projectRoot: root,
      scope: 'all',
      cwd: root,
      disableGit: true,
      extractorConfig: {
        included_extensions: ['.js', '.jsx', '.ts', '.tsx'],
        ignored_patterns_hash: '',
        max_parse_file_bytes: 4096,
        max_query_wait_ms: 2500,
      },
    });
    const be = backend(root);

    // Grow it past the 4096-byte cap on disk: mtime+size differ (gate trips) but
    // size > cap => the read path cannot hash it (§6.1.4). This is an *unchecked*
    // file, NOT a budget exhaustion (§6.1.6) — the reason must not claim otherwise.
    const padding = '// pad '.repeat(1000);
    fs.writeFileSync(
      path.join(root, 'src/big/Big.tsx'),
      `import React from 'react';\nexport const Big = () => <div/>;\n${padding}\n`,
      'utf-8',
    );

    const res = await be.find({ query: 'Big', cwd: root });
    const details = res.freshness_badge.details as Record<string, Record<string, unknown>>;
    assert.notEqual(
      details.spot_check.partial_reason,
      'lazy_check_budget_exhausted',
      'oversized-unchecked must not be mislabeled as budget exhaustion',
    );
    assert.equal(res.freshness_badge.freshness, 'fresh', 'oversized candidate does not change the index signal');
    assert.ok(
      (details.spot_check.unchecked_files as string[] | undefined)?.includes('src/big/Big.tsx'),
      'oversized file still disclosed as unchecked',
    );
  });

  it('records a partial spot-check when the 32-file lazy budget is exhausted', async () => {
    const root = tmpProject();
    // generate 40 component files that all match the token "Widget", then touch
    // them all on disk so every shard trips the cheap gate and must be hashed.
    // Names share the camelCase sub-token "widget" so one query hits all 40
    // (the tokenizer splits "WidgetThing5" -> {"widgetthing5","widget","thing5"}).
    for (let i = 0; i < 40; i++) {
      writeSrc(
        root,
        `src/widgets/WidgetThing${i}.tsx`,
        `import React from 'react';
export const WidgetThing${i} = () => <div>w${i}</div>;
`,
      );
    }
    await refreshAll(root);
    const be = backend(root);

    // touch every file: append a byte so mtime+size differ from the shard,
    // forcing a budget-consuming hash for each (>32 => budget exhausts).
    for (let i = 0; i < 40; i++) {
      const p = path.join(root, `src/widgets/WidgetThing${i}.tsx`);
      fs.appendFileSync(p, `// touched ${i}\n`);
    }

    // a token bucket containing all 40 entries: lowercase "widget" sub-token.
    const res = await be.find({ query: 'Widget', cwd: root, limit: 100 });
    assert.equal(res.freshness_badge.freshness, 'fresh', 'budget exhaustion stays in spot_check');
    const details = res.freshness_badge.details as Record<string, Record<string, unknown>>;
    assert.equal(details.spot_check.partial_reason, 'lazy_check_budget_exhausted');
    assert.ok((details.spot_check.unchecked_files as string[] | undefined)?.length, 'unchecked files listed');
  });
});

describe('code-map related memory (spec §11)', () => {
  it('attaches a memory item whose related_paths includes the briefed file', async () => {
    const root = tmpProject();
    fixture(root);
    await refreshAll(root);

    const memory: RelatedMemoryItem[] = [
      {
        id: 'dec#1',
        kind: 'decision',
        text: 'App shell uses a thin provider tree.',
        tags: ['architecture'],
        related_paths: ['src/app/App.tsx'],
      },
      {
        id: 'trp#9',
        kind: 'trap',
        text: 'unrelated note about deployment',
        tags: ['ci'],
        related_paths: ['scripts/deploy.ts'],
      },
    ];
    const reader: MemoryReader = () => memory;
    const be = backend(root, reader);

    const brief = await be.brief({ target: 'App', cwd: root });
    assert.equal(brief.related_memory.length, 1, 'only the path-matching memory attached');
    assert.equal(brief.related_memory[0]!.id, 'dec#1');

    // the per-file reading entry for App.tsx carries the memory id.
    const appEntry = brief.suggested_files_to_read.find((f) => f.path === 'src/app/App.tsx');
    assert.ok(appEntry, 'App.tsx in reading list');
    assert.ok(appEntry!.related_memory_ids.includes('dec#1'), 'memory id wired to the file');
  });

  it('attachRelatedMemory caps at 5 and ranks by relevance', () => {
    const items: RelatedMemoryItem[] = [];
    for (let i = 0; i < 8; i++) {
      items.push({
        id: `m#${i}`,
        kind: 'decision',
        text: `note ${i}`,
        tags: [],
        related_paths: ['src/app/App.tsx'],
      });
    }
    // a stronger match (related_paths + tag) should rank above the rest.
    items.push({
      id: 'm#strong',
      kind: 'decision',
      text: 'mentions src/app/App.tsx directly',
      tags: ['App'],
      related_paths: ['src/app/App.tsx'],
    });
    const out = attachRelatedMemory(items, ['src/app/App.tsx'], ['App']);
    assert.equal(out.length, 5, 'capped at 5');
    assert.equal(out[0]!.id, 'm#strong', 'strongest match ranked first');
  });

  it('matches by literal file-path mention in memory text', () => {
    const items: RelatedMemoryItem[] = [
      {
        id: 'm#text',
        kind: 'trap',
        text: 'editing src/hooks/useAuth.ts breaks the session refresh path',
        tags: [],
        related_paths: [],
      },
    ];
    const out = attachRelatedMemory(items, ['src/hooks/useAuth.ts'], ['useAuth']);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.id, 'm#text');
  });

  it('derives a non-persistent memory join from target imports, with evidence and freshness', async () => {
    const root = tmpProject();
    fixture(root);
    await refreshAll(root);
    const memory: RelatedMemoryItem = {
      id: 'trp#import',
      kind: 'trap',
      text: 'The useAuth import must stay behind the session boundary.',
      tags: [],
      related_paths: [],
      created_at: new Date().toISOString(),
      last_confirmed_at: new Date().toISOString(),
    };

    const brief = await backend(root, () => [memory]).brief({ target: 'src/app/App.tsx', cwd: root });
    const joined = brief.related_memory.find((item) => item.id === memory.id);
    assert.ok(joined, 'memory text matching a target import is attached');
    assert.deepEqual(joined.match_evidence?.matched_imports, ['useAuth']);
    assert.ok(joined.match_evidence?.sources.includes('import_text'));
    assert.equal(joined.match_evidence?.confidence, 0.72);
    assert.equal(joined.memory_freshness?.status, 'fresh');
    assert.equal(memory.match_evidence, undefined, 'the reader record is not mutated or persisted');
    assert.equal(memory.memory_freshness, undefined, 'freshness is response-local too');

    const app = brief.suggested_files_to_read.find((entry) => entry.path === 'src/app/App.tsx');
    assert.ok(app?.related_memory_ids.includes(memory.id), 'derived evidence is attached to its target file');
    const symbols = readSymbolsIndex(root);
    const appSymbol = Object.values(symbols?.entries ?? {}).flat().find((entry) => entry.path === 'src/app/App.tsx');
    assert.ok(appSymbol, 'the target shard is indexed');
    const shard = readShard(appSymbol.file_id, root);
    assert.ok(shard, 'the target shard remains readable after brief');
    assert.ok(shard.nodes.every((node) => !node.related_memory_ids.includes(memory.id)), 'no symbol-memory edge is persisted');
  });

  it('matches explicit symbols but rejects generic import stop words', () => {
    const memory: RelatedMemoryItem[] = [
      {
        id: 'dec#symbol', kind: 'decision', text: 'executeMcpToolCall owns transport startup.', tags: [], related_paths: [],
        created_at: new Date().toISOString(), last_confirmed_at: new Date().toISOString(),
      },
      {
        id: 'dec#generic', kind: 'decision', text: 'React rendering is unrelated.', tags: [], related_paths: [],
      },
    ];
    const joined = attachRelatedMemory(memory, ['src/commands/mcp.ts'], ['executeMcpToolCall'], ['React']);
    assert.deepEqual(joined.map((item) => item.id), ['dec#symbol']);
    assert.deepEqual(joined[0]!.match_evidence?.matched_symbols, ['executeMcpToolCall']);
    assert.equal(joined[0]!.match_evidence?.confidence, 0.82);
  });
});
