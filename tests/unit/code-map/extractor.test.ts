import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractFile, langForExtension } from '../../../src/core/code-map/extractor.js';
import type { CodeNode } from '../../../src/core/code-map/types.js';

const PROJECT = 'prj_extractor_test';

function byName(nodes: CodeNode[], name: string): CodeNode | undefined {
  return nodes.find((n) => n.name === name);
}

const TS_SOURCE = `import { readFileSync } from 'node:fs';
import helper from './helper';

export interface UserShape {
  id: number;
}

export type UserId = number;

export class UserService {
  load(): UserShape { return { id: 1 }; }
}

export function computeTotal(a: number, b: number): number {
  return a + b;
}

const internalCount = 5;
export { internalCount };
`;

const TSX_SOURCE = `import React, { useEffect } from 'react';
import { api } from '../api';

export function useAuth() {
  const [user] = React.useState(null);
  useEffect(() => {}, []);
  return user;
}

export const App = () => {
  useEffect(() => {}, []);
  return <div className="app"><span>hi</span></div>;
};

function NotExported() {
  return <p>x</p>;
}

export default App;
`;

describe('code-map extractor', () => {
  it('extracts TS function, class, interface, type + import/export edges', async () => {
    const res = await extractFile({
      projectId: PROJECT,
      path: 'src/service.ts',
      lang: 'typescript',
      source: TS_SOURCE,
      sizeBytes: Buffer.byteLength(TS_SOURCE),
      maxParseFileBytes: 1024 * 1024,
    });

    assert.equal(res.parseStatus, 'parsed');

    const fn = byName(res.nodes, 'computeTotal');
    assert.ok(fn, 'function extracted');
    assert.equal(fn!.subtype, 'function');
    assert.equal(fn!.exported, true);

    const cls = byName(res.nodes, 'UserService');
    assert.ok(cls);
    assert.equal(cls!.subtype, 'class');
    assert.equal(cls!.exported, true);

    const iface = byName(res.nodes, 'UserShape');
    assert.ok(iface);
    assert.equal(iface!.subtype, 'interface');

    const ty = byName(res.nodes, 'UserId');
    assert.ok(ty);
    assert.equal(ty!.subtype, 'type');

    // export { internalCount } marks the variable exported
    const internal = byName(res.nodes, 'internalCount');
    assert.ok(internal);
    assert.equal(internal!.exported, true);

    // import edges to module specifiers
    const importModules = res.nodes.filter((n) => n.kind === 'module').map((n) => n.name);
    assert.ok(importModules.includes('node:fs'));
    assert.ok(importModules.includes('./helper'));
    assert.ok(res.edges.some((e) => e.kind === 'imports'));
    assert.ok(res.edges.some((e) => e.kind === 'defines'));
    assert.ok(res.edges.some((e) => e.kind === 'exports'));

    // spec §5.7 imported[] — the named binding is captured on the module node.
    const fsMod = res.nodes.find((n) => n.kind === 'module' && n.name === 'node:fs');
    assert.deepEqual(fsMod!.imported_names, ['readFileSync'], 'named import binding captured');
    const helperMod = res.nodes.find((n) => n.kind === 'module' && n.name === './helper');
    assert.deepEqual(helperMod!.imported_names, ['default'], 'default import recorded as "default"');

    // spans are 1-based and non-degenerate.
    assert.equal(fn!.span!.start_line, 14, 'computeTotal starts on its declaration line');
    assert.ok(fn!.span!.end_line >= fn!.span!.start_line);
    assert.ok(fn!.span!.start_col >= 1 && fn!.span!.start_line >= 1, 'spans are 1-based');
  });

  it('detects React component and hook subtypes in TSX', async () => {
    const res = await extractFile({
      projectId: PROJECT,
      path: 'src/App.tsx',
      lang: 'tsx',
      source: TSX_SOURCE,
      sizeBytes: Buffer.byteLength(TSX_SOURCE),
      maxParseFileBytes: 1024 * 1024,
    });

    assert.equal(res.parseStatus, 'parsed');

    const hook = byName(res.nodes, 'useAuth');
    assert.ok(hook, 'hook extracted');
    assert.equal(hook!.subtype, 'hook');

    const component = byName(res.nodes, 'App');
    assert.ok(component, 'component extracted');
    assert.equal(component!.subtype, 'component');
    assert.equal(component!.exported, true);

    // a non-PascalCase-returning-JSX still classifies as component if PascalCase + JSX
    const notExported = byName(res.nodes, 'NotExported');
    assert.ok(notExported);
    assert.equal(notExported!.subtype, 'component');
    assert.equal(notExported!.exported, false);
  });

  it('oversized supported file -> skipped_too_large with a file node, no symbols', async () => {
    const res = await extractFile({
      projectId: PROJECT,
      path: 'src/big.ts',
      lang: 'typescript',
      source: '', // not read because oversized
      sizeBytes: 2 * 1024 * 1024,
      maxParseFileBytes: 1024 * 1024,
    });
    assert.equal(res.parseStatus, 'skipped_too_large');
    assert.equal(res.nodes.length, 1);
    assert.equal(res.nodes[0]!.kind, 'file');
    assert.equal(res.edges.length, 0);
    assert.ok(res.diagnostics.length >= 1);
  });

  it('syntactically broken file -> parse_error, never throws', async () => {
    const broken = 'export function ( { const = = = <<< @@@ }';
    const res = await extractFile({
      projectId: PROJECT,
      path: 'src/broken.ts',
      lang: 'typescript',
      source: broken,
      sizeBytes: Buffer.byteLength(broken),
      maxParseFileBytes: 1024 * 1024,
    });
    assert.equal(res.parseStatus, 'parse_error');
    // file node is always present
    assert.ok(res.nodes.some((n) => n.kind === 'file'));
    assert.ok(res.diagnostics.length >= 1);
  });

  it('re-export `export ... from` records the source module in the imports view', async () => {
    const src = `export { helper, other as o } from './helper';
export * from './star';
import { a } from './a';
`;
    const res = await extractFile({
      projectId: PROJECT,
      path: 'src/reexport.ts',
      lang: 'typescript',
      source: src,
      sizeBytes: Buffer.byteLength(src),
      maxParseFileBytes: 1024 * 1024,
    });
    assert.equal(res.parseStatus, 'parsed');
    const mods = new Map(
      res.nodes.filter((n) => n.kind === 'module').map((n) => [n.name, n.imported_names]),
    );
    assert.deepEqual(mods.get('./helper'), ['helper', 'other'], 're-export source captured');
    assert.deepEqual(mods.get('./star'), ['*'], 'export * source captured');
    assert.deepEqual(mods.get('./a'), ['a'], 'plain import still captured');
    // a re-export must NOT fabricate a local `export` symbol with the bare name.
    assert.ok(
      !res.nodes.some((n) => n.kind === 'symbol' && n.name === 'helper'),
      're-export does not invent a local symbol',
    );
  });

  it('default-export arrow function is classified as a component', async () => {
    const src = `const Page = () => <main>p</main>;
export default Page;
`;
    const res = await extractFile({
      projectId: PROJECT,
      path: 'src/Page.tsx',
      lang: 'tsx',
      source: src,
      sizeBytes: Buffer.byteLength(src),
      maxParseFileBytes: 1024 * 1024,
    });
    const page = byName(res.nodes, 'Page');
    assert.equal(page!.subtype, 'component');
    assert.equal(page!.exported, true, 'default-exported binding marked exported');
  });

  it('langForExtension maps extensions to grammars', () => {
    assert.equal(langForExtension('.ts'), 'typescript');
    assert.equal(langForExtension('.tsx'), 'tsx');
    assert.equal(langForExtension('.jsx'), 'tsx');
    assert.equal(langForExtension('.js'), 'javascript');
    assert.equal(langForExtension('.py'), null);
  });
});
