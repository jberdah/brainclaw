import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runBootstrapProfile } from '../../src/core/bootstrap.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

describe('core/bootstrap harvest depth (pln#557 stp_d6bb1d95)', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-bootstrap-harvest-',
      projectId: 'prj_bootstrap_harvest',
      currentAgent: 'copilot',
    });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  function writeAdr(filename: string, body: string): string {
    const adrDir = path.join(workspace.dir, 'docs', 'adr');
    fs.mkdirSync(adrDir, { recursive: true });
    const filepath = path.join(adrDir, filename);
    fs.writeFileSync(filepath, body, 'utf-8');
    return filepath;
  }

  it('reads ADR files and emits typed decision candidates with excerpts', () => {
    writeAdr(
      '0001-use-postgres.md',
      [
        '# 0001 — Use Postgres for primary storage',
        '',
        '## Status',
        '',
        'Accepted',
        '',
        '## Decision',
        '',
        'We will adopt PostgreSQL 16 as the system of record for transactional data. ',
        'It satisfies the ACID + JSONB requirements raised by the platform team.',
        '',
        'Continuation paragraph that must NOT be included in the excerpt.',
        '',
        '## Consequences',
        '',
        'Operational tooling moves to pgbackrest.',
        '',
      ].join('\n'),
    );

    writeAdr(
      '0002-no-decision-heading.md',
      [
        '# 0002 — Caching strategy',
        '',
        '## Status',
        '',
        'Proposed',
        '',
        '## Context',
        '',
        'We need fast lookups for read-heavy endpoints; an in-memory layer is required.',
        '',
        '## Trade-offs',
        '',
        'Cache invalidation complexity vs. response latency.',
        '',
      ].join('\n'),
    );

    writeAdr(
      '0003-malformed.md',
      [
        'no markdown headings at all',
        'just one freeform sentence describing a deferred discussion of retries.',
      ].join('\n'),
    );

    const result = runBootstrapProfile({ cwd: workspace.dir, refresh: true });
    const adrSeeds = result.seeds.filter((seed) => seed.source_kind === 'adr');
    assert.equal(adrSeeds.length, 3, 'expected one seed per ADR file');
    assert.ok(adrSeeds.every((seed) => seed.seed_kind === 'decision'));
    assert.ok(adrSeeds.every((seed) => seed.confidence === 'high'));

    const accepted = adrSeeds.find((seed) => seed.source_ref.endsWith('0001-use-postgres.md'));
    assert.ok(accepted, 'first ADR seed missing');
    assert.ok(accepted!.text.includes('Use Postgres'), `title not surfaced: ${accepted!.text}`);
    assert.ok(accepted!.text.includes('[Accepted]'), `status not surfaced: ${accepted!.text}`);
    assert.ok(
      accepted!.text.includes('PostgreSQL 16'),
      `decision excerpt missing: ${accepted!.text}`,
    );
    assert.ok(
      !accepted!.text.includes('Continuation paragraph'),
      'excerpt must stop at first decision paragraph',
    );
    assert.ok(
      accepted!.related_paths?.some((p) => p.endsWith('0001-use-postgres.md')),
      'related_paths missing ADR file',
    );
    assert.equal(accepted!.promotion_hint, 'decision');

    const fallback = adrSeeds.find((seed) => seed.source_ref.endsWith('0002-no-decision-heading.md'));
    assert.ok(fallback, 'fallback ADR seed missing');
    assert.ok(
      fallback!.text.includes('Caching strategy'),
      `title not surfaced for fallback: ${fallback!.text}`,
    );
    assert.ok(
      fallback!.text.includes('[Proposed]'),
      `status not surfaced for fallback: ${fallback!.text}`,
    );
    assert.ok(
      fallback!.text.includes('in-memory layer'),
      `fallback excerpt should pick first non-title paragraph: ${fallback!.text}`,
    );

    const malformed = adrSeeds.find((seed) => seed.source_ref.endsWith('0003-malformed.md'));
    assert.ok(malformed, 'malformed ADR seed missing');
    assert.ok(
      malformed!.text.includes('deferred discussion of retries'),
      `malformed ADR should still surface body text: ${malformed!.text}`,
    );
  });

  it('routes decision/constraint/trap seeds to typed candidates in the import plan', () => {
    writeAdr(
      '0010-architecture-choice.md',
      [
        '# 0010 — Pick the event bus',
        '',
        '## Status',
        '',
        'Accepted',
        '',
        '## Decision',
        '',
        'NATS will be the brokered transport for cross-service events.',
      ].join('\n'),
    );

    const result = runBootstrapProfile({ cwd: workspace.dir, refresh: true });

    const decisionSeed = result.seeds.find((seed) => seed.seed_kind === 'decision');
    assert.ok(decisionSeed, 'decision seed must exist before import-plan check');

    const decisionSuggestion = result.importPlan.suggestions.find(
      (suggestion) => suggestion.target === 'decision' && suggestion.source_seed_ids.includes(decisionSeed!.id),
    );
    assert.ok(
      decisionSuggestion,
      `decision seed must produce a decision-target candidate. Plan: ${JSON.stringify(result.importPlan.suggestions)}`,
    );
    assert.equal(decisionSuggestion!.outcome, 'pending');
    assert.equal(decisionSuggestion!.confidence, 'high');
    assert.ok(
      decisionSuggestion!.tags.includes('bootstrap-import'),
      'typed candidates must carry the bootstrap-import tag for uninstall tracking',
    );
    assert.ok(
      decisionSuggestion!.rationale.includes('architecture decision record'),
      'ADR rationale should mention the source',
    );
  });

  it('does not persist transient execution-context facts as seeds', () => {
    fs.writeFileSync(path.join(workspace.dir, 'README.md'), '# Transient check\n\n## Test\n\n- npm test\n', 'utf-8');

    const result = runBootstrapProfile({ cwd: workspace.dir, refresh: true });

    assert.ok(
      result.profile.sources_scanned.includes('execution_context'),
      'execution_context source must still be reported for display',
    );
    assert.ok(
      result.seeds.every((seed) => !seed.text.startsWith('Current branch:')),
      `no seed should describe the current branch — got ${result.seeds.filter((s) => s.text.startsWith('Current branch:')).map((s) => s.text).join(', ')}`,
    );
    assert.ok(
      result.seeds.every((seed) => !seed.text.startsWith('Active branch:')),
      'no seed should describe active branches (transient)',
    );
    assert.ok(
      result.seeds.every((seed) => seed.text !== 'Repository has uncommitted changes.'),
      'dirty-status warning must not become a seed',
    );
    assert.ok(
      result.seeds.every((seed) => seed.source_ref !== 'git:branch' && seed.source_ref !== 'git:status'),
      'no seed should reference the transient git:branch/git:status source refs',
    );
  });

  it('caps ADR reading at 20 files, newest first', () => {
    const adrDir = path.join(workspace.dir, 'docs', 'adr');
    fs.mkdirSync(adrDir, { recursive: true });

    const written: { name: string; filepath: string }[] = [];
    for (let i = 0; i < 25; i++) {
      const name = `${String(i).padStart(4, '0')}-decision-${i}.md`;
      const filepath = path.join(adrDir, name);
      fs.writeFileSync(
        filepath,
        [
          `# ${name.replace(/\.md$/, '')}`,
          '',
          '## Decision',
          '',
          `Decision body ${i}.`,
        ].join('\n'),
        'utf-8',
      );
      written.push({ name, filepath });
    }

    // Stamp distinct mtimes so the "newest first" sort is deterministic:
    // higher index ⇒ newer mtime.
    const base = Date.now();
    for (const [i, entry] of written.entries()) {
      const t = new Date(base + i * 1000);
      fs.utimesSync(entry.filepath, t, t);
    }

    const result = runBootstrapProfile({ cwd: workspace.dir, refresh: true });
    const adrSeeds = result.seeds.filter((seed) => seed.source_kind === 'adr');
    assert.equal(adrSeeds.length, 20, `ADR cap not honored: got ${adrSeeds.length}`);

    const oldestKept = written.slice(-20)[0].name;
    const newest = written[written.length - 1].name;
    assert.ok(
      adrSeeds.some((seed) => seed.source_ref.endsWith(newest)),
      'newest ADR must be in the kept set',
    );
    assert.ok(
      adrSeeds.some((seed) => seed.source_ref.endsWith(oldestKept)),
      'oldest of the 20 newest ADRs must be in the kept set',
    );
    assert.ok(
      adrSeeds.every((seed) => {
        const file = path.basename(seed.source_ref);
        return Number(file.slice(0, 4)) >= 5; // 5..24 = 20 newest
      }),
      'only the 20 newest ADRs may be kept',
    );
  });
});
