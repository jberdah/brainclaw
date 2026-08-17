import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, saveConfig } from '../../src/core/config.js';
import { isolateAgentEnv } from '../helpers/workspace.js';
import { registerAgentIdentity } from '../../src/core/agent-registry.js';
import {
  clearCurrentSession,
  gcStaleSessions,
  loadAllSessions,
  loadCurrentSession,
  loadSessionById,
  saveCurrentSession,
} from '../../src/core/identity.js';
import { findOutermostBrainclawRoot } from '../../src/core/io.js';
import type { CurrentSessionState } from '../../src/core/schema.js';

/**
 * pln#648 (a) — the session record must live at a STABLE, workspace-unique
 * location. The reproduced P0: a session started while the EFFECTIVE store was
 * a child project parked the record under that child; every switch moved the
 * truth out of the resolver's reach, status said `api` while writes went to
 * `web`. These tests assert ON DISK (trp#1292) that the record now lands at
 * the workspace anchor regardless of which child was effective, that
 * pre-anchor records stay readable through the read-chain, and that the
 * relocation/GC decay works.
 */
describe('session records anchor at the workspace root (pln#648)', () => {
  let isolation: { fakeHome: string; restore: () => void } | undefined;
  let root: string;
  let api: string;
  let web: string;

  const AGENT = 'worker';

  const makeStore = (dir: string, name: string, projectId: string, workspace = false): string => {
    fs.mkdirSync(path.join(dir, '.brainclaw'), { recursive: true });
    saveConfig(
      defaultConfig(name, {
        projectId,
        ...(workspace ? { projectMode: 'multi-project' as const, projectStrategy: 'folder' as const } : {}),
      }),
      dir,
    );
    if (workspace) {
      fs.appendFileSync(path.join(dir, '.brainclaw', 'config.yaml'), '\nstore_type: workspace\n', 'utf-8');
    }
    return path.resolve(dir);
  };

  const sessionRecord = (id: string, overrides: Partial<CurrentSessionState> = {}): CurrentSessionState => {
    const now = new Date().toISOString();
    return {
      schema_version: 2,
      session_id: id,
      started_at: now,
      last_seen_at: now,
      agent: AGENT,
      agent_id: 'agt_anchor_test',
      host_id: 'host-test',
      pid: process.pid,
      ...overrides,
    };
  };

  const sessionsFile = (store: string, id: string) => path.join(store, '.brainclaw', 'sessions', `${id}.json`);

  beforeEach(() => {
    isolation = isolateAgentEnv();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-anchor-'));
    root = makeStore(base, 'workspace', 'prj_ws_anchor', true);
    api = makeStore(path.join(base, 'apps', 'api'), 'api', 'prj_api_anchor');
    web = makeStore(path.join(base, 'apps', 'web'), 'web', 'prj_web_anchor');
    process.env.BRAINCLAW_STORE_BOUNDARY = root;
    process.env.BRAINCLAW_AGENT_NAME = AGENT;
    for (const store of [root, api, web]) {
      registerAgentIdentity({ agentName: AGENT, kind: 'agent', cwd: store });
    }
  });

  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    isolation?.restore();
    isolation = undefined;
  });

  it('a session saved while a CHILD store is effective lands at the WORKSPACE ROOT on disk', () => {
    // The P0 setup: session-start ran while `web` was the effective store —
    // pre-fix, the record was parked under web/.brainclaw/sessions/ where the
    // resolver never probed it again after a switch.
    saveCurrentSession(sessionRecord('sess_anchor_core', {
      active_project: { path: api, name: 'api', switched_at: new Date().toISOString() },
    }), web);

    assert.ok(fs.existsSync(sessionsFile(root, 'sess_anchor_core')), 'record must land under the workspace root');
    assert.ok(!fs.existsSync(sessionsFile(web, 'sess_anchor_core')), 'record must NOT be parked under the effective child');

    // The same truth is visible from EVERY vantage point of the workspace.
    assert.equal(loadCurrentSession(root)?.session_id, 'sess_anchor_core');
    assert.equal(loadCurrentSession(web)?.session_id, 'sess_anchor_core');
    assert.equal(loadCurrentSession(api)?.active_project?.path, api);
    assert.equal(loadSessionById('sess_anchor_core', web)?.session_id, 'sess_anchor_core');
  });

  it('pre-anchor records parked under a child stay readable through the read-chain', () => {
    fs.mkdirSync(path.dirname(sessionsFile(web, 'sess_preanchor')), { recursive: true });
    fs.writeFileSync(sessionsFile(web, 'sess_preanchor'), JSON.stringify(sessionRecord('sess_preanchor')));

    assert.equal(loadCurrentSession(web)?.session_id, 'sess_preanchor');
    assert.equal(loadSessionById('sess_preanchor', web)?.session_id, 'sess_preanchor');
    assert.ok(loadAllSessions(web).some((s) => s.session_id === 'sess_preanchor'));
  });

  it('saving relocates a pre-anchor record: one copy at the root, the legacy copy proven then removed', () => {
    fs.mkdirSync(path.dirname(sessionsFile(web, 'sess_relocate')), { recursive: true });
    fs.writeFileSync(sessionsFile(web, 'sess_relocate'), JSON.stringify(sessionRecord('sess_relocate')));

    saveCurrentSession(sessionRecord('sess_relocate'), web);

    assert.ok(fs.existsSync(sessionsFile(root, 'sess_relocate')), 'anchored copy must exist');
    assert.ok(!fs.existsSync(sessionsFile(web, 'sess_relocate')), 'legacy copy must be removed after relocation');
    assert.equal(loadAllSessions(web).filter((s) => s.session_id === 'sess_relocate').length, 1);
  });

  it('the GC sweeps the whole read-chain, and clear proves before unlinking anywhere', () => {
    const expired = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
    fs.mkdirSync(path.dirname(sessionsFile(web, 'sess_old_legacy')), { recursive: true });
    fs.writeFileSync(sessionsFile(web, 'sess_old_legacy'), JSON.stringify(sessionRecord('sess_old_legacy', { last_seen_at: expired })));
    saveCurrentSession(sessionRecord('sess_fresh_anchor', { pid: process.pid + 100000 }), web);

    const removed = gcStaleSessions(web, '4h');
    assert.equal(removed, 1, 'the expired pre-anchor record is collected from the legacy location');
    assert.ok(!fs.existsSync(sessionsFile(web, 'sess_old_legacy')));
    assert.ok(fs.existsSync(sessionsFile(root, 'sess_fresh_anchor')));

    clearCurrentSession(web, 'sess_fresh_anchor');
    assert.ok(!fs.existsSync(sessionsFile(root, 'sess_fresh_anchor')), 'clear must reach the anchored record from a child vantage point');
  });

  it('BRAINCLAW_STORE_BOUNDARY caps the anchor walk: a bounded child keeps its sessions local', () => {
    process.env.BRAINCLAW_STORE_BOUNDARY = web;

    saveCurrentSession(sessionRecord('sess_bounded'), web);

    assert.ok(fs.existsSync(sessionsFile(web, 'sess_bounded')), 'the boundary must contain the record in the child store');
    assert.ok(!fs.existsSync(sessionsFile(root, 'sess_bounded')), 'the walk must never climb above the boundary');
    assert.equal(findOutermostBrainclawRoot(web), web);
  });

  it('a relative cwd never makes the relocation delete its own record (codex round 1)', () => {
    // Pre-fix: sessionsDirs compared a resolved anchor against a RAW-cwd legacy
    // path — with cwd='.', the SAME directory compared unequal and the
    // relocation unlinked the file saveCurrentSession had just written.
    const previousCwd = process.cwd();
    process.env.BRAINCLAW_STORE_BOUNDARY = web;
    process.chdir(web);
    try {
      saveCurrentSession(sessionRecord('sess_relative'), '.');
      assert.ok(fs.existsSync(sessionsFile(web, 'sess_relative')), 'the record must survive its own relocation pass');
      assert.equal(loadSessionById('sess_relative', '.')?.session_id, 'sess_relative');
      assert.equal(loadCurrentSession('.')?.session_id, 'sess_relative');
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('sibling DECLARED workspaces under a parent store stay isolated (codex round 1)', () => {
    // Pre-fix: the outermost walk ignored `store_type: workspace`, so two
    // sibling workspaces under a common parent store both anchored to the
    // parent — and each could see (and the resolver adopt) the other's session.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-anchor-siblings-'));
    const outer = makeStore(base, 'outer', 'prj_outer_repo');
    const left = makeStore(path.join(base, 'left'), 'left', 'prj_left', true);
    const service = makeStore(path.join(base, 'left', 'service'), 'service', 'prj_left_service');
    const right = makeStore(path.join(base, 'right'), 'right', 'prj_right', true);
    process.env.BRAINCLAW_STORE_BOUNDARY = outer;
    for (const store of [outer, left, service, right]) {
      registerAgentIdentity({ agentName: AGENT, kind: 'agent', cwd: store });
    }
    try {
      saveCurrentSession(sessionRecord('sess_left_only'), service);

      assert.ok(fs.existsSync(sessionsFile(left, 'sess_left_only')), 'the NEAREST declared workspace is the anchor');
      assert.ok(!fs.existsSync(sessionsFile(outer, 'sess_left_only')), 'the parent store must not receive the record');
      assert.equal(loadCurrentSession(right), undefined, 'a sibling workspace must never see the session');
      assert.equal(loadCurrentSession(service)?.session_id, 'sess_left_only');
    } finally {
      try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('single-project stores are unchanged: the anchor of an isolated store is itself', () => {
    const solo = makeStore(fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-anchor-solo-')), 'solo', 'prj_solo_anchor');
    process.env.BRAINCLAW_STORE_BOUNDARY = solo;
    registerAgentIdentity({ agentName: AGENT, kind: 'agent', cwd: solo });
    try {
      saveCurrentSession(sessionRecord('sess_solo'), solo);
      assert.ok(fs.existsSync(sessionsFile(solo, 'sess_solo')));
      assert.equal(loadCurrentSession(solo)?.session_id, 'sess_solo');
    } finally {
      try { fs.rmSync(solo, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
});
