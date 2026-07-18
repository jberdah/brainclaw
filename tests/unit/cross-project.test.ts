import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  resolveCrossProjectLinks,
  detectCrossProjectCycles,
  loadCrossProjectState,
  resolveCrossProjectTarget,
  resolveCrossProjectWritableTarget,
  resolveProjectCwd,
  writeCrossProjectSignal,
  listIncomingCrossProjectSignals,
} from '../../src/core/cross-project.js';
import { saveState } from '../../src/core/state.js';
import { defaultConfig, loadConfig, saveConfig } from '../../src/core/config.js';
import { ensureMemoryDir } from '../../src/core/io.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import type { Candidate, State } from '../../src/core/schema.js';

function initProject(dir: string): void {
  ensureMemoryDir(dir);
  saveConfig(defaultConfig('linked-project', { projectId: 'prj_linked' }), dir);
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-xp-'));
}

const BASE_STATE: State = {
  version: 1, write_version: 1,
  active_constraints: [], recent_decisions: [], known_traps: [],
  open_handoffs: [], plan_items: [],
};

describe('cross-project', () => {
  let workspace: TestWorkspace;
  let linkedDir: string;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-xp-main-', projectId: 'prj_xp_main', currentAgent: 'copilot' });
    linkedDir = tmpDir();
    initProject(linkedDir);
  });

  afterEach(() => {
    workspace.cleanup();
    fs.rmSync(linkedDir, { recursive: true, force: true });
  });

  it('returns empty array when no cross_project_links configured', () => {
    const links = resolveCrossProjectLinks(workspace.dir);
    assert.deepEqual(links, []);
  });

  it('resolves a valid cross_project_link as available', () => {
    const config = loadConfig(workspace.dir);
    config.cross_project_links = [{ path: linkedDir, role: 'subscriber' }];
    saveConfig(config, workspace.dir);

    const links = resolveCrossProjectLinks(workspace.dir);
    assert.equal(links.length, 1);
    assert.equal(links[0].available, true);
    assert.equal(links[0].absolutePath, linkedDir);
  });

  it('marks a link as unavailable when path does not exist', () => {
    const config = loadConfig(workspace.dir);
    config.cross_project_links = [{ path: '/nonexistent/project', role: 'subscriber' }];
    saveConfig(config, workspace.dir);

    const links = resolveCrossProjectLinks(workspace.dir);
    assert.equal(links[0].available, false);
  });

  it('loads state from a linked project', () => {
    saveState({
      ...BASE_STATE,
      recent_decisions: [{
        id: 'dec_xp01', text: 'API uses REST not GraphQL',
        created_at: new Date().toISOString(), author: 'copilot',
        author_id: 'agt_test', project_id: 'prj_xp_linked', tags: ['api'],
      }],
    }, linkedDir);

    const state = loadCrossProjectState(linkedDir);
    assert.equal(state.recent_decisions.length, 1);
    assert.equal(state.recent_decisions[0].id, 'dec_xp01');
  });

  it('resolveCrossProjectTarget finds link by project name', () => {
    const config = loadConfig(workspace.dir);
    config.cross_project_links = [{ path: linkedDir, name: 'brainclaw-website', role: 'publisher' }];
    saveConfig(config, workspace.dir);

    const link = resolveCrossProjectTarget('brainclaw-website', workspace.dir);
    assert.equal(link.projectName, 'brainclaw-website');
    assert.equal(link.role, 'publisher');
  });

  it('resolveCrossProjectTarget throws when link not found', () => {
    assert.throws(
      () => resolveCrossProjectTarget('unknown-project', workspace.dir),
      /No cross_project_link found/,
    );
  });

  it('detectCrossProjectCycles returns empty array when no cycles', () => {
    const config = loadConfig(workspace.dir);
    config.cross_project_links = [{ path: linkedDir, role: 'subscriber' }];
    saveConfig(config, workspace.dir);

    const cycles = detectCrossProjectCycles(workspace.dir);
    assert.deepEqual(cycles, []);
  });

  it('resolveCrossProjectWritableTarget enforces publisher role and channels', () => {
    const config = loadConfig(workspace.dir);
    config.cross_project_links = [{ path: linkedDir, name: 'brainclaw-website', role: 'publisher', channels: ['candidate'] }];
    saveConfig(config, workspace.dir);

    const link = resolveCrossProjectWritableTarget('brainclaw-website', 'candidate', workspace.dir);
    assert.equal(link.role, 'publisher');
    assert.throws(
      () => resolveCrossProjectWritableTarget('brainclaw-website', 'handoff', workspace.dir),
      /does not allow handoff signals/,
    );
  });

  it('writes and lists structured incoming cross-project signals', () => {
    const config = loadConfig(workspace.dir);
    config.cross_project_links = [{ path: linkedDir, name: 'brainclaw-website', role: 'publisher' }];
    saveConfig(config, workspace.dir);

    const candidate: Candidate = {
      id: 'cnd_signal01',
      short_label: 'cnd#1',
      type: 'decision',
      text: 'Route API calls through the shared gateway',
      created_at: new Date().toISOString(),
      author: workspace.currentAgent.agent_name,
      author_id: workspace.currentAgent.agent_id,
      project_id: 'prj_xp_main',
      session_id: 'sess_signal',
      tags: ['cross-project'],
      status: 'pending',
      star_count: 0,
      starred_by: [],
      usage_count: 0,
      usage_events: [],
    };

    const signal = writeCrossProjectSignal('brainclaw-website', 'candidate', candidate, workspace.dir);
    assert.equal(signal.entity_type, 'candidate');

    const incoming = listIncomingCrossProjectSignals(linkedDir);
    assert.equal(incoming.length, 1);
    assert.equal(incoming[0].entity_type, 'candidate');
    assert.equal(incoming[0].from_project.name, 'brainclaw-tests');
    assert.equal((incoming[0].payload as Candidate).id, 'cnd_signal01');
  });

  it('skips valid-JSON but wrong-shape signal files instead of crashing (trp_e90b3198)', () => {
    const config = loadConfig(workspace.dir);
    config.cross_project_links = [{ path: linkedDir, name: 'brainclaw-website', role: 'publisher' }];
    saveConfig(config, workspace.dir);

    const candidate: Candidate = {
      id: 'cnd_ok', short_label: 'cnd#ok', type: 'decision', text: 'well-formed signal',
      created_at: new Date().toISOString(), author: workspace.currentAgent.agent_name,
      author_id: workspace.currentAgent.agent_id, project_id: 'prj_xp_main', session_id: 'sess_ok',
      tags: [], status: 'pending', star_count: 0, starred_by: [], usage_count: 0, usage_events: [],
    };
    writeCrossProjectSignal('brainclaw-website', 'candidate', candidate, workspace.dir);

    // Locate the materialized signal dir under the linked project and drop in
    // files that are valid JSON but NOT our envelope shape — as a second
    // signaling subsystem sharing the directory would (missing from_project.name
    // / from_agent.name / created_at). Before the guard these crashed every
    // read with a TypeError (bclaw_context board, reachable purely locally).
    const findSignalDir = (root: string): string | undefined => {
      const stack = [root];
      while (stack.length) {
        const d = stack.pop()!;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          const full = path.join(d, e.name);
          if (e.name === 'cross-project') return full;
          stack.push(full);
        }
      }
      return undefined;
    };
    const signalDir = findSignalDir(path.join(linkedDir, '.brainclaw'));
    assert.ok(signalDir, 'expected a materialized cross-project signal dir');
    const wellFormed = JSON.parse(fs.readFileSync(path.join(signalDir!, fs.readdirSync(signalDir!).find((f) => f.endsWith('.json'))!), 'utf-8'));
    // A grab-bag of valid-JSON but non-conforming files a second subsystem might leave:
    fs.writeFileSync(path.join(signalDir!, 'a-other-subsystem.json'), JSON.stringify({ type: 'other-subsystem', from: { project_name: 'x' } }));
    fs.writeFileSync(path.join(signalDir!, 'a-empty.json'), JSON.stringify({}));
    // Full envelope shape but payload is null / a primitive → the consumer's
    // `'text' in payload` would throw without the payload-object guard.
    fs.writeFileSync(path.join(signalDir!, 'a-null-payload.json'), JSON.stringify({ ...wellFormed, id: 'sig_null', payload: null }));
    fs.writeFileSync(path.join(signalDir!, 'a-primitive-payload.json'), JSON.stringify({ ...wellFormed, id: 'sig_prim', payload: 'not-an-object' }));
    // Foreign entity_type must not flow downstream as a bogus type.
    fs.writeFileSync(path.join(signalDir!, 'a-bad-entity.json'), JSON.stringify({ ...wellFormed, id: 'sig_bad', entity_type: 'widget' }));

    let incoming: ReturnType<typeof listIncomingCrossProjectSignals> = [];
    assert.doesNotThrow(() => { incoming = listIncomingCrossProjectSignals(linkedDir); });
    assert.equal(incoming.length, 1, 'only the well-formed envelope survives; every non-conforming file is skipped');
    assert.equal((incoming[0].payload as Candidate).id, 'cnd_ok');

    // Prove the board's data-feeding function stays crash-free with all that garbage present.
    assert.doesNotThrow(() => listIncomingCrossProjectSignals(linkedDir));
  });
});

describe('resolveProjectCwd (pln#359)', () => {
  let workspace: TestWorkspace;
  let linkedDir: string;

  beforeEach(() => {
    workspace = createTestWorkspace({ prefix: 'bclaw-rpc-main-', projectId: 'prj_rpc_main', currentAgent: 'copilot' });
    linkedDir = tmpDir();
    initProject(linkedDir);
    // Wire one cross_project_link by default for the linked-project cases
    const config = loadConfig(workspace.dir);
    config.cross_project_links = [{ path: linkedDir, name: 'linked-project', role: 'publisher' }];
    saveConfig(config, workspace.dir);
  });

  afterEach(() => {
    workspace.cleanup();
    fs.rmSync(linkedDir, { recursive: true, force: true });
  });

  it('returns currentCwd when project arg is undefined', () => {
    assert.equal(resolveProjectCwd(undefined, workspace.dir), workspace.dir);
  });

  it('returns currentCwd when project arg is empty string', () => {
    assert.equal(resolveProjectCwd('', workspace.dir), workspace.dir);
    assert.equal(resolveProjectCwd('   ', workspace.dir), workspace.dir);
  });

  it('returns currentCwd when project arg matches the current project_name', () => {
    const config = loadConfig(workspace.dir);
    config.project_name = 'self-project';
    saveConfig(config, workspace.dir);
    assert.equal(resolveProjectCwd('self-project', workspace.dir), workspace.dir);
  });

  it('returns currentCwd when project arg matches the current dir basename', () => {
    const basename = path.basename(workspace.dir);
    assert.equal(resolveProjectCwd(basename, workspace.dir), workspace.dir);
  });

  it('resolves to a cross_project_link by name', () => {
    assert.equal(resolveProjectCwd('linked-project', workspace.dir), linkedDir);
  });

  it('resolves to a cross_project_link by basename', () => {
    const basename = path.basename(linkedDir);
    assert.equal(resolveProjectCwd(basename, workspace.dir), linkedDir);
  });

  it('resolves to a cross_project_link by absolute path', () => {
    assert.equal(resolveProjectCwd(linkedDir, workspace.dir), linkedDir);
  });

  it('throws on an unknown project (not linked, not in workspace chain)', () => {
    assert.throws(
      () => resolveProjectCwd('totally-unknown', workspace.dir),
      /Unknown project: 'totally-unknown'.*Configured cross_project_links: linked-project/s,
    );
  });

  it('throws when the matched link is unavailable (target dir gone)', () => {
    fs.rmSync(linkedDir, { recursive: true, force: true });
    assert.throws(
      () => resolveProjectCwd('linked-project', workspace.dir),
      /not available.*not brainclaw-initialised/s,
    );
    // Re-create so afterEach doesn't fail
    fs.mkdirSync(linkedDir, { recursive: true });
    initProject(linkedDir);
  });

  it('error message lists configured links to help the agent self-correct', () => {
    let captured: Error | undefined;
    try { resolveProjectCwd('typo-project', workspace.dir); } catch (e) { captured = e as Error; }
    assert.ok(captured);
    assert.match(captured!.message, /linked-project/);
    assert.match(captured!.message, /brainclaw link add/);
  });
});
