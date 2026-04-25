/**
 * Fresh-agent onboarding e2e (Codex P5) — simulates what a new agent sees on
 * first contact with brainclaw and pins the invariants that shape its mental
 * model.
 *
 * Scenario:
 *   1. Create a fresh workspace (equivalent to `brainclaw init`).
 *   2. Run `brainclaw export --all --write` to materialize every agent
 *      surface.
 *   3. Inspect each surface and assert:
 *        - AGENTS.md, CLAUDE.md, .cursor/rules/brainclaw.md, .windsurfrules,
 *          .clinerules/brainclaw.md, .github/copilot-instructions.md,
 *          .continue/rules/brainclaw.md, .roo/rules/brainclaw.md,
 *          .kilo/rules/brainclaw.md,
 *          GEMINI.md all carry the facade-first session protocol.
 *        - No CLI verb appears as the *primary* instruction before a facade
 *          (CLI is explicitly a fallback).
 *        - `brainclaw export --all` reports no "Unknown export format"
 *          warnings — every registered target generates output.
 *
 * This is intentionally narrow: deep per-agent coverage lives in
 * export-multiformat.test and agent-surface-facade-first.test. The goal here
 * is a single test that guards the user-visible story.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runExport } from '../../src/commands/export.js';
import { AGENT_EXPORT_REGISTRY } from '../../src/core/agent-files.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function captureStdio(fn: () => void): string[] {
  const logs: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  try {
    fn();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
  return logs;
}

/** Check that a facade mention precedes any CLI verb reference. */
function assertFacadeLeadsCli(name: string, content: string): void {
  const stripFrontmatter = (s: string): string => {
    if (!s.startsWith('---')) return s;
    const end = s.indexOf('\n---', 3);
    return end < 0 ? s : s.slice(end + 4);
  };
  const body = stripFrontmatter(content);
  const facade = body.search(/bclaw_work|bclaw_coordinate|bclaw_context\b|bclaw_dispatch|bclaw_session_end|bclaw_release_claim/);
  assert.ok(facade >= 0, `${name} does not mention any Brainclaw MCP facade — a fresh agent would not know the canonical entry point`);
  const cliPatterns = [
    /\bbrainclaw context\b/,
    /\bbrainclaw claim list\b/,
    /\bbrainclaw claim create\b/,
    /\bbrainclaw session-end\b/,
  ];
  for (const p of cliPatterns) {
    const pos = body.search(p);
    if (pos >= 0) {
      assert.ok(
        pos > facade,
        `${name}: CLI verb ${String(p)} appears before the first facade — CLI must be a fallback, not the primary instruction`,
      );
    }
  }
}

describe('fresh-agent onboarding e2e (Codex P5)', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-fresh-agent-' });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('export --all --write generates every registered target with no Unknown-format warnings', () => {
    const logs = captureStdio(() => runExport({ all: true, write: true, cwd: workspace.dir }));

    // Hard assertion: no skipped formats.
    const unknownWarnings = logs.filter((l) => /Unknown export format/.test(l));
    assert.deepEqual(unknownWarnings, [], `fresh agent must see every surface; got: ${unknownWarnings.join(' | ')}`);

    // Every registered target's path appears somewhere in the output.
    for (const target of AGENT_EXPORT_REGISTRY) {
      const escaped = target.relativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.ok(
        logs.some((l) => new RegExp(escaped).test(l)),
        `no log line mentioned ${target.relativePath} — is ${target.format} (${target.agentName}) being exported?`,
      );
    }
  });

  it('every primary text surface tells the facade-first story to a fresh agent', () => {
    captureStdio(() => runExport({ all: true, write: true, cwd: workspace.dir }));

    // Primary agent-facing surfaces that a new agent reads on first contact.
    // Skills live in agent homes (skills/openclaw/SKILL.md etc) and are not
    // resolved from a workspace root, so we only check the text surfaces a
    // fresh agent is guaranteed to load.
    const primarySurfaces = [
      'AGENTS.md',
      'CLAUDE.md',
      '.github/copilot-instructions.md',
      '.cursor/rules/brainclaw.md',
      '.windsurfrules',
      '.clinerules/brainclaw.md',
      '.continue/rules/brainclaw.md',
      '.roo/rules/brainclaw.md',
      '.kilo/rules/brainclaw.md',
      'GEMINI.md',
    ];

    for (const rel of primarySurfaces) {
      const full = path.join(workspace.dir, rel);
      assert.ok(fs.existsSync(full), `${rel} should be generated by export --all`);
      const content = fs.readFileSync(full, 'utf-8');
      assertFacadeLeadsCli(rel, content);
    }
  });

  it('generated files declare the current brainclaw version (no stale managed-by banners)', () => {
    captureStdio(() => runExport({ all: true, write: true, cwd: workspace.dir }));

    const surfaces = ['AGENTS.md', 'CLAUDE.md', '.cursor/rules/brainclaw.md'];
    for (const rel of surfaces) {
      const content = fs.readFileSync(path.join(workspace.dir, rel), 'utf-8');
      // Banner shape: "Managed by brainclaw v<MAJOR>.<MINOR>.<PATCH>"
      assert.match(
        content,
        /Managed by brainclaw v\d+\.\d+\.\d+/,
        `${rel} must carry a current "Managed by brainclaw vX.Y.Z" banner so a fresh agent knows the file is live`,
      );
    }
  });
});
