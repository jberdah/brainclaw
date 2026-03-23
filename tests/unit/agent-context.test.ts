import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAgentToolingContext } from '../../src/core/agent-context.js';

describe('core/agent-context', () => {
  let dir: string;
  let codexHome: string;
  let previousCodexHome: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-agent-context-'));
    codexHome = path.join(dir, '.codex-home');
    fs.mkdirSync(path.join(codexHome, 'skills', '.system', 'code-review'), { recursive: true });
    fs.mkdirSync(path.join(codexHome, 'skills', '.system', 'code-review', 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(codexHome, 'skills', '.system', 'code-review', 'references'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agent Guide\n\n- Read memory first\n- Prefer focused diffs\n', 'utf-8');
    fs.writeFileSync(
      path.join(codexHome, 'skills', '.system', 'code-review', 'SKILL.md'),
      '# Code Review\n\nUse this skill when reviewing code changes.\n',
      'utf-8',
    );
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      'model = "gpt-5.4"\n\n[mcp_servers.atlassian]\ncommand = "npx"\nargs = ["-y", "mcp-remote", "https://mcp.atlassian.com/v1/sse"]\n\n[mcp_servers.localfs]\ncommand = "node"\n',
      'utf-8',
    );
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
  });

  afterEach(() => {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads AGENTS.md, local skills, and MCP config deterministically', () => {
    const snapshot = buildAgentToolingContext({ cwd: dir });

    assert.equal(snapshot.agents_md_present, true);
    assert.equal(snapshot.agents_md_title, 'Agent Guide');
    assert.deepEqual(snapshot.agents_rules, ['Read memory first', 'Prefer focused diffs']);
    assert.equal(snapshot.skills.length, 1);
    assert.equal(snapshot.skills[0]?.name, 'code-review');
    assert.equal(snapshot.skills[0]?.scripts_present, true);
    assert.equal(snapshot.skills[0]?.references_present, true);
    assert.equal(snapshot.skills[0]?.assets_present, false);
    assert.match(snapshot.skills[0]?.source_path ?? '', /SKILL\.md$/);
    assert.equal(snapshot.mcp_servers.length, 2);
    assert.equal(snapshot.mcp_servers[0]?.name, 'atlassian');
    assert.equal(snapshot.mcp_servers[0]?.transport, 'remote');
    assert.equal(snapshot.mcp_servers[0]?.availability, 'remote');
    assert.equal(snapshot.mcp_servers[1]?.name, 'localfs');
    assert.equal(snapshot.mcp_servers[1]?.availability, 'available');
  });

  it('returns empty inventories when no local signals are present', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-agent-context-empty-'));
    try {
      const snapshot = buildAgentToolingContext({
        cwd: emptyDir,
        env: { CODEX_HOME: path.join(emptyDir, '.missing-codex') },
      });

      assert.equal(snapshot.agents_md_present, false);
      assert.deepEqual(snapshot.agents_rules, []);
      assert.deepEqual(snapshot.skills, []);
      assert.deepEqual(snapshot.mcp_servers, []);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('skips descriptive "why this matters" bullets in AGENTS.md', () => {
    fs.writeFileSync(
      path.join(dir, 'AGENTS.md'),
      [
        '## brainclaw — why this matters',
        '',
        'This project uses brainclaw for shared memory.',
        '- You may edit files another agent is actively working on',
        '- You will miss known traps and architectural decisions',
        '',
        '## brainclaw — session protocol (REQUIRED)',
        '',
        '- Call bclaw_session_start before any work',
        '- Call bclaw_get_context for your scope',
        '',
        '## brainclaw — active constraints',
        '',
        '- No deployments on Friday',
      ].join('\n'),
      'utf-8',
    );
    const snapshot = buildAgentToolingContext({ cwd: dir });
    // "why" bullets should be excluded, only protocol and constraints kept
    assert.ok(!snapshot.agents_rules.some((r) => r.includes('You may edit')), 'why bullet should be excluded');
    assert.ok(!snapshot.agents_rules.some((r) => r.includes('You will miss')), 'why bullet should be excluded');
    assert.ok(snapshot.agents_rules.some((r) => r.includes('bclaw_session_start')), 'protocol rule should be included');
    assert.ok(snapshot.agents_rules.some((r) => r.includes('No deployments')), 'constraint should be included');
  });

  it('marks stdio MCP servers with missing local commands', () => {
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      '[mcp_servers.missing]\ncommand = "definitely-missing-brainclaw-command"\n',
      'utf-8',
    );

    const snapshot = buildAgentToolingContext({ cwd: dir });
    assert.equal(snapshot.mcp_servers.length, 1);
    assert.equal(snapshot.mcp_servers[0]?.name, 'missing');
    assert.equal(snapshot.mcp_servers[0]?.transport, 'stdio');
    assert.equal(snapshot.mcp_servers[0]?.availability, 'missing_command');
    assert.equal(snapshot.mcp_servers[0]?.source, 'codex_home');
  });
});
