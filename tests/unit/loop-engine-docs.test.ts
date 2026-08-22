/**
 * Documentation contract for the public Loop Engine surface.
 *
 * The README used to frame the engine almost entirely as a review-loop feature
 * while the runtime shipped five LoopKind defaults. That skew makes fresh
 * agents choose review even for planning, research, implementation, or debug
 * work. Keep the main entry points tied to the source-owned kind list.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { LOOP_KINDS } from '../../src/core/loops/types.js';

function readProjectFile(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('Loop Engine documentation surface', () => {
  it('documents every shipped default protocol as a supported workflow', () => {
    const guide = readProjectFile('docs/concepts/loop-engine.md');
    const supportedWorkflows = guide.split('## Supported workflows', 2)[1]?.split('## Relation to existing primitives', 2)[0];

    assert.ok(supportedWorkflows, 'Loop Engine guide must contain a Supported workflows section');
    for (const kind of LOOP_KINDS) {
      assert.match(
        supportedWorkflows,
        new RegExp(`\\| ${'`'}${kind}${'`'} \\|`),
        `Loop Engine guide must document the shipped ${kind} protocol`,
      );
    }
  });

  it('frames review as one workflow and documents cross-cutting clarification', () => {
    const guide = readProjectFile('docs/concepts/loop-engine.md');

    assert.match(guide, /not a review feature with a few extensions/i);
    assert.match(guide, /Clarification is a cross-cutting primitive/);
    assert.match(guide, /`request_input`/);
    assert.match(guide, /`provide_input`/);
  });

  it('keeps the README, product model, and MCP reference aligned with the public engine', () => {
    const readme = readProjectFile('README.md');
    const productModel = readProjectFile('docs/product/agent-first-model.md');
    const cli = readProjectFile('docs/cli.md');
    const mcp = readProjectFile('docs/integrations/mcp.md');

    assert.match(readme, /five shipped default workflows: \*\*review, ideation,\s*implementation, research, and debug\*\*/i);
    assert.match(productModel, /The runtime ships \*\*five default protocols\*\*, not just a review loop/i);
    assert.match(cli, /A direct `open` must include `allow_orphan: true`/);
    assert.match(mcp, /five built-in `review`, `ideation`, `implementation`,\s*`research`, and `debug` workflows/i);
  });
});
