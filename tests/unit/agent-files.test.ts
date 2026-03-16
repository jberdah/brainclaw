import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BRAINCLAW_SECTION_START,
  BRAINCLAW_SECTION_END,
  buildBrainclawSection,
  buildHygieneSection,
  upsertBrainclawSection,
  ensureClineMcpConfig,
  ensureCopilotSkill,
  ensureCursorMdc,
  ensureAgentFiles,
  ensureGitignoreEntries,
  ensureWindsurfMcpConfig,
  writeDetectedAgentAutoConfig,
} from '../../src/core/agent-files.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-agent-files-'));
}

describe('core/agent-files — buildBrainclawSection', () => {
  it('contains the sentinel markers', () => {
    const section = buildBrainclawSection('.brainclaw');
    assert.ok(section.includes(BRAINCLAW_SECTION_START));
    assert.ok(section.includes(BRAINCLAW_SECTION_END));
    assert.ok(section.includes('.brainclaw'));
  });

  it('contains session-start behavioral contract', () => {
    const section = buildBrainclawSection('.brainclaw');
    assert.ok(section.includes('brainclaw context'), 'should mention brainclaw context');
    assert.ok(section.includes('Session start'), 'should have session start section');
    assert.ok(section.includes('list-claims'), 'should mention list-claims for checking other agents');
  });

  it('contains before-finishing behavioral contract', () => {
    const section = buildBrainclawSection('.brainclaw');
    assert.ok(section.includes('release-claim'), 'should mention release-claim');
    assert.ok(section.includes('update-plan'), 'should mention update-plan');
    assert.ok(section.includes('Before finishing'), 'should have before finishing section');
  });

  it('contains recording-work quick reference', () => {
    const section = buildBrainclawSection('.brainclaw');
    assert.ok(section.includes('brainclaw decision'), 'should mention decision command');
    assert.ok(section.includes('brainclaw claim'), 'should mention claim command');
    assert.ok(section.includes('brainclaw plan'), 'should mention plan command');
  });
});

describe('core/agent-files — buildHygieneSection', () => {
  it('contains before-starting and before-finishing rules', () => {
    const section = buildHygieneSection();
    assert.ok(section.includes('brainclaw context'));
    assert.ok(section.includes('release-claim'));
    assert.ok(section.includes('update-plan'));
    assert.ok(section.includes('session-end'));
  });
});

describe('core/agent-files — upsertBrainclawSection', () => {
  it('appends to empty content', () => {
    const result = upsertBrainclawSection('', '<!-- brainclaw:start -->\nhello\n<!-- brainclaw:end -->');
    assert.ok(result.includes('hello'));
  });

  it('appends after existing content', () => {
    const result = upsertBrainclawSection('# Existing\n\nSome text.', '<!-- brainclaw:start -->\nhello\n<!-- brainclaw:end -->');
    assert.ok(result.startsWith('# Existing'));
    assert.ok(result.includes('hello'));
  });

  it('replaces an existing brainclaw section', () => {
    const original = '# Title\n\n<!-- brainclaw:start -->\nold content\n<!-- brainclaw:end -->\n\nafter';
    const result = upsertBrainclawSection(original, '<!-- brainclaw:start -->\nnew content\n<!-- brainclaw:end -->');
    assert.ok(result.includes('new content'));
    assert.ok(!result.includes('old content'));
    assert.ok(result.includes('after'));
  });

  it('does not duplicate the section on repeated calls', () => {
    const section = '<!-- brainclaw:start -->\nhello\n<!-- brainclaw:end -->';
    const first = upsertBrainclawSection('# Title\n', section);
    const second = upsertBrainclawSection(first, section);
    const count = (second.match(/<!-- brainclaw:start -->/g) ?? []).length;
    assert.equal(count, 1);
  });
});

describe('core/agent-files — ensureAgentFiles', () => {
  it('creates AGENTS.md and copilot-instructions.md when absent', () => {
    const dir = tmpDir();
    try {
      const result = ensureAgentFiles(dir, '.brainclaw');
      assert.equal(result.agentsMdCreated, true);
      assert.equal(result.agentsMdUpdated, false);
      assert.equal(result.copilotInstructionsCreated, true);
      assert.ok(fs.existsSync(path.join(dir, 'AGENTS.md')));
      assert.ok(fs.existsSync(path.join(dir, '.github', 'copilot-instructions.md')));
      const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8');
      assert.ok(agents.includes(BRAINCLAW_SECTION_START));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('updates existing AGENTS.md without erasing existing content', () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# My Project\n\nExisting rules here.\n', 'utf-8');
      const result = ensureAgentFiles(dir, '.brainclaw');
      assert.equal(result.agentsMdUpdated, true);
      assert.equal(result.agentsMdCreated, false);
      const content = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8');
      assert.ok(content.includes('Existing rules here.'));
      assert.ok(content.includes(BRAINCLAW_SECTION_START));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replaces the brainclaw section on re-run without duplicating it', () => {
    const dir = tmpDir();
    try {
      ensureAgentFiles(dir, '.brainclaw');
      ensureAgentFiles(dir, '.brainclaw');
      const content = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8');
      const count = (content.match(/<!-- brainclaw:start -->/g) ?? []).length;
      assert.equal(count, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('core/agent-files — ensureGitignoreEntries', () => {
  it('creates .gitignore when absent', () => {
    const dir = tmpDir();
    try {
      ensureGitignoreEntries(dir, ['AGENTS.md', '.github/copilot-instructions.md']);
      const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
      assert.ok(content.includes('AGENTS.md'));
      assert.ok(content.includes('.github/copilot-instructions.md'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('appends missing entries to existing .gitignore', () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\ndist/\n', 'utf-8');
      ensureGitignoreEntries(dir, ['AGENTS.md']);
      const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
      assert.ok(content.includes('node_modules/'));
      assert.ok(content.includes('AGENTS.md'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not duplicate entries already present', () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), 'AGENTS.md\n', 'utf-8');
      ensureGitignoreEntries(dir, ['AGENTS.md']);
      const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
      const count = (content.match(/AGENTS\.md/g) ?? []).length;
      assert.equal(count, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('core/agent-files — auto-config writers', () => {
  it('creates and reuses Cline MCP settings in the workspace', () => {
    const dir = tmpDir();
    try {
      const first = ensureClineMcpConfig(dir);
      assert.equal(first.created, true);
      assert.equal(first.relativePath, '.vscode/cline_mcp_settings.json');

      const filePath = path.join(dir, '.vscode', 'cline_mcp_settings.json');
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { mcpServers?: Record<string, unknown> };
      assert.ok(content.mcpServers?.brainclaw, 'brainclaw MCP config should be present');

      const second = ensureClineMcpConfig(dir);
      assert.equal(second.created, false);
      assert.equal(second.updated, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates a Copilot skill as SKILL.md under .github/skills', () => {
    const dir = tmpDir();
    try {
      const result = ensureCopilotSkill(dir);
      assert.equal(result.created, true);
      const filePath = path.join(dir, '.github', 'skills', 'brainclaw-context', 'SKILL.md');
      const content = fs.readFileSync(filePath, 'utf-8');
      assert.ok(content.includes('name: brainclaw-context'));
      assert.ok(content.includes('brainclaw context --json'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates a Cursor MDC rule without sentinel wrapping', () => {
    const dir = tmpDir();
    try {
      const result = ensureCursorMdc(dir);
      assert.equal(result.created, true);
      const filePath = path.join(dir, '.cursor', 'rules', 'brainclaw-mcp-shim.mdc');
      const content = fs.readFileSync(filePath, 'utf-8');
      assert.ok(content.startsWith('---\n'));
      assert.ok(content.includes('<run_command>'));
      assert.ok(!content.includes(BRAINCLAW_SECTION_START));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates Windsurf MCP config under the provided home directory', () => {
    const homeDir = tmpDir();
    try {
      const result = ensureWindsurfMcpConfig(homeDir);
      assert.ok(result, 'result should be defined when a home dir is provided');
      assert.equal(result?.created, true);
      const filePath = path.join(homeDir, '.codeium', 'windsurf', 'mcp_config.json');
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { mcpServers?: Record<string, unknown> };
      assert.ok(content.mcpServers?.brainclaw, 'brainclaw MCP config should be present');
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('writes only the relevant detected auto-config companion files', () => {
    const dir = tmpDir();
    try {
      const cursorResults = writeDetectedAgentAutoConfig('cursor', dir);
      assert.equal(cursorResults.length, 1);
      assert.equal(cursorResults[0]?.relativePath, '.cursor/rules/brainclaw-mcp-shim.mdc');

      const copilotResults = writeDetectedAgentAutoConfig('github-copilot', dir);
      assert.equal(copilotResults.length, 1);
      assert.equal(copilotResults[0]?.relativePath, '.github/skills/brainclaw-context/SKILL.md');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
