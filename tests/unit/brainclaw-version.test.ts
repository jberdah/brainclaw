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
} from '../../src/core/brainclaw-version.js';

describe('core/brainclaw-version', () => {
  it('reads the installed CLI version from package metadata', () => {
    assert.equal(getInstalledBrainclawVersion(), '0.13.0');
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
      fs.writeFileSync(manifestPath, JSON.stringify({
        version: 1,
        channel: 'local-pack',
        package_name: 'brainclaw',
        latest_installable_version: '1.0.0',
        artifact_path: './brainclaw-1.0.0.tgz',
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
      assert.equal(result.latest_installable_version, '1.0.0');
      assert.ok(result.install_command?.includes('brainclaw-1.0.0.tgz'));
      assert.equal(result.release_notes, 'Adds local installable update checks.');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recognizes npm as a modeled but not yet implemented update source', () => {
    const result = checkBrainclawInstallableUpdate({
      brainclaw_update_source: {
        type: 'npm',
        package_name: 'brainclaw',
        dist_tag: 'latest',
      },
      brainclaw_upgrade_command: undefined,
      brainclaw_upgrade_message: undefined,
    }, process.cwd());

    assert.equal(result.status, 'unsupported_source');
    assert.equal(result.source_type, 'npm');
  });

  it('publishes a local installable release manifest and tarball into .releases', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-local-release-'));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'brainclaw',
        version: '0.6.1',
        type: 'module',
        files: ['index.js'],
      }, null, 2), 'utf-8');
      fs.writeFileSync(path.join(dir, 'index.js'), 'export const value = 1;\n', 'utf-8');

      const result = publishLocalBrainclawRelease(dir, {
        releaseNotes: 'Local self-update build.',
      });

      assert.equal(result.workspace_version, '0.6.1');
      assert.equal(result.manifest_path, DEFAULT_LOCAL_RELEASE_MANIFEST_PATH);
      assert.ok(result.artifact_path.includes('.releases/'));
      assert.ok(result.artifact_path.endsWith('.tgz'));
      assert.ok(fs.existsSync(path.join(dir, '.releases', 'brainclaw-local.json')));
      assert.ok(fs.existsSync(path.join(dir, result.artifact_path.replace(/^\.\//, '').replace(/\//g, path.sep))));

      const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.releases', 'brainclaw-local.json'), 'utf-8'));
      assert.equal(manifest.latest_installable_version, '0.6.1');
      assert.equal(manifest.artifact_path, './brainclaw-0.6.1.tgz');
      assert.equal(manifest.release_notes, 'Local self-update build.');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
