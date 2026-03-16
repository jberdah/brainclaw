import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveExportTarget,
  writeExportFile,
  AGENT_EXPORT_REGISTRY,
  FALLBACK_EXPORT_TARGET,
  upsertBrainclawSection,
  BRAINCLAW_SECTION_START,
  BRAINCLAW_SECTION_END,
} from '../../src/core/agent-files.js';
import { runExport } from '../../src/commands/export.js';
import { loadConfig } from '../../src/core/config.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { afterEach, beforeEach } from 'node:test';

describe('agent export registry', () => {
  it('resolves known agents to their native format and path', () => {
    const cases: [string, string, string][] = [
      ['github-copilot', 'copilot-instructions', '.github/copilot-instructions.md'],
      ['claude-code',    'claude-md',            'CLAUDE.md'],
      ['cursor',         'cursor-rules',         '.cursor/rules/brainclaw.md'],
      ['windsurf',       'windsurf',             '.windsurfrules'],
      ['cline',          'cline',                '.clinerules/brainclaw.md'],
      ['codex',          'agents-md',            'AGENTS.md'],
      ['continue',       'continue',             '.continue/rules/brainclaw.md'],
      ['roo',            'roo',                  '.roo/rules/brainclaw.md'],
    ];
    for (const [agentName, expectedFormat, expectedPath] of cases) {
      const target = resolveExportTarget(agentName);
      assert.equal(target.format, expectedFormat, `${agentName} format`);
      assert.equal(target.relativePath, expectedPath, `${agentName} path`);
    }
  });

  it('falls back to agents-md for unknown agents', () => {
    const target = resolveExportTarget('some-unknown-agent');
    assert.equal(target.format, FALLBACK_EXPORT_TARGET.format);
    assert.equal(target.relativePath, FALLBACK_EXPORT_TARGET.relativePath);
  });

  it('AGENT_EXPORT_REGISTRY covers all known agents', () => {
    const names = AGENT_EXPORT_REGISTRY.map((t) => t.agentName);
    for (const expected of ['github-copilot', 'claude-code', 'cursor', 'windsurf', 'cline', 'continue', 'roo']) {
      assert.ok(names.includes(expected), `registry should contain ${expected}`);
    }
  });
});

describe('writeExportFile', () => {
  it('creates file and parent dirs if they do not exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-export-write-'));
    try {
      const result = writeExportFile('# test content', '.cursor/rules/brainclaw.md', tmpDir);
      assert.equal(result.created, true);
      assert.ok(fs.existsSync(result.filePath));
      const content = fs.readFileSync(result.filePath, 'utf-8');
      assert.ok(content.includes('# test content'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('upserts brainclaw section in existing .md file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-export-upsert-'));
    try {
      const filePath = path.join(tmpDir, 'CLAUDE.md');
      fs.writeFileSync(filePath, '# My project\n\nExisting content.\n', 'utf-8');
      writeExportFile('new brainclaw section', 'CLAUDE.md', tmpDir);
      const content = fs.readFileSync(filePath, 'utf-8');
      assert.ok(content.includes('Existing content.'));
      assert.ok(content.includes('new brainclaw section'));
      assert.ok(content.includes(BRAINCLAW_SECTION_START));
      assert.ok(content.includes(BRAINCLAW_SECTION_END));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns created=false on second write', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-export-nocreate-'));
    try {
      writeExportFile('v1', 'CLAUDE.md', tmpDir);
      const result2 = writeExportFile('v2', 'CLAUDE.md', tmpDir);
      assert.equal(result2.created, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('export command formats', () => {
  let workspace: TestWorkspace;

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-export-fmt-',
      projectId: 'prj_export_fmt_test',
    });
  });

  afterEach(() => {
    workspace.cleanup();
  });

  const formats = [
    { format: 'copilot-instructions' as const, expectedFile: '.github/copilot-instructions.md' },
    { format: 'claude-md' as const,            expectedFile: 'CLAUDE.md' },
    { format: 'cursor-rules' as const,         expectedFile: '.cursor/rules/brainclaw.md' },
    { format: 'windsurf' as const,             expectedFile: '.windsurfrules' },
    { format: 'cline' as const,                expectedFile: '.clinerules/brainclaw.md' },
    { format: 'agents-md' as const,            expectedFile: 'AGENTS.md' },
    { format: 'roo' as const,                  expectedFile: '.roo/rules/brainclaw.md' },
    { format: 'continue' as const,             expectedFile: '.continue/rules/brainclaw.md' },
  ];

  for (const { format, expectedFile } of formats) {
    it(`--format ${format} --write creates ${expectedFile} with hygiene section`, () => {
      const logs: string[] = [];
      const orig = console.log;
      console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
      try {
        runExport({ format, write: true, cwd: workspace.dir });
      } finally {
        console.log = orig;
      }
      const filePath = path.join(workspace.dir, expectedFile);
      assert.ok(fs.existsSync(filePath), `${expectedFile} should exist`);
      const content = fs.readFileSync(filePath, 'utf-8');
      assert.ok(content.includes('brainclaw'), 'should mention brainclaw');
      assert.ok(content.includes('brainclaw context'), 'should contain hygiene: brainclaw context');
      assert.ok(content.includes('release-claim'), 'should contain hygiene: release-claim');

      if (format === 'copilot-instructions') {
        assert.ok(fs.existsSync(path.join(workspace.dir, '.github', 'skills', 'brainclaw-context', 'SKILL.md')));
      }
      if (format === 'cursor-rules') {
        assert.ok(fs.existsSync(path.join(workspace.dir, '.cursor', 'rules', 'brainclaw-mcp-shim.mdc')));
      }
      if (format === 'cline') {
        assert.ok(fs.existsSync(path.join(workspace.dir, '.vscode', 'cline_mcp_settings.json')));
      }

      const declarationAgentName = format === 'agents-md'
        ? 'codex'
        : format === 'copilot-instructions'
          ? 'github-copilot'
          : format === 'claude-md'
            ? 'claude-code'
            : format === 'cursor-rules'
              ? 'cursor'
              : format;
      const declaration = loadConfig(workspace.dir).agent_integrations.declarations.find((item) => item.agent_name === declarationAgentName);
      assert.ok(declaration, `manifest should include declaration for ${format}`);
    });
  }

  it('--detect with BRAINCLAW_AGENT env writes to correct file', () => {
    const savedAgent = process.env.BRAINCLAW_AGENT;
    process.env.BRAINCLAW_AGENT = 'claude-code';
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    try {
      runExport({ detect: true, cwd: workspace.dir });
      const claudeMd = path.join(workspace.dir, 'CLAUDE.md');
      assert.ok(fs.existsSync(claudeMd), 'CLAUDE.md should be created');
      const declaration = loadConfig(workspace.dir).agent_integrations.declarations.find((item) => item.agent_name === 'claude-code');
      assert.ok(declaration, 'manifest should include claude-code');
      assert.ok(logs.some((l) => l.includes('claude-code')), 'should log detected agent');
      assert.ok(logs.some((l) => l.includes('CLAUDE.md')), 'should log file written');
    } finally {
      console.log = orig;
      if (savedAgent === undefined) delete process.env.BRAINCLAW_AGENT;
      else process.env.BRAINCLAW_AGENT = savedAgent;
    }
  });

  it('--detect with cursor env writes to .cursor/rules/brainclaw.md', () => {
    const saved = process.env.CURSOR_TRACE_ID;
    process.env.CURSOR_TRACE_ID = 'test-trace';
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    try {
      runExport({ detect: true, cwd: workspace.dir });
      const cursorFile = path.join(workspace.dir, '.cursor', 'rules', 'brainclaw.md');
      assert.ok(fs.existsSync(cursorFile), '.cursor/rules/brainclaw.md should be created');
      assert.ok(fs.existsSync(path.join(workspace.dir, '.cursor', 'rules', 'brainclaw-mcp-shim.mdc')));
      const declaration = loadConfig(workspace.dir).agent_integrations.declarations.find((item) => item.agent_name === 'cursor');
      assert.ok(declaration, 'manifest should include cursor');
    } finally {
      console.log = orig;
      if (saved === undefined) delete process.env.CURSOR_TRACE_ID;
      else process.env.CURSOR_TRACE_ID = saved;
    }
  });

  it('--detect with copilot env writes both instructions and the Copilot skill', () => {
    const savedToken = process.env.GITHUB_COPILOT_TOKEN;
    process.env.GITHUB_COPILOT_TOKEN = 'test-token';
    try {
      runExport({ detect: true, cwd: workspace.dir });
      assert.ok(fs.existsSync(path.join(workspace.dir, '.github', 'copilot-instructions.md')));
      assert.ok(fs.existsSync(path.join(workspace.dir, '.github', 'skills', 'brainclaw-context', 'SKILL.md')));
      const declaration = loadConfig(workspace.dir).agent_integrations.declarations.find((item) => item.agent_name === 'github-copilot');
      assert.ok(declaration, 'manifest should include github-copilot');
    } finally {
      if (savedToken === undefined) delete process.env.GITHUB_COPILOT_TOKEN;
      else process.env.GITHUB_COPILOT_TOKEN = savedToken;
    }
  });
});
