import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEntity,
  getEntity,
  updateEntity,
} from '../../src/core/entity-operations.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

/**
 * Parametric coverage for trp#187: bclaw_update silently dropped patches on
 * plan/decision/constraint/trap because the legacy impls (updatePlan,
 * updateMemoryItem) only handled a typed subset, not every field declared in
 * EntityRegistry.updatable. This suite locks the contract: for each entity
 * with an implemented update path, patching each updatable field must
 * actually land — not just return success and noop.
 *
 * If you add a field to EntityRegistry.updatable for these entities, add a
 * row to UPDATE_COVERAGE so the patch path stays honest.
 */

interface CoverageRow {
  field: string;
  before: unknown;
  after: unknown;
  /** Optional read accessor when the persisted shape differs from patch key. */
  readKey?: string;
}

interface EntityCoverage {
  entity: 'plan' | 'decision' | 'constraint' | 'trap';
  createPayload: Record<string, unknown>;
  rows: CoverageRow[];
}

const COVERAGE: EntityCoverage[] = [
  {
    entity: 'plan',
    createPayload: { text: 'initial plan text', author: 'tester', priority: 'medium' },
    rows: [
      { field: 'text', before: 'initial plan text', after: 'updated plan text' },
      { field: 'tags', before: [], after: ['fix', 'cleanup'] },
      { field: 'priority', before: 'medium', after: 'high' },
      { field: 'estimated_effort', before: undefined, after: 60 },
      { field: 'depends_on', before: [], after: ['pln_other'] },
      { field: 'actual_effort', before: undefined, after: '45min' },
      { field: 'assignee', before: undefined, after: 'codex' },
    ],
  },
  {
    entity: 'decision',
    createPayload: { text: 'pick TypeScript', author: 'tester' },
    rows: [
      { field: 'text', before: 'pick TypeScript', after: 'pick TypeScript (revised)' },
      { field: 'tags', before: [], after: ['lang', 'tooling'] },
      { field: 'related_paths', before: undefined, after: ['src/index.ts'] },
      { field: 'scope', before: undefined, after: 'project' },
      { field: 'outcome', before: undefined, after: 'approved' },
    ],
  },
  {
    entity: 'constraint',
    createPayload: { text: 'no telemetry', author: 'tester' },
    rows: [
      { field: 'text', before: 'no telemetry', after: 'no telemetry, ever' },
      { field: 'tags', before: [], after: ['privacy', 'core'] },
      { field: 'category', before: undefined, after: 'security' },
      { field: 'scope', before: undefined, after: 'project' },
      { field: 'related_paths', before: undefined, after: ['src/core/'] },
      { field: 'expires_at', before: undefined, after: '2027-01-01T00:00:00.000Z' },
    ],
  },
  {
    entity: 'trap',
    createPayload: { text: 'rebase wipes node_modules', author: 'tester', severity: 'medium' },
    rows: [
      { field: 'text', before: 'rebase wipes node_modules', after: 'rebase wipes node_modules (mitigated by detachWorktreeJunctions)' },
      { field: 'tags', before: [], after: ['worktree', 'junction'] },
      { field: 'severity', before: 'medium', after: 'high' },
      { field: 'scope', before: undefined, after: 'project' },
      { field: 'related_paths', before: undefined, after: ['src/core/worktree.ts'] },
      { field: 'expires_at', before: undefined, after: '2027-01-01T00:00:00.000Z' },
      { field: 'platform_scope', before: undefined, after: 'win32' },
    ],
  },
];

describe('core/entity-operations — bclaw_update coverage (trp#187)', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-update-coverage-' });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  for (const { entity, createPayload, rows } of COVERAGE) {
    describe(entity, () => {
      for (const row of rows) {
        it(`patching '${row.field}' actually persists (no silent drop)`, () => {
          const created = createEntity(entity, createPayload, workspace.dir);

          updateEntity(entity, created.id, { [row.field]: row.after }, workspace.dir);

          const fetched = getEntity(entity, created.id, workspace.dir) as Record<string, unknown>;
          const readKey = row.readKey ?? row.field;
          assert.deepEqual(
            fetched[readKey],
            row.after,
            `Field '${row.field}' on ${entity} was silently dropped by bclaw_update — expected ${JSON.stringify(row.after)}, got ${JSON.stringify(fetched[readKey])}`,
          );
        });
      }

      it('updating multiple fields at once persists all of them', () => {
        const created = createEntity(entity, createPayload, workspace.dir);

        const multiPatch: Record<string, unknown> = {};
        for (const row of rows.slice(0, 3)) {
          multiPatch[row.field] = row.after;
        }

        updateEntity(entity, created.id, multiPatch, workspace.dir);
        const fetched = getEntity(entity, created.id, workspace.dir) as Record<string, unknown>;

        for (const row of rows.slice(0, 3)) {
          const readKey = row.readKey ?? row.field;
          assert.deepEqual(
            fetched[readKey],
            row.after,
            `Multi-patch on ${entity}: field '${row.field}' was not persisted`,
          );
        }
      });
    });
  }
});
