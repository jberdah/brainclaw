import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildExecutionContext } from '../../src/core/execution-context.js';

describe('core/execution-context', () => {
  it('detects git state, toolchains, and redacted env signals through the injected runner', () => {
    const snapshot = buildExecutionContext({
      cwd: 'C:/repo',
      env: {
        SHELL: '/bin/zsh',
        BRAINCLAW_AGENT: 'copilot',
        BRAINCLAW_SESSION_ID: 'sess_1234567890',
        CI: 'true',
        VIRTUAL_ENV: 'C:/repo/.venv',
      },
      runner: (command, args) => {
        const key = `${command} ${args.join(' ')}`;
        switch (key) {
          case 'git rev-parse --show-toplevel':
            return { status: 0, stdout: 'C:/repo\n', stderr: '' };
          case 'git rev-parse --abbrev-ref HEAD':
            return { status: 0, stdout: 'feat/context\n', stderr: '' };
          case 'git status --porcelain':
            return { status: 0, stdout: ' M src/app.ts\n', stderr: '' };
          case 'git remote':
            return { status: 0, stdout: 'origin\n', stderr: '' };
          case 'node --version':
            return { status: 0, stdout: 'v22.2.0\n', stderr: '' };
          case 'npm --version':
            return { status: 0, stdout: '10.1.0\n', stderr: '' };
          default:
            return { status: 1, stdout: '', stderr: 'missing' };
        }
      },
    });

    assert.equal(snapshot.workspace_root, 'C:/repo');
    assert.equal(snapshot.branch, 'feat/context');
    assert.equal(snapshot.git_status, 'dirty');
    assert.equal(snapshot.has_remote, true);
    assert.equal(snapshot.shell, 'zsh');
    assert.ok(snapshot.toolchains.some((tool) => tool.name === 'node' && tool.available && tool.version === 'v22.2.0'));
    assert.ok(snapshot.toolchains.some((tool) => tool.name === 'npm' && tool.available && tool.version === '10.1.0'));
    assert.ok(snapshot.toolchains.some((tool) => tool.name === 'pnpm' && tool.available === false));
    assert.ok(snapshot.env_signals.some((signal) => signal.name === 'BRAINCLAW_AGENT' && signal.value === 'copilot'));
    assert.ok(snapshot.env_signals.some((signal) => signal.name === 'BRAINCLAW_SESSION_ID' && signal.redacted));
    assert.ok(snapshot.env_signals.some((signal) => signal.name === 'VIRTUAL_ENV' && signal.value === '.venv'));
  });

  it('returns a partial snapshot when git and toolchains are unavailable', () => {
    const snapshot = buildExecutionContext({
      cwd: 'C:/repo',
      env: {
        PSModulePath: 'set',
      },
      runner: () => ({ status: 1, stdout: '', stderr: 'missing' }),
    });

    assert.equal(snapshot.git_status, 'unavailable');
    assert.equal(snapshot.has_remote, false);
    assert.equal(snapshot.branch, undefined);
    assert.equal(snapshot.shell, 'powershell');
    assert.ok(snapshot.toolchains.every((tool) => tool.available === false));
  });
});
