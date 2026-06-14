import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assessBrainclawVersion,
  checkBrainclawInstallableUpdate,
  DEFAULT_LOCAL_RELEASE_MANIFEST_PATH,
  getInstalledBrainclawVersion,
  publishLocalBrainclawRelease,
  renderBrainclawInstallableUpdateNotice,
} from '../../src/core/brainclaw-version.js';
import { AgentReleaseNotesSchema } from '../../src/core/schema.js';

describe('core/brainclaw-version', () => {
  it('reads the installed CLI version from package metadata', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'),
    ) as { version?: string };
    assert.equal(getInstalledBrainclawVersion(), packageJson.version);
  });

  it('reports an upgrade requirement when the minimum version is higher than the local CLI', () => {
    const result = assessBrainclawVersion({
      minimum_brainclaw_version: '99.0.0',
      brainclaw_upgrade_message: 'New manifest-aware bootstrapping.',
      brainclaw_upgrade_command: 'npm pack && npm i -g ./brainclaw-99.0.0.tgz',
    });

    assert.equal(result.status, 'upgrade_required');
    assert.equal(result.minimum_brainclaw_version, '99.0.0');
    assert.equal(result.upgrade_message, 'New manifest-aware bootstrapping.');
    assert.equal(result.upgrade_command, 'npm pack && npm i -g ./brainclaw-99.0.0.tgz');
  });

  it('rejects invalid configured version strings', () => {
    const result = assessBrainclawVersion({
      minimum_brainclaw_version: 'latest',
    });

    assert.equal(result.status, 'invalid_config');
    assert.ok(result.message.includes('minimum_brainclaw_version=latest'));
  });

  it('detects a newer installable build from a local-pack manifest', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-version-check-'));
    try {
      const manifestPath = path.join(dir, 'brainclaw-release.json');
      // Use a clearly-future version so the test stays green regardless of
      // what the current package.json version is (we only need the comparison
      // "manifest > installed").
      fs.writeFileSync(manifestPath, JSON.stringify({
        version: 1,
        channel: 'local-pack',
        package_name: 'brainclaw',
        latest_installable_version: '99.0.0',
        artifact_path: './brainclaw-99.0.0.tgz',
        release_notes: 'Adds local installable update checks.',
      }, null, 2), 'utf-8');

      const result = checkBrainclawInstallableUpdate({
        brainclaw_update_source: {
          type: 'local-pack',
          manifest_path: manifestPath,
        },
        brainclaw_upgrade_command: undefined,
        brainclaw_upgrade_message: undefined,
      }, dir);

      assert.equal(result.status, 'update_available');
      assert.equal(result.latest_installable_version, '99.0.0');
      assert.ok(result.install_command?.includes('brainclaw-99.0.0.tgz'));
      assert.equal(result.release_notes, 'Adds local installable update checks.');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves npm dist-tags for an explicit npm update source', () => {
    const result = checkBrainclawInstallableUpdate({
      brainclaw_update_source: {
        type: 'npm',
        package_name: 'brainclaw',
        dist_tag: 'prelaunch',
      },
      brainclaw_upgrade_command: undefined,
      brainclaw_upgrade_message: undefined,
    }, process.cwd(), {
      npmLookup: () => ({
        dist_tags: {
          latest: '0.19.11',
          prelaunch: '99.0.0',
        },
        checked_at: '2026-03-22T10:00:00.000Z',
        cached: false,
      }),
    });

    assert.equal(result.status, 'update_available');
    assert.equal(result.source_type, 'npm');
    assert.equal(result.latest_installable_version, '99.0.0');
    assert.equal(result.install_command, 'npm install -g brainclaw@99.0.0');
    assert.equal(result.checked_at, '2026-03-22T10:00:00.000Z');
    assert.equal(result.cached, false);
  });

  it('falls back to the public npm latest channel when requested', () => {
    const result = checkBrainclawInstallableUpdate({
      brainclaw_upgrade_command: undefined,
      brainclaw_upgrade_message: undefined,
    }, process.cwd(), {
      useDefaultNpmSource: true,
      npmLookup: () => ({
        dist_tags: {
          latest: '99.0.0',
        },
        checked_at: '2026-03-22T10:00:00.000Z',
        cached: true,
      }),
    });

    assert.equal(result.status, 'update_available');
    assert.equal(result.source_type, 'npm');
    assert.equal(result.default_source, true);
    assert.equal(result.source_description, 'brainclaw@latest (default npm channel)');
    assert.equal(result.cached, true);
  });

  it('publishes a local installable release manifest and tarball into .releases', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-local-release-'));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'brainclaw',
        version: '0.6.1',
        type: 'module',
        files: ['index.js'],
        scripts: {
          'build:release': 'node build-release.mjs',
          'pack:check': 'node pack-check.mjs',
        },
      }, null, 2), 'utf-8');
      fs.writeFileSync(path.join(dir, 'index.js'), 'export const value = 1;\n', 'utf-8');
      fs.writeFileSync(path.join(dir, 'build-release.mjs'), 'import fs from "node:fs"; fs.writeFileSync("build-release.marker", "ok\\n");\n', 'utf-8');
      fs.writeFileSync(path.join(dir, 'pack-check.mjs'), 'import fs from "node:fs"; fs.writeFileSync("pack-check.marker", "ok\\n");\n', 'utf-8');

      const result = publishLocalBrainclawRelease(dir, {
        releaseNotes: 'Local self-update build.',
      });

      assert.equal(result.workspace_version, '0.6.1');
      assert.equal(result.manifest_path, DEFAULT_LOCAL_RELEASE_MANIFEST_PATH);
      assert.ok(result.artifact_path.includes('.releases/'));
      assert.ok(result.artifact_path.endsWith('.tgz'));
      assert.ok(fs.existsSync(path.join(dir, '.releases', 'brainclaw-local.json')));
      assert.ok(fs.existsSync(path.join(dir, result.artifact_path.replace(/^\.\//, '').replace(/\//g, path.sep))));
      assert.ok(fs.existsSync(path.join(dir, 'build-release.marker')));
      assert.ok(fs.existsSync(path.join(dir, 'pack-check.marker')));

      const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.releases', 'brainclaw-local.json'), 'utf-8'));
      assert.equal(manifest.latest_installable_version, '0.6.1');
      assert.equal(manifest.artifact_path, './brainclaw-0.6.1.tgz');
      assert.equal(manifest.release_notes, 'Local self-update build.');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stores agent_release_notes in the local-pack manifest when provided', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-arn-publish-'));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'brainclaw',
        version: '0.6.2',
        type: 'module',
        files: ['index.js'],
        scripts: {
          'build:release': 'node build-release.mjs',
          'pack:check': 'node pack-check.mjs',
        },
      }, null, 2), 'utf-8');
      fs.writeFileSync(path.join(dir, 'index.js'), 'export const value = 1;\n', 'utf-8');
      fs.writeFileSync(path.join(dir, 'build-release.mjs'), 'import fs from "node:fs"; fs.writeFileSync("build-release.marker", "ok\\n");\n', 'utf-8');
      fs.writeFileSync(path.join(dir, 'pack-check.mjs'), 'import fs from "node:fs"; fs.writeFileSync("pack-check.marker", "ok\\n");\n', 'utf-8');

      const arn = {
        summary: 'Adds worktree isolation for multi-agent sessions.',
        breaking_risk: 'none' as const,
        highlights: ['feat: brainclaw worktree create|list|remove|prune', 'feat: claim TTL'],
        action_recommendation: 'Safe to auto-install.',
      };

      const result = publishLocalBrainclawRelease(dir, {
        releaseNotes: 'v0.6.2 changes.',
        agentReleaseNotes: arn,
      });

      assert.deepEqual(result.agent_release_notes, arn);
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.releases', 'brainclaw-local.json'), 'utf-8'));
      assert.equal(manifest.agent_release_notes.summary, arn.summary);
      assert.equal(manifest.agent_release_notes.breaking_risk, 'none');
      assert.deepEqual(manifest.agent_release_notes.highlights, arn.highlights);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('surfaces agent_release_notes from local-pack manifest in installable update check', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-arn-check-'));
    try {
      const arn = {
        summary: 'Claim TTL end-to-end.',
        breaking_risk: 'low' as const,
        highlights: ['feat: claim expiry auto-cleanup'],
        action_recommendation: 'Review TTL defaults before upgrading shared projects.',
      };
      const manifestPath = path.join(dir, 'brainclaw-release.json');
      // Future-proof version (> any currently-shipped package) so the
      // installable-update check keeps producing `update_available`.
      fs.writeFileSync(manifestPath, JSON.stringify({
        version: 1,
        channel: 'local-pack',
        package_name: 'brainclaw',
        latest_installable_version: '99.0.0',
        artifact_path: './brainclaw-99.0.0.tgz',
        release_notes: 'Claim TTL.',
        agent_release_notes: arn,
      }, null, 2), 'utf-8');

      const result = checkBrainclawInstallableUpdate({
        brainclaw_update_source: { type: 'local-pack', manifest_path: manifestPath },
        brainclaw_upgrade_command: undefined,
        brainclaw_upgrade_message: undefined,
      }, dir);

      assert.equal(result.status, 'update_available');
      assert.ok(result.agent_release_notes, 'agent_release_notes should be populated');
      assert.equal(result.agent_release_notes!.summary, arn.summary);
      assert.equal(result.agent_release_notes!.breaking_risk, 'low');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('AgentReleaseNotesSchema', () => {
  it('parses a minimal valid payload (summary only)', () => {
    const result = AgentReleaseNotesSchema.parse({ summary: 'Fix critical bug in store.' });
    assert.equal(result.summary, 'Fix critical bug in store.');
    assert.equal(result.breaking_risk, 'none'); // default
    assert.equal(result.agent_relevance, undefined);
  });

  it('parses a full payload with all optional fields', () => {
    const result = AgentReleaseNotesSchema.parse({
      summary: 'Major coordination upgrade.',
      agent_relevance: 'New bclaw_worktree_create MCP tool. bclaw_claim now supports createWorktree param.',
      breaking_risk: 'medium',
      recommended_for: ['multi-agent', 'large-teams'],
      highlights: ['feat: git worktree isolation', 'feat: claim TTL'],
      action_recommendation: 'Needs operator review before upgrading shared projects.',
    });
    assert.equal(result.breaking_risk, 'medium');
    assert.deepEqual(result.recommended_for, ['multi-agent', 'large-teams']);
    assert.equal(result.highlights?.length, 2);
  });

  it('rejects an empty summary', () => {
    assert.throws(() => AgentReleaseNotesSchema.parse({ summary: '' }));
  });

  it('rejects an unknown breaking_risk value', () => {
    assert.throws(() => AgentReleaseNotesSchema.parse({ summary: 'ok', breaking_risk: 'critical' }));
  });
});

describe('renderBrainclawInstallableUpdateNotice — structured notes', () => {
  it('returns null when no update is available', () => {
    assert.equal(renderBrainclawInstallableUpdateNotice({
      checked: true,
      source_type: 'local-pack',
      source_description: null,
      latest_installable_version: '0.1.0',
      artifact_path: null,
      install_command: null,
      release_notes: null,
      status: 'up_to_date',
      message: 'Up to date.',
    }), null);
  });

  it('renders structured notes with highlights when agent_release_notes is present', () => {
    const notice = renderBrainclawInstallableUpdateNotice({
      checked: true,
      source_type: 'local-pack',
      source_description: null,
      latest_installable_version: '99.0.0',
      artifact_path: null,
      install_command: 'npm install -g brainclaw@99.0.0',
      release_notes: 'Changelog text.',
      agent_release_notes: {
        summary: 'Adds worktree isolation.',
        breaking_risk: 'none',
        highlights: ['feat: worktree create', 'feat: claim TTL'],
        action_recommendation: 'Safe to auto-install.',
      },
      status: 'update_available',
      message: 'Update available: 99.0.0.',
    });
    assert.ok(notice, 'should return a non-null notice');
    assert.ok(notice!.includes('Summary: Adds worktree isolation.'));
    assert.ok(notice!.includes('• feat: worktree create'));
    assert.ok(notice!.includes('Action: Safe to auto-install.'));
    // Should NOT include plain "Why update:" fallback when structured notes are present
    assert.ok(!notice!.includes('Why update:'));
  });

  it('falls back to plain release_notes when no structured notes present', () => {
    const notice = renderBrainclawInstallableUpdateNotice({
      checked: true,
      source_type: 'npm',
      source_description: null,
      latest_installable_version: '99.0.0',
      artifact_path: null,
      install_command: 'npm install -g brainclaw@99.0.0',
      release_notes: 'See changelog at github.',
      status: 'update_available',
      message: 'Update available.',
    });
    assert.ok(notice!.includes('Why update: See changelog at github.'));
  });

  it('omits breaking risk line when risk is none', () => {
    const notice = renderBrainclawInstallableUpdateNotice({
      checked: true,
      source_type: 'local-pack',
      source_description: null,
      latest_installable_version: '99.0.0',
      artifact_path: null,
      install_command: null,
      release_notes: null,
      agent_release_notes: {
        summary: 'Minor patch.',
        breaking_risk: 'none',
      },
      status: 'update_available',
      message: 'Update available.',
    });
    assert.ok(!notice!.includes('Breaking risk'));
  });
});
