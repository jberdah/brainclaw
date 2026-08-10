/**
 * End-to-end regressions for the Fable audit (2026-07-03). The target source
 * modules are stored under tests/fixtures/code-map/relevance; importers are
 * generated in the copied temp project so their count is explicit in the test.
 */
import { afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonlBackend } from '../../../src/core/code-map/backend.js';
import { refresh } from '../../../src/core/code-map/refresh.js';
import { isTestPath } from '../../../src/core/code-map/query.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, '../../../../tests/fixtures/code-map/relevance');
const cleanup: string[] = [];

before(() => {
  assert.ok(fs.existsSync(path.join(FIXTURE_ROOT, 'src/core/entity-registry.ts')));
  assert.ok(fs.existsSync(path.join(FIXTURE_ROOT, 'src/commands/mcp.ts')));
});

afterEach(() => {
  while (cleanup.length > 0) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
});

function write(root: string, relativePath: string, source: string): void {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source, 'utf-8');
}

async function refreshedFixture(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-code-map-relevance-'));
  cleanup.push(root);
  fs.cpSync(FIXTURE_ROOT, root, { recursive: true });

  // The exact-tier decoy has no importers; these make the real registry central.
  for (let i = 1; i <= 4; i++) {
    write(
      root,
      `src/consumers/entity-consumer-${i}.ts`,
      `import { ENTITY_REGISTRY } from '../core/entity-registry';\nexport const entityConsumer${i} = ENTITY_REGISTRY.size;\n`,
    );
  }
  // Eight source dependents and ten test importers reproduce the mcp.ts crowding.
  for (let i = 1; i <= 8; i++) {
    write(
      root,
      `src/consumers/mcp-consumer-${i}.ts`,
      `import { executeMcpToolCall } from '../commands/mcp';\nexport const mcpConsumer${i} = executeMcpToolCall();\n`,
    );
  }
  for (let i = 1; i <= 10; i++) {
    write(root, `tests/mcp/mcp-importer-${i}.test.ts`, `import '../../src/commands/mcp';\nexport const mcpImporter${i} = true;\n`);
  }

  await refresh({ projectId: 'prj_relevance_dogfood', projectRoot: root, scope: 'all', cwd: root, disableGit: true });
  return root;
}

describe('code-map relevance — Fable audit dogfood', () => {
  it('find(EntityRegistry) ranks the real ENTITY_REGISTRY in entity-registry.ts first', async () => {
    const root = await refreshedFixture();
    const result = await new JsonlBackend().find({ query: 'EntityRegistry', cwd: root });
    const target = result.matches.findIndex(
      (match) => match.name === 'ENTITY_REGISTRY' && match.path === 'src/core/entity-registry.ts',
    );

    assert.ok(target >= 0 && target < 3, `real registry must be top 3, got ${JSON.stringify(result.matches)}`);
    assert.equal(target, 0, 'centrality resolves the same-tier shadow before lexical path ordering');
    const prefix = result.matches.find((match) => match.name === 'EntityRegistryIndex');
    assert.ok(prefix && result.matches[0]!.score > prefix.score, 'exact tier stays above prefix tier');
  });

  it('brief(src/commands/mcp.ts) keeps its reading list source-led and names the public entry point', async () => {
    const root = await refreshedFixture();
    const result = await new JsonlBackend().brief({ target: 'src/commands/mcp.ts', cwd: root });
    const sourceCount = result.suggested_files_to_read.filter((file) => !isTestPath(file.path)).length;
    const testCount = result.suggested_files_to_read.filter((file) => isTestPath(file.path)).length;
    const target = result.suggested_files_to_read.find((file) => file.path === 'src/commands/mcp.ts');

    assert.ok(sourceCount >= 6, `expected >=6 source entries, got ${JSON.stringify(result.suggested_files_to_read)}`);
    assert.ok(testCount <= 3, `test importers stay within the 3/12 reserve, got ${testCount}`);
    assert.ok(target, 'the actual MCP module is included');
    assert.match(target!.reason, /defines matching symbol executeMcpToolCall/);
    assert.doesNotMatch(target!.reason, /ForTests/);
  });
});
