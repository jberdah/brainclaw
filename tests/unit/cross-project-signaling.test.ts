import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, loadConfig, saveConfig } from '../../src/core/config.js';
import { buildCoordinationSnapshot } from '../../src/core/coordination.js';
import { listIncomingCrossProjectSignals, writeCrossProjectSignal } from '../../src/core/cross-project.js';
import { ensureMemoryDir } from '../../src/core/io.js';
import type { Candidate, RuntimeNote } from '../../src/core/schema.js';

function initProject(dir: string, projectName: string, projectId: string): void {
  ensureMemoryDir(dir);
  saveConfig(defaultConfig(projectName, { projectId }), dir);
}

describe('cross-project signaling', () => {
  let alphaDir: string;
  let betaDir: string;

  beforeEach(() => {
    alphaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-xps-alpha-'));
    betaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-xps-beta-'));
    initProject(alphaDir, 'alpha', 'prj_alpha');
    initProject(betaDir, 'beta', 'prj_beta');

    const alphaConfig = loadConfig(alphaDir);
    alphaConfig.cross_project_links = [{
      name: 'beta',
      path: betaDir,
      role: 'publisher',
      channels: ['candidate', 'runtime_note'],
    }];
    saveConfig(alphaConfig, alphaDir);

    const betaConfig = loadConfig(betaDir);
    betaConfig.cross_project_links = [{
      name: 'alpha',
      path: alphaDir,
      role: 'publisher',
      channels: ['candidate', 'runtime_note'],
    }];
    saveConfig(betaConfig, betaDir);
  });

  afterEach(() => {
    fs.rmSync(alphaDir, { recursive: true, force: true });
    fs.rmSync(betaDir, { recursive: true, force: true });
  });

  it('exchanges cross-project signals and surfaces them on each board', () => {
    const candidate: Candidate = {
      id: 'cnd_alpha01',
      short_label: 'cnd#1',
      type: 'decision',
      text: 'Route export jobs through the shared gateway.',
      created_at: '2026-04-06T10:00:00Z',
      author: 'claude-code',
      author_id: 'agt_alpha',
      project_id: 'prj_alpha',
      session_id: 'sess_alpha',
      tags: ['cross-project'],
      status: 'pending',
      star_count: 0,
      starred_by: [],
      usage_count: 0,
      usage_events: [],
    };
    const runtimeNote: RuntimeNote = {
      id: 'rtn_beta01',
      agent: 'codex',
      agent_id: 'agt_beta',
      project_id: 'prj_beta',
      session_id: 'sess_beta',
      text: 'Beta validated the shared gateway contract.',
      created_at: '2026-04-06T10:05:00Z',
      tags: ['cross-project'],
      visibility: 'shared',
      note_type: 'observation',
    };

    writeCrossProjectSignal('beta', 'candidate', candidate, alphaDir);
    writeCrossProjectSignal('alpha', 'runtime_note', runtimeNote, betaDir);

    const betaSignals = listIncomingCrossProjectSignals(betaDir);
    assert.equal(betaSignals.length, 1);
    assert.equal(betaSignals[0]!.entity_type, 'candidate');
    assert.equal(betaSignals[0]!.from_project.name, 'alpha');
    assert.equal((betaSignals[0]!.payload as Candidate).id, 'cnd_alpha01');

    const alphaSignals = listIncomingCrossProjectSignals(alphaDir);
    assert.equal(alphaSignals.length, 1);
    assert.equal(alphaSignals[0]!.entity_type, 'runtime_note');
    assert.equal(alphaSignals[0]!.from_project.name, 'beta');
    assert.equal((alphaSignals[0]!.payload as RuntimeNote).id, 'rtn_beta01');

    const betaBoard = buildCoordinationSnapshot({ cwd: betaDir, skipAgentAutoDetect: true });
    assert.ok(betaBoard.incoming_signals);
    assert.equal(betaBoard.incoming_signals!.length, 1);
    assert.equal(betaBoard.incoming_signals![0]!.entity_type, 'candidate');
    assert.equal(betaBoard.incoming_signals![0]!.from_project, 'alpha');
    assert.equal(betaBoard.incoming_signals![0]!.from_agent, 'claude-code');
    assert.equal(betaBoard.incoming_signals![0]!.preview, candidate.text);

    const alphaBoard = buildCoordinationSnapshot({ cwd: alphaDir, skipAgentAutoDetect: true });
    assert.ok(alphaBoard.incoming_signals);
    assert.equal(alphaBoard.incoming_signals!.length, 1);
    assert.equal(alphaBoard.incoming_signals![0]!.entity_type, 'runtime_note');
    assert.equal(alphaBoard.incoming_signals![0]!.from_project, 'beta');
    assert.equal(alphaBoard.incoming_signals![0]!.from_agent, 'codex');
    assert.equal(alphaBoard.incoming_signals![0]!.preview, runtimeNote.text);
  });
});
