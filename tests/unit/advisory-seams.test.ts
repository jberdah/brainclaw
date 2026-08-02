/**
 * Fable audit P0/P1 — advisories must reach the surface an agent actually calls.
 *
 * Two features shipped in 1.19.0 computed a warning and dropped it at the last
 * joint:
 *
 *  - `stale_surfaces` (pln#638 2b): gated on maintenanceMode='full', so
 *    `bclaw_work` (which starts sessions in 'fast') could never even COMPUTE it;
 *    `bclaw_session_start` computed it and omitted it from the response; the CLI
 *    human output never printed it. Only surface: `--json`.
 *  - `scope_warnings` (pln#636 C2 backstop): computed by endSession, dropped by
 *    both the MCP handler and the CLI human output.
 *
 * These tests call `executeMcpToolCall` — the real MCP dispatch — because every
 * prior failure of this class had a green test one layer below the surface.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { executeMcpToolCall } from '../../src/commands/mcp.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

interface WarnCarrier {
  warnings?: string[];
  warning_details?: Array<{ code: string; message: string }>;
}

/**
 * The two handler families use different envelopes — session handlers spread
 * their fields FLAT onto the response (`toolResponse({content, ...structured})`),
 * while facade tools like bclaw_work put them under `structuredContent`. Read
 * both so these tests assert on what each tool actually returns.
 */
function warnCarrier(response: Record<string, unknown>): WarnCarrier {
  const flat = response as WarnCarrier;
  const structured = (response.structuredContent ?? {}) as WarnCarrier;
  return {
    warnings: structured.warnings ?? flat.warnings,
    warning_details: structured.warning_details ?? flat.warning_details,
  };
}

/** Plant a generated surface stamped by an older brainclaw than the running one. */
function plantStaleSurface(dir: string): void {
  fs.writeFileSync(
    path.join(dir, 'CLAUDE.md'),
    '> Written by brainclaw v0.0.1 at 2026-01-01T00:00:00\n\n# stale guidance\n',
    'utf-8',
  );
}

describe('advisory seams — the warning reaches the called surface', { concurrency: false }, () => {
  let workspace: TestWorkspace;
  let previousTestMode: string | undefined;

  beforeEach(() => {
    previousTestMode = process.env.BRAINCLAW_TEST_MODE;
    process.env.BRAINCLAW_TEST_MODE = '1';
    workspace = createTestWorkspace({ prefix: 'bclaw-advisory-seam-', currentAgent: 'codex' });
  });

  afterEach(() => {
    process.env.BRAINCLAW_TEST_MODE = previousTestMode;
    workspace.cleanup();
  });

  it('bclaw_session_start: stale_surfaces lands in warnings AND warning_details', async () => {
    plantStaleSurface(workspace.dir);
    const outcome = await executeMcpToolCall({
      name: 'bclaw_session_start',
      args: { agent: 'codex' },
      cwd: workspace.dir,
    });
    assert.equal(outcome.response.isError, false);
    const s = warnCarrier(outcome.response as unknown as Record<string, unknown>);
    assert.ok(
      s.warning_details?.some((w) => w.code === 'generated_surfaces_stale'),
      `warning_details must carry generated_surfaces_stale, got: ${JSON.stringify(s.warning_details)}`,
    );
    assert.ok(
      s.warnings?.some((w) => /older brainclaw/.test(w)),
      'the legacy warnings channel must carry the message too',
    );
  });

  it('bclaw_work: the CANONICAL entry point surfaces stale_surfaces', async () => {
    // The P0 finding: bclaw_work starts its session in fast mode, and the check
    // was gated on full — so the canonical entry point could never even compute
    // the advisory it was designed to deliver. Would fail on the 1.19.0 code.
    plantStaleSurface(workspace.dir);
    const outcome = await executeMcpToolCall({
      name: 'bclaw_work',
      args: { intent: 'consult', agent: 'codex' },
      cwd: workspace.dir,
    });
    assert.equal(outcome.response.isError, false);
    const s = warnCarrier(outcome.response as unknown as Record<string, unknown>);
    assert.ok(
      s.warning_details?.some((w) => w.code === 'generated_surfaces_stale'),
      `bclaw_work must surface the advisory, got warning_details: ${JSON.stringify(s.warning_details)}`,
    );
  });

  it('no stale surface → no warning noise on either tool', async () => {
    // The other half of the contract: silence stays silent. A permanent warning
    // teaches agents to skip the channel (trp#1275's lesson, one level up).
    const outcome = await executeMcpToolCall({
      name: 'bclaw_session_start',
      args: { agent: 'codex' },
      cwd: workspace.dir,
    });
    const s = warnCarrier(outcome.response as unknown as Record<string, unknown>);
    assert.ok(
      !s.warning_details?.some((w) => w.code === 'generated_surfaces_stale'),
      'a workspace with no stale surface must not warn',
    );
  });

  it('bclaw_session_end: scope_warnings reaches warnings AND warning_details', async () => {
    // Build the real thing end to end: a git repo, a claim with a path scope and
    // a base_sha (created through the MCP surface, not a core helper), a write
    // OUTSIDE the scope, then session_end. The C2 backstop must report it on the
    // response — not merely compute it.
    const { execSync } = await import('node:child_process');
    const run = (cmd: string): void => {
      execSync(cmd, { cwd: workspace.dir, stdio: 'pipe' });
    };
    fs.mkdirSync(path.join(workspace.dir, 'src', 'core'), { recursive: true });
    fs.mkdirSync(path.join(workspace.dir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(workspace.dir, 'src', 'core', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(workspace.dir, '.gitignore'), '.brainclaw/\n');
    run('git init -q');
    run('git add -A');
    run('git -c user.email=t@example.com -c user.name=T commit -q -m base');

    const start = await executeMcpToolCall({
      name: 'bclaw_session_start',
      args: { agent: 'codex' },
      cwd: workspace.dir,
    });
    assert.equal(start.response.isError, false);

    const claim = await executeMcpToolCall({
      name: 'bclaw_claim',
      args: { agent: 'codex', scope: 'src/core', description: 'core work', advisory: true },
      cwd: workspace.dir,
    });
    assert.equal(claim.response.isError, false);

    // The stray write the reconcile must catch.
    fs.writeFileSync(path.join(workspace.dir, 'docs', 'stray.md'), '# outside the claim\n');

    const end = await executeMcpToolCall({
      name: 'bclaw_session_end',
      args: { agent: 'codex', autoRelease: true, reflect: false },
      cwd: workspace.dir,
    });
    assert.equal(end.response.isError, false);
    const s = warnCarrier(end.response as unknown as Record<string, unknown>);
    assert.ok(
      s.warning_details?.some((w) => w.code === 'wrote_outside_claim_scope'),
      `session_end must surface the C2 backstop, got warning_details: ${JSON.stringify(s.warning_details)}`,
    );
    assert.ok(
      s.warnings?.some((w) => /outside/.test(w)),
      'the legacy warnings channel must carry it too',
    );
  });
});
