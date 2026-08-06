import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { listAvailableProjects, runSwitch } from '../../src/commands/switch.js';
import { loadCurrentSession, loadSessionById, saveCurrentSession } from '../../src/core/identity.js';
import { loadActiveProject, saveActiveProject, clearActiveProject } from '../../src/core/active-project.js';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import { addCrossProjectLink } from '../../src/core/cross-project.js';

/**
 * F3 + F5 (monorepo independence, trp_71accb07) — CLI `switch`.
 *
 * F3: `brainclaw switch X` is session-scoped by default and auto-creates a
 *     session — it must NEVER write the shared global active-project.json, so
 *     two CLI agents can't clobber each other. `--global` is the ONLY CLI path
 *     that mutates the shared pointer; it bypasses the session. `--clear` is
 *     session-only by default, `--clear --global` clears the shared pointer.
 * F5: `--list` / show reflect the agent's own session active project, not just
 *     the global pointer.
 */
describe('switch CLI — session-scoped by default (F3+F5)', () => {
  let ws: TestWorkspace;
  let restoreCwd: (() => void) | undefined;
  let previousSessionId: string | undefined;

  function addChildProject(rel: string, name: string): string {
    const dir = path.join(ws.dir, rel);
    fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
    saveConfig(defaultConfig(name, { projectId: `prj_${name}` }), dir);
    return path.resolve(dir);
  }

  function makeSession(sessionId: string, pid: number): void {
    const now = new Date().toISOString();
    saveCurrentSession({
      session_id: sessionId,
      started_at: now,
      last_seen_at: now,
      agent: ws.currentAgent.agent_name,
      agent_id: ws.currentAgent.agent_id,
      host_id: 'host-test',
      pid,
    }, ws.dir);
  }

  function captureLog(fn: () => void): string {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try { fn(); } finally { console.log = orig; }
    return lines.join('\n');
  }

  beforeEach(() => {
    previousSessionId = process.env.BRAINCLAW_SESSION_ID;
    delete process.env.BRAINCLAW_SESSION_ID;
    ws = createTestWorkspace({ prefix: 'bclaw-switch-cli-', currentAgent: 'claude-code' });
    restoreCwd = ws.useCwd();
    // Anchor workspace resolution to the test dir (mirror bclaw-switch.test.ts).
    process.env.BRAINCLAW_CWD = ws.dir;
    // Folder-mode multi-project so nested children resolve by name.
    ws.updateConfig((c) => {
      c.project_mode = 'multi-project';
      c.projects.strategy = 'folder';
    });
  });

  afterEach(() => {
    restoreCwd?.();
    ws.cleanup();
    if (previousSessionId === undefined) delete process.env.BRAINCLAW_SESSION_ID;
    else process.env.BRAINCLAW_SESSION_ID = previousSessionId;
  });

  it('default switch writes the session, never the global pointer', () => {
    const api = addChildProject('apps/api', 'api');
    runSwitch('api', { cwd: ws.dir });
    assert.equal(loadCurrentSession(ws.dir)?.active_project?.path, api);
    assert.ok(!loadActiveProject(ws.dir), 'global active-project must be untouched by a default switch');
  });

  it('auto-creates the session for an explicit BRAINCLAW_SESSION_ID with no file yet', () => {
    const api = addChildProject('apps/api', 'api');
    process.env.BRAINCLAW_SESSION_ID = 'sess_new';
    runSwitch('api', { cwd: ws.dir });
    assert.equal(loadSessionById('sess_new', ws.dir)?.active_project?.path, api);
    assert.ok(!loadActiveProject(ws.dir), 'global must stay untouched');
  });

  it('two CLI agents switch independently without clobbering (no shared global)', () => {
    const api = addChildProject('apps/api', 'api');
    const web = addChildProject('apps/web', 'web');
    makeSession('sess_A', 111111);
    makeSession('sess_B', 222222);

    process.env.BRAINCLAW_SESSION_ID = 'sess_A';
    runSwitch('api', { cwd: ws.dir });
    process.env.BRAINCLAW_SESSION_ID = 'sess_B';
    runSwitch('web', { cwd: ws.dir });

    assert.equal(loadSessionById('sess_A', ws.dir)?.active_project?.path, api);
    assert.equal(loadSessionById('sess_B', ws.dir)?.active_project?.path, web);
    assert.ok(!loadActiveProject(ws.dir), 'neither agent may write the shared global pointer');
  });

  it('--list marks the session active project, not the global one (F5)', () => {
    const api = addChildProject('apps/api', 'api');
    const web = addChildProject('apps/web', 'web');
    // Global says api; the agent's session says web — list must follow the session.
    saveActiveProject(ws.dir, { path: api, name: 'api', switched_at: new Date().toISOString() });
    try {
      process.env.BRAINCLAW_SESSION_ID = 'sess_L';
      runSwitch('web', { cwd: ws.dir });
      const out = captureLog(() => runSwitch(undefined, { cwd: ws.dir, list: true, json: true }));
      const parsed = JSON.parse(out) as {
        active_source: string;
        projects: Array<{ path: string; active: boolean }>;
      };
      assert.equal(parsed.active_source, 'session');
      const webEntry = parsed.projects.find((p) => path.resolve(p.path) === web);
      const apiEntry = parsed.projects.find((p) => path.resolve(p.path) === api);
      assert.equal(webEntry?.active, true, 'session project (web) must be marked active');
      assert.equal(apiEntry?.active, false, 'global project (api) must NOT be marked active');
    } finally {
      clearActiveProject(ws.dir);
    }
  });

  it('show (no arg) reports the session active project with scope=session (F5)', () => {
    const web = addChildProject('apps/web', 'web');
    process.env.BRAINCLAW_SESSION_ID = 'sess_S';
    runSwitch('web', { cwd: ws.dir });
    const out = captureLog(() => runSwitch(undefined, { cwd: ws.dir, json: true }));
    const parsed = JSON.parse(out) as { active: boolean; scope: string; path: string };
    assert.equal(parsed.active, true);
    assert.equal(parsed.scope, 'session');
    assert.equal(path.resolve(parsed.path), web);
  });

  /**
   * pln#649 step 5 — the READER that displays must derive from the resolver that WRITES.
   *
   * `showCurrent` used to walk its own session-then-global ladder, so it could name only
   * two of the resolver's seven rungs. An agent physically inside a child project, with no
   * session switch and a global pointer aimed elsewhere, was told the GLOBAL project while
   * every write of its own went to the child. That is the precise shape of the pln#648 bug
   * — green status, data beside it — and the reason it survived weeks of use: the status
   * surface kept saying the reassuring thing.
   */
  it('status reports the CHILD the agent is inside, not the divergent global pointer (step 5)', () => {
    const api = addChildProject('apps/api', 'api');
    const web = addChildProject('apps/web', 'web');
    // The shared pointer names web; the agent is standing in api and has no session switch.
    saveActiveProject(ws.dir, { path: web, name: 'web', switched_at: new Date().toISOString() });
    try {
      const out = captureLog(() => runSwitch(undefined, { cwd: api, json: true }));
      const parsed = JSON.parse(out) as { active: boolean; scope: string; path: string };
      assert.equal(path.resolve(parsed.path), api,
        'the reported project must be the one a write would reach, not the shared pointer');
      assert.equal(parsed.scope, 'cwd_child',
        'and the scope must name the selector that actually won — a rung the old reader could not express');
    } finally {
      clearActiveProject(ws.dir);
    }
  });

  /**
   * THE INVARIANT STEP 5 ACTUALLY STATES: every reader echoes the SAME `active_source`.
   *
   * Pinned across the two surfaces rather than inside either, because the defect was never
   * that one of them was wrong on its own — it was that they disagreed, and the writer
   * followed a third answer. Each surface passing its own test is exactly the state that
   * shipped the pln#648 bug.
   */
  it('--list and show agree on active_source from the same cwd (step 5 invariant)', () => {
    const api = addChildProject('apps/api', 'api');
    addChildProject('apps/web', 'web');

    const showOut = captureLog(() => runSwitch(undefined, { cwd: api, json: true }));
    const shown = JSON.parse(showOut) as { scope: string; path?: string };
    const listed = listAvailableProjects(api);

    assert.equal(listed.active_source, shown.scope,
      `the two readers must name the same winning selector — list=${listed.active_source} show=${shown.scope}`);
    const activeInList = listed.projects.find((p) => p.active);
    if (shown.path) {
      assert.equal(path.resolve(activeInList?.path ?? ''), path.resolve(shown.path),
        'and they must mark the same project active');
    }
  });

  it('--clear is session-only by default — leaves the global pointer intact', () => {
    const api = addChildProject('apps/api', 'api');
    const web = addChildProject('apps/web', 'web');
    saveActiveProject(ws.dir, { path: api, name: 'api', switched_at: new Date().toISOString() });
    try {
      process.env.BRAINCLAW_SESSION_ID = 'sess_C';
      runSwitch('web', { cwd: ws.dir });
      assert.equal(loadSessionById('sess_C', ws.dir)?.active_project?.path, web);

      runSwitch(undefined, { cwd: ws.dir, clear: true });
      assert.ok(!loadSessionById('sess_C', ws.dir)?.active_project, 'session active_project must be cleared');
      assert.equal(path.resolve(loadActiveProject(ws.dir)?.path ?? ''), api, 'global pointer must survive a default clear');
    } finally {
      clearActiveProject(ws.dir);
    }
  });

  it('--clear --global clears the shared pointer', () => {
    const api = addChildProject('apps/api', 'api');
    saveActiveProject(ws.dir, { path: api, name: 'api', switched_at: new Date().toISOString() });
    runSwitch(undefined, { cwd: ws.dir, clear: true, global: true });
    assert.ok(!loadActiveProject(ws.dir), '--clear --global must remove the shared pointer');
  });

  it('--global switch writes the shared pointer and bypasses the session', () => {
    const api = addChildProject('apps/api', 'api');
    try {
      runSwitch('api', { cwd: ws.dir, global: true });
      assert.equal(path.resolve(loadActiveProject(ws.dir)?.path ?? ''), api, '--global must write the shared pointer');
      assert.ok(!loadCurrentSession(ws.dir)?.active_project, '--global must NOT write a session active_project');
    } finally {
      clearActiveProject(ws.dir);
    }
  });

  it('--global resolves a cross-project LINKED project (not a nested child) and writes only the global pointer', () => {
    // External project (outside ws), reachable only via a cross-project link —
    // resolveProjectRef can't find it; the --global branch must use the link
    // fallback, matching what --list shows and the session path can target.
    const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-switch-ext-'));
    fs.mkdirSync(path.join(ext, '.brainclaw'), { recursive: true });
    saveConfig(defaultConfig('extproj', { projectId: 'prj_extproj' }), ext);
    addCrossProjectLink({ path: ext, name: 'extproj', cwd: ws.dir });
    try {
      runSwitch('extproj', { cwd: ws.dir, global: true });
      assert.equal(path.resolve(loadActiveProject(ws.dir)?.path ?? ''), path.resolve(ext), '--global must resolve the linked project and write the shared pointer');
      assert.ok(!loadCurrentSession(ws.dir)?.active_project, '--global must NOT write a session active_project');
    } finally {
      clearActiveProject(ws.dir);
      fs.rmSync(ext, { recursive: true, force: true });
    }
  });
});
