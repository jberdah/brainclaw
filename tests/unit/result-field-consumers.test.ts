/**
 * The seam guard — every advisory field on a result type must have a READER.
 *
 * Prescribed by the Fable audit after four instances of one failure class in a
 * single day: `base_sha` (stamped by a function nothing calls), `stale_surfaces`
 * and `scope_warnings` (computed, then dropped from every response), and a
 * transport test pinning a helper no surface emitted. The shared shape: the
 * mechanism works, the tests are green, and the value dies at the last joint —
 * nothing ever READS it.
 *
 * `rg stale_surfaces src/` answered in one second: two producing files, zero
 * consumers. This test is that grep, made permanent and made precise:
 *
 *  - fields come from the AST of the declared result interfaces (never a
 *    hand-kept list of names);
 *  - a CONSUMER is a property ACCESS (`x.field`, destructuring) that is not the
 *    target of an assignment — object-literal construction and `x.field = y`
 *    are production, not consumption;
 *  - only `src/` counts. A field read solely by tests is exactly the disease.
 *
 * JSON.stringify pass-through does not name the field, so it correctly does not
 * count — "visible only via --json" was the bug, not a consumer.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

function findRepoRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'src'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`repo root not found from ${import.meta.dirname}`);
}

const SRC = path.join(findRepoRoot(), 'src');

/** The result types where this failure class lives: session lifecycle results. */
const GUARDED_INTERFACES: Array<{ file: string; name: string }> = [
  { file: 'commands/session-start.ts', name: 'SessionStartResult' },
  { file: 'commands/session-end.ts', name: 'SessionEndResult' },
];

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf-8'), ts.ScriptTarget.ESNext, true);
}

function sourceFiles(dir: string = SRC): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return e.isFile() && e.name.endsWith('.ts') ? [full] : [];
  });
}

/** Own declared fields of an interface (not inherited — the audit class is
 *  "field ADDED to a result type", and inherited SessionSnapshot fields have
 *  their own consumers elsewhere). */
function ownFields(rel: string, interfaceName: string): string[] {
  const sf = parse(path.join(SRC, rel));
  const fields: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
      for (const m of node.members) {
        if (ts.isPropertySignature(m) && m.name && ts.isIdentifier(m.name)) fields.push(m.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return fields;
}

/** Is this property access a READ (consumption) rather than a write/construction? */
function isRead(node: ts.PropertyAccessExpression): boolean {
  const parent = node.parent;
  // `x.field = y` — assignment target, i.e. production.
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === node) {
    return false;
  }
  return true;
}

/** Collect every field name READ anywhere in src/, as accesses or destructuring. */
function collectReadFieldNames(): Set<string> {
  const reads = new Set<string>();
  for (const file of sourceFiles()) {
    const sf = parse(file);
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && isRead(node)) reads.add(node.name.text);
      // `const { stale_surfaces } = result` — destructuring is a read.
      if (ts.isBindingElement(node)) {
        const name = node.propertyName ?? node.name;
        if (ts.isIdentifier(name)) reads.add(name.text);
      }
      // `?.` chains parse as PropertyAccessExpression too, covered above.
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return reads;
}

describe('seam guard — result fields must have a reader in src/', () => {
  const reads = collectReadFieldNames();

  for (const { file, name } of GUARDED_INTERFACES) {
    it(`${name}: every declared field is consumed somewhere`, () => {
      const fields = ownFields(file, name);
      assert.ok(fields.length >= 3, `${name} lost its fields — the AST walk went blind (found ${fields.length})`);
      const orphans = fields.filter((f) => !reads.has(f));
      assert.deepEqual(
        orphans, [],
        `${name} declares field(s) that nothing in src/ ever READS. Computed-then-dropped is the `
        + `base_sha/stale_surfaces failure class — wire the field to its surface or remove it:\n${orphans.join('\n')}`,
      );
    });
  }

  it('detects the historical offenders when their consumers are hypothetically removed', () => {
    // Self-check that the guard is not vacuous: the two fields the audit caught
    // must be present AND currently consumed — i.e. they are in the read set at
    // all. If someone deletes the wiring, the tests above fail; if someone
    // renames the fields, this one fails and forces the list to be reconsidered.
    for (const historical of ['stale_surfaces', 'scope_warnings']) {
      assert.ok(reads.has(historical), `${historical} lost its consumer again — the audit-P0 regression`);
    }
  });
});
