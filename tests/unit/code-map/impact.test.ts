/**
 * Code Map P3 — local impact analysis over the resolved P1c/P1d graph.
 *
 * Locks the public distinctions that make the result safe for an agent:
 * direct vs opt-in transitives, resolved test imports vs filename suggestions,
 * concrete edge causes, bounded traversal, and an explainable count-only risk.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refresh } from '../../../src/core/code-map/refresh.js';
import { JsonlBackend } from '../../../src/core/code-map/backend.js';
import { IMPACT_DEPENDENT_CAP, IMPACT_MAX_DEPTH, IMPACT_NAMING_SUGGESTION_CONFIDENCE } from '../../../src/core/code-map/impact.js';

const cleanupDirs: string[] = [];
const PROJECT = 'prj_impact_test';

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-codemap-impact-'));
  cleanupDirs.push(dir);
  return dir;
}

function writeSrc(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

async function fixture(root: string): Promise<void> {
  writeSrc(root, 'src/core.ts', 'export function target() { return 1; }\n');
  writeSrc(root, 'src/direct.ts', "import { target } from './core';\nexport function direct() { return target(); }\n");
  writeSrc(root, 'src/transitive.ts', "import { direct } from './direct';\nexport const run = direct;\n");
  writeSrc(root, 'tests/core.test.ts', "import { target } from '../src/core';\nexport const verified = target();\n");
  // Indexed test with no import: this MUST be a separate low-confidence suggestion.
  writeSrc(root, 'tests/target.test.ts', 'export const conventionOnly = true;\n');
  await refresh({ projectId: PROJECT, projectRoot: root, scope: 'all', cwd: root, disableGit: true });
}

afterEach(() => {
  while (cleanupDirs.length > 0) fs.rmSync(cleanupDirs.pop() as string, { recursive: true, force: true });
});

describe('code-map impact', () => {
  it('separates definition, resolved direct/transitive dependents, tests, and count-based risk', async () => {
    const root = tmpProject();
    await fixture(root);
    const result = await new JsonlBackend().impact({ target: 'target', depth: 2, cwd: root });

    assert.equal(result.definition.match_kind, 'exact');
    assert.ok(result.definition.entries.some((entry) => entry.path === 'src/core.ts' && entry.name === 'target'));

    const direct = result.direct_dependents.find((entry) => entry.path === 'src/direct.ts');
    assert.ok(direct, 'direct importer is reported separately');
    assert.equal(direct!.depth, 1);
    assert.ok(direct!.causes.some((cause) => cause.kind === 'imports_symbol' && cause.module === './core'));
    assert.ok(direct!.causes.some((cause) => cause.kind === 'resolves_to' && cause.target.path === 'src/core.ts'));

    const transitive = result.transitive_dependents.find((entry) => entry.path === 'src/transitive.ts');
    assert.ok(transitive, 'depth=2 opts into a second resolved hop');
    assert.equal(transitive!.depth, 2);
    assert.ok(transitive!.causes.some((cause) => cause.target.path === 'src/direct.ts'));

    const resolvedTest = result.tests_for.find((entry) => entry.path === 'tests/core.test.ts');
    assert.ok(resolvedTest, 'test import is derived from a resolved edge');
    assert.equal(resolvedTest!.relation, 'resolved_import');
    assert.ok((resolvedTest!.causes ?? []).some((cause) => cause.kind === 'imports_symbol'));

    const suggestion = result.tests_for.find((entry) => entry.path === 'tests/target.test.ts');
    assert.ok(suggestion, 'filename convention remains visible but separate');
    assert.equal(suggestion!.relation, 'naming_convention_suggestion');
    assert.equal(suggestion!.confidence, IMPACT_NAMING_SUGGESTION_CONFIDENCE);
    assert.equal(suggestion!.causes, undefined, 'a naming convention cannot pretend to be a graph relation');

    assert.equal(result.risk.formula, 'direct_dependents + transitive_dependents');
    assert.equal(result.risk.score, result.risk.counters.direct_dependents + result.risk.counters.transitive_dependents);
    assert.equal(result.risk.counters.resolved_test_files, 1);
    assert.equal(result.risk.counters.suggested_test_files, 1);
    assert.equal(result.freshness_badge.status, 'fresh');
  });

  it('keeps transitive traversal opt-in and clamps depth and response volume', async () => {
    const root = tmpProject();
    await fixture(root);
    const backend = new JsonlBackend();

    const directOnly = await backend.impact({ target: 'target', cwd: root });
    assert.equal(directOnly.limits.max_depth, 1);
    assert.deepEqual(directOnly.transitive_dependents, []);

    const clamped = await backend.impact({ target: 'target', depth: IMPACT_MAX_DEPTH + 10, limit: IMPACT_DEPENDENT_CAP + 1, cwd: root });
    assert.equal(clamped.limits.max_depth, IMPACT_MAX_DEPTH);
    assert.equal(clamped.limits.max_dependents_per_section, IMPACT_DEPENDENT_CAP);
  });

  it('reports missing indexes without manufacturing an impact', async () => {
    const result = await new JsonlBackend().impact({ target: 'target', depth: 2, cwd: tmpProject() });
    assert.equal(result.definition.match_kind, 'none');
    assert.equal(result.risk.score, 0);
    assert.equal(result.freshness_badge.status, 'missing_index');
  });
});