import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runUninstall } from '../../src/commands/uninstall.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

describe('uninstall command', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-uninstall-' });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('refuses project uninstall in non-TTY mode without --yes', async () => {
    const originalExit = process.exit;
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as typeof process.exit;
    try {
      await assert.rejects(
        () => runUninstall({ project: true, cwd: workspace.dir }),
        /process\.exit\(1\)/,
      );
      assert.ok(fs.existsSync(path.join(workspace.dir, '.brainclaw')));
    } finally {
      process.exit = originalExit;
      if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
      if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
    }
  });

  it('strips brainclaw entries from shared configs without deleting user entries', async () => {
    writeJson(path.join(workspace.dir, '.mcp.json'), {
      mcpServers: {
        brainclaw: { command: 'npx', args: ['brainclaw', 'mcp'] },
        other: { command: 'other' },
      },
    });
    writeJson(path.join(workspace.dir, '.roo', 'mcp.json'), {
      mcpServers: {
        brainclaw: { command: 'npx' },
        rooUser: { command: 'user' },
      },
    });
    writeJson(path.join(workspace.dir, '.continue', 'config.json'), {
      mcpServers: [{ name: 'brainclaw', command: 'npx' }, { name: 'other', command: 'other' }],
    });
    writeJson(path.join(workspace.dir, 'opencode.json'), {
      mcp: { brainclaw: { type: 'local' }, other: { type: 'local' } },
    });
    writeJson(path.join(workspace.dir, '.claude', 'settings.local.json'), {
      permissions: {
        allow: ['Bash(npx brainclaw:*)', 'mcp__brainclaw__*', 'Bash(git status)'],
        additionalDirectories: [
          path.join(workspace.dir, '.claude', 'worktrees'),
          path.join(workspace.dir, 'user-owned'),
        ],
      },
    });

    await runUninstall({ project: true, yes: true, cwd: workspace.dir });

    const mcp = JSON.parse(fs.readFileSync(path.join(workspace.dir, '.mcp.json'), 'utf-8'));
    assert.deepEqual(Object.keys(mcp.mcpServers), ['other']);
    const roo = JSON.parse(fs.readFileSync(path.join(workspace.dir, '.roo', 'mcp.json'), 'utf-8'));
    assert.deepEqual(Object.keys(roo.mcpServers), ['rooUser']);
    const cont = JSON.parse(fs.readFileSync(path.join(workspace.dir, '.continue', 'config.json'), 'utf-8'));
    assert.deepEqual(cont.mcpServers.map((entry: { name: string }) => entry.name), ['other']);
    const opencode = JSON.parse(fs.readFileSync(path.join(workspace.dir, 'opencode.json'), 'utf-8'));
    assert.deepEqual(Object.keys(opencode.mcp), ['other']);
    const claude = JSON.parse(fs.readFileSync(path.join(workspace.dir, '.claude', 'settings.local.json'), 'utf-8'));
    assert.deepEqual(claude.permissions.allow, ['Bash(git status)']);
    assert.deepEqual(claude.permissions.additionalDirectories, [path.join(workspace.dir, 'user-owned')]);
  });
});
