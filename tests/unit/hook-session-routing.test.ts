/**
 * Regression for trp#2207: an interactive hook is a new CLI process and may
 * not inherit the MCP session environment. The hook event is its stable
 * session authority, so routing must be tested through the real CLI boundary.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import { createTrap } from '../../src/core/operations/memory-write.js';
import { saveCurrentSession } from '../../src/core/identity.js';

const CLI_PATH = path.resolve('dist-test/src/cli.js');
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function makeStore(dir: string, name: string, projectId: string, workspace = false): void {
  fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
  saveConfig(defaultConfig(name, {
    projectId,
    ...(workspace ? { projectMode: 'multi-project' as const, projectStrategy: 'folder' as const } : {}),
  }), dir);
  if (workspace) fs.appendFileSync(path.join(dir, '.brainclaw', 'config.yaml'), '\nstore_type: workspace\n', 'utf8');
}

describe('hook session routing — mono-repo workspace', () => {
  it('routes UserPromptSubmit to the session-switched child when identity is only in hook stdin', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-hook-routing-'));
    roots.push(root);
    const child = path.join(root, 'apps', 'api');
    makeStore(root, 'workspace', 'prj_workspace', true);
    makeStore(child, 'api', 'prj_api');

    const sessionId = 'sess_hook_routing';
    const now = new Date().toISOString();
    saveCurrentSession({
      session_id: sessionId,
      started_at: now,
      last_seen_at: now,
      agent: 'codex',
      agent_id: 'agt_hook_test',
      host_id: 'host_hook_test',
      pid: process.pid,
      active_project: { path: child, name: 'api', switched_at: now },
    }, root);
    const marker = 'hook routing child marker';
    createTrap({ text: marker, author: 'fixture', severity: 'high' }, child);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BRAINCLAW_CWD: root,
      BRAINCLAW_STORE_BOUNDARY: root,
      USER: 'hook-test-user',
      USERNAME: 'hook-test-user',
    };
    delete env.BRAINCLAW_AGENT_NAME;
    delete env.BRAINCLAW_SESSION_ID;
    delete env.BRAINCLAW_PROJECT;

    const result = spawnSync(process.execPath, [
      CLI_PATH,
      'context-diff',
      '--hook',
      '--since',
      '1970-01-01T00:00:00.000Z',
      '--json',
    ], {
      cwd: root,
      env,
      input: JSON.stringify({ session_id: sessionId }),
      encoding: 'utf8',
      timeout: 30_000,
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as {
      counts?: { traps?: number };
      changed_items?: Array<{ text?: string }>;
    };
    assert.ok((output.counts?.traps ?? 0) >= 1, 'hook must read the child project state');
    assert.ok(output.changed_items?.some((item) => item.text === marker), 'child trap must be visible to the hook');
  });
});
