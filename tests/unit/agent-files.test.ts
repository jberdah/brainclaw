import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  BRAINCLAW_SECTION_START,
  BRAINCLAW_SECTION_END,
  buildBrainclawSection,
  buildClaudeCodeCommandText,
  buildHygieneSection,
  hasBrainclawSection,
  upsertBrainclawSection,
  ensureClineMcpConfig,
  ensureCopilotSkill,
  ensureCursorMdc,
  ensureAgentFiles,
  ensureGitignoreEntries,
  collectWorkspaceGitignoreEntries,
  collectExportGitignoreEntries,
  auditLocalAgentWorkspaceFiles,
  ensureWindsurfMcpConfig,
  ensureClaudeCodeMcpConfig,
  ensureClaudeCodeCommand,
  ensureClaudeCodeSettings,
  ensureCursorMcpConfig,
  ensureRooMcpConfig,
  ensureContinueMcpConfig,
  ensureOpenCodeMcpConfig,
  ensureAntigravityMcpConfig,
  writeDetectedAgentAutoConfig,
} from '../../src/core/agent-files.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-agent-files-'));
}

function git(args: string[], cwd: string): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
  });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout;
}

function initGitRepo(dir: string): void {
  git(['init'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test User'], dir);
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
    assert.ok(
      section.includes('brainclaw claim list'),
      'should mention claim list for checking other agents',
    );
  });

  it('contains before-finishing behavioral contract', () => {
    const section = buildBrainclawSection('.brainclaw');
    assert.ok(section.includes('claim release'), 'should mention claim release');
    assert.ok(section.includes('plan update'), 'should mention plan update');
    assert.ok(section.includes('Before finishing'), 'should have before finishing section');
  });

  it('contains recording-work quick reference', () => {
    const section = buildBrainclawSection('.brainclaw');
    assert.ok(section.includes('brainclaw memory create decision'), 'should mention decision command');
    assert.ok(section.includes('brainclaw claim create'), 'should mention claim command');
    assert.ok(section.includes('brainclaw plan create'), 'should mention plan command');
  });
});

describe('core/agent-files — buildHygieneSection', () => {
  it('contains before-starting and before-finishing rules', () => {
    const section = buildHygieneSection();
    assert.ok(section.includes('brainclaw context'));
    assert.ok(section.includes('claim release'));
    assert.ok(section.includes('session-end'));
  });

  it('includes plan and claim workflow instructions', () => {
    const section = buildHygieneSection();
    assert.ok(section.includes('claim list'), 'should mention claim list to check other agents');
    assert.ok(section.includes('brainclaw plan create'), 'should mention creating plans');
    assert.ok(section.includes('brainclaw claim create'), 'should mention claiming files');
  });
});

describe('core/agent-files — hasBrainclawSection', () => {
  it('detects the managed sentinel block', () => {
    assert.equal(hasBrainclawSection(`${BRAINCLAW_SECTION_START}\nhello\n${BRAINCLAW_SECTION_END}`), true);
    assert.equal(hasBrainclawSection('# plain markdown'), false);
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

  it('can refresh only existing managed files during upgrade-style flows', () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(
        path.join(dir, 'AGENTS.md'),
        '# Local notes\n\n<!-- brainclaw:start -->\nold\n<!-- brainclaw:end -->\n',
        'utf-8',
      );

      const result = ensureAgentFiles(dir, '.brainclaw', {
        onlyExisting: true,
        requireExistingSection: true,
      });

      assert.equal(result.agentsMdUpdated, true);
      assert.equal(result.copilotInstructionsCreated, false);
      assert.ok(!fs.existsSync(path.join(dir, '.github', 'copilot-instructions.md')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips existing files that are not already managed by brainclaw when required', () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# User-owned instructions\n', 'utf-8');

      const result = ensureAgentFiles(dir, '.brainclaw', {
        onlyExisting: true,
        requireExistingSection: true,
      });

      assert.equal(result.agentsMdUpdated, false);
      assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8'), '# User-owned instructions\n');
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

describe('core/agent-files — collectWorkspaceGitignoreEntries', () => {
  it('keeps only workspace-local generated files and excludes package.json', () => {
    const dir = tmpDir();
    const homeDir = tmpDir();
    try {
      const entries = collectWorkspaceGitignoreEntries(dir, [
        {
          filePath: path.join(dir, '.claude', 'settings.local.json'),
          relativePath: '.claude/settings.local.json',
        },
        {
          filePath: path.join(homeDir, '.cursor', 'mcp.json'),
          relativePath: '.cursor/mcp.json',
        },
        {
          filePath: path.join(dir, 'package.json'),
          relativePath: 'package.json',
        },
      ]);

      assert.deepEqual(entries, ['.claude/settings.local.json']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe('core/agent-files — collectExportGitignoreEntries', () => {
  it('includes the main export target and workspace-local companion files by default', () => {
    const dir = tmpDir();
    const homeDir = tmpDir();
    try {
      const entries = collectExportGitignoreEntries(dir, 'CLAUDE.md', [
        {
          filePath: path.join(dir, '.claude', 'settings.local.json'),
          relativePath: '.claude/settings.local.json',
        },
        {
          filePath: path.join(homeDir, '.claude', 'settings.json'),
        },
      ]);

      assert.deepEqual(entries, ['CLAUDE.md', '.claude/settings.local.json']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('can skip the main export target for explicitly shared instructions', () => {
    const dir = tmpDir();
    try {
      const entries = collectExportGitignoreEntries(dir, 'CLAUDE.md', [
        {
          filePath: path.join(dir, '.mcp.json'),
          relativePath: '.mcp.json',
        },
      ], { includeTarget: false });

      assert.deepEqual(entries, ['.mcp.json']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('core/agent-files — auditLocalAgentWorkspaceFiles', () => {
  it('skips the audit when the workspace is not a git repo', () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, '.mcp.json'), '{}\n', 'utf-8');
      const audit = auditLocalAgentWorkspaceFiles(dir);
      assert.equal(audit.isGitRepo, false);
      assert.equal(audit.hasIssues, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags local Brainclaw agent files that are missing from .gitignore', () => {
    const dir = tmpDir();
    try {
      initGitRepo(dir);
      fs.writeFileSync(path.join(dir, '.mcp.json'), '{}\n', 'utf-8');
      fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.claude', '.bclaw-session'), '', 'utf-8');
      const audit = auditLocalAgentWorkspaceFiles(dir);
      assert.equal(audit.isGitRepo, true);
      assert.deepEqual(audit.missingGitignorePaths, ['.mcp.json', '.claude/.bclaw-session']);
      assert.deepEqual(audit.trackedPaths, []);
      assert.equal(audit.hasIssues, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports tracked local agent files even if they are now ignored', () => {
    const dir = tmpDir();
    try {
      initGitRepo(dir);
      fs.writeFileSync(path.join(dir, '.mcp.json'), '{}\n', 'utf-8');
      git(['add', '.mcp.json'], dir);
      fs.writeFileSync(path.join(dir, '.gitignore'), '.mcp.json\n', 'utf-8');

      const audit = auditLocalAgentWorkspaceFiles(dir);
      assert.deepEqual(audit.missingGitignorePaths, []);
      assert.deepEqual(audit.trackedPaths, ['.mcp.json']);
      assert.equal(audit.hasIssues, true);
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
      // cursor without homeDir → only MDC
      const cursorResults = writeDetectedAgentAutoConfig('cursor', dir, {});
      assert.equal(cursorResults.length, 1);
      assert.equal(cursorResults[0]?.relativePath, '.cursor/rules/brainclaw-mcp-shim.mdc');

      const copilotResults = writeDetectedAgentAutoConfig('github-copilot', dir);
      assert.equal(copilotResults.length, 1);
      assert.equal(copilotResults[0]?.relativePath, '.github/skills/brainclaw-context/SKILL.md');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates Claude Code MCP config at .mcp.json', () => {
    const dir = tmpDir();
    try {
      const first = ensureClaudeCodeMcpConfig(dir);
      assert.equal(first.created, true);
      assert.equal(first.relativePath, '.mcp.json');

      const filePath = path.join(dir, '.mcp.json');
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { mcpServers?: Record<string, unknown> };
      assert.ok(content.mcpServers?.brainclaw, 'brainclaw MCP entry should be present');

      const second = ensureClaudeCodeMcpConfig(dir);
      assert.equal(second.created, false);
      assert.equal(second.updated, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('injects BRAINCLAW_CWD in workspace-level MCP configs', () => {
    const dir = tmpDir();
    try {
      ensureClaudeCodeMcpConfig(dir);
      const filePath = path.join(dir, '.mcp.json');
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
        mcpServers?: Record<string, { env?: Record<string, string> }>;
      };
      const env = content.mcpServers?.brainclaw?.env;
      assert.ok(env, 'brainclaw MCP entry should have env');
      assert.equal(env.BRAINCLAW_CWD, dir, 'BRAINCLAW_CWD should point to workspace root');
      assert.equal(env.BRAINCLAW_AGENT, 'claude-code', 'BRAINCLAW_AGENT should be set');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('injects BRAINCLAW_CWD in Cline MCP config', () => {
    const dir = tmpDir();
    try {
      ensureClineMcpConfig(dir);
      const filePath = path.join(dir, '.vscode', 'cline_mcp_settings.json');
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
        mcpServers?: Record<string, { env?: Record<string, string> }>;
      };
      const env = content.mcpServers?.brainclaw?.env;
      assert.ok(env, 'brainclaw MCP entry should have env');
      assert.equal(env.BRAINCLAW_CWD, dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('injects BRAINCLAW_CWD in OpenCode MCP config', () => {
    const dir = tmpDir();
    try {
      ensureOpenCodeMcpConfig(dir);
      const filePath = path.join(dir, 'opencode.json');
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
        mcp?: Record<string, { env?: Record<string, string> }>;
      };
      const env = content.mcp?.brainclaw?.env;
      assert.ok(env, 'brainclaw MCP entry should have env');
      assert.equal(env.BRAINCLAW_CWD, dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates Claude Code slash command with workflow content', () => {
    const dir = tmpDir();
    try {
      const result = ensureClaudeCodeCommand(dir);
      assert.equal(result.created, true);
      assert.equal(result.relativePath, '.claude/commands/brainclaw.md');

      const filePath = path.join(dir, '.claude', 'commands', 'brainclaw.md');
      const content = fs.readFileSync(filePath, 'utf-8');
      assert.ok(content.includes('brainclaw context --json'));
      assert.ok(content.includes('brainclaw claim list'));
      assert.ok(content.includes('brainclaw claim create'));
      assert.ok(content.includes('session-end'));

      const second = ensureClaudeCodeCommand(dir);
      assert.equal(second.created, false);
      assert.equal(second.updated, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds Claude Code command text with resource-style CLI commands', () => {
    const content = buildClaudeCodeCommandText();
    assert.ok(content.includes('brainclaw claim list'));
    assert.ok(content.includes('brainclaw claim create'));
    assert.ok(!content.includes('brainclaw list-claims'));
  });

  it('creates Claude Code settings with permissions and session hooks', () => {
    const dir = tmpDir();
    try {
      const first = ensureClaudeCodeSettings(dir);
      assert.equal(first.created, true);
      assert.equal(first.relativePath, '.claude/settings.local.json');

      const filePath = path.join(dir, '.claude', 'settings.local.json');
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
        permissions?: { allow?: string[] };
        hooks?: { UserPromptSubmit?: unknown[]; Stop?: unknown[]; PostToolUse?: unknown[] };
      };
      assert.ok(content.permissions?.allow?.includes('Bash(npx brainclaw:*)'));
      assert.ok(content.permissions?.allow?.includes('mcp__brainclaw__*'), 'MCP tool whitelist should be present');
      assert.ok(Array.isArray(content.hooks?.UserPromptSubmit) && content.hooks.UserPromptSubmit.length > 0);
      assert.ok(Array.isArray(content.hooks?.Stop) && content.hooks.Stop.length > 0);
      assert.ok(Array.isArray(content.hooks?.PostToolUse) && content.hooks.PostToolUse.length > 0, 'PostToolUse hook for check-events should be present');
      const postToolEntry = content.hooks!.PostToolUse![0] as { matcher?: string; hooks?: Array<{ command?: string }> };
      assert.equal(postToolEntry.matcher, 'mcp__brainclaw__');
      assert.ok(postToolEntry.hooks?.[0]?.command?.includes('check-events'));

      const second = ensureClaudeCodeSettings(dir);
      assert.equal(second.created, false);
      assert.equal(second.updated, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges Claude Code settings without overwriting existing keys', () => {
    const dir = tmpDir();
    try {
      const settingsPath = path.join(dir, '.claude', 'settings.local.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ['Bash(git:*)'] }, customKey: 'value' }), 'utf-8');

      ensureClaudeCodeSettings(dir);

      const content = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
        permissions?: { allow?: string[] };
        customKey?: string;
      };
      assert.ok(content.permissions?.allow?.includes('Bash(npx brainclaw:*)'), 'brainclaw permission should be added');
      assert.ok(content.permissions?.allow?.includes('mcp__brainclaw__*'), 'MCP whitelist should be added');
      assert.ok(content.permissions?.allow?.includes('Bash(git:*)'), 'existing permission should be preserved');
      assert.equal(content.customKey, 'value', 'unrelated keys should be preserved');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates Cursor MCP config under the provided home directory', () => {
    const homeDir = tmpDir();
    try {
      const result = ensureCursorMcpConfig(homeDir);
      assert.ok(result, 'result should be defined when a home dir is provided');
      assert.equal(result?.created, true);
      assert.equal(result?.relativePath, '.cursor/mcp.json');
      const filePath = path.join(homeDir, '.cursor', 'mcp.json');
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { mcpServers?: Record<string, unknown> };
      assert.ok(content.mcpServers?.brainclaw, 'brainclaw MCP entry should be present');

      const second = ensureCursorMcpConfig(homeDir);
      assert.equal(second?.updated, false);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('returns undefined for Cursor MCP config when no homeDir provided', () => {
    const result = ensureCursorMcpConfig(undefined);
    assert.equal(result, undefined);
  });

  it('creates Roo Code MCP config at .roo/mcp.json', () => {
    const dir = tmpDir();
    try {
      const first = ensureRooMcpConfig(dir);
      assert.equal(first.created, true);
      assert.equal(first.relativePath, '.roo/mcp.json');

      const filePath = path.join(dir, '.roo', 'mcp.json');
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { mcpServers?: Record<string, unknown> };
      assert.ok(content.mcpServers?.brainclaw, 'brainclaw MCP entry should be present');

      const second = ensureRooMcpConfig(dir);
      assert.equal(second.created, false);
      assert.equal(second.updated, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates Continue MCP config as array entry in .continue/config.json', () => {
    const dir = tmpDir();
    try {
      const first = ensureContinueMcpConfig(dir);
      assert.equal(first.created, true);
      assert.equal(first.relativePath, '.continue/config.json');

      const filePath = path.join(dir, '.continue', 'config.json');
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { mcpServers?: unknown[] };
      assert.ok(Array.isArray(content.mcpServers));
      assert.ok(content.mcpServers?.some((e: unknown) => typeof e === 'object' && e !== null && (e as Record<string, unknown>).name === 'brainclaw'));

      // idempotent — no duplicate
      ensureContinueMcpConfig(dir);
      const content2 = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { mcpServers?: unknown[] };
      const brainclawEntries = content2.mcpServers?.filter((e: unknown) => typeof e === 'object' && e !== null && (e as Record<string, unknown>).name === 'brainclaw');
      assert.equal(brainclawEntries?.length, 1, 'should not create duplicate entries');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writeDetectedAgentAutoConfig claude-code without homeDir returns 3 results', () => {
    const dir = tmpDir();
    try {
      const results = writeDetectedAgentAutoConfig('claude-code', dir, {});
      assert.equal(results.length, 3);
      assert.ok(results.some((r) => r.relativePath === '.mcp.json'));
      assert.ok(results.some((r) => r.relativePath === '.claude/commands/brainclaw.md'));
      assert.ok(results.some((r) => r.relativePath === '.claude/settings.local.json'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writeDetectedAgentAutoConfig claude-code with homeDir returns 5 results including global', () => {
    const dir = tmpDir();
    const homeDir = tmpDir();
    try {
      const results = writeDetectedAgentAutoConfig('claude-code', dir, { HOME: homeDir });
      assert.equal(results.length, 5);
      assert.ok(results.some((r) => r.relativePath === '.mcp.json'));
      assert.ok(results.some((r) => r.relativePath === '.claude/commands/brainclaw.md'));
      assert.ok(results.some((r) => r.relativePath === '.claude/settings.local.json'));
      // global registrations (no relativePath set, filePath is absolute)
      assert.ok(results.some((r) => r.filePath.includes('.claude') && r.filePath.includes('settings.json') && !r.filePath.includes('settings.local.json')));
      assert.ok(results.some((r) => r.filePath.includes('.claude') && r.filePath.includes('commands') && r.filePath.includes('brainclaw.md')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('writeDetectedAgentAutoConfig cursor with homeDir returns 2 results', () => {
    const dir = tmpDir();
    const homeDir = tmpDir();
    try {
      const results = writeDetectedAgentAutoConfig('cursor', dir, { HOME: homeDir });
      assert.equal(results.length, 2);
      assert.ok(results.some((r) => r.relativePath === '.cursor/rules/brainclaw-mcp-shim.mdc'));
      assert.ok(results.some((r) => r.relativePath === '.cursor/mcp.json'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('writeDetectedAgentAutoConfig roo returns 1 result', () => {
    const dir = tmpDir();
    try {
      const results = writeDetectedAgentAutoConfig('roo', dir);
      assert.equal(results.length, 1);
      assert.equal(results[0]?.relativePath, '.roo/mcp.json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writeDetectedAgentAutoConfig continue without homeDir returns 1 result', () => {
    const dir = tmpDir();
    try {
      const results = writeDetectedAgentAutoConfig('continue', dir, {});
      assert.equal(results.length, 1);
      assert.equal(results[0]?.relativePath, '.continue/config.json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writeDetectedAgentAutoConfig continue with homeDir returns 2 results including global', () => {
    const dir = tmpDir();
    const homeDir = tmpDir();
    try {
      const results = writeDetectedAgentAutoConfig('continue', dir, { HOME: homeDir });
      assert.equal(results.length, 2);
      assert.ok(results.some((r) => r.relativePath === '.continue/config.json'));
      assert.ok(results.some((r) => r.filePath.includes('.continue') && r.filePath.includes('config.json') && !r.filePath.startsWith(dir)));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('creates OpenCode MCP config in opencode.json with mcp.brainclaw entry', () => {
    const dir = tmpDir();
    try {
      const first = ensureOpenCodeMcpConfig(dir);
      assert.equal(first.created, true);
      assert.equal(first.relativePath, 'opencode.json');

      const filePath = path.join(dir, 'opencode.json');
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { mcp?: Record<string, unknown> };
      assert.ok(content.mcp?.brainclaw, 'brainclaw MCP entry should be present');

      const second = ensureOpenCodeMcpConfig(dir);
      assert.equal(second.created, false);
      assert.equal(second.updated, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates Antigravity MCP config under the provided home directory', () => {
    const homeDir = tmpDir();
    try {
      const result = ensureAntigravityMcpConfig(homeDir);
      assert.ok(result, 'result should be defined when a home dir is provided');
      assert.equal(result?.created, true);
      assert.equal(result?.relativePath, '.gemini/antigravity/mcp_config.json');

      const filePath = path.join(homeDir, '.gemini', 'antigravity', 'mcp_config.json');
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { mcpServers?: Record<string, unknown> };
      assert.ok(content.mcpServers?.brainclaw, 'brainclaw MCP entry should be present');

      const second = ensureAntigravityMcpConfig(homeDir);
      assert.equal(second?.updated, false);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('returns undefined for Antigravity MCP config when no homeDir provided', () => {
    const result = ensureAntigravityMcpConfig(undefined);
    assert.equal(result, undefined);
  });

  it('writeDetectedAgentAutoConfig opencode returns 1 result', () => {
    const dir = tmpDir();
    try {
      const results = writeDetectedAgentAutoConfig('opencode', dir);
      assert.equal(results.length, 1);
      assert.equal(results[0]?.relativePath, 'opencode.json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writeDetectedAgentAutoConfig antigravity with homeDir returns 1 result', () => {
    const dir = tmpDir();
    const homeDir = tmpDir();
    try {
      const results = writeDetectedAgentAutoConfig('antigravity', dir, { HOME: homeDir });
      assert.equal(results.length, 1);
      assert.equal(results[0]?.relativePath, '.gemini/antigravity/mcp_config.json');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
