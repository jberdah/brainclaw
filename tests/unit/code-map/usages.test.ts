import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractFile } from '../../../src/core/code-map/extractor.js';
import { refresh } from '../../../src/core/code-map/refresh.js';
import { listShards } from '../../../src/core/code-map/store.js';
import { JsonlBackend } from '../../../src/core/code-map/backend.js';

const PROJECT = 'prj_usage_test';
const cleanup: string[] = [];

function sourceResult(pathname: string, lang: 'typescript' | 'python', source: string) {
  return extractFile({
    projectId: PROJECT,
    path: pathname,
    lang,
    source,
    sizeBytes: Buffer.byteLength(source),
    maxParseFileBytes: 1024 * 1024,
  });
}

function tempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-codemap-usages-'));
  cleanup.push(dir);
  return dir;
}

function write(root: string, rel: string, source: string): void {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source, 'utf8');
}

afterEach(() => {
  while (cleanup.length > 0) fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe('code-map P4 lexical usages', () => {
  it('emits proved local calls/references and leaves a dynamic method as a textual hint', async () => {
    const result = await sourceResult('src/local.ts', 'typescript', `
function local() { return 1; }
function caller() {
  const ref = local;
  local();
  obj.local();
}
`);
    const local = result.nodes.find((node) => node.kind === 'symbol' && node.name === 'local')!;
    const caller = result.nodes.find((node) => node.kind === 'symbol' && node.name === 'caller')!;

    const usages = result.edges.filter((edge) => edge.from === caller.id && edge.to === local.id);
    assert.ok(usages.some((edge) => edge.kind === 'calls' && edge.confidence === 1));
    assert.ok(usages.some((edge) => edge.kind === 'references' && edge.confidence === 1));
    const dynamic = usages.find((edge) => edge.kind === 'possible_textual_match');
    assert.ok(dynamic, 'dynamic property remains visible only as an advisory hint');
    assert.equal(dynamic!.confidence, 0.2);
    assert.equal(usages.filter((edge) => edge.kind === 'calls').length, 1, 'obj.local() is never a proved calls edge');
  });

  it('abstains when a local binding shadows a same-named function', async () => {
    const result = await sourceResult('src/shadow.ts', 'typescript', `
function target() { return 1; }
function caller() {
  const target = () => 2;
  return target();
}
`);
    const target = result.nodes.find((node) => node.kind === 'symbol' && node.name === 'target')!;
    const caller = result.nodes.find((node) => node.kind === 'symbol' && node.name === 'caller')!;
    assert.ok(!result.edges.some((edge) => edge.from === caller.id && edge.to === target.id && edge.kind === 'calls'));
  });

  it('resolves a TS alias import before emitting calls/references, then propagates them to impact', async () => {
    const root = tempProject();
    write(root, 'src/remote.ts', 'export function remote() { return 1; }\n');
    write(root, 'src/client.ts', `import { remote as alias } from './remote';
export function caller() {
  const ref = alias;
  return alias();
}
export function shadowed() {
  const alias = () => 2;
  return alias();
}
`);
    await refresh({ projectId: PROJECT, projectRoot: root, scope: 'all', cwd: root, disableGit: true });

    const shards = listShards(root);
    const remote = shards.find((shard) => shard.path === 'src/remote.ts')!.nodes.find((node) => node.name === 'remote')!;
    const client = shards.find((shard) => shard.path === 'src/client.ts')!;
    const caller = client.nodes.find((node) => node.name === 'caller')!;
    const usages = client.edges.filter((edge) => edge.from === caller.id && edge.to === remote.id);
    assert.ok(usages.some((edge) => edge.kind === 'calls' && edge.origin === 'usage_import'));
    assert.ok(usages.some((edge) => edge.kind === 'references' && edge.origin === 'usage_import'));
    const shadowed = client.nodes.find((node) => node.name === 'shadowed')!;
    assert.ok(!client.edges.some((edge) => edge.from === shadowed.id && edge.to === remote.id && edge.kind === 'calls'));

    const impact = await new JsonlBackend().impact({ target: 'remote', cwd: root });
    const dependent = impact.direct_dependents.find((entry) => entry.path === 'src/client.ts');
    assert.ok(dependent);
    assert.ok(dependent!.causes.some((cause) => cause.kind === 'calls' && cause.confidence === 1));
    assert.ok(dependent!.causes.some((cause) => cause.kind === 'references' && cause.confidence === 1));
  });

  it('resolves Python from-import aliases and never treats attribute calls as direct calls', async () => {
    const root = tempProject();
    write(root, 'pkg/__init__.py', '');
    write(root, 'pkg/remote.py', 'def remote():\n    return 1\n');
    write(root, 'pkg/client.py', `from .remote import remote as alias

def caller():
    ref = alias
    alias()
    obj.alias()
`);
    await refresh({ projectId: PROJECT, projectRoot: root, scope: 'all', cwd: root, disableGit: true });

    const shards = listShards(root);
    const remote = shards.find((shard) => shard.path === 'pkg/remote.py')!.nodes.find((node) => node.name === 'remote')!;
    const client = shards.find((shard) => shard.path === 'pkg/client.py')!;
    const caller = client.nodes.find((node) => node.name === 'caller')!;
    const usages = client.edges.filter((edge) => edge.from === caller.id && edge.to === remote.id);
    assert.ok(usages.some((edge) => edge.kind === 'calls'));
    assert.ok(usages.some((edge) => edge.kind === 'references'));
    assert.equal(usages.filter((edge) => edge.kind === 'calls').length, 1, 'obj.alias() is dynamic');
  });
});