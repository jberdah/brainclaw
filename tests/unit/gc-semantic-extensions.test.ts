/**
 * pln#436: coverage for compact() extensions — released-claim archival,
 * session runtime_note archival, auto-handoff deduplication. Each helper
 * operates file-direct on the coordination stores, so the tests set up
 * the directory layout by hand rather than going through full store APIs.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compact, enforceRuntimeNoteRetention } from '../../src/core/gc-semantic.js';
import { ensureMemoryDir } from '../../src/core/io.js';
import { defaultConfig, saveConfig } from '../../src/core/config.js';

function createStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-compact-ext-'));
  ensureMemoryDir(dir);
  saveConfig(defaultConfig('compact-ext', { projectId: 'prj_compact_ext' }), dir);
  return dir;
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function olderThan(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function writeJson(filePath: string, payload: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload), 'utf-8');
}

describe('gc-semantic — pln#436 extensions', () => {
  let dir: string;
  beforeEach(() => { dir = createStore(); });
  afterEach(() => { cleanup(dir); });

  it('archives released claims older than minAgeDays', () => {
    const claimsDir = path.join(dir, '.brainclaw', 'coordination', 'claims');
    writeJson(path.join(claimsDir, 'clm_old.json'), {
      id: 'clm_old', status: 'released',
      released_at: olderThan(30), scope: 'old/scope', agent: 'codex',
    });
    writeJson(path.join(claimsDir, 'clm_new.json'), {
      id: 'clm_new', status: 'released',
      released_at: olderThan(3), scope: 'recent/scope', agent: 'codex',
    });
    writeJson(path.join(claimsDir, 'clm_active.json'), {
      id: 'clm_active', status: 'active',
      created_at: olderThan(30), scope: 'still/live', agent: 'codex',
    });

    const result = compact({ cwd: dir, minAgeDays: 14, dedupHandoffs: false, purgeSessionNotes: false });

    assert.equal(result.claims_archived, 1, 'only clm_old should be archived');
    assert.equal(fs.existsSync(path.join(claimsDir, 'clm_old.json')), false);
    assert.equal(fs.existsSync(path.join(claimsDir, 'clm_new.json')), true, 'recent released claim preserved');
    assert.equal(fs.existsSync(path.join(claimsDir, 'clm_active.json')), true, 'active claim preserved');
    assert.equal(fs.existsSync(path.join(claimsDir, 'compacted.jsonl')), true);
  });

  it('archives session-tagged runtime_notes older than minAgeDays', () => {
    const runtimeDir = path.join(dir, '.brainclaw', 'coordination', 'runtime');
    writeJson(path.join(runtimeDir, 'claude-code', 'rtn_a.json'), {
      id: 'rtn_a', tags: ['session'], text: 'Session started', created_at: olderThan(30),
    });
    writeJson(path.join(runtimeDir, 'claude-code', 'rtn_b.json'), {
      id: 'rtn_b', tags: ['session'], text: 'Session started', created_at: olderThan(3),
    });
    writeJson(path.join(runtimeDir, 'codex', 'rtn_c.json'), {
      id: 'rtn_c', tags: ['quick-capture'], text: 'Real user note', created_at: olderThan(30),
    });

    const result = compact({ cwd: dir, minAgeDays: 14, dedupHandoffs: false, purgeReleasedClaims: false });

    assert.equal(result.session_notes_archived, 1, 'only old session note should be archived');
    assert.equal(fs.existsSync(path.join(runtimeDir, 'claude-code', 'rtn_a.json')), false);
    assert.equal(fs.existsSync(path.join(runtimeDir, 'claude-code', 'rtn_b.json')), true, 'recent session note preserved');
    assert.equal(fs.existsSync(path.join(runtimeDir, 'codex', 'rtn_c.json')), true, 'non-session note preserved');
  });

  it('dedupes auto-generated session-end handoffs sharing a commits signature', () => {
    const handoffsDir = path.join(dir, '.brainclaw', 'coordination', 'handoffs');
    const commits = 'Commits: abc123 fix(a): thing\ndef456 fix(b): other';
    writeJson(path.join(handoffsDir, 'hnd_1.json'), {
      id: 'hnd_1', status: 'open',
      text: `Session sess_aaa — auto-generated handoff\n${commits}`,
      created_at: olderThan(10),
    });
    writeJson(path.join(handoffsDir, 'hnd_2.json'), {
      id: 'hnd_2', status: 'open',
      text: `Session sess_bbb — auto-generated handoff\n${commits}`,
      created_at: olderThan(8),
    });
    writeJson(path.join(handoffsDir, 'hnd_3.json'), {
      id: 'hnd_3', status: 'open',
      text: `Session sess_ccc — auto-generated handoff\n${commits}`,
      created_at: olderThan(5), // newest — kept
    });
    writeJson(path.join(handoffsDir, 'hnd_human.json'), {
      id: 'hnd_human', status: 'open',
      text: 'Reviewer handoff — please validate pln_xyz',
      created_at: olderThan(2),
    });

    const result = compact({ cwd: dir, minAgeDays: 14, purgeReleasedClaims: false, purgeSessionNotes: false });

    assert.equal(result.handoffs_deduped, 2, 'two older duplicates should be archived');
    assert.equal(fs.existsSync(path.join(handoffsDir, 'hnd_1.json')), false);
    assert.equal(fs.existsSync(path.join(handoffsDir, 'hnd_2.json')), false);
    assert.equal(fs.existsSync(path.join(handoffsDir, 'hnd_3.json')), true, 'most recent dup kept');
    assert.equal(fs.existsSync(path.join(handoffsDir, 'hnd_human.json')), true, 'human handoff untouched');
  });

  it('dry-run reports eligibility without deleting files', () => {
    const claimsDir = path.join(dir, '.brainclaw', 'coordination', 'claims');
    writeJson(path.join(claimsDir, 'clm_old.json'), {
      id: 'clm_old', status: 'released', released_at: olderThan(30), scope: 'x', agent: 'y',
    });

    const result = compact({ cwd: dir, dryRun: true, minAgeDays: 14 });

    assert.equal(result.dry_run, true);
    assert.equal(result.claims_archived, 1, 'dry-run still reports count');
    assert.equal(fs.existsSync(path.join(claimsDir, 'clm_old.json')), true, 'file preserved under dry-run');
  });
});

describe('gc-semantic — pln#564 runtime-note retention', () => {
  let dir: string;
  beforeEach(() => { dir = createStore(); });
  afterEach(() => { cleanup(dir); });

  const runtimeFile = (d: string, agent: string, id: string): string =>
    path.join(d, '.brainclaw', 'coordination', 'runtime', agent, `${id}.json`);

  function seedSessionNotes(agent: string, count: number): void {
    for (let i = 0; i < count; i++) {
      writeJson(runtimeFile(dir, agent, `rtn_sess_${agent}_${i}`), {
        id: `rtn_sess_${agent}_${i}`, agent, schema_version: 2,
        text: 'Session ended', created_at: new Date(Date.now() - i * 60_000).toISOString(),
        tags: ['session'], visibility: 'shared', note_type: i % 2 === 0 ? 'session_end' : 'session_start',
      });
    }
  }

  it('keeps the newest N session/lifecycle notes per agent and all observations', () => {
    seedSessionNotes('claude-code', 50);
    // lifecycle telemetry (carries event_type, no 'session' tag)
    for (let i = 0; i < 40; i++) {
      writeJson(runtimeFile(dir, 'agent-runtime', `evt_${i}`), {
        id: `evt_${i}`, agent: 'agent-runtime', event_type: 'run_running',
        text: 'health check', created_at: new Date(Date.now() - i * 1000).toISOString(),
        tags: ['agent-runtime', 'run'],
      });
    }
    // genuine observations — must all survive
    for (let i = 0; i < 5; i++) {
      writeJson(runtimeFile(dir, 'claude-code', `rtn_obs_${i}`), {
        id: `rtn_obs_${i}`, agent: 'claude-code', schema_version: 2,
        text: `real finding ${i}`, created_at: olderThan(1), tags: ['dogfooding'], note_type: 'observation',
      });
    }

    const result = enforceRuntimeNoteRetention({ cwd: dir, keepPerAgent: 20 });

    assert.equal(result.by_class.session, 50);
    assert.equal(result.by_class.lifecycle, 40);
    assert.equal(result.by_class.observation, 5);
    // kept = 20 session + 20 lifecycle + 5 observations
    assert.equal(result.kept, 45);
    assert.equal(result.archived, 50, '30 session + 20 lifecycle over the cap');
    // observations untouched
    for (let i = 0; i < 5; i++) {
      assert.equal(fs.existsSync(runtimeFile(dir, 'claude-code', `rtn_obs_${i}`)), true);
    }
    // newest session note kept, oldest archived
    assert.equal(fs.existsSync(runtimeFile(dir, 'claude-code', 'rtn_sess_claude-code_0')), true, 'newest kept');
    assert.equal(fs.existsSync(runtimeFile(dir, 'claude-code', 'rtn_sess_claude-code_49')), false, 'oldest archived');
  });

  it('archives fakehome/Temp-scoped test leakage unconditionally and parks a backup', () => {
    writeJson(runtimeFile(dir, 'claude-code', 'rtn_leak'), {
      id: 'rtn_leak', agent: 'claude-code', schema_version: 2, text: 'leak',
      created_at: olderThan(1), tags: ['session'], note_type: 'session_end',
      scope: 'C:\\Users\\x\\AppData\\Local\\Temp\\bclaw-fakehome-abc\\.brainclaw\\worktrees\\deadbeef',
    });

    const result = enforceRuntimeNoteRetention({ cwd: dir, keepPerAgent: 20 });

    assert.equal(result.by_class.fakehome, 1);
    assert.equal(result.archived, 1, 'fakehome leakage archived even under the cap');
    assert.equal(fs.existsSync(runtimeFile(dir, 'claude-code', 'rtn_leak')), false);
    assert.ok(result.backup_path && fs.existsSync(result.backup_path), 'park-don\'t-delete backup exists');
  });

  it('dry-run reports the same counts without deleting', () => {
    seedSessionNotes('codex', 30);
    const result = enforceRuntimeNoteRetention({ cwd: dir, keepPerAgent: 10, dryRun: true });
    assert.equal(result.by_class.session, 30);
    assert.equal(result.archived, 20);
    assert.equal(fs.existsSync(runtimeFile(dir, 'codex', 'rtn_sess_codex_29')), true, 'dry-run preserves files');
  });
});
