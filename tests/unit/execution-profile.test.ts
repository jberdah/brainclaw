import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClaimEnvPrefix,
  detectHostExecutionProfile,
  resolveExecutionProfile,
  renderEnvSet,
  verifyNodeBinary,
  type ExecutionProfile,
} from '../../src/core/execution-profile.js';

// ── Detection ──────────────────────────────────────────────────────────────

describe('execution-profile/detectHostExecutionProfile', () => {
  it('detects pwsh on Windows when PSModulePath is set', () => {
    const profile = detectHostExecutionProfile({
      env: { PSModulePath: 'C:\\Modules', COMSPEC: 'C:\\Windows\\System32\\cmd.exe' },
      platform: 'win32',
    });
    assert.equal(profile.os, 'win');
    assert.equal(profile.shell, 'pwsh');
  });

  it('falls back to cmd on Windows when only COMSPEC is set', () => {
    const profile = detectHostExecutionProfile({
      env: { COMSPEC: 'C:\\Windows\\System32\\cmd.exe' },
      platform: 'win32',
    });
    assert.equal(profile.shell, 'cmd');
  });

  it('falls back to pwsh on Windows when neither variable is set', () => {
    const profile = detectHostExecutionProfile({ env: {}, platform: 'win32' });
    assert.equal(profile.shell, 'pwsh');
    assert.equal(profile.os, 'win');
  });

  it('detects bash from $SHELL on Linux', () => {
    const profile = detectHostExecutionProfile({
      env: { SHELL: '/bin/bash' },
      platform: 'linux',
    });
    assert.equal(profile.shell, 'bash');
    assert.equal(profile.os, 'linux');
  });

  it('detects zsh from $SHELL on macOS', () => {
    const profile = detectHostExecutionProfile({
      env: { SHELL: '/bin/zsh' },
      platform: 'darwin',
    });
    assert.equal(profile.shell, 'zsh');
    assert.equal(profile.os, 'mac');
  });

  it('falls back to bash on POSIX without $SHELL', () => {
    const profile = detectHostExecutionProfile({ env: {}, platform: 'linux' });
    assert.equal(profile.shell, 'bash');
  });

  it('treats unknown POSIX shells (fish, csh, …) as bash', () => {
    const profile = detectHostExecutionProfile({
      env: { SHELL: '/usr/local/bin/fish' },
      platform: 'linux',
    });
    assert.equal(profile.shell, 'bash');
  });

  it('treats unknown platforms as linux (most permissive default)', () => {
    const profile = detectHostExecutionProfile({
      env: {},
      platform: 'aix' as NodeJS.Platform,
    });
    assert.equal(profile.os, 'linux');
  });

  it('node_path defaults to process.execPath when available', () => {
    const profile = detectHostExecutionProfile({ env: {}, platform: 'linux' });
    assert.equal(profile.node_path, process.execPath);
  });

  it('applies safe defaults for spawn_method / working_dir / sandbox', () => {
    const profile = detectHostExecutionProfile({ env: {}, platform: 'linux' });
    assert.equal(profile.spawn_method, 'cli');
    assert.equal(profile.working_dir_strategy, 'cwd');
    assert.equal(profile.sandbox_profile, 'none');
  });
});

// ── Resolution ─────────────────────────────────────────────────────────────

describe('execution-profile/resolveExecutionProfile', () => {
  it('agent override beats host', () => {
    const host: ExecutionProfile = { shell: 'pwsh', os: 'win' };
    const agent: ExecutionProfile = { shell: 'bash' };
    const resolved = resolveExecutionProfile(host, agent);
    assert.equal(resolved.shell, 'bash');
    assert.equal(resolved.os, 'win'); // host kept where agent did not override
  });

  it('host fills in fields the agent leaves blank', () => {
    const host: ExecutionProfile = { shell: 'pwsh', os: 'win', sandbox_profile: 'workspace-write' };
    const resolved = resolveExecutionProfile(host, undefined);
    assert.equal(resolved.shell, 'pwsh');
    assert.equal(resolved.os, 'win');
    assert.equal(resolved.sandbox_profile, 'workspace-write');
  });

  it('module defaults fill in fields the host AND agent leave blank', () => {
    const resolved = resolveExecutionProfile(undefined, undefined);
    assert.equal(resolved.shell, 'bash');
    assert.equal(resolved.os, 'linux');
    assert.equal(resolved.spawn_method, 'cli');
    assert.equal(resolved.working_dir_strategy, 'cwd');
    assert.equal(resolved.sandbox_profile, 'none');
  });

  it('partial host with no agent override resolves to host union defaults', () => {
    const host: ExecutionProfile = { shell: 'zsh' };
    const resolved = resolveExecutionProfile(host, undefined);
    assert.equal(resolved.shell, 'zsh');
    assert.equal(resolved.os, 'linux');     // module default
    assert.equal(resolved.sandbox_profile, 'none'); // module default
  });

  it('does not throw on completely empty host AND agent', () => {
    assert.doesNotThrow(() => resolveExecutionProfile(undefined, undefined));
    assert.doesNotThrow(() => resolveExecutionProfile({}, {}));
  });
});

// ── renderEnvSet ───────────────────────────────────────────────────────────

describe('execution-profile/renderEnvSet', () => {
  it('bash uses KEY="VALUE"', () => {
    assert.equal(renderEnvSet('bash', 'BRAINCLAW_CLAIM_ID', 'clm_x'), 'BRAINCLAW_CLAIM_ID="clm_x"');
  });

  it('zsh uses KEY="VALUE"', () => {
    assert.equal(renderEnvSet('zsh', 'X', 'y'), 'X="y"');
  });

  it('sh uses KEY="VALUE"', () => {
    assert.equal(renderEnvSet('sh', 'X', 'y'), 'X="y"');
  });

  it('pwsh uses $env:KEY="VALUE"', () => {
    assert.equal(renderEnvSet('pwsh', 'BRAINCLAW_CLAIM_ID', 'clm_x'), '$env:BRAINCLAW_CLAIM_ID="clm_x"');
  });

  it('cmd uses set KEY=VALUE (no quotes)', () => {
    assert.equal(renderEnvSet('cmd', 'BRAINCLAW_CLAIM_ID', 'clm_x'), 'set BRAINCLAW_CLAIM_ID=clm_x');
  });
});

// ── buildClaimEnvPrefix ────────────────────────────────────────────────────

describe('execution-profile/buildClaimEnvPrefix', () => {
  // Bash/zsh/sh use the LEGACY unquoted form — byte-identical to the pre-
  // pln#496 dispatcher.ts:buildEnvPrefix output. This is intentional: codex
  // review of commit 87a9f73 (asgn_02c3c742) flagged the quoted variant as
  // a POSIX output drift versus the consolidated call sites; preserving
  // the legacy bytes keeps any downstream string-match safe.
  it('bash uses unquoted KEY=VALUE (legacy byte-identical)', () => {
    assert.equal(
      buildClaimEnvPrefix('clm_x', { shell: 'bash' }),
      'BRAINCLAW_CLAIM_ID=clm_x ',
    );
  });

  it('zsh inherits the bash unquoted form', () => {
    assert.equal(buildClaimEnvPrefix('clm_x', { shell: 'zsh' }), 'BRAINCLAW_CLAIM_ID=clm_x ');
  });

  it('sh inherits the bash unquoted form', () => {
    // Explicit sh case requested by codex review on 87a9f73 — the previous
    // matrix grouped sh under bash/zsh defaults but never asserted it.
    assert.equal(buildClaimEnvPrefix('clm_x', { shell: 'sh' }), 'BRAINCLAW_CLAIM_ID=clm_x ');
  });

  it('cmd uses set KEY=VALUE && (Windows shell:true default)', () => {
    assert.equal(
      buildClaimEnvPrefix('clm_x', { shell: 'cmd' }),
      'set BRAINCLAW_CLAIM_ID=clm_x && ',
    );
  });

  it('pwsh uses $env:KEY="VALUE"; (statement separator, opt-in via override)', () => {
    assert.equal(
      buildClaimEnvPrefix('clm_x', { shell: 'pwsh' }),
      '$env:BRAINCLAW_CLAIM_ID="clm_x"; ',
    );
  });

  it('returns empty string when claimId is undefined / empty / dry-run sentinel', () => {
    assert.equal(buildClaimEnvPrefix(undefined), '');
    assert.equal(buildClaimEnvPrefix(''), '');
    assert.equal(buildClaimEnvPrefix('(dry-run)'), '');
  });

  it('host default on Windows is cmd (legacy parity, NOT pwsh-via-PSModulePath)', () => {
    // Codex review finding: PSModulePath sniff making pwsh the default on
    // modern Windows hosts was a regression because the legacy spawn
    // pipeline runs through child_process.spawn(shell:true) which Windows
    // resolves to cmd. The fix locks the no-shell-override path to cmd
    // on Windows, so pwsh becomes opt-in via explicit { shell: 'pwsh' }.
    if (process.platform === 'win32') {
      const result = buildClaimEnvPrefix('clm_y');
      assert.match(result, /^set BRAINCLAW_CLAIM_ID=clm_y && $/);
    } else {
      // On non-Windows runners (CI Linux), no host override → bash form.
      const result = buildClaimEnvPrefix('clm_y');
      assert.match(result, /^BRAINCLAW_CLAIM_ID=clm_y $/);
    }
  });

  it('falls back to host detection when shell is not provided', () => {
    const result = buildClaimEnvPrefix('clm_y');
    assert.ok(result.length > 0, 'should produce a prefix');
    assert.match(result, /BRAINCLAW_CLAIM_ID/);
  });
});

// ── verifyNodeBinary ───────────────────────────────────────────────────────

describe('execution-profile/verifyNodeBinary', () => {
  it('returns the version when the running node is reachable', () => {
    const version = verifyNodeBinary(process.execPath);
    assert.ok(version);
    assert.match(version!, /^v\d+/);
  });

  it('returns undefined when nodePath is undefined', () => {
    assert.equal(verifyNodeBinary(undefined), undefined);
  });

  it('returns undefined for a non-existent path', () => {
    const result = verifyNodeBinary('/path/that/does/not/exist/node');
    assert.equal(result, undefined);
  });
});
