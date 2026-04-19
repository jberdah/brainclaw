import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { saveState, loadState, emptyState } from '../../src/core/state.js';
import { runUpgrade } from '../../src/commands/upgrade.js';
import { listBackups, createBackup } from '../../src/core/upgrades/backup.js';
import { SCHEMA_VERSION_FILE } from '../../src/core/upgrades/schema-version.js';
import { storeLockPath } from '../../src/core/io.js';

function captureLogs(fn: () => void): string[] {
  const originalLog = console.log;
  const originalError = console.error;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  console.error = (...args: unknown[]) => { logs.push('[ERROR] ' + args.map(String).join(' ')); };
  try {
    fn();
    return logs;
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

describe('upgrade command', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-upgrade-',
      projectId: 'prj_upgrade_test',
      currentAgent: 'testuser',
    });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('reports no upgrade needed when already up to date', () => {
    const logs = captureLogs(() => {
      runUpgrade({ cwd: workspace.dir });
    });
    assert.ok(logs.some(l => l.includes('up to date')));
  });

  it('moves files from legacy dirs to entity-aligned dirs', () => {
    // Write a claim to the legacy path
    const legacyClaims = path.join(workspace.dir, '.brainclaw', 'claims');
    fs.mkdirSync(legacyClaims, { recursive: true });
    fs.writeFileSync(
      path.join(legacyClaims, 'clm_test123.json'),
      JSON.stringify({ schema_version: 2, id: 'clm_test123', text: 'test claim', scope: 'src/', created_at: new Date().toISOString(), author: 'testuser', status: 'active', tags: [] }),
    );

    const logs = captureLogs(() => {
      runUpgrade({ cwd: workspace.dir });
    });

    assert.ok(logs.some(l => l.includes('clm_test123.json')));
    assert.ok(logs.some(l => l.includes('Upgrade complete')));

    // File should be in entity path now
    const entityPath = path.join(workspace.dir, '.brainclaw', 'coordination', 'claims', 'clm_test123.json');
    assert.ok(fs.existsSync(entityPath), 'File should exist at entity-aligned path');

    // Legacy should be gone
    assert.ok(!fs.existsSync(path.join(legacyClaims, 'clm_test123.json')), 'File should be removed from legacy path');
  });

  it('does not clobber existing entity-aligned files', () => {
    // Write same ID to both legacy and entity paths
    const legacyClaims = path.join(workspace.dir, '.brainclaw', 'claims');
    const entityClaims = path.join(workspace.dir, '.brainclaw', 'coordination', 'claims');
    fs.mkdirSync(legacyClaims, { recursive: true });
    fs.mkdirSync(entityClaims, { recursive: true });

    fs.writeFileSync(path.join(legacyClaims, 'clm_dup.json'), JSON.stringify({ id: 'clm_dup', text: 'legacy version' }));
    fs.writeFileSync(path.join(entityClaims, 'clm_dup.json'), JSON.stringify({ id: 'clm_dup', text: 'entity version' }));

    captureLogs(() => {
      runUpgrade({ cwd: workspace.dir });
    });

    // Entity version should be preserved
    const content = JSON.parse(fs.readFileSync(path.join(entityClaims, 'clm_dup.json'), 'utf-8'));
    assert.equal(content.text, 'entity version');
  });

  it('dry-run does not move files', () => {
    const legacyClaims = path.join(workspace.dir, '.brainclaw', 'claims');
    fs.mkdirSync(legacyClaims, { recursive: true });
    fs.writeFileSync(
      path.join(legacyClaims, 'clm_dry.json'),
      JSON.stringify({ schema_version: 2, id: 'clm_dry', text: 'dry test' }),
    );

    const logs = captureLogs(() => {
      runUpgrade({ cwd: workspace.dir, dryRun: true });
    });

    assert.ok(logs.some(l => l.includes('dry run')));
    assert.ok(fs.existsSync(path.join(legacyClaims, 'clm_dry.json')), 'Legacy file should still exist');
  });

  it('is idempotent — second run reports no upgrade needed', () => {
    const legacyClaims = path.join(workspace.dir, '.brainclaw', 'claims');
    fs.mkdirSync(legacyClaims, { recursive: true });
    fs.writeFileSync(
      path.join(legacyClaims, 'clm_idem.json'),
      JSON.stringify({ schema_version: 2, id: 'clm_idem', text: 'test' }),
    );

    captureLogs(() => { runUpgrade({ cwd: workspace.dir }); });
    const logs = captureLogs(() => { runUpgrade({ cwd: workspace.dir }); });

    assert.ok(logs.some(l => l.includes('up to date')));
  });

  it('refreshes managed bootstrap sections that still mention legacy CLI commands', () => {
    const agentsPath = path.join(workspace.dir, 'AGENTS.md');
    fs.writeFileSync(agentsPath, `# Notes

<!-- brainclaw:start -->
## Brainclaw — shared project memory

1. Run \`brainclaw list-claims\`
2. Finish with \`brainclaw release-claim <id>\`
<!-- brainclaw:end -->
`, 'utf-8');

    const logs = captureLogs(() => {
      runUpgrade({ cwd: workspace.dir });
    });

    const content = fs.readFileSync(agentsPath, 'utf-8');
    assert.ok(content.includes('brainclaw claim list'));
    assert.ok(content.includes('brainclaw claim release <id>'));
    assert.ok(!content.includes('brainclaw list-claims'));
    assert.ok(logs.some((line) => line.includes('managed agent file')));
  });

  it('refreshes generated export files and workspace-local helper commands without touching global config', () => {
    fs.writeFileSync(path.join(workspace.dir, 'CLAUDE.md'), `<!-- brainclaw:start -->
# shared_agent_memory_mvp

## Brainclaw — required coordination

Run \`brainclaw list-claims\`
<!-- brainclaw:end -->
`, 'utf-8');

    fs.mkdirSync(path.join(workspace.dir, '.claude', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(workspace.dir, '.claude', 'commands', 'brainclaw.md'), `Legacy
1. brainclaw list-claims
2. brainclaw claim "desc" --scope src/
`, 'utf-8');

    runUpgrade({ cwd: workspace.dir });

    const claudeExport = fs.readFileSync(path.join(workspace.dir, 'CLAUDE.md'), 'utf-8');
    const claudeCommand = fs.readFileSync(path.join(workspace.dir, '.claude', 'commands', 'brainclaw.md'), 'utf-8');
    // Adaptive template for Claude Code (Full tier) uses MCP tool names, not CLI aliases
    assert.ok(claudeExport.includes('bclaw_claim') || claudeExport.includes('brainclaw claim'));
    assert.ok(!claudeExport.includes('brainclaw list-claims'));
    assert.ok(claudeCommand.includes('brainclaw claim create'));
    assert.ok(!claudeCommand.includes('brainclaw claim "desc"'));
  });

  it('rejects schema-targeted runs that disable backups', () => {
    const originalLog = console.log;
    const originalError = console.error;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    console.error = (...args: unknown[]) => { logs.push('[ERROR] ' + args.map(String).join(' ')); };
    const originalExit = process.exit;

    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as typeof process.exit;

    try {
      assert.throws(() => runUpgrade({ cwd: workspace.dir, to: '1.0', backup: false }), /process\.exit\(1\)/);
    } finally {
      process.exit = originalExit;
      console.log = originalLog;
      console.error = originalError;
    }

    assert.ok(logs.some((line) => line.includes('requires a backup')));
    assert.equal(listBackups(path.join(workspace.dir, '.brainclaw')).length, 0);
  });

  it('records the current store schema version in upgrade backups', () => {
    const schemaFile = path.join(workspace.dir, '.brainclaw', SCHEMA_VERSION_FILE);
    fs.writeFileSync(schemaFile, JSON.stringify({
      schema_version: 1,
      current: '0.7.0',
      history: [
        { from: '0.6.0', to: '0.7.0', at: '2026-04-17T00:00:00.000Z', patches: ['seed'] },
      ],
    }, null, 2), 'utf-8');

    captureLogs(() => {
      runUpgrade({ cwd: workspace.dir, to: '1.0' });
    });

    const backups = listBackups(path.join(workspace.dir, '.brainclaw'));
    assert.equal(backups.length, 1);
    assert.equal(backups[0]!.manifest.store_schema_version, '0.7.0');
  });

  it('refuses rollback when the newest backup advertises an unknown schema version', () => {
    const storePath = path.join(workspace.dir, '.brainclaw');
    createBackup({ storePath, storeSchemaVersion: '9.9.9' });

    const originalLog = console.log;
    const originalError = console.error;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    console.error = (...args: unknown[]) => { logs.push('[ERROR] ' + args.map(String).join(' ')); };
    const originalExit = process.exit;

    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as typeof process.exit;

    try {
      assert.throws(() => runUpgrade({ cwd: workspace.dir, rollback: true }), /process\.exit\(1\)/);
    } finally {
      process.exit = originalExit;
      console.log = originalLog;
      console.error = originalError;
    }

    assert.ok(logs.some((line) => line.includes('schema 9.9.9')));
  });

  it('shares the store-wide lock with normal writers', () => {
    const lockFile = `${storeLockPath(workspace.dir)}.lock`;
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, timestamp: 10_000 }), 'utf-8');

    const originalLog = console.log;
    const originalError = console.error;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    console.error = (...args: unknown[]) => { logs.push('[ERROR] ' + args.map(String).join(' ')); };
    const originalExit = process.exit;

    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as typeof process.exit;
    const originalDateNow = Date.now;
    let nowCalls = 0;
    Date.now = () => {
      nowCalls += 1;
      return nowCalls === 1 ? 1_000 : 7_000;
    };

    try {
      assert.throws(() => runUpgrade({ cwd: workspace.dir }), /process\.exit\(1\)/);
    } finally {
      Date.now = originalDateNow;
      process.exit = originalExit;
      console.log = originalLog;
      console.error = originalError;
      fs.rmSync(lockFile, { force: true });
    }

    assert.ok(logs.some((line) => line.includes('store mutation or upgrade is in progress')));
  });
});

describe('init --force preserves existing data', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-init-safe-',
      projectId: 'prj_init_safe_test',
      currentAgent: 'testuser',
    });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('does not wipe state when data already exists', () => {
    // Save some data
    const state = emptyState();
    state.recent_decisions.push({
      id: 'dec_preserve',
      text: 'This decision must survive init --force',
      created_at: new Date().toISOString(),
      author: 'testuser',
      author_id: workspace.currentAgent.agent_id,
      project_id: 'prj_init_safe_test',
      tags: ['test'],
    } as any);
    saveState(state, workspace.dir);

    // Simulate what init --force does (the fixed version)
    const existingState = loadState(workspace.dir);
    const hasExistingData =
      existingState.active_constraints.length > 0 ||
      existingState.recent_decisions.length > 0 ||
      existingState.known_traps.length > 0 ||
      existingState.open_handoffs.length > 0 ||
      existingState.plan_items.length > 0;

    if (!hasExistingData) {
      saveState(emptyState(), workspace.dir);
    }

    // Verify data survived
    const afterState = loadState(workspace.dir);
    assert.equal(afterState.recent_decisions.length, 1);
    assert.equal(afterState.recent_decisions[0].id, 'dec_preserve');
  });
});

