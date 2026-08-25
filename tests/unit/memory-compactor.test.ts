import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeAndApply, analyzeMemory, suggestCompaction, formatReport } from '../../src/core/memory-compactor.js';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import { ensureMemoryDir } from '../../src/core/io.js';
import { loadState, saveState } from '../../src/core/state.js';
import type { State } from '../../src/core/schema.js';

function createState(): State {
  return {
    version: 1,
    write_version: 1,
    active_constraints: [],
    recent_decisions: [],
    known_traps: [],
    open_handoffs: [],
    plan_items: [],
  };
}

function createCompactorStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-compactor-test-'));
  ensureMemoryDir(dir);
  saveConfig(defaultConfig('compactor-tests', { projectId: 'prj_compactor_test' }), dir);
  return dir;
}

function cleanupTestStore(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function readJsonLines(filepath: string): Array<Record<string, unknown>> {
  return fs.readFileSync(filepath, 'utf-8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const NOW = new Date().toISOString();
const OLD_DATE = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(); // 200 days ago

describe('core/memory-compactor', () => {
  describe('analyzeMemory', () => {
    it('returns empty report for empty state', () => {
      const state = createState();
      const report = analyzeMemory(state);
      assert.equal(report.clusters.length, 0);
      assert.equal(report.staleItems.length, 0);
      assert.equal(report.totalItems, 0);
      assert.equal(report.archivableCount, 0);
    });

    it('detects near-duplicate traps', () => {
      const state = createState();
      state.known_traps.push(
        {
          id: 'trp_aaa',
          text: 'Never mock the database in integration tests, use a real test database',
          created_at: '2026-01-15T10:00:00Z',
          author: 'alice',
          status: 'active',
          severity: 'high',
          tags: ['testing', 'db'],
          visibility: 'shared',
        },
        {
          id: 'trp_bbb',
          text: 'Do not mock the database in integration tests, always use a real test database instead',
          created_at: '2026-02-01T10:00:00Z',
          author: 'bob',
          status: 'active',
          severity: 'high',
          tags: ['testing'],
          visibility: 'shared',
        },
      );

      const report = analyzeMemory(state);
      assert.equal(report.clusters.length, 1, 'should detect one cluster');
      assert.equal(report.clusters[0]!.items.length, 2);
      assert.equal(report.clusters[0]!.type, 'trap');
      // Keep the most recent item
      assert.equal(report.clusters[0]!.keepId, 'trp_bbb');
    });

    it('does not cluster items of different types', () => {
      const state = createState();
      state.active_constraints.push({
        id: 'cst_a',
        text: 'Always use prepared statements for SQL queries',
        created_at: NOW,
        author: 'alice',
        status: 'active',
        tags: ['security'],
      });
      state.known_traps.push({
        id: 'trp_a',
        text: 'Always use prepared statements for SQL queries',
        created_at: NOW,
        author: 'alice',
        status: 'active',
        severity: 'high',
        tags: ['security'],
        visibility: 'shared',
      });

      const report = analyzeMemory(state);
      // Same text but different types — no clusters
      assert.equal(report.clusters.length, 0);
    });

    it('detects stale items with no references', () => {
      const state = createState();
      state.recent_decisions.push({
        id: 'dec_old',
        text: 'Decided to use ESM modules for the entire project',
        created_at: OLD_DATE,
        author: 'alice',
        tags: ['architecture'],
      });

      const report = analyzeMemory(state);
      assert.equal(report.staleItems.length, 1);
      assert.equal(report.staleItems[0]!.id, 'dec_old');
      assert.ok(report.staleItems[0]!.score < 0.2);
    });

    it('does not mark referenced old items as stale', () => {
      const state = createState();
      state.recent_decisions.push({
        id: 'dec_old',
        text: 'Decided to use ESM modules',
        created_at: OLD_DATE,
        author: 'alice',
        tags: ['architecture'],
      });
      // A plan references this decision
      state.plan_items.push({
        id: 'pln_ref',
        short_label: 'pln#1',
        text: 'Follow up on dec_old: ensure all packages export ESM',
        created_at: NOW,
        updated_at: NOW,
        author: 'alice',
        status: 'todo',
        type: 'chore',
        priority: 'medium',
        tags: [],
        depends_on: [],
      });

      const report = analyzeMemory(state);
      // The reference bumps the score above threshold
      assert.equal(report.staleItems.length, 0);
    });

    it('clusters three similar constraints', () => {
      const state = createState();
      state.active_constraints.push(
        {
          id: 'cst_1',
          text: 'All API endpoints must validate authentication tokens before processing requests',
          created_at: '2026-01-01T10:00:00Z',
          author: 'alice',
          status: 'active',
          tags: ['auth', 'api'],
        },
        {
          id: 'cst_2',
          text: 'Every API endpoint must validate authentication tokens before processing the request',
          created_at: '2026-01-15T10:00:00Z',
          author: 'bob',
          status: 'active',
          tags: ['security'],
        },
        {
          id: 'cst_3',
          text: 'API endpoints should validate auth tokens prior to request processing',
          created_at: '2026-02-01T10:00:00Z',
          author: 'alice',
          status: 'active',
          tags: ['auth'],
        },
      );

      const report = analyzeMemory(state);
      assert.equal(report.clusters.length, 1);
      assert.equal(report.clusters[0]!.items.length, 3);
      // Keeper is most recent
      assert.equal(report.clusters[0]!.keepId, 'cst_3');
      // archivable = 2 (the other two)
      assert.equal(report.archivableCount, 2);
    });

    it('respects custom similarity threshold', () => {
      const state = createState();
      state.known_traps.push(
        {
          id: 'trp_1',
          text: 'Watch out for circular imports in the auth module',
          created_at: NOW,
          author: 'alice',
          status: 'active',
          severity: 'medium',
          tags: ['imports'],
          visibility: 'shared',
        },
        {
          id: 'trp_2',
          text: 'Beware of circular imports in the authentication module code',
          created_at: NOW,
          author: 'bob',
          status: 'active',
          severity: 'medium',
          tags: ['imports'],
          visibility: 'shared',
        },
      );

      // High threshold — might not cluster
      const strict = analyzeMemory(state, { similarityThreshold: 0.95 });
      assert.equal(strict.clusters.length, 0);

      // Low threshold — should cluster
      const loose = analyzeMemory(state, { similarityThreshold: 0.3 });
      assert.equal(loose.clusters.length, 1);
    });
  });

  describe('analyzeAndApply', () => {
    let storeDir: string;

    beforeEach(() => {
      storeDir = createCompactorStore();
    });

    afterEach(() => {
      cleanupTestStore(storeDir);
    });

    it('archives duplicate constraints and decisions from a real store', () => {
      const state = createState();
      // Keep this fixture relative to the test clock. Absolute 2026-04 dates
      // eventually crossed the compactor's stale-age threshold and made this
      // duplicate-only scenario archive trp_keep as a third, unrelated item.
      const recentOld = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
      const recentNew = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
      const recentKeep = new Date().toISOString();
      state.active_constraints.push(
        {
          id: 'cst_dup_old',
          text: 'Validate JWT tokens before processing API requests',
          created_at: recentOld,
          author: 'alice',
          status: 'active',
          tags: ['auth'],
          related_paths: ['src/api/gateway.ts'],
        },
        {
          id: 'cst_dup_new',
          text: 'Validate JWT tokens before processing API requests in the gateway',
          created_at: recentNew,
          author: 'bob',
          status: 'active',
          tags: ['security'],
          related_paths: ['src/api/gateway.ts'],
        },
      );
      state.recent_decisions.push(
        {
          id: 'dec_dup_old',
          text: 'Use SQLite for local development and automated tests',
          created_at: recentOld,
          author: 'alice',
          tags: ['storage'],
          related_paths: ['src/storage'],
        },
        {
          id: 'dec_dup_new',
          text: 'Use SQLite for local development and automated test runs',
          created_at: recentNew,
          author: 'bob',
          tags: ['local-dev'],
          related_paths: ['src/storage'],
        },
      );
      state.known_traps.push({
        id: 'trp_keep',
        text: 'Do not reuse session ids across hosts',
        created_at: recentKeep,
        author: 'alice',
        status: 'active',
        severity: 'high',
        tags: ['sessions'],
        visibility: 'shared',
      });

      saveState(state, storeDir);

      const { report, result } = analyzeAndApply({ cwd: storeDir });

      assert.equal(report.clusters.length, 2);
      assert.equal(report.archivableCount, 2);
      assert.equal(result.archivedCount, 2);
      assert.equal(result.mergedClusters, 2);
      assert.equal(result.staleArchived, 0);

      const nextState = loadState(storeDir);
      assert.equal(nextState.active_constraints.length, 1);
      assert.equal(nextState.recent_decisions.length, 1);
      assert.equal(nextState.known_traps.length, 1);
      assert.deepEqual(nextState.active_constraints[0]!.tags.sort(), ['auth', 'security']);
      assert.deepEqual(nextState.recent_decisions[0]!.tags.sort(), ['local-dev', 'storage']);

      const constraintsDir = path.join(storeDir, '.brainclaw', 'memory', 'constraints');
      const decisionsDir = path.join(storeDir, '.brainclaw', 'memory', 'decisions');
      const constraintArchive = readJsonLines(path.join(constraintsDir, 'compacted.jsonl'));
      const decisionArchive = readJsonLines(path.join(decisionsDir, 'compacted.jsonl'));

      assert.equal(constraintArchive.length, 1);
      assert.equal(constraintArchive[0]!.id, 'cst_dup_old');
      assert.equal(typeof constraintArchive[0]!._compacted_at, 'string');
      assert.equal(decisionArchive.length, 1);
      assert.equal(decisionArchive[0]!.id, 'dec_dup_old');
      assert.equal(typeof decisionArchive[0]!._compacted_at, 'string');

      assert.equal(fs.existsSync(path.join(constraintsDir, 'cst_dup_old.json')), false);
      assert.equal(fs.existsSync(path.join(decisionsDir, 'dec_dup_old.json')), false);
      assert.equal(fs.existsSync(path.join(constraintsDir, 'cst_dup_new.json')), true);
      assert.equal(fs.existsSync(path.join(decisionsDir, 'dec_dup_new.json')), true);
    });
  });

  describe('suggestCompaction', () => {
    it('returns undefined for clean state', () => {
      const state = createState();
      assert.equal(suggestCompaction(state), undefined);
    });

    it('returns hint when clusters exist', () => {
      const state = createState();
      state.known_traps.push(
        {
          id: 'trp_x',
          text: 'Do not use eval() in any production code path',
          created_at: NOW,
          author: 'alice',
          status: 'active',
          severity: 'high',
          tags: ['security'],
          visibility: 'shared',
        },
        {
          id: 'trp_y',
          text: 'Never use eval() in production code paths',
          created_at: NOW,
          author: 'bob',
          status: 'active',
          severity: 'high',
          tags: ['security'],
          visibility: 'shared',
        },
      );

      const hint = suggestCompaction(state);
      assert.ok(hint);
      assert.ok(hint.includes('cluster'));
      assert.ok(hint.includes('brainclaw prune --semantic'));
    });
  });

  describe('formatReport', () => {
    it('formats empty report', () => {
      const report = analyzeMemory(createState());
      const text = formatReport(report);
      assert.ok(text.includes('0 items scanned'));
      assert.ok(text.includes('No compaction opportunities'));
    });

    it('formats report with clusters and stale items', () => {
      const state = createState();
      state.known_traps.push(
        {
          id: 'trp_a',
          text: 'Always check for null before accessing nested properties',
          created_at: NOW,
          author: 'alice',
          status: 'active',
          severity: 'medium',
          tags: ['safety'],
          visibility: 'shared',
        },
        {
          id: 'trp_b',
          text: 'Always check for null before you access nested properties',
          created_at: NOW,
          author: 'bob',
          status: 'active',
          severity: 'medium',
          tags: ['null-safety'],
          visibility: 'shared',
        },
      );
      state.recent_decisions.push({
        id: 'dec_stale',
        text: 'Use legacy build system for now',
        created_at: OLD_DATE,
        author: 'alice',
        tags: ['build'],
      });

      const report = analyzeMemory(state);
      const text = formatReport(report);
      assert.ok(text.includes('Similar clusters'));
      assert.ok(text.includes('KEEP'));
      assert.ok(text.includes('archive'));
      assert.ok(text.includes('Stale items'));
      assert.ok(text.includes('Estimated reduction'));
    });
  });
});
