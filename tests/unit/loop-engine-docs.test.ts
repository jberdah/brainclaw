/**
 * Documentation contract for the public Loop Engine surface (pln#676 / dec#171).
 *
 * The engine ships FIVE default protocols, all equal citizens of one runtime.
 * Prior drafts framed the whole engine as a review feature with a few
 * extensions; this test locks the current framing so a fresh agent picks the
 * right kind — not always `review` — for planning, ideation, execution,
 * research, and debug work.
 *
 * Guards:
 *   1. Every shipped `LoopKind` appears in the Supported workflows table.
 *   2. No per-protocol guide claims to BE the engine — each is one of five.
 *   3. Every per-protocol guide points at the shared engine + attempt-authority.
 *   4. Examples in the engine doc point at APIs that actually exist in code.
 *   5. Cross-doc parity (README, product model, CLI, MCP integration) is held.
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

  it('leads with the shared engine and delegates review specifics to the review guide', () => {
    const guide = readProjectFile('docs/concepts/loop-engine.md');
    const sectionOrder = Array.from(guide.matchAll(/^## (.+)$/gm)).map((m) => m[1]);
    const idxAttempt = sectionOrder.findIndex((h) => /^Attempt authority$/i.test(h ?? ''));
    const idxSupported = sectionOrder.findIndex((h) => /^Supported workflows$/i.test(h ?? ''));
    const idxRecovery = sectionOrder.findIndex((h) => /^Recovery and observability$/i.test(h ?? ''));
    const idxPersistence = sectionOrder.findIndex((h) => /^Persistence$/i.test(h ?? ''));

    assert.ok(idxAttempt >= 0, 'engine guide must reference Attempt authority as its own section');
    assert.ok(idxSupported > idxAttempt, 'Attempt authority must appear before Supported workflows');
    assert.ok(idxRecovery >= 0, 'engine guide must carry a Recovery and observability section');
    assert.ok(idxRecovery < idxPersistence, 'Recovery and observability must appear before Persistence');

    // Review-specific automation must NOT dominate the engine page anymore —
    // dec#171 asks for review, ideation, implementation, research, debug to
    // have equivalent weight. The review-specific H2 headers that used to live
    // here have moved to docs/loops/review.md.
    assert.doesNotMatch(guide, /^## Review automation \(one workflow\)$/m, 'review-specific H2 must live in docs/loops/review.md');
    assert.doesNotMatch(guide, /^## Review-specific reliability notes$/m, 'review reliability notes belong in docs/loops/review.md');
    assert.doesNotMatch(guide, /^### Symmetric review-AND-fix mode$/m, 'symmetric review section belongs in docs/loops/review.md');
  });

  it('names the attempt-authority document as the identity contract', () => {
    const guide = readProjectFile('docs/concepts/loop-engine.md');
    const authority = readProjectFile('docs/concepts/attempt-authority.md');

    assert.match(guide, /attempt-authority\.md/, 'engine guide must link to attempt-authority.md');
    assert.match(authority, /AttemptAuthority/, 'attempt-authority guide must name AttemptAuthority');
    assert.match(authority, /TurnReservation/, 'attempt-authority guide must reference the TurnReservation core');
    assert.match(authority, /`launch\(epoch\)`/, 'attempt-authority guide must reference immutable launch cells');
    assert.match(authority, /settlement and takeover contend on (?:the same|one immutable) `close\(epoch\)`/i);
    assert.match(authority, /common worker path/i, 'attempt-authority must describe one cross-kind dispatch path');
    assert.match(authority, /durable projections/i, 'attempt-authority must place durable projections before crossing');
    assert.match(authority, /hard-link create-if-absent/i, 'the Windows-safe no-clobber publish primitive must be explicit');
    assert.match(authority, /two-release activation/i, 'the incompatible-writer activation boundary must be explicit');
    assert.doesNotMatch(authority, /future multi-run|takeover model.*deferred/is, 'the shipped multi-run model must not be described as deferred');
    // Stable logical identity + fresh physical-generation identity.
    assert.match(authority, /\| `turn_id`/, 'attempt-authority must ship an identity matrix row for turn_id');
    assert.match(authority, /\| `assignment_id`/, 'attempt-authority must ship an identity matrix row for assignment_id');
    assert.match(authority, /\| `attempt_epoch`/, 'attempt-authority must ship an identity matrix row for attempt_epoch');
    assert.match(authority, /\| `run_id`/, 'attempt-authority must ship an identity matrix row for run_id');
    assert.match(authority, /\| `launch_nonce`/, 'attempt-authority must ship an identity matrix row for launch nonce');
    assert.match(authority, /\| `contract_hash`/, 'attempt-authority must ship an identity matrix row for contract hash');
    assert.match(authority, /\| `workspace_digest`/, 'attempt-authority must ship an identity matrix row for workspace digest');
  });

  it('ships one guide per shipped LoopKind with a comparable template', () => {
    const REQUIRED_SECTIONS = [
      '## Purpose',
      '## Default protocol',
      '## Entry point', // matches "Entry point" or "Entry points"
      '## Advance gates',
      '## Stop condition',
      '## Artifacts',
      '## Recovery',
      '## When NOT to use',
      '## Reference implementation',
    ] as const;

    const lengths: number[] = [];
    for (const kind of LOOP_KINDS) {
      const guide = readProjectFile(`docs/loops/${kind}.md`);
      // Header names the kind exactly.
      assert.match(guide, new RegExp(`^# ${kind[0]!.toUpperCase()}${kind.slice(1)} loop$`, 'm'), `docs/loops/${kind}.md must open with a "# <Kind> loop" H1`);
      // Every guide must state it is one of the five equal protocols, not the engine.
      assert.match(guide, /one of five equal protocols/i, `docs/loops/${kind}.md must state it is one of five equal protocols`);
      // Every guide links back to the shared engine and to attempt-authority.
      assert.match(guide, /\.\.\/concepts\/loop-engine\.md/, `docs/loops/${kind}.md must link to the shared engine`);
      assert.match(guide, /\.\.\/concepts\/attempt-authority\.md/, `docs/loops/${kind}.md must link to attempt-authority`);
      // No guide claims to BE the engine.
      assert.doesNotMatch(guide, /^# Loop [Ee]ngine\b/m, `docs/loops/${kind}.md must not present itself as the Loop Engine`);

      // Shared template — every required section must be present.
      for (const section of REQUIRED_SECTIONS) {
        assert.ok(
          guide.includes(section) || guide.includes(`${section}s`),
          `docs/loops/${kind}.md must include a ${section} section`,
        );
      }

      lengths.push(guide.length);
    }

    // Comparable weight — the longest guide must not exceed 2x the shortest.
    const min = Math.min(...lengths);
    const max = Math.max(...lengths);
    assert.ok(
      max <= min * 2,
      `loop protocol guides must have comparable weight (min=${min}, max=${max}); the runtime ships five equal protocols, so the docs should not either`,
    );
  });

  it('per-protocol guides point at APIs that actually exist in the runtime', () => {
    const currentApiSymbols = [
      'bclaw_loop',
      'DEFAULT_PROTOCOLS',
      'complete_turn',
      'advance',
      'iteration-engine',
    ];
    for (const kind of LOOP_KINDS) {
      const guide = readProjectFile(`docs/loops/${kind}.md`);
      // At least one Reference implementation link resolves to a src/ file that exists.
      const srcLinks = Array.from(guide.matchAll(/\((?:\.\.\/)+(src\/[^)]+?)(?:#[^)]*)?\)/g)).map((m) => m[1]!);
      assert.ok(srcLinks.length > 0, `docs/loops/${kind}.md must reference at least one file in src/`);
      for (const rel of srcLinks) {
        assert.ok(
          fs.existsSync(path.join(process.cwd(), rel)),
          `docs/loops/${kind}.md references missing runtime file ${rel}`,
        );
      }
      // Guides collectively must name current API symbols; each guide names at least one.
      assert.ok(
        currentApiSymbols.some((sym) => guide.includes(sym)),
        `docs/loops/${kind}.md must name at least one current API symbol (${currentApiSymbols.join(', ')})`,
      );
    }
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
