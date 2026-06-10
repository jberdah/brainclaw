import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'yaml';
import {
  ensureClaudeCodeMcpConfig,
  ensureClaudeCodeSettings,
  ensureCopilotMcpConfig,
  ensureContinueUserPermissions,
  ensureGitignoreEntries,
  ensureHermesMcpConfig,
  ensureKilocodeConfig,
  ensureVscodeExtensionRecommendation,
} from '../../src/core/agent-files.js';

function tmpDir(prefix = 'bclaw-writer-safety-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runThrice<T>(fn: () => T): T[] {
  return [fn(), fn(), fn()];
}

describe('config writers — parse-failure abort (never clobber)', () => {
  it('leaves an unparseable .mcp.json byte-identical and reports skipped', () => {
    const dir = tmpDir();
    try {
      const filePath = path.join(dir, '.mcp.json');
      const broken = '{ "mcpServers": { "mine": } BROKEN';
      fs.writeFileSync(filePath, broken, 'utf-8');

      const result = ensureClaudeCodeMcpConfig(dir);
      assert.equal(result.skipped, true);
      assert.equal(result.created, false);
      assert.equal(result.updated, false);
      assert.ok(result.warning && result.warning.includes('left untouched'));
      assert.equal(fs.readFileSync(filePath, 'utf-8'), broken, 'file must not be overwritten');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves an unparseable settings.local.json byte-identical', () => {
    const dir = tmpDir();
    try {
      const filePath = path.join(dir, '.claude', 'settings.local.json');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const broken = '// not valid for strict JSON\n{ "permissions": { "allow": [ } }';
      fs.writeFileSync(filePath, broken, 'utf-8');

      const result = ensureClaudeCodeSettings(dir);
      assert.equal(result.skipped, true);
      assert.equal(fs.readFileSync(filePath, 'utf-8'), broken);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses a BOM-prefixed .mcp.json and preserves user servers (3× idempotent)', () => {
    const dir = tmpDir();
    try {
      const filePath = path.join(dir, '.mcp.json');
      const userConfig = { mcpServers: { userServer: { command: 'my-tool', args: ['serve'] } } };
      fs.writeFileSync(filePath, `\u{FEFF}${JSON.stringify(userConfig, null, 2)}\n`, 'utf-8');

      const [first, second, third] = runThrice(() => ensureClaudeCodeMcpConfig(dir));
      assert.equal(first!.skipped ?? false, false);
      assert.equal(second!.created || second!.updated, false, 'second run must be a no-op');
      assert.equal(third!.created || third!.updated, false, 'third run must be a no-op');

      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
        mcpServers: Record<string, { command?: string; args?: string[] }>;
      };
      assert.deepEqual(parsed.mcpServers.userServer, userConfig.mcpServers.userServer, 'user server must survive');
      assert.ok(parsed.mcpServers.brainclaw, 'brainclaw entry added');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses .vscode/settings.json with JSONC comments instead of clobbering it', () => {
    const dir = tmpDir();
    try {
      const filePath = path.join(dir, '.vscode', 'settings.json');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, [
        '{',
        '  // user-tuned editor settings',
        '  "editor.fontSize": 14,',
        '  /* keep this */',
        '  "files.eol": "\\n"',
        '}',
      ].join('\n'), 'utf-8');

      const [first, second] = runThrice(() => ensureCopilotMcpConfig(dir));
      assert.equal(first!.skipped ?? false, false);
      assert.equal(second!.created || second!.updated, false, 'second run must be a no-op');

      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
      assert.equal(parsed['editor.fontSize'], 14, 'user data must survive');
      assert.equal(parsed['files.eol'], '\n');
      assert.ok(parsed['github.copilot.chat.mcpServers'], 'brainclaw MCP entry added');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses .vscode/extensions.json with comments and keeps user recommendations', () => {
    const dir = tmpDir();
    try {
      const filePath = path.join(dir, '.vscode', 'extensions.json');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, '{\n  // team picks\n  "recommendations": ["dbaeumer.vscode-eslint"]\n}\n', 'utf-8');

      ensureVscodeExtensionRecommendation(dir);
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { recommendations: string[] };
      assert.ok(parsed.recommendations.includes('dbaeumer.vscode-eslint'), 'user recommendation must survive');
      assert.ok(parsed.recommendations.includes('brainclaw.brainclaw-vscode'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Claude Code session hooks — generation, dedupe, migration', () => {
  interface HookFile {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>>;
  }

  function readSettings(dir: string): HookFile {
    return JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf-8')) as HookFile;
  }

  function brainclawCommands(entries: HookFile['hooks'][string]): string[] {
    return entries.flatMap((e) => e.hooks.map((h) => h.command))
      .filter((c) => /brainclaw|bclaw|check-events/.test(c));
  }

  it('emits hook commands that keep the cli.js argument (no bare node.exe)', () => {
    const dir = tmpDir();
    try {
      ensureClaudeCodeSettings(dir);
      const content = readSettings(dir);
      const [sessionCmd] = brainclawCommands(content.hooks.UserPromptSubmit!);
      assert.ok(sessionCmd, 'session hook present');
      // Either npx fallback, or resolved node + cli.js — never node alone.
      if (!sessionCmd!.includes('npx brainclaw')) {
        assert.ok(sessionCmd!.includes('cli.js'), `resolved hook must include cli.js: ${sessionCmd}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrates duplicated + broken legacy hooks down to exactly one per event, preserving user hooks', () => {
    const dir = tmpDir();
    try {
      const filePath = path.join(dir, '.claude', 'settings.local.json');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      // Mirror of the duplication observed live: stale absolute-bin variant +
      // broken node.exe variant (cli.js arg dropped) + an old flag set.
      fs.writeFileSync(filePath, JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { matcher: '', hooks: [{ type: 'command', command: 'f=.claude/.bclaw-session; if [ ! -f "$f" ]; then touch "$f"; "C:/Users/x/AppData/Roaming/npm/brainclaw" session-start --include-context 2>/dev/null; else "C:/Users/x/AppData/Roaming/npm/brainclaw" context-diff 2>/dev/null; fi' }] },
            { matcher: '', hooks: [{ type: 'command', command: 'f=.claude/.bclaw-session; if [ ! -f "$f" ]; then touch "$f"; "C:/Program Files/nodejs/node.exe" session-start --include-context 2>/dev/null; else "C:/Program Files/nodejs/node.exe" context-diff 2>/dev/null; fi' }] },
            { matcher: '', hooks: [{ type: 'command', command: 'echo my-own-user-hook' }] },
          ],
          Stop: [
            { matcher: '', hooks: [{ type: 'command', command: 'rm -f .claude/.bclaw-session; "C:/Users/x/AppData/Roaming/npm/brainclaw" session-end --auto-release --reflect 2>/dev/null' }] },
            { matcher: '', hooks: [{ type: 'command', command: 'rm -f .claude/.bclaw-session; "C:/Users/x/AppData/Roaming/npm/brainclaw" session-end --auto-release --reflect --reflect-handoff 2>/dev/null' }] },
            { matcher: '', hooks: [{ type: 'command', command: 'npx brainclaw session-end --auto-release 2>/dev/null' }] },
          ],
        },
      }, null, 2), 'utf-8');

      ensureClaudeCodeSettings(dir);
      const content = readSettings(dir);

      assert.equal(brainclawCommands(content.hooks.UserPromptSubmit!).length, 1, 'exactly one brainclaw UserPromptSubmit hook');
      assert.equal(brainclawCommands(content.hooks.Stop!).length, 1, 'exactly one brainclaw Stop hook');
      assert.equal(brainclawCommands(content.hooks.PostToolUse!).length, 1, 'exactly one brainclaw PostToolUse hook');

      const userHooks = content.hooks.UserPromptSubmit!
        .flatMap((e) => e.hooks.map((h) => h.command))
        .filter((c) => c === 'echo my-own-user-hook');
      assert.equal(userHooks.length, 1, 'user-authored hook must survive migration');

      const [sessionCmd] = brainclawCommands(content.hooks.UserPromptSubmit!);
      assert.ok(
        !/node(\.exe)?" session-start/.test(sessionCmd!),
        `broken bare-node hook must not survive: ${sessionCmd}`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent across 3 runs (file byte-identical after first run)', () => {
    const dir = tmpDir();
    try {
      const filePath = path.join(dir, '.claude', 'settings.local.json');
      ensureClaudeCodeSettings(dir);
      const afterFirst = fs.readFileSync(filePath, 'utf-8');

      const second = ensureClaudeCodeSettings(dir);
      const third = ensureClaudeCodeSettings(dir);
      assert.equal(second.created || second.updated, false);
      assert.equal(third.created || third.updated, false);
      assert.equal(fs.readFileSync(filePath, 'utf-8'), afterFirst);

      const content = readSettings(dir);
      for (const event of ['UserPromptSubmit', 'Stop', 'PostToolUse'] as const) {
        assert.equal(brainclawCommands(content.hooks[event]!).length, 1, `exactly one brainclaw hook for ${event}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('kilo.jsonc — comment-preserving edit', () => {
  it('inserts permission.external_directory while preserving comments and user keys (3×)', () => {
    const dir = tmpDir();
    try {
      const filePath = path.join(dir, 'kilo.jsonc');
      const fixture = [
        '{',
        '  // model picks tuned by hand',
        '  "model": "claude-opus-4-7", // primary',
        '  /* block comment the user cares about */',
        '  "permission": {',
        '    "browser": "ask"',
        '  }',
        '}',
      ].join('\n');
      fs.writeFileSync(filePath, fixture, 'utf-8');

      const [first, second, third] = runThrice(() => ensureKilocodeConfig(dir));
      assert.equal(first!.updated, true);
      assert.equal(second!.created || second!.updated, false, 'second run no-op');
      assert.equal(third!.created || third!.updated, false, 'third run no-op');

      const raw = fs.readFileSync(filePath, 'utf-8');
      assert.ok(raw.includes('// model picks tuned by hand'), 'line comment preserved');
      assert.ok(raw.includes('/* block comment the user cares about */'), 'block comment preserved');
      assert.ok(raw.includes('// primary'), 'trailing comment preserved');
      assert.ok(raw.includes('"browser": "ask"'), 'user permission key preserved');

      // Parse the JSONC (strip comments) to verify structure
      const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      const parsed = JSON.parse(stripped) as { permission: Record<string, string>; model: string };
      assert.equal(parsed.permission.external_directory, 'deny');
      assert.equal(parsed.permission.browser, 'ask');
      assert.equal(parsed.model, 'claude-opus-4-7');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replaces a differing external_directory value in place', () => {
    const dir = tmpDir();
    try {
      const filePath = path.join(dir, 'kilo.jsonc');
      fs.writeFileSync(filePath, '{\n  // keep\n  "permission": { "external_directory": "allow" }\n}\n', 'utf-8');
      const result = ensureKilocodeConfig(dir);
      assert.equal(result.updated, true);
      const raw = fs.readFileSync(filePath, 'utf-8');
      assert.ok(raw.includes('// keep'));
      assert.ok(raw.includes('"external_directory": "deny"'));
      assert.ok(!raw.includes('"allow"'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is byte-identical when the value is already deny', () => {
    const dir = tmpDir();
    try {
      const filePath = path.join(dir, 'kilo.jsonc');
      const fixture = '{\n  // mine\n  "permission": {\n    "external_directory": "deny"\n  }\n}\n';
      fs.writeFileSync(filePath, fixture, 'utf-8');
      const result = ensureKilocodeConfig(dir);
      assert.equal(result.created || result.updated, false);
      assert.equal(fs.readFileSync(filePath, 'utf-8'), fixture);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips an unparseable kilo.jsonc and leaves it untouched', () => {
    const dir = tmpDir();
    try {
      const filePath = path.join(dir, 'kilo.jsonc');
      const broken = '{ "permission": { /* unterminated';
      fs.writeFileSync(filePath, broken, 'utf-8');
      const result = ensureKilocodeConfig(dir);
      assert.equal(result.skipped, true);
      assert.equal(fs.readFileSync(filePath, 'utf-8'), broken);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Hermes config.yaml — managed-subtree merge', () => {
  it('preserves comments, anchors, and user keys across 3 runs', () => {
    const home = tmpDir('bclaw-hermes-safety-');
    try {
      const filePath = path.join(home, '.hermes', 'config.yaml');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const fixture = [
        '# my hand-written hermes config',
        'default_model: &model openrouter/auto',
        'fallback_model: *model',
        'sampling:',
        '  temperature: 0.2 # keep low',
        '',
      ].join('\n');
      fs.writeFileSync(filePath, fixture, 'utf-8');

      const workspace = tmpDir('bclaw-hermes-safety-ws-');
      const first = ensureHermesMcpConfig(home, workspace);
      assert.ok(first);
      assert.equal(first!.skipped ?? false, false);
      assert.equal(first!.updated, true);

      const afterFirst = fs.readFileSync(filePath, 'utf-8');
      assert.ok(afterFirst.includes('# my hand-written hermes config'), 'user comment preserved');
      assert.ok(afterFirst.includes('&model'), 'anchor preserved');
      assert.ok(afterFirst.includes('*model'), 'alias preserved');
      assert.ok(afterFirst.includes('# keep low'), 'inline comment preserved');

      const second = ensureHermesMcpConfig(home, workspace);
      const third = ensureHermesMcpConfig(home, workspace);
      assert.equal(second!.created || second!.updated, false, 'second run no-op');
      assert.equal(third!.created || third!.updated, false, 'third run no-op');
      assert.equal(fs.readFileSync(filePath, 'utf-8'), afterFirst, 'byte-identical after first run');

      const parsed = yaml.parse(afterFirst) as Record<string, any>;
      assert.equal(parsed.default_model, 'openrouter/auto');
      assert.equal(parsed.fallback_model, 'openrouter/auto');
      assert.equal(parsed.sampling.temperature, 0.2);
      assert.equal(parsed.mcp_servers.brainclaw.env.BRAINCLAW_AGENT, 'hermes');
      fs.rmSync(workspace, { recursive: true, force: true });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('skips an unparseable config.yaml instead of replacing it with a stub', () => {
    const home = tmpDir('bclaw-hermes-broken-');
    try {
      const filePath = path.join(home, '.hermes', 'config.yaml');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const broken = 'default_model: [unclosed\n  bad: : :\n';
      fs.writeFileSync(filePath, broken, 'utf-8');

      const result = ensureHermesMcpConfig(home, undefined);
      assert.ok(result);
      assert.equal(result!.skipped, true);
      assert.equal(fs.readFileSync(filePath, 'utf-8'), broken);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('Continue permissions.yaml — managed-subtree merge', () => {
  it('preserves comments and user tool entries across 3 runs', () => {
    const home = tmpDir('bclaw-continue-safety-');
    try {
      const filePath = path.join(home, '.continue', 'permissions.yaml');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const fixture = [
        '# reviewed by the team 2026-05',
        'tools:',
        '  my_custom_tool:',
        '    allow: false # deliberately blocked',
        '',
      ].join('\n');
      fs.writeFileSync(filePath, fixture, 'utf-8');

      const first = ensureContinueUserPermissions(home);
      assert.ok(first);
      assert.equal(first!.skipped ?? false, false);
      const afterFirst = fs.readFileSync(filePath, 'utf-8');
      assert.ok(afterFirst.includes('# reviewed by the team 2026-05'), 'header comment preserved');
      assert.ok(afterFirst.includes('# deliberately blocked'), 'inline comment preserved');

      const second = ensureContinueUserPermissions(home);
      const third = ensureContinueUserPermissions(home);
      assert.equal(second!.created || second!.updated, false, 'second run no-op');
      assert.equal(third!.created || third!.updated, false, 'third run no-op');
      assert.equal(fs.readFileSync(filePath, 'utf-8'), afterFirst, 'byte-identical after first run');

      const parsed = yaml.parse(afterFirst) as { tools: Record<string, { allow: boolean }> };
      assert.equal(parsed.tools.my_custom_tool.allow, false, 'user tool entry untouched');
      assert.equal(parsed.tools.bclaw_work?.allow, true, 'brainclaw tool allowed');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('skips an unparseable permissions.yaml', () => {
    const home = tmpDir('bclaw-continue-broken-');
    try {
      const filePath = path.join(home, '.continue', 'permissions.yaml');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const broken = 'tools: [a: b\n  : bad';
      fs.writeFileSync(filePath, broken, 'utf-8');
      const result = ensureContinueUserPermissions(home);
      assert.ok(result);
      assert.equal(result!.skipped, true);
      assert.equal(fs.readFileSync(filePath, 'utf-8'), broken);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('gitignore — banner does not accumulate', () => {
  it('writes the banner once across successive calls', () => {
    const dir = tmpDir();
    try {
      ensureGitignoreEntries(dir, ['.vscode/mcp.json']);
      ensureGitignoreEntries(dir, ['.roo/mcp.json']);
      ensureGitignoreEntries(dir, ['.kilo/mcp.json']);
      const raw = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
      const banners = raw.match(/# Agent instruction files \(generated by brainclaw\)/g) ?? [];
      assert.equal(banners.length, 1, `expected exactly one banner, got:\n${raw}`);
      assert.ok(raw.includes('.vscode/mcp.json'));
      assert.ok(raw.includes('.roo/mcp.json'));
      assert.ok(raw.includes('.kilo/mcp.json'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mojibake guard', () => {
  it('src contains no double-encoded UTF-8 (â€)', () => {
    const srcDir = path.resolve(import.meta.dirname, '..', '..', 'src');
    const offenders: string[] = [];
    const scan = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { scan(full); continue; }
        if (!/\.(ts|js)$/.test(entry.name)) continue;
        if (/â€/.test(fs.readFileSync(full, 'utf-8'))) offenders.push(full);
      }
    };
    scan(srcDir);
    assert.deepEqual(offenders, []);
  });
});
