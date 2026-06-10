/**
 * Dead-reference detection (pln#557 step 2): memory entities whose
 * related_paths point at files deleted by a refactor must surface in
 * stale_warnings instead of staying "confident and wrong".
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectDeadReferenceCandidates,
  detectDeadReferences,
  detectStaleness,
  staleSummary,
} from '../../src/core/staleness.js';
import type { Constraint, Decision, Trap } from '../../src/core/schema.js';

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

describe('core/staleness dead references', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-deadref-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'alive.ts'), 'export {};\n', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('flags items whose related_paths no longer exist', () => {
    const warnings = detectDeadReferences([
      {
        id: 'dec_dead',
        entity: 'decision',
        text: 'Routing lives in src/router.ts',
        created_at: daysAgo(40),
        related_paths: ['src/router.ts'],
      },
      {
        id: 'dec_alive',
        entity: 'decision',
        text: 'Helper lives in src/alive.ts',
        created_at: daysAgo(40),
        related_paths: ['src/alive.ts'],
      },
    ], root);

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].id, 'dec_dead');
    assert.equal(warnings[0].entity, 'decision');
    assert.match(warnings[0].reason, /src\/router\.ts/);
    assert.match(warnings[0].reason, /refactor/);
    assert.match(warnings[0].suggested_action, /related_paths/);
  });

  it('skips globs, URLs and empty entries — they are not checkable', () => {
    const warnings = detectDeadReferences([
      {
        id: 'cst_glob',
        entity: 'constraint',
        text: 'Glob scope',
        created_at: daysAgo(5),
        related_paths: ['src/**/*.ts', 'https://example.com/doc', '  ', 'src/alive.ts'],
      },
    ], root);
    assert.deepEqual(warnings, []);
  });

  it('lists only the missing subset when some paths still exist', () => {
    const warnings = detectDeadReferences([
      {
        id: 'trp_partial',
        entity: 'trap',
        text: 'Partial refs',
        created_at: daysAgo(5),
        related_paths: ['src/alive.ts', 'src/gone.ts'],
      },
    ], root);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].reason, /src\/gone\.ts/);
    assert.ok(!warnings[0].reason.includes('alive.ts'));
  });

  it('collectDeadReferenceCandidates keeps only active constraints and traps', () => {
    const mk = (over: object) => ({
      id: 'x', text: 't', created_at: daysAgo(1), author: 'a', tags: [], ...over,
    });
    const decisions = [mk({ id: 'dec_1', related_paths: ['a'] })] as Decision[];
    const constraints = [
      mk({ id: 'cst_active', status: 'active', related_paths: ['a'] }),
      mk({ id: 'cst_resolved', status: 'resolved', related_paths: ['a'] }),
    ] as unknown as Constraint[];
    const traps = [
      mk({ id: 'trp_active', status: 'active', severity: 'low', visibility: 'shared', related_paths: ['a'] }),
      mk({ id: 'trp_resolved', status: 'resolved', severity: 'low', visibility: 'shared', related_paths: ['a'] }),
    ] as unknown as Trap[];

    const items = collectDeadReferenceCandidates({ decisions, constraints, traps, projectRoot: root });
    const ids = items.map((i) => i.id);
    assert.deepEqual(ids.sort(), ['cst_active', 'dec_1', 'trp_active']);
  });

  it('detectStaleness integrates dead references into the report and summary', () => {
    const decision = {
      id: 'dec_dead_int',
      text: 'References a deleted module',
      created_at: daysAgo(10),
      author: 'tester',
      tags: [],
      related_paths: ['src/removed-module.ts'],
    } as Decision;

    const report = detectStaleness([], [], [], [], Date.now(), [], {
      decisions: [decision],
      constraints: [],
      projectRoot: root,
    });

    assert.equal(report.dead_reference_count, 1);
    assert.equal(report.warnings.length, 1);
    assert.equal(report.warnings[0].entity, 'decision');
    assert.match(staleSummary(report), /dead file reference/);
  });

  it('detectStaleness without a scan keeps the legacy report shape', () => {
    const report = detectStaleness([], [], [], []);
    assert.equal(report.dead_reference_count, undefined);
  });
});
