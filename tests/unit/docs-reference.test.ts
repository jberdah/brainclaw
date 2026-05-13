import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CONTEXT_SCHEMA_VERSION } from '../../src/core/context.js';

const repoRoot = process.cwd();

function readRepoFile(...segments: string[]): string {
  return fs.readFileSync(path.join(repoRoot, ...segments), 'utf-8');
}

describe('documentation reference drift', () => {
  it('documents the current context schema version in context-format.md', () => {
    const text = readRepoFile('docs', 'context-format.md');
    assert.ok(text.includes(`Current version: \`${CONTEXT_SCHEMA_VERSION}\``));
  });

  it('documents the operational CLI commands that recently drifted', () => {
    const cli = readRepoFile('docs', 'cli.md');
    for (const heading of [
      '### `brainclaw setup-machine`',
      '### `brainclaw runtime-status`',
      '### `brainclaw check-security`',
      '### `brainclaw setup-security`',
      '### `brainclaw worktree`',
      '### `brainclaw note create <text>`',
      '### `brainclaw assignment cancel <id>`',
    ]) {
      assert.ok(cli.includes(heading), `missing CLI docs heading: ${heading}`);
    }
  });

  it('surfaces the release-maintenance guide from packaged entry points', () => {
    const index = readRepoFile('docs', 'index.md');
    const quickstart = readRepoFile('docs', 'quickstart.md');
    const cli = readRepoFile('docs', 'cli.md');
    const guide = readRepoFile('docs', 'release-maintenance.md');

    assert.ok(index.includes('[release-maintenance.md](release-maintenance.md)'));
    assert.ok(quickstart.includes('[release-maintenance.md](release-maintenance.md)'));
    assert.ok(cli.includes('[release-maintenance.md](release-maintenance.md)'));
    assert.ok(guide.includes('node --test dist-test/tests/unit/docs-reference.test.js'));
  });

  it('does not claim worktree isolation is unavailable in shipped docs', () => {
    const readme = readRepoFile('README.md');
    const overview = readRepoFile('docs', 'integrations', 'overview.md');
    assert.ok(!readme.includes('until dedicated Git worktrees per agent or session are implemented'));
    assert.ok(!overview.includes('planned but not yet available'));
  });

  it('marks project-refs as a proposal rather than shipped surface', () => {
    const projectRefs = readRepoFile('docs', 'architecture', 'project-refs.md');
    assert.ok(projectRefs.includes('Proposal / design note'));
  });
});
