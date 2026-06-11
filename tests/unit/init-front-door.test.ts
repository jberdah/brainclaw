import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'yaml';
import { spawnSync } from 'node:child_process';
import { runInit } from '../../src/commands/init.js';
import { loadConfig } from '../../src/core/config.js';
import { BACKUP_DIR_PREFIX } from '../../src/core/upgrades/backup.js';

function tmpDir(prefix: string = 'bclaw-init-front-door-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initGit(dir: string): void {
  spawnSync('git', ['init'], { cwd: dir, encoding: 'utf-8' });
}

describe('init front-door (pln#556 steps 3-5)', () => {
  let dir: string;
  let prevCwd: string;

  beforeEach(() => {
    dir = tmpDir();
    initGit(dir);
    prevCwd = process.cwd();
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('seeds governance.curators with the human running init', async () => {
    // pln#556 step 5: solo-agent fresh defaults — approval_policy=review +
    // curators=[] on fresh init = every candidate trapped pending forever.
    // The current_agent becomes the default curator.
    await runInit({ yes: true, skipMachinePrereqs: true });
    const config = loadConfig(dir);
    assert.ok(config.governance, 'governance block should exist');
    assert.equal(config.governance!.curators.length, 1, 'curators should be seeded with one name');
    assert.equal(config.governance!.curators[0], config.current_agent);
  });

  it('--force takes a sibling backup before reconstructing config', async () => {
    // pln#556 step 4 / feedback_no_init_force: --force must not overwrite
    // without a recovery path.
    await runInit({ yes: true, skipMachinePrereqs: true });
    await runInit({ yes: true, force: true, skipMachinePrereqs: true });

    const backups = fs
      .readdirSync(dir)
      .filter((entry) => entry.startsWith(BACKUP_DIR_PREFIX));
    assert.ok(backups.length >= 1, `expected at least one backup, got ${JSON.stringify(backups)}`);
  });

  it('--force preserves curator personalisations through merge', async () => {
    // pln#556 step 4: redaction patterns, governance overrides, sensitive
    // paths, claim TTL — all must survive a force-reconstruction. Pre-merge
    // behaviour wiped them silently.
    await runInit({ yes: true, skipMachinePrereqs: true });

    // Customise the config the way a curator would.
    const configPath = path.join(dir, '.brainclaw', 'config.yaml');
    const raw = yaml.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    raw.redaction = {
      enabled: true,
      patterns: ['(?i)corp[_-]?internal', '(?i)customer[_-]?secret'],
    };
    raw.sensitive_paths = ['.env.local', 'private/', 'creds/'];
    raw.claims = { auto_release_after_hours: 72 };
    raw.governance = {
      approval_policy: 'review',
      curators: ['lead-curator', 'second-curator'],
      review_sla_hours: 12,
    };
    fs.writeFileSync(configPath, yaml.stringify(raw), 'utf-8');

    await runInit({ yes: true, force: true, skipMachinePrereqs: true });

    const reloaded = loadConfig(dir);
    assert.deepEqual(reloaded.redaction?.patterns, ['(?i)corp[_-]?internal', '(?i)customer[_-]?secret']);
    assert.deepEqual(reloaded.sensitive_paths, ['.env.local', 'private/', 'creds/']);
    assert.equal(reloaded.claims?.auto_release_after_hours, 72);
    assert.deepEqual(reloaded.governance?.curators, ['lead-curator', 'second-curator']);
    assert.equal(reloaded.governance?.review_sla_hours, 12);
  });
});
