/**
 * Regression: every machine-generated agent surface must push the Brainclaw
 * MCP facade first — the CLI is only a fallback when MCP is unavailable.
 *
 * Codex audit (2026-04-20) flagged five surfaces as still CLI-first:
 *   - .cursor/rules/brainclaw-session.mdc (alwaysApply)
 *   - .cursor/rules/brainclaw-mcp-shim.mdc (alwaysApply)
 *   - .windsurf/rules/brainclaw.md
 *   - .github/skills/brainclaw-context/SKILL.md
 *   - .agents/skills/brainclaw/SKILL.md (universal)
 *
 * With alwaysApply: true the Cursor rules override the main brainclaw.md rule,
 * so the agent learned "brainclaw context" CLI workflow even though the
 * facade was documented elsewhere. This test locks in the alignment by
 * exercising the writer functions directly and inspecting the template
 * output — if a future commit re-introduces a CLI-first template, the
 * assertion fails.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  ensureCursorMdc,
  ensureWindsurfModernRules,
  ensureCopilotSkill,
  ensureUniversalBrainclawSkill,
} from '../../src/core/agent-files.js';
import { generateCursorHook, generateWindsurfHook, generateMarkdownHook } from '../../src/commands/hooks.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-facade-surface-'));
}

function cleanupTmpDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Strip YAML frontmatter so trigger-phrase metadata doesn't match CLI patterns. */
function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('\n---', 3);
  if (end < 0) return content;
  return content.slice(end + 4);
}

function assertFacadeFirst(name: string, rawContent: string): void {
  const content = stripFrontmatter(rawContent);
  // Must mention at least one MCP facade by name.
  const facadeMatch = content.search(/bclaw_work|bclaw_coordinate|bclaw_context\b|bclaw_session_end|bclaw_release_claim/);
  assert.ok(facadeMatch >= 0, `${name} must mention a Brainclaw MCP facade`);

  // Any CLI usage (brainclaw context / claim / session-end) must come AFTER
  // the first facade mention. Mentions inside a "fallback" clause are fine
  // as long as they arrive later in the document.
  const cliPatterns = [
    /\bbrainclaw context\b/,
    /\bbrainclaw claim list\b/,
    /\bbrainclaw claim create\b/,
    /\bbrainclaw session-end\b/,
    /\bbrainclaw update-plan\b/,
  ];
  for (const pattern of cliPatterns) {
    const m = content.search(pattern);
    if (m >= 0) {
      assert.ok(
        m > facadeMatch,
        `${name}: CLI verb ${String(pattern)} appears BEFORE any facade mention — CLI must be a fallback, not the primary path`,
      );
    }
  }
}

describe('agent surface alignment — facade-first templates', () => {
  it('ensureCursorMdc (Cursor alwaysApply rule) is facade-first', () => {
    const dir = makeTmpDir();
    try {
      const result = ensureCursorMdc(dir);
      const content = fs.readFileSync(result.filePath, 'utf-8');
      assertFacadeFirst('cursor mcp-shim', content);
      assert.match(content, /alwaysApply:\s*true/);
    } finally {
      cleanupTmpDir(dir);
    }
  });

  it('ensureWindsurfModernRules (.windsurf/rules/brainclaw.md) is facade-first', () => {
    const dir = makeTmpDir();
    try {
      const result = ensureWindsurfModernRules(dir);
      const content = fs.readFileSync(result.filePath, 'utf-8');
      assertFacadeFirst('windsurf modern rules', content);
    } finally {
      cleanupTmpDir(dir);
    }
  });

  it('ensureCopilotSkill (.github/skills/brainclaw-context/SKILL.md) is facade-first', () => {
    const dir = makeTmpDir();
    try {
      const result = ensureCopilotSkill(dir);
      const content = fs.readFileSync(result.filePath, 'utf-8');
      assertFacadeFirst('copilot skill', content);
    } finally {
      cleanupTmpDir(dir);
    }
  });

  it('ensureUniversalBrainclawSkill (.agents/skills/brainclaw/SKILL.md) is facade-first', () => {
    const dir = makeTmpDir();
    try {
      const result = ensureUniversalBrainclawSkill(dir);
      const content = fs.readFileSync(result.filePath, 'utf-8');
      assertFacadeFirst('universal skill', content);
    } finally {
      cleanupTmpDir(dir);
    }
  });

  it('generateCursorHook (brainclaw-session.mdc) is facade-first', () => {
    const content = generateCursorHook('test-project');
    assertFacadeFirst('cursor session hook', content);
  });

  it('generateWindsurfHook (.windsurfrules sentinel section) is facade-first', () => {
    const content = generateWindsurfHook('test-project');
    assertFacadeFirst('windsurf hook', content);
  });

  it('generateMarkdownHook (cline/codex/copilot shared template) is facade-first', () => {
    const content = generateMarkdownHook('Cline', 'test-project');
    assertFacadeFirst('markdown hook', content);
  });
});
