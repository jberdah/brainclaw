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
  ensureWindsurfModernRules,
  ensureClaudeCodeMcpConfig,
  ensureClaudeCodeCommand,
  ensureClaudeCodeSettings,
  ensureCursorMcpConfig,
  ensureRooMcpConfig,
  ensureContinueMcpConfig,
  ensureOpenCodeMcpConfig,
  ensureContinueUserPermissions,
  ensureAntigravityMcpConfig,
  ensureAntigravityHooks,
  ensureCursorHooks,
  ensureCopilotHooks,
  ensureCodexMcpConfig,
  ensureUniversalBrainclawSkill,
  patchAllMcpConfigs,
  resetMcpCommandCache,
  writeExportCompanionFiles,
  writeDetectedAgentAutoConfig,
} from '../../src/core/agent-files.js';
import { MCP_HEADLESS_AUTO_TOOL_NAMES } from '../../src/commands/mcp.js';
import yaml from 'yaml';

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

  it('ensureWindsurfMcpConfig writes alwaysAllow array matching MCP_HEADLESS_AUTO_TOOL_NAMES', () => {
    const homeDir = tmpDir();
    try {
      const result = ensureWindsurfMcpConfig(homeDir);
      assert.ok(result, 'result should be defined');
      const filePath = path.join(homeDir, '.codeium', 'windsurf', 'mcp_config.json');
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
        mcpServers?: { brainclaw?: { alwaysAllow?: unknown } };
      };
      const alwaysAllow = content.mcpServers?.brainclaw?.alwaysAllow;
      assert.ok(Array.isArray(alwaysAllow), 'alwaysAllow should be an array');
      assert.equal(
        (alwaysAllow as unknown[]).length,
        MCP_HEADLESS_AUTO_TOOL_NAMES.length,
        'alwaysAllow length should match MCP_HEADLESS_AUTO_TOOL_NAMES',
      );
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('ensureWindsurfModernRules creates .windsurf/rules/brainclaw.md and is idempotent', () => {
    const dir = tmpDir();
    try {
      const first = ensureWindsurfModernRules(dir);
      assert.equal(first.created, true);
      assert.equal(first.updated, false);
      assert.equal(first.kind, 'rule');
      assert.equal(first.relativePath, '.windsurf/rules/brainclaw.md');

      const filePath = path.join(dir, '.windsurf', 'rules', 'brainclaw.md');
      assert.ok(fs.existsSync(filePath), 'file should exist');
      const raw = fs.readFileSync(filePath, 'utf-8');
      assert.ok(raw.includes('brainclaw'), 'file should contain brainclaw reference');
      assert.ok(raw.includes('brainclaw context'), 'file should mention brainclaw context command');

      const second = ensureWindsurfModernRules(dir);
      assert.equal(second.created, false);
      assert.equal(second.updated, false, 'second call should be idempotent');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes only the relevant detected auto-config companion files', () => {
    const dir = tmpDir();
    try {
      // cursor without homeDir → MDC + hooks + universal skill
      const cursorResults = writeDetectedAgentAutoConfig('cursor', dir, {});
      assert.equal(cursorResults.length, 3);
      assert.ok(cursorResults.some(r => r.relativePath === '.cursor/rules/brainclaw-mcp-shim.mdc'));
      assert.ok(cursorResults.some(r => r.relativePath === '.cursor/hooks.json'));
      assert.ok(cursorResults.some(r => r.relativePath === '.agents/skills/brainclaw/SKILL.md'));

      const copilotResults = writeDetectedAgentAutoConfig('github-copilot', dir);
      assert.equal(copilotResults.length, 5);
      assert.ok(copilotResults.some(r => r.relativePath === '.vscode/settings.json'));
      assert.ok(copilotResults.some(r => r.relativePath === '.github/skills/brainclaw-context/SKILL.md'));
      assert.ok(copilotResults.some(r => r.relativePath === '.github/copilot/hooks.json'));
      assert.ok(copilotResults.some(r => r.relativePath === '.agents/skills/brainclaw/SKILL.md'));
      assert.ok(copilotResults.some(r => r.relativePath === '.vscode/extensions.json'));
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

  it('writeDetectedAgentAutoConfig claude-code without homeDir returns 4 results', () => {
    const dir = tmpDir();
    try {
      const results = writeDetectedAgentAutoConfig('claude-code', dir, {});
      assert.equal(results.length, 4);
      assert.ok(results.some((r) => r.relativePath === '.mcp.json'));
      assert.ok(results.some((r) => r.relativePath === '.claude/commands/brainclaw.md'));
      assert.ok(results.some((r) => r.relativePath === '.claude/settings.local.json'));
      assert.ok(results.some((r) => r.relativePath === '.vscode/extensions.json'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writeDetectedAgentAutoConfig claude-code with homeDir returns 6 results including global', () => {
    const dir = tmpDir();
    const homeDir = tmpDir();
    try {
      const results = writeDetectedAgentAutoConfig('claude-code', dir, { HOME: homeDir });
      assert.equal(results.length, 6);
      assert.ok(results.some((r) => r.relativePath === '.mcp.json'));
      assert.ok(results.some((r) => r.relativePath === '.claude/commands/brainclaw.md'));
      assert.ok(results.some((r) => r.relativePath === '.claude/settings.local.json'));
      assert.ok(results.some((r) => r.relativePath === '.vscode/extensions.json'));
      // global registrations (no relativePath set, filePath is absolute)
      assert.ok(results.some((r) => r.filePath.includes('.claude') && r.filePath.includes('settings.json') && !r.filePath.includes('settings.local.json')));
      assert.ok(results.some((r) => r.filePath.includes('.claude') && r.filePath.includes('commands') && r.filePath.includes('brainclaw.md')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('writeDetectedAgentAutoConfig cursor with homeDir returns 4 results (mdc + hooks + skill + MCP)', () => {
    const dir = tmpDir();
    const homeDir = tmpDir();
    try {
      const results = writeDetectedAgentAutoConfig('cursor', dir, { HOME: homeDir });
      assert.equal(results.length, 4);
      assert.ok(results.some((r) => r.relativePath === '.cursor/rules/brainclaw-mcp-shim.mdc'));
      assert.ok(results.some((r) => r.relativePath === '.cursor/hooks.json'));
      assert.ok(results.some((r) => r.relativePath === '.cursor/mcp.json'));
      assert.ok(results.some((r) => r.relativePath === '.agents/skills/brainclaw/SKILL.md'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('writeDetectedAgentAutoConfig roo returns 2 results including universal skill', () => {
    const dir = tmpDir();
    try {
      const results = writeDetectedAgentAutoConfig('roo', dir);
      assert.equal(results.length, 2);
      assert.ok(results.some((r) => r.relativePath === '.roo/mcp.json'));
      assert.ok(results.some((r) => r.relativePath === '.agents/skills/brainclaw/SKILL.md'));
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

  it('writeDetectedAgentAutoConfig continue with homeDir returns 3 results including global MCP + permissions', () => {
    const dir = tmpDir();
    const homeDir = tmpDir();
    try {
      const results = writeDetectedAgentAutoConfig('continue', dir, { HOME: homeDir });
      assert.equal(results.length, 3);
      assert.ok(results.some((r) => r.relativePath === '.continue/config.json'));
      assert.ok(results.some((r) => r.filePath.includes('.continue') && r.filePath.includes('config.json') && !r.filePath.startsWith(dir)));
      assert.ok(results.some((r) => r.kind === 'permissions' && r.filePath.includes('permissions.yaml')));
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

  it('ensureOpenCodeMcpConfig writes permission map with headless-auto tools', () => {
    const dir = tmpDir();
    try {
      ensureOpenCodeMcpConfig(dir);
      const filePath = path.join(dir, 'opencode.json');
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
        mcp?: Record<string, { permission?: Record<string, string> }>;
      };
      const permission = content.mcp?.brainclaw?.permission;
      assert.ok(permission, 'brainclaw MCP entry should have a permission map');
      for (const tool of MCP_HEADLESS_AUTO_TOOL_NAMES) {
        assert.equal(permission[tool], 'allow', `tool ${tool} should be mapped to "allow"`);
      }
      // No extra keys beyond the headless-auto set
      assert.equal(Object.keys(permission).length, MCP_HEADLESS_AUTO_TOOL_NAMES.length);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ensureContinueUserPermissions writes permissions.yaml with headless-auto tools', () => {
    const homeDir = tmpDir();
    try {
      const result = ensureContinueUserPermissions(homeDir);
      assert.ok(result, 'result should be defined when a home dir is provided');
      assert.equal(result?.created, true);
      assert.equal(result?.kind, 'permissions');

      const filePath = path.join(homeDir, '.continue', 'permissions.yaml');
      const raw = fs.readFileSync(filePath, 'utf-8');
      assert.ok(raw.startsWith('# Managed by brainclaw'), 'should have managed-by header');

      const parsed = yaml.parse(raw) as { tools?: Record<string, { allow?: boolean }> };
      assert.ok(parsed.tools, 'parsed YAML should have a tools key');
      for (const tool of MCP_HEADLESS_AUTO_TOOL_NAMES) {
        assert.equal(parsed.tools[tool]?.allow, true, `tool ${tool} should have allow: true`);
      }

      // Idempotent
      const second = ensureContinueUserPermissions(homeDir);
      assert.equal(second?.created, false);
      assert.equal(second?.updated, false);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('ensureContinueUserPermissions preserves existing top-level and per-tool settings', () => {
    const homeDir = tmpDir();
    try {
      const filePath = path.join(homeDir, '.continue', 'permissions.yaml');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, yaml.stringify({
        profiles: { strict: true },
        tools: {
          custom_tool: { ask: true },
          bclaw_work: { ask: true, note: 'keep' },
        },
      }), 'utf-8');

      const result = ensureContinueUserPermissions(homeDir);
      assert.ok(result, 'result should be defined when a home dir is provided');
      assert.equal(result?.created, false);
      assert.equal(result?.updated, true);

      const parsed = yaml.parse(fs.readFileSync(filePath, 'utf-8')) as {
        profiles?: { strict?: boolean };
        tools?: Record<string, { allow?: boolean; ask?: boolean; note?: string }>;
      };
      assert.equal(parsed.profiles?.strict, true, 'top-level keys should be preserved');
      assert.equal(parsed.tools?.custom_tool?.ask, true, 'unrelated tool entries should be preserved');
      assert.equal(parsed.tools?.bclaw_work?.ask, true, 'existing per-tool fields should be preserved');
      assert.equal(parsed.tools?.bclaw_work?.note, 'keep', 'existing metadata should be preserved');
      assert.equal(parsed.tools?.bclaw_work?.allow, true, 'brainclaw tool should be forced to allow');
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('ensureContinueUserPermissions returns undefined when no homeDir', () => {
    const result = ensureContinueUserPermissions(undefined);
    assert.equal(result, undefined);
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

  it('ensureCursorHooks writes .cursor/hooks.json with session events + idempotence', () => {
    const dir = tmpDir();
    try {
      const first = ensureCursorHooks(dir);
      assert.equal(first.created, true);
      assert.equal(first.relativePath, '.cursor/hooks.json');

      const filePath = path.join(dir, '.cursor', 'hooks.json');
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
        version?: number;
        hooks?: Record<string, Array<{ command?: string; type?: string }>>;
      };
      assert.equal(content.version, 1);
      assert.ok(content.hooks?.sessionStart?.[0]?.command?.includes('session-start'), 'sessionStart hook present');
      assert.ok(content.hooks?.beforeSubmitPrompt?.[0]?.command?.includes('context-diff'), 'beforeSubmitPrompt hook present');
      assert.ok(content.hooks?.stop?.[0]?.command?.includes('session-end'), 'stop hook present');
      assert.equal(content.hooks?.sessionStart?.[0]?.type, 'command');
      assert.ok(content.hooks?.sessionStart?.[0]?.command?.includes('cli.js'), 'resolved CLI path should be present');
      if (process.platform === 'win32') {
        assert.ok(content.hooks?.sessionStart?.[0]?.command?.includes('2>$null'), 'Windows should use PowerShell stderr redirection');
        assert.ok(!content.hooks?.sessionStart?.[0]?.command?.includes('/dev/null'), 'Windows should not use POSIX stderr redirection');
      } else {
        assert.ok(content.hooks?.sessionStart?.[0]?.command?.includes('2>/dev/null'), 'POSIX shells should use /dev/null redirection');
      }

      const second = ensureCursorHooks(dir);
      assert.equal(second.created, false);
      assert.equal(second.updated, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ensureAntigravityHooks writes hooks.json with PascalCase events + idempotence', () => {
    const homeDir = tmpDir();
    try {
      const first = ensureAntigravityHooks(homeDir);
      assert.ok(first, 'result should be defined');
      assert.equal(first?.created, true);
      assert.equal(first?.relativePath, '.gemini/antigravity/hooks.json');

      const filePath = path.join(homeDir, '.gemini', 'antigravity', 'hooks.json');
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
        SessionStart?: Array<{ command?: string }>;
        UserPromptSubmit?: Array<{ command?: string }>;
        Stop?: Array<{ command?: string }>;
      };
      assert.ok(content.SessionStart?.[0]?.command?.includes('session-start'), 'SessionStart hook present');
      assert.ok(content.UserPromptSubmit?.[0]?.command?.includes('context-diff'), 'UserPromptSubmit hook present');
      assert.ok(content.Stop?.[0]?.command?.includes('session-end'), 'Stop hook present');
      assert.ok(content.SessionStart?.[0]?.command?.includes('cli.js'), 'resolved CLI path should be present');
      if (process.platform === 'win32') {
        assert.ok(content.SessionStart?.[0]?.command?.includes('2>$null'), 'Windows should use PowerShell stderr redirection');
        assert.ok(!content.SessionStart?.[0]?.command?.includes('/dev/null'), 'Windows should not use POSIX stderr redirection');
      }

      const second = ensureAntigravityHooks(homeDir);
      assert.equal(second?.created, false);
      assert.equal(second?.updated, false);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('ensureAntigravityHooks returns undefined when no homeDir', () => {
    assert.equal(ensureAntigravityHooks(undefined), undefined);
  });

  it('ensureCopilotHooks writes .github/copilot/hooks.json with Copilot format + idempotence', () => {
    const dir = tmpDir();
    try {
      const first = ensureCopilotHooks(dir);
      assert.equal(first.created, true);
      assert.equal(first.relativePath, '.github/copilot/hooks.json');

      const filePath = path.join(dir, '.github', 'copilot', 'hooks.json');
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
        version?: number;
        hooks?: Record<string, Array<{ bash?: string; powershell?: string; type?: string; timeoutSec?: number }>>;
      };
      assert.equal(content.version, 1);
      assert.ok(content.hooks?.sessionStart?.[0]?.bash?.includes('session-start'), 'sessionStart hook present');
      assert.ok(content.hooks?.userPromptSubmitted?.[0]?.bash?.includes('context-diff'), 'userPromptSubmitted hook present');
      assert.ok(content.hooks?.sessionEnd?.[0]?.bash?.includes('session-end'), 'sessionEnd hook present');
      assert.ok(content.hooks?.sessionStart?.[0]?.bash?.includes('cli.js'), 'bash command should target the CLI entrypoint');
      assert.ok(content.hooks?.sessionStart?.[0]?.bash?.includes('2>/dev/null'), 'bash command should use POSIX stderr redirection');
      assert.ok(content.hooks?.sessionStart?.[0]?.powershell?.includes('cli.js'), 'powershell command should target the CLI entrypoint');
      assert.ok(content.hooks?.sessionStart?.[0]?.powershell?.includes('2>$null'), 'powershell command should use Windows stderr redirection');
      assert.equal(content.hooks?.sessionStart?.[0]?.type, 'command');
      assert.equal(content.hooks?.sessionStart?.[0]?.timeoutSec, 30);

      const second = ensureCopilotHooks(dir);
      assert.equal(second.created, false);
      assert.equal(second.updated, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writeDetectedAgentAutoConfig opencode returns 2 results including universal skill', () => {
    const dir = tmpDir();
    try {
      const results = writeDetectedAgentAutoConfig('opencode', dir);
      assert.equal(results.length, 2);
      assert.ok(results.some((r) => r.relativePath === 'opencode.json'));
      assert.ok(results.some((r) => r.relativePath === '.agents/skills/brainclaw/SKILL.md'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writeDetectedAgentAutoConfig antigravity with homeDir returns 2 results (MCP + hooks)', () => {
    const dir = tmpDir();
    const homeDir = tmpDir();
    try {
      const results = writeDetectedAgentAutoConfig('antigravity', dir, { HOME: homeDir });
      assert.equal(results.length, 2);
      assert.ok(results.some(r => r.relativePath === '.gemini/antigravity/mcp_config.json'));
      assert.ok(results.some(r => r.relativePath === '.gemini/antigravity/hooks.json'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('writeExportCompanionFiles includes hooks for copilot, cursor, and antigravity exports', () => {
    const dir = tmpDir();
    const homeDir = tmpDir();
    try {
      const copilot = writeExportCompanionFiles('copilot-instructions', dir, { HOME: homeDir });
      assert.ok(copilot.some((r) => r.relativePath === '.github/copilot/hooks.json'));

      const cursor = writeExportCompanionFiles('cursor-rules', dir, { HOME: homeDir });
      assert.ok(cursor.some((r) => r.relativePath === '.cursor/hooks.json'));

      const antigravity = writeExportCompanionFiles('gemini-md', dir, { HOME: homeDir });
      assert.ok(antigravity.some((r) => r.relativePath === '.gemini/antigravity/mcp_config.json'));
      assert.ok(antigravity.some((r) => r.relativePath === '.gemini/antigravity/hooks.json'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('creates Codex config.toml with forward-slash paths only', () => {
    const homeDir = tmpDir();
    try {
      resetMcpCommandCache();
      // Inject a Windows-style path via CODEX_HOME env override
      const codexHome = path.join(homeDir, '.codex');
      const result = ensureCodexMcpConfig(homeDir, { CODEX_HOME: codexHome });
      assert.ok(result, 'result should be defined');
      assert.equal(result?.created, true);
      const filePath = path.join(codexHome, 'config.toml');
      const content = fs.readFileSync(filePath, 'utf-8');
      // No unescaped backslashes should appear in any TOML value
      assert.ok(!content.includes('\\'), 'config.toml must not contain backslash characters');
      assert.ok(content.includes('[mcp_servers.brainclaw]'));
      assert.ok(content.includes('BRAINCLAW_AGENT = "codex"'));
      assert.ok(content.includes('startup_timeout_ms = 20000'));
    } finally {
      resetMcpCommandCache();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('does not create duplicate sections on repeated ensureCodexMcpConfig calls', () => {
    const homeDir = tmpDir();
    try {
      resetMcpCommandCache();
      const codexHome = path.join(homeDir, '.codex');
      // First call — creates the file
      ensureCodexMcpConfig(homeDir, { CODEX_HOME: codexHome });
      // Second call — must not duplicate the section
      ensureCodexMcpConfig(homeDir, { CODEX_HOME: codexHome });

      const filePath = path.join(codexHome, 'config.toml');
      const content = fs.readFileSync(filePath, 'utf-8');
      const occurrences = (content.match(/\[mcp_servers\.brainclaw\]/g) ?? []).length;
      assert.equal(occurrences, 1, 'should have exactly one [mcp_servers.brainclaw] section');
    } finally {
      resetMcpCommandCache();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('replaces corrupted/duplicate Codex sections when force-resolved via patchAllMcpConfigs', () => {
    const homeDir = tmpDir();
    try {
      resetMcpCommandCache();
      const codexHome = path.join(homeDir, '.codex');
      fs.mkdirSync(codexHome, { recursive: true });

      // Simulate a corrupted file with duplicate sections and backslash paths
      const corrupted = [
        '[mcp_servers.brainclaw]',
        'command = "C:/Program Files/nodejs/node.exe"',
        'args = ["C:\\\\Users\\\\user\\\\brainclaw\\\\dist\\\\cli.js", "mcp"]',
        '',
        '[mcp_servers.brainclaw.env]',
        'BRAINCLAW_AGENT = "codex"',
        '',
        '[mcp_servers.brainclaw]',
        'command = "C:/Program Files/nodejs/node.exe"',
        'args = ["C:\\\\Users\\\\user\\\\brainclaw\\\\dist\\\\cli.js", "mcp"]',
        '',
        '[mcp_servers.brainclaw.env]',
        'BRAINCLAW_AGENT = "codex"',
      ].join('\n') + '\n';

      const filePath = path.join(codexHome, 'config.toml');
      fs.writeFileSync(filePath, corrupted, 'utf-8');

      // patchAllMcpConfigs sets _forceResolve = true internally, which triggers
      // the section-replace logic in ensureCodexMcpConfig.
      resetMcpCommandCache();
      patchAllMcpConfigs(homeDir, { HOME: homeDir, CODEX_HOME: codexHome });

      const fixed = fs.readFileSync(filePath, 'utf-8');
      const occurrences = (fixed.match(/\[mcp_servers\.brainclaw\]/g) ?? []).length;
      assert.equal(occurrences, 1, 'patching should leave exactly one [mcp_servers.brainclaw] section');
      assert.ok(!fixed.includes('\\\\'), 'no double-backslash escape sequences should remain');
    } finally {
      resetMcpCommandCache();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe('ensureCodexMcpConfig — idempotence and safety', () => {
  it('is idempotent: multiple calls produce exactly one main section and no duplicate tool entries', () => {
    const homeDir = tmpDir();
    try {
      resetMcpCommandCache();
      const codexHome = path.join(homeDir, '.codex');
      ensureCodexMcpConfig(homeDir, { CODEX_HOME: codexHome });
      ensureCodexMcpConfig(homeDir, { CODEX_HOME: codexHome });
      ensureCodexMcpConfig(homeDir, { CODEX_HOME: codexHome });

      const filePath = path.join(codexHome, 'config.toml');
      const content = fs.readFileSync(filePath, 'utf-8');
      const sectionOccurrences = (content.match(/\[mcp_servers\.brainclaw\]/g) ?? []).length;
      assert.equal(sectionOccurrences, 1, 'exactly one [mcp_servers.brainclaw] section');

      // Each tool should appear at most once — no duplicate tool entries
      for (const tool of MCP_HEADLESS_AUTO_TOOL_NAMES) {
        const toolOccurrences = (content.match(new RegExp(`\\[mcp_servers\\.brainclaw\\.tools\\.${tool}\\]`, 'g')) ?? []).length;
        assert.equal(toolOccurrences, 1, `tool ${tool} must appear exactly once`);
      }
    } finally {
      resetMcpCommandCache();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('purges legacy tool sections absent from the headless-auto catalog', () => {
    const homeDir = tmpDir();
    try {
      resetMcpCommandCache();
      const codexHome = path.join(homeDir, '.codex');
      fs.mkdirSync(codexHome, { recursive: true });

      const existing = [
        '[mcp_servers.brainclaw]',
        'command = "node"',
        'args = ["brainclaw", "mcp"]',
        '',
        '[mcp_servers.brainclaw.env]',
        'BRAINCLAW_AGENT = "codex"',
        '',
        '[mcp_servers.brainclaw.tools.bclaw_dispatch]',
        'approval_mode = "approve"',
      ].join('\n') + '\n';

      const filePath = path.join(codexHome, 'config.toml');
      fs.writeFileSync(filePath, existing, 'utf-8');

      ensureCodexMcpConfig(homeDir, { CODEX_HOME: codexHome });

      const content = fs.readFileSync(filePath, 'utf-8');
      assert.ok(
        !content.includes('[mcp_servers.brainclaw.tools.bclaw_dispatch]'),
        'bclaw_dispatch should be purged from tool sections',
      );
      assert.ok(
        content.includes('[mcp_servers.brainclaw.tools.'),
        'headless-auto tool sections should be present',
      );
    } finally {
      resetMcpCommandCache();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('preserves main block cwd customization while syncing tool subsections', () => {
    const homeDir = tmpDir();
    try {
      resetMcpCommandCache();
      const codexHome = path.join(homeDir, '.codex');
      fs.mkdirSync(codexHome, { recursive: true });

      const existing = [
        '[mcp_servers.brainclaw]',
        'command = "node"',
        'args = ["brainclaw", "mcp"]',
        'cwd = "/my/custom/project"',
        'startup_timeout_ms = 20000',
        '',
        '[mcp_servers.brainclaw.env]',
        'BRAINCLAW_AGENT = "codex"',
      ].join('\n') + '\n';

      const filePath = path.join(codexHome, 'config.toml');
      fs.writeFileSync(filePath, existing, 'utf-8');

      ensureCodexMcpConfig(homeDir, { CODEX_HOME: codexHome });

      const content = fs.readFileSync(filePath, 'utf-8');
      assert.ok(content.includes('cwd = "/my/custom/project"'), 'cwd customization should be preserved');
      assert.ok(content.includes('[mcp_servers.brainclaw.tools.'), 'tool subsections should be added');
      assert.ok(content.includes('MACHINE-MANAGED'), 'machine-managed header should be written');
    } finally {
      resetMcpCommandCache();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('handles CRLF line endings without duplicating sections', () => {
    const homeDir = tmpDir();
    try {
      resetMcpCommandCache();
      const codexHome = path.join(homeDir, '.codex');
      fs.mkdirSync(codexHome, { recursive: true });

      const filePath = path.join(codexHome, 'config.toml');
      fs.writeFileSync(filePath, '[some_other_section]\r\nkey = "value"\r\n', 'utf-8');

      ensureCodexMcpConfig(homeDir, { CODEX_HOME: codexHome });

      const content = fs.readFileSync(filePath, 'utf-8');
      const sectionOccurrences = (content.match(/\[mcp_servers\.brainclaw\]/g) ?? []).length;
      assert.equal(sectionOccurrences, 1, 'exactly one [mcp_servers.brainclaw] section with CRLF input');
      const headerOccurrences = (content.match(/MACHINE-MANAGED/g) ?? []).length;
      assert.equal(headerOccurrences, 1, 'exactly one MACHINE-MANAGED tools block header');
    } finally {
      resetMcpCommandCache();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('F1 scope lock: sensitive tools absent, coordination tools present in MCP_HEADLESS_AUTO_TOOL_NAMES', () => {
    const sensitive = [
      'bclaw_dispatch',
      'bclaw_accept',
      'bclaw_reject',
      'bclaw_create_plan',
      'bclaw_setup',
      'bclaw_switch',
      'bclaw_bootstrap',
    ];
    const safeExpected = [
      'bclaw_work',
      'bclaw_coordinate',
      'bclaw_claim',
      'bclaw_session_start',
      'bclaw_assignment_update',
      'bclaw_read_inbox',
    ];

    for (const tool of sensitive) {
      assert.ok(
        !MCP_HEADLESS_AUTO_TOOL_NAMES.includes(tool),
        `${tool} must NOT be in MCP_HEADLESS_AUTO_TOOL_NAMES (sensitive tool)`,
      );
    }
    for (const tool of safeExpected) {
      assert.ok(
        MCP_HEADLESS_AUTO_TOOL_NAMES.includes(tool),
        `${tool} must be in MCP_HEADLESS_AUTO_TOOL_NAMES (safe coordination tool)`,
      );
    }
  });

  it('emits a customization warning on stdout when approval_mode != "approve"', () => {
    const homeDir = tmpDir();
    const captured: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as NodeJS.WriteStream).write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      if (typeof chunk === 'string') captured.push(chunk);
      return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
    };

    try {
      resetMcpCommandCache();
      const codexHome = path.join(homeDir, '.codex');
      fs.mkdirSync(codexHome, { recursive: true });

      const existing = [
        '[mcp_servers.brainclaw]',
        'command = "node"',
        'args = ["brainclaw", "mcp"]',
        '',
        '[mcp_servers.brainclaw.env]',
        'BRAINCLAW_AGENT = "codex"',
        '',
        '[mcp_servers.brainclaw.tools.bclaw_claim]',
        'approval_mode = "suggest"',
      ].join('\n') + '\n';

      const filePath = path.join(codexHome, 'config.toml');
      fs.writeFileSync(filePath, existing, 'utf-8');

      ensureCodexMcpConfig(homeDir, { CODEX_HOME: codexHome });

      const output = captured.join('');
      assert.ok(
        output.includes('[brainclaw] Warning'),
        'should emit a [brainclaw] Warning to stdout',
      );
      assert.ok(
        output.includes('bclaw_claim'),
        'warning should mention the tool with the non-approve mode',
      );
      assert.ok(
        output.includes('"suggest"'),
        'warning should include the actual approval_mode value',
      );
    } finally {
      (process.stdout as NodeJS.WriteStream).write = originalWrite as typeof process.stdout.write;
      resetMcpCommandCache();
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe('ensureUniversalBrainclawSkill', () => {
  it('creates .agents/skills/brainclaw/SKILL.md with expected frontmatter', () => {
    const dir = tmpDir();
    try {
      const result = ensureUniversalBrainclawSkill(dir);
      assert.equal(result.kind, 'skill');
      assert.equal(result.created, true);
      assert.equal(result.updated, false);
      assert.equal(result.relativePath, '.agents/skills/brainclaw/SKILL.md');

      const filePath = path.join(dir, '.agents', 'skills', 'brainclaw', 'SKILL.md');
      assert.ok(fs.existsSync(filePath), 'SKILL.md should exist');
      const content = fs.readFileSync(filePath, 'utf-8');
      assert.ok(content.includes('name: brainclaw'), 'should have name frontmatter');
      assert.ok(content.includes('allowed-tools:'), 'should have allowed-tools frontmatter');
      assert.ok(content.includes('Bash(npx brainclaw:*)'), 'should allow brainclaw bash commands');
      assert.ok(content.startsWith('---\n'), 'should start with frontmatter delimiter');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent — second call returns created=false, updated=false', () => {
    const dir = tmpDir();
    try {
      ensureUniversalBrainclawSkill(dir);
      const second = ensureUniversalBrainclawSkill(dir);
      assert.equal(second.created, false);
      assert.equal(second.updated, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writeDetectedAgentAutoConfig codex without homeDir returns 1 result (universal skill)', () => {
    const dir = tmpDir();
    try {
      const results = writeDetectedAgentAutoConfig('codex', dir, {});
      assert.equal(results.length, 1);
      assert.equal(results[0]?.relativePath, '.agents/skills/brainclaw/SKILL.md');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writeDetectedAgentAutoConfig codex with homeDir returns 2 results including MCP config', () => {
    const dir = tmpDir();
    const homeDir = tmpDir();
    try {
      const results = writeDetectedAgentAutoConfig('codex', dir, { HOME: homeDir });
      assert.equal(results.length, 2);
      assert.ok(results.some((r) => r.relativePath === '.agents/skills/brainclaw/SKILL.md'));
      assert.ok(results.some((r) => r.filePath.includes('.codex') && r.filePath.includes('config.toml')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe('ensureUniversalBrainclawSkill', () => {
  it('creates .agents/skills/brainclaw/SKILL.md with expected frontmatter fields', () => {
    const dir = tmpDir();
    try {
      const result = ensureUniversalBrainclawSkill(dir);
      assert.equal(result.kind, 'skill');
      assert.equal(result.created, true);
      assert.equal(result.updated, false);
      assert.equal(result.relativePath, '.agents/skills/brainclaw/SKILL.md');

      const filePath = path.join(dir, '.agents', 'skills', 'brainclaw', 'SKILL.md');
      assert.ok(fs.existsSync(filePath), 'SKILL.md should exist');
      const content = fs.readFileSync(filePath, 'utf-8');
      assert.ok(content.startsWith('---\n'), 'should start with YAML frontmatter');
      assert.ok(content.includes('name: brainclaw'), 'frontmatter should have name: brainclaw');
      assert.ok(content.includes('description:'), 'frontmatter should have description field');
      assert.ok(content.includes('allowed-tools:'), 'frontmatter should have allowed-tools field');
      assert.ok(content.includes('brainclaw context --json'), 'body should mention brainclaw context --json');
      assert.ok(content.includes('brainclaw session-end'), 'body should mention session-end');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent: repeated calls return created=false updated=false when content unchanged', () => {
    const dir = tmpDir();
    try {
      const first = ensureUniversalBrainclawSkill(dir);
      assert.equal(first.created, true);

      const second = ensureUniversalBrainclawSkill(dir);
      assert.equal(second.created, false);
      assert.equal(second.updated, false);

      const third = ensureUniversalBrainclawSkill(dir);
      assert.equal(third.created, false);
      assert.equal(third.updated, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('writeDetectedAgentAutoConfig — universal skill inclusion', () => {
  it('github-copilot includes .agents/skills/brainclaw/SKILL.md', () => {
    const dir = tmpDir();
    try {
      const results = writeDetectedAgentAutoConfig('github-copilot', dir);
      assert.ok(
        results.some(r => r.relativePath === '.agents/skills/brainclaw/SKILL.md'),
        'github-copilot should include universal skill',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cursor includes .agents/skills/brainclaw/SKILL.md', () => {
    const dir = tmpDir();
    try {
      const results = writeDetectedAgentAutoConfig('cursor', dir, {});
      assert.ok(
        results.some(r => r.relativePath === '.agents/skills/brainclaw/SKILL.md'),
        'cursor should include universal skill',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('roo includes .agents/skills/brainclaw/SKILL.md', () => {
    const dir = tmpDir();
    try {
      const results = writeDetectedAgentAutoConfig('roo', dir);
      assert.ok(
        results.some(r => r.relativePath === '.agents/skills/brainclaw/SKILL.md'),
        'roo should include universal skill',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opencode includes .agents/skills/brainclaw/SKILL.md', () => {
    const dir = tmpDir();
    try {
      const results = writeDetectedAgentAutoConfig('opencode', dir);
      assert.ok(
        results.some(r => r.relativePath === '.agents/skills/brainclaw/SKILL.md'),
        'opencode should include universal skill',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('codex includes .agents/skills/brainclaw/SKILL.md (no homeDir)', () => {
    const dir = tmpDir();
    try {
      const results = writeDetectedAgentAutoConfig('codex', dir, {});
      assert.ok(
        results.some(r => r.relativePath === '.agents/skills/brainclaw/SKILL.md'),
        'codex should include universal skill',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
