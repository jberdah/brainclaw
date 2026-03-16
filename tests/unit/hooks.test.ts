import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generateCursorHook,
  generateWindsurfHook,
  writeHook,
  writeDetectedAgentHooks,
} from '../../src/commands/hooks.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-hooks-'));
}

describe('hooks — generateCursorHook', () => {
  it('produces valid MDC frontmatter with alwaysApply: true', () => {
    const content = generateCursorHook('my-project');
    assert.ok(content.startsWith('---\n'), 'must start with YAML frontmatter delimiter');
    assert.ok(content.includes('alwaysApply: true'), 'must set alwaysApply: true');
    assert.ok(content.includes('my-project'), 'must include project name');
  });

  it('includes brainclaw context and session-end commands', () => {
    const content = generateCursorHook('proj');
    assert.ok(content.includes('brainclaw context'), 'must reference brainclaw context');
    assert.ok(content.includes('release-claim'), 'must reference release-claim');
    assert.ok(content.includes('session-end'), 'must reference session-end');
  });
});

describe('hooks — generateWindsurfHook', () => {
  it('includes SESSION START section', () => {
    const content = generateWindsurfHook('my-project');
    assert.ok(content.includes('SESSION START'), 'must have SESSION START marker');
    assert.ok(content.includes('brainclaw context'), 'must reference brainclaw context');
    assert.ok(content.includes('my-project'), 'must include project name');
  });

  it('includes session-end instructions', () => {
    const content = generateWindsurfHook('proj');
    assert.ok(content.includes('release-claim'), 'must reference release-claim');
    assert.ok(content.includes('session-end'), 'must reference session-end');
  });
});

describe('hooks — writeHook', () => {
  it('creates .mdc file verbatim (no sentinel wrapping)', () => {
    const dir = tmpDir();
    try {
      const content = generateCursorHook('test-project');
      const result = writeHook(content, '.cursor/rules/brainclaw-session.mdc', dir);
      assert.ok(result.created, 'should report created:true for new file');
      assert.equal(result.relativePath, '.cursor/rules/brainclaw-session.mdc');
      const written = fs.readFileSync(path.join(dir, '.cursor/rules/brainclaw-session.mdc'), 'utf-8');
      assert.ok(written.startsWith('---\n'), 'MDC file must preserve frontmatter');
      assert.ok(!written.includes('<!-- brainclaw:start -->'), 'MDC file must not have sentinel markers');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('upserts sentinel section in plain markdown rules files', () => {
    const dir = tmpDir();
    try {
      const content = generateWindsurfHook('test-project');
      writeHook(content, '.windsurfrules', dir);
      const written = fs.readFileSync(path.join(dir, '.windsurfrules'), 'utf-8');
      assert.ok(written.includes('<!-- brainclaw:start -->'), 'must have sentinel start');
      assert.ok(written.includes('<!-- brainclaw:end -->'), 'must have sentinel end');

      // second write must not duplicate
      writeHook(content, '.windsurfrules', dir);
      const written2 = fs.readFileSync(path.join(dir, '.windsurfrules'), 'utf-8');
      const count = (written2.match(/<!-- brainclaw:start -->/g) ?? []).length;
      assert.equal(count, 1, 'sentinel section must not be duplicated on repeated writes');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports created:false on second write', () => {
    const dir = tmpDir();
    try {
      const content = generateWindsurfHook('proj');
      writeHook(content, '.windsurfrules', dir);
      const second = writeHook(content, '.windsurfrules', dir);
      assert.equal(second.created, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates parent directories as needed', () => {
    const dir = tmpDir();
    try {
      writeHook('# test', '.cursor/rules/brainclaw-session.mdc', dir);
      assert.ok(fs.existsSync(path.join(dir, '.cursor/rules')), 'parent dirs must be created');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('hooks — writeDetectedAgentHooks', () => {
  it('writes cursor hook when agentName is cursor', () => {
    const dir = tmpDir();
    try {
      const results = writeDetectedAgentHooks('cursor', 'my-project', dir);
      assert.equal(results.length, 1);
      assert.equal(results[0].relativePath, '.cursor/rules/brainclaw-session.mdc');
      assert.ok(fs.existsSync(path.join(dir, '.cursor/rules/brainclaw-session.mdc')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes windsurf hook when agentName is windsurf', () => {
    const dir = tmpDir();
    try {
      const results = writeDetectedAgentHooks('windsurf', 'my-project', dir);
      assert.equal(results.length, 1);
      assert.equal(results[0].relativePath, '.windsurfrules');
      assert.ok(fs.existsSync(path.join(dir, '.windsurfrules')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty array for unknown agents', () => {
    const dir = tmpDir();
    try {
      const results = writeDetectedAgentHooks('github-copilot', 'my-project', dir);
      assert.equal(results.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
