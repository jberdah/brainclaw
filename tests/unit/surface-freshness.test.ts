/**
 * pln#638 volet 2b — lazy freshness reconcile of generated guidance surfaces.
 *
 * 2a made the live header honest (it names its real triggers instead of claiming
 * "auto-refreshed"). 2b uses the stamp that honesty put there.
 *
 * The load-bearing test here is the UNKNOWN one: a surface with no stamp must
 * never be reported as stale. Every project that adopted brainclaw before the
 * stamp existed, and every hand-written AGENTS.md, would otherwise be accused on
 * every session start — the false-positive failure mode that teaches agents to
 * ignore a channel.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessSurfaceFreshness,
  LIVE_SURFACE_REFRESH_COMMAND,
  parseSurfaceProvenance,
  reconcileSurfaceFreshness,
  STABLE_SURFACE_REFRESH_COMMAND,
  staleSurfaceWarning,
} from '../../src/core/surface-freshness.js';
import { renderLiveSection } from '../../src/core/instruction-templates.js';
import { DEFAULT_CAPABILITY_PROFILES } from '../../src/core/agent-capability.js';

describe('surface provenance — parsing the stamp 2a emits', { concurrency: false }, () => {
  it('reads the version out of the REAL rendered live header', () => {
    // Derived from the actual renderer, not a hand-copied string: if
    // renderLiveHeader's format changes, this fails loudly instead of silently
    // parsing nothing forever. That is the whole lesson of trp_7fc3e3c4, and the
    // reason volet 2c renders rather than greps.
    let checked = 0;
    for (const profile of Object.values(DEFAULT_CAPABILITY_PROFILES)) {
      const input = {
        profile,
        // The field names the renderer actually reads (instruction-templates.ts
        // lines 342-471). The 2c suite passes a differently-shaped fixture and
        // swallows the resulting TypeError in a try/catch — here the render must
        // genuinely succeed, or this test asserts nothing.
        state: {
          active_constraints: [], known_traps: [], plan_items: [],
          open_handoffs: [], recent_decisions: [],
        },
        projectName: 'freshness-fixture',
        brainclawVersion: '1.18.0',
        resolvedInstructions: [],
      } as unknown as Parameters<typeof renderLiveSection>[0];
      const live = renderLiveSection(input);
      if (!live) continue; // this profile has no live companion tier
      assert.equal(
        parseSurfaceProvenance(live.content).version, '1.18.0',
        `the stamp must parse out of the real header for ${profile.name}:\n${live.content.slice(0, 300)}`,
      );
      checked += 1;
    }
    assert.ok(checked > 0, 'no live companion surface rendered — this test would otherwise assert nothing');
  });

  it('reads a SKILL.md front-matter stamp', () => {
    const content = '---\nname: openclaw\nbrainclaw_version: 1.17.2\n---\n\n# Skill\n';
    assert.equal(parseSurfaceProvenance(content).version, '1.17.2');
  });

  it('tolerates a prerelease version', () => {
    assert.equal(parseSurfaceProvenance('> Written by brainclaw v2.0.0-rc.1 at 2026-08-01').version, '2.0.0-rc.1');
  });

  it('returns nothing for an unstamped file rather than guessing', () => {
    assert.equal(parseSurfaceProvenance('# My hand-written AGENTS.md\n\nDo the thing.\n').version, undefined);
  });
});

describe('surface freshness — silent on doubt', { concurrency: false }, () => {
  it('an unstamped surface is UNKNOWN, never stale', () => {
    // The assertion that keeps this feature from being noise.
    const verdict = assessSurfaceFreshness('# hand-written\n', '1.18.0');
    assert.equal(verdict.kind, 'unknown');
  });

  it('a matching stamp is fresh', () => {
    const verdict = assessSurfaceFreshness('> Written by brainclaw v1.18.0 at 2026-08-01T10:00:00', '1.18.0');
    assert.equal(verdict.kind, 'fresh');
  });

  it('a different stamp is stale, and reports BOTH versions', () => {
    const verdict = assessSurfaceFreshness('> Written by brainclaw v1.16.0 at 2026-06-01T10:00:00', '1.18.0');
    assert.equal(verdict.kind, 'stale');
    assert.ok(verdict.kind === 'stale');
    assert.equal(verdict.stampedVersion, '1.16.0');
    assert.equal(verdict.currentVersion, '1.18.0');
  });
});

describe('surface freshness — reconcile over a project tree', { concurrency: false }, () => {
  let root: string;

  function write(rel: string, content: string): void {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf-8');
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-surface-fresh-'));
  });

  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('finds a stale registry surface and leaves it on disk untouched', () => {
    write('CLAUDE.md', '> Written by brainclaw v1.10.0 at 2026-01-01T00:00:00\n\n# guidance\n');
    const before = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf-8');

    const result = reconcileSurfaceFreshness(root, '1.18.0');
    assert.deepEqual(result.stale.map((s) => s.relativePath), ['CLAUDE.md']);
    assert.equal(result.stale[0].stampedVersion, '1.10.0');
    assert.equal(result.stale[0].kind, 'stable');
    assert.equal(
      fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf-8'), before,
      'reconcile must NEVER rewrite: regeneration is an explicit act',
    );
  });

  it('scans live-companion targets too, not just the main registry — and marks them live', () => {
    write('.github/copilot-instructions.live.md', '> Written by brainclaw v1.9.0 at 2026-01-01T00:00:00\n');
    const result = reconcileSurfaceFreshness(root, '1.18.0');
    assert.deepEqual(result.stale.map((s) => s.relativePath), ['.github/copilot-instructions.live.md']);
    assert.equal(result.stale[0].kind, 'live');
  });

  it('counts a current surface as fresh and an unstamped one as unknown', () => {
    write('CLAUDE.md', '> Written by brainclaw v1.18.0 at 2026-08-01T00:00:00\n');
    write('AGENTS.md', '# hand-written, no stamp\n');
    const result = reconcileSurfaceFreshness(root, '1.18.0');
    assert.deepEqual(result.stale, [], 'neither of these is stale');
    assert.equal(result.freshCount, 1);
    assert.equal(result.unknownCount, 1);
  });

  it('reports nothing for an empty project', () => {
    const result = reconcileSurfaceFreshness(root, '1.18.0');
    assert.deepEqual(result.stale, []);
    assert.equal(result.freshCount, 0);
  });

  it('finds the stamp even when the file is large — it only reads the head', () => {
    write('CLAUDE.md', `> Written by brainclaw v1.11.0 at 2026-01-01T00:00:00\n${'filler line\n'.repeat(5000)}`);
    const result = reconcileSurfaceFreshness(root, '1.18.0');
    assert.equal(result.stale.length, 1);
  });

  it('never throws when a registry path is a DIRECTORY rather than a file', () => {
    fs.mkdirSync(path.join(root, 'CLAUDE.md'), { recursive: true });
    assert.doesNotThrow(() => reconcileSurfaceFreshness(root, '1.18.0'));
  });
});

describe('surface freshness — the advisory', { concurrency: false }, () => {
  it('emits nothing when nothing is stale', () => {
    assert.equal(staleSurfaceWarning({ stale: [], freshCount: 3, unknownCount: 1 }, '1.18.0'), undefined);
  });

  it('names the files, their versions, and the command that fixes them', () => {
    const warning = staleSurfaceWarning({
      stale: [{ relativePath: 'CLAUDE.md', stampedVersion: '1.10.0', kind: 'stable' }],
      freshCount: 0,
      unknownCount: 0,
    }, '1.18.0');
    assert.equal(warning?.code, 'generated_surfaces_stale');
    assert.match(warning!.message, /CLAUDE\.md \(v1\.10\.0\)/);
    assert.match(warning!.message, /brainclaw export --all --write/);
    assert.equal(warning?.data?.refresh_command, STABLE_SURFACE_REFRESH_COMMAND);
    assert.deepEqual(warning?.data?.refresh_commands, [STABLE_SURFACE_REFRESH_COMMAND]);
  });

  it('recommends `brainclaw refresh` when only live companions are stale — export never rewrites those', () => {
    // trp_6a49f976: the first real-world firing of this advisory (v1.20.0
    // upgrade) listed six live companions and recommended an export command
    // that (a) the CLI rejects and (b) would not have touched any of them.
    const warning = staleSurfaceWarning({
      stale: [{ relativePath: '.cursor/live.md', stampedVersion: '1.19.1', kind: 'live' }],
      freshCount: 0,
      unknownCount: 0,
    }, '1.20.0');
    assert.match(warning!.message, /brainclaw refresh/);
    assert.doesNotMatch(warning!.message, /export/);
    assert.equal(warning?.data?.refresh_command, LIVE_SURFACE_REFRESH_COMMAND);
    assert.deepEqual(warning?.data?.refresh_commands, [LIVE_SURFACE_REFRESH_COMMAND]);
  });

  it('recommends BOTH commands when both kinds are stale, as one runnable string', () => {
    const warning = staleSurfaceWarning({
      stale: [
        { relativePath: 'CLAUDE.md', stampedVersion: '1.10.0', kind: 'stable' },
        { relativePath: '.cursor/live.md', stampedVersion: '1.10.0', kind: 'live' },
      ],
      freshCount: 0,
      unknownCount: 0,
    }, '1.18.0');
    assert.match(warning!.message, /brainclaw export --all --write/);
    assert.match(warning!.message, /brainclaw refresh/);
    assert.equal(
      warning?.data?.refresh_command,
      `${STABLE_SURFACE_REFRESH_COMMAND} && ${LIVE_SURFACE_REFRESH_COMMAND}`,
    );
    assert.deepEqual(
      warning?.data?.refresh_commands,
      [STABLE_SURFACE_REFRESH_COMMAND, LIVE_SURFACE_REFRESH_COMMAND],
    );
  });

  it('the commands it recommends are ones the CLI actually accepts', () => {
    // The 2c-class tripwire this file was missing: runExport (export.ts) exits
    // with "--format, --detect, or --all is required" unless a mode flag is
    // present. A recovery command the engine itself rejects is the exact drift
    // pln#638 exists to eliminate — and it shipped in 1.20.0 anyway. Exact
    // token contract rather than a mode-flag regex (codex review, PR #163):
    // a loose match would accept `--format` with no argument, or a command
    // that lost its `--write` and silently became a stdout dump.
    assert.deepEqual(
      STABLE_SURFACE_REFRESH_COMMAND.split(' '),
      ['brainclaw', 'export', '--all', '--write'],
    );
    assert.deepEqual(LIVE_SURFACE_REFRESH_COMMAND.split(' '), ['brainclaw', 'refresh']);
  });

  it('carries NO next_actions — there is no MCP tool that regenerates', () => {
    // Deliberate. `bclaw_setup` is the onboarding wizard and takes no write flag,
    // so pointing at it would ship args the engine rejects — the exact drift this
    // plan exists to eliminate. pln#634's rule: no genuine follow-up, no field.
    const warning = staleSurfaceWarning({
      stale: [{ relativePath: 'CLAUDE.md', stampedVersion: '1.10.0', kind: 'stable' }],
      freshCount: 0,
      unknownCount: 0,
    }, '1.18.0');
    assert.equal(warning?.next_actions, undefined);
  });

  it('caps the reported list and says how many it omitted', () => {
    const stale = Array.from({ length: 12 }, (_, i) => (
      { relativePath: `f${i}.md`, stampedVersion: '1.0.0', kind: 'stable' as const }
    ));
    const warning = staleSurfaceWarning({ stale, freshCount: 0, unknownCount: 0 }, '1.18.0');
    assert.match(warning!.message, /\+4 more/);
    assert.equal(warning?.data?.stale_surfaces_omitted, 4);
  });
});
