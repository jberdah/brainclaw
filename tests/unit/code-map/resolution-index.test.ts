/**
 * Code Map P1d — buildResolutionIndex + store round-trip.
 *
 * Locks: reverse maps keyed by TARGET path (via fileNodeId inversion) and by target
 * SYMBOL node id; rich entries (path, file_id, module, imported, confidence);
 * per-importer merge; deterministic ordering; empty when no edges; non-indexed
 * resolves_to target skipped; store write/read survives + null-proto re-home.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildResolutionIndex } from '../../../src/core/code-map/indexes.js';
import { fileNodeId } from '../../../src/core/code-map/ids.js';
import { writeResolutionIndex, readResolutionIndex } from '../../../src/core/code-map/store.js';
import type { CodeEdge, CodeLang, CodeNode, FileShard } from '../../../src/core/code-map/types.js';

const PROJECT = 'prj_resolution_index_test';

function moduleNode(id: string, source: string, importedNames: string[] = []): CodeNode {
  return {
    id, kind: 'module', subtype: null, lang: 'typescript', name: source, path: 'a.ts',
    span: { start_line: 1, start_col: 1, end_line: 1, end_col: 10 },
    exported: false, confidence: 1, related_memory_ids: [], imported_names: importedNames,
  } as CodeNode;
}
function symbolNode(id: string, name: string): CodeNode {
  return {
    id, kind: 'symbol', subtype: 'function', lang: 'typescript', name, path: 'b.ts',
    span: { start_line: 2, start_col: 1, end_line: 4, end_col: 1 },
    exported: true, confidence: 1, related_memory_ids: [], imported_names: [],
  } as CodeNode;
}
function shard(p: string, lang: CodeLang, nodes: CodeNode[], edges: CodeEdge[] = []): FileShard {
  return { path: p, file_id: `fid_${p}`, lang, nodes, edges } as unknown as FileShard;
}
const bFileId = fileNodeId(PROJECT, 'b.ts', 'typescript');
function rt(from: string, to: string, confidence = 1): CodeEdge {
  return { id: `e_${from}_${to}`, from, to, kind: 'resolves_to', confidence, source: { path: 'a.ts', line: 1 } } as CodeEdge;
}
function is(from: string, to: string, confidence = 1): CodeEdge {
  return { id: `e_${from}_${to}_s`, from, to, kind: 'imports_symbol', confidence, source: { path: 'a.ts', line: 1 } } as CodeEdge;
}

describe('code-map P1d buildResolutionIndex', () => {
  it('builds reverse-by-file (via fileNodeId inversion) and reverse-by-symbol', () => {
    const a = shard('a.ts', 'typescript', [moduleNode('module:m1', './b', ['foo'])], [rt('module:m1', bFileId), is('module:m1', 'sym:foo')]);
    const b = shard('b.ts', 'typescript', [symbolNode('sym:foo', 'foo')]);
    const idx = buildResolutionIndex(PROJECT, [a, b]);

    const byFile = idx.dependents_by_file['b.ts'];
    assert.ok(byFile, 'b.ts has dependents');
    assert.equal(byFile!.length, 1);
    assert.equal(byFile![0]!.path, 'a.ts');
    assert.equal(byFile![0]!.file_id, 'fid_a.ts');
    assert.equal(byFile![0]!.module, './b');
    assert.deepEqual(byFile![0]!.imported, ['foo']);
    assert.equal(byFile![0]!.confidence, 1);

    const bySym = idx.dependents_by_symbol['sym:foo'];
    assert.ok(bySym, 'sym:foo has dependents');
    assert.equal(bySym![0]!.path, 'a.ts');
  });

  it('skips a resolves_to whose target node id is not an indexed file', () => {
    const a = shard('a.ts', 'typescript', [moduleNode('module:m1', './gone')], [rt('module:m1', 'file:deadbeef')]);
    const idx = buildResolutionIndex(PROJECT, [a]);
    assert.deepEqual(Object.keys(idx.dependents_by_file), []);
  });

  it('merges two module nodes from one importer to the same target file', () => {
    const a = shard('a.ts', 'typescript',
      [moduleNode('module:m1', './b', ['foo']), moduleNode('module:m2', './b', ['bar'])],
      [rt('module:m1', bFileId, 0.8), rt('module:m2', bFileId, 1)]);
    const b = shard('b.ts', 'typescript', [symbolNode('sym:foo', 'foo')]);
    const idx = buildResolutionIndex(PROJECT, [a, b]);
    const deps = idx.dependents_by_file['b.ts'];
    assert.equal(deps!.length, 1, 'one merged entry per importer');
    assert.deepEqual(deps![0]!.imported, ['bar', 'foo'], 'imported names unioned + sorted');
    assert.equal(deps![0]!.confidence, 1, 'strongest confidence kept');
  });

  it('is empty when there are no resolution edges', () => {
    const a = shard('a.ts', 'typescript', [moduleNode('module:m1', './b')], []);
    const idx = buildResolutionIndex(PROJECT, [a]);
    assert.deepEqual(Object.keys(idx.dependents_by_file), []);
    assert.deepEqual(Object.keys(idx.dependents_by_symbol), []);
  });

  it('is deterministic (keys + arrays sorted) across two builds', () => {
    const mk = (): FileShard[] => {
      const a = shard('a.ts', 'typescript', [moduleNode('module:m1', './b', ['foo'])], [rt('module:m1', bFileId)]);
      const c = shard('c.ts', 'typescript', [moduleNode('module:m2', './b', ['foo'])], [rt('module:m2', bFileId)]);
      const b = shard('b.ts', 'typescript', [symbolNode('sym:foo', 'foo')]);
      return [c, a, b]; // unsorted input order
    };
    const i1 = buildResolutionIndex(PROJECT, mk());
    const i2 = buildResolutionIndex(PROJECT, mk());
    assert.deepEqual(i1.dependents_by_file, i2.dependents_by_file);
    assert.deepEqual(i1.dependents_by_file['b.ts']!.map((e) => e.path), ['a.ts', 'c.ts'], 'entries sorted by path');
  });

  it('store write/read round-trips (and re-homes maps onto null-proto)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1d-idx-'));
    try {
      const a = shard('a.ts', 'typescript', [moduleNode('module:m1', './b', ['foo'])], [rt('module:m1', bFileId), is('module:m1', 'sym:foo')]);
      const b = shard('b.ts', 'typescript', [symbolNode('sym:foo', 'foo')]);
      const idx = buildResolutionIndex(PROJECT, [a, b]);
      writeResolutionIndex(idx, dir);
      const back = readResolutionIndex(dir);
      assert.ok(back);
      assert.deepEqual(back!.dependents_by_file['b.ts'], idx.dependents_by_file['b.ts']);
      assert.deepEqual(back!.dependents_by_symbol['sym:foo'], idx.dependents_by_symbol['sym:foo']);
      assert.equal(Object.getPrototypeOf(back!.dependents_by_file), null, 'null-proto map');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readResolutionIndex returns null when absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1d-idx-'));
    try {
      assert.equal(readResolutionIndex(dir), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
