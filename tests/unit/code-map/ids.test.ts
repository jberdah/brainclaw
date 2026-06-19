import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { edgeId, fileId, nodeId, shardPrefix, shardRelPath } from '../../../src/core/code-map/ids.js';

describe('code-map ids', () => {
  it('fileId is deterministic and salted by projectId + path', () => {
    const a = fileId('prj_1', 'src/app/App.tsx');
    const b = fileId('prj_1', 'src/app/App.tsx');
    assert.equal(a, b, 'same inputs -> same id');
    assert.match(a, /^[0-9a-f]{64}$/, 'hex sha256');

    assert.notEqual(a, fileId('prj_2', 'src/app/App.tsx'), 'projectId changes id');
    assert.notEqual(a, fileId('prj_1', 'src/app/Other.tsx'), 'path changes id');
  });

  it('nodeId is deterministic', () => {
    const base = {
      projectId: 'prj_1',
      path: 'src/app/App.tsx',
      lang: 'tsx' as const,
      kind: 'symbol' as const,
      subtype: 'component' as const,
      name: 'App',
      startLine: 12,
      startCol: 1,
    };
    assert.equal(nodeId(base), nodeId({ ...base }), 'same inputs -> same id');
    assert.match(nodeId(base), /^[0-9a-f]{64}$/);
  });

  it('lang is part of the nodeId hash input (spec §5.4)', () => {
    const base = {
      projectId: 'prj_1',
      path: 'src/app/App.tsx',
      kind: 'symbol' as const,
      subtype: 'component' as const,
      name: 'App',
      startLine: 12,
      startCol: 1,
    };
    const asTsx = nodeId({ ...base, lang: 'tsx' });
    const asTs = nodeId({ ...base, lang: 'typescript' });
    assert.notEqual(asTsx, asTs, 'differing lang must produce a different node id');
  });

  it('nodeId reacts to name and position', () => {
    const base = {
      projectId: 'prj_1',
      path: 'a.ts',
      lang: 'typescript' as const,
      kind: 'symbol' as const,
      subtype: 'function' as const,
      name: 'foo',
      startLine: 1,
      startCol: 1,
    };
    assert.notEqual(nodeId(base), nodeId({ ...base, name: 'bar' }));
    assert.notEqual(nodeId(base), nodeId({ ...base, startLine: 2 }));
    assert.notEqual(nodeId(base), nodeId({ ...base, startCol: 2 }));
  });

  it('edgeId is deterministic from endpoints + kind', () => {
    const e1 = edgeId({ projectId: 'prj_1', from: 'file:a', to: 'sym:b', kind: 'defines' });
    const e2 = edgeId({ projectId: 'prj_1', from: 'file:a', to: 'sym:b', kind: 'defines' });
    assert.equal(e1, e2);
    assert.notEqual(e1, edgeId({ projectId: 'prj_1', from: 'file:a', to: 'sym:b', kind: 'contains' }));
  });

  it('shard path uses the first two hex chars as a prefix dir', () => {
    const id = fileId('prj_1', 'src/app/App.tsx');
    assert.equal(shardPrefix(id), id.slice(0, 2));
    assert.equal(shardRelPath(id), `files/${id.slice(0, 2)}/${id}.json`);
  });
});
