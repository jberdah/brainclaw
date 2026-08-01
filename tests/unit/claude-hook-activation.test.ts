/**
 * pln#636 C1, second half (review finding F2) — GENERATION IS NOT ACTIVATION.
 *
 * The original C1 scope repaired the hook script's internals and left it unwired:
 * `install-hooks` merely PRINTED activation instructions. A repaired script
 * nobody activates is still dead, so the writer has to own the wiring the way the
 * Codex writer has owned `.codex/hooks.json` since v1.17.0.
 *
 * The tests that matter most here are the non-destructive ones. This file holds
 * the operator's own permission allow-list; clobbering it would be a far worse
 * outcome than an unactivated advisory (trp_5f342186 — a hook mechanism may never
 * be the thing that destroys work).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { activateClaudePreToolHook } from '../../src/commands/install-hooks.js';

describe('PreToolUse hook activation — additive merge into .claude/settings.json', { concurrency: false }, () => {
  let root: string;
  let settingsPath: string;
  const hookPath = 'C:\\repo\\.git\\hooks\\claude-pre-tool.sh';
  const expectedCommand = 'C:/repo/.git/hooks/claude-pre-tool.sh';

  function readSettings(): Record<string, any> {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-hook-activate-'));
    settingsPath = path.join(root, '.claude', 'settings.json');
  });

  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('creates settings.json with the matcher-array shape Claude Code accepts', () => {
    const result = activateClaudePreToolHook(root, hookPath);
    assert.equal(result.status, 'activated');

    const entry = readSettings().hooks.PreToolUse[0];
    assert.equal(entry.matcher, 'Edit|Write|MultiEdit|NotebookEdit');
    assert.equal(entry.hooks[0].type, 'command');
    assert.equal(entry.hooks[0].command, expectedCommand, 'the command must be POSIX-style — it runs through a shell');
  });

  it('never matches Bash — a shell command has no statically knowable footprint', () => {
    activateClaudePreToolHook(root, hookPath);
    assert.ok(
      !readSettings().hooks.PreToolUse[0].matcher.includes('Bash'),
      'matching Bash would force the hook to guess, which is the noise that made v1 ignorable',
    );
  });

  it('PRESERVES the operator\'s permission allow-list', () => {
    // The single most important assertion in this file. Rewriting settings.json
    // from scratch would silently drop this.
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      permissions: { allow: ['Bash(npm run:*)', 'Read(//c/Users/dev/**)'] },
      someFutureKey: { nested: true },
    }, null, 2));

    assert.equal(activateClaudePreToolHook(root, hookPath).status, 'activated');
    const after = readSettings();
    assert.deepEqual(after.permissions.allow, ['Bash(npm run:*)', 'Read(//c/Users/dev/**)']);
    assert.deepEqual(after.someFutureKey, { nested: true }, 'unknown keys must survive untouched');
    assert.equal(after.hooks.PreToolUse.length, 1);
  });

  it('APPENDS to an existing PreToolUse array instead of replacing it', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'my-guard.py' }] }],
        PostToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'mine.sh' }] }],
      },
    }, null, 2));

    activateClaudePreToolHook(root, hookPath);
    const hooks = readSettings().hooks;
    assert.equal(hooks.PreToolUse.length, 2, 'the operator\'s own PreToolUse hook must survive');
    assert.equal(hooks.PreToolUse[0].hooks[0].command, 'my-guard.py');
    assert.equal(hooks.PreToolUse[1].hooks[0].command, expectedCommand);
    assert.ok(hooks.PostToolUse, 'unrelated hook events must survive');
  });

  it('is idempotent — a second run reports already_active and changes nothing', () => {
    activateClaudePreToolHook(root, hookPath);
    const first = fs.readFileSync(settingsPath, 'utf-8');

    const second = activateClaudePreToolHook(root, hookPath);
    assert.equal(second.status, 'already_active');
    assert.equal(fs.readFileSync(settingsPath, 'utf-8'), first, 'no duplicate entry, no rewrite');
  });

  it('recognises an already-active hook written with backslashes', () => {
    // An operator who wired it by hand on Windows may have used native separators.
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: hookPath }] }] },
    }, null, 2));
    assert.equal(activateClaudePreToolHook(root, hookPath).status, 'already_active');
  });

  it('REFUSES to touch unparseable settings.json, leaving it byte-identical', () => {
    // Non-negotiable: an advisory nicety may not destroy the operator's config.
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const garbage = '{ "permissions": { "allow": [ "oops"  // truncated';
    fs.writeFileSync(settingsPath, garbage);

    const result = activateClaudePreToolHook(root, hookPath);
    assert.equal(result.status, 'failed');
    assert.match((result as { reason: string }).reason, /valid JSON/);
    assert.equal(fs.readFileSync(settingsPath, 'utf-8'), garbage, 'the file must be untouched');
  });

  it('refuses a settings.json that is a JSON array rather than an object', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '[]');
    const result = activateClaudePreToolHook(root, hookPath);
    assert.equal(result.status, 'failed');
    assert.equal(fs.readFileSync(settingsPath, 'utf-8'), '[]');
  });

  it('tolerates a non-object hooks key rather than throwing', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: 'nonsense' }));
    const result = activateClaudePreToolHook(root, hookPath);
    assert.equal(result.status, 'activated');
    assert.equal(readSettings().hooks.PreToolUse.length, 1);
  });
});
