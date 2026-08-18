import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deleteRuntimeNote, listRuntimeNotes, listSharedJournaledRuntimeNotes, runtimeNotePath, saveRuntimeNote } from '../../src/core/runtime.js';
import { sanitizeAgentPathSegment } from '../../src/core/io.js';
import { saveVersionedJsonFile } from '../../src/core/migration.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import type { RuntimeNote } from '../../src/core/schema.js';

/**
 * pln#673 — the agent name arrives from the environment (BRAINCLAW_AGENT_NAME)
 * and became a DIRECTORY name unvalidated. Reproduced on disk on 2026-08-18
 * before the fix: `'../../../../outside/PWNED'` made saveRuntimeNote create the
 * directory and write the note ENTIRELY OUTSIDE the store.
 *
 * The fix normalizes the segment on write and keeps a raw-name read fallback,
 * so the second half of these tests is about what must NOT change: existing
 * notes stay readable and deletable.
 */
describe('agent name as a path segment (pln#673)', () => {
  let workspace: TestWorkspace;
  let outside: string;

  const note = (id: string, agent: string, visibility: Exclude<RuntimeNote['visibility'], undefined> = 'shared'): RuntimeNote => ({
    id,
    agent,
    text: 'probe',
    created_at: new Date().toISOString(),
    tags: [],
    visibility,
    note_type: 'observation',
  });

  const filesUnder = (dir: string): string[] => {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        out.push(path.relative(dir, full));
      }
    };
    walk(dir);
    return out;
  };

  beforeEach(() => {
    workspace = createTestWorkspace({
      prefix: 'bclaw-agentseg-',
      projectId: 'prj_agent_segment',
      currentAgent: 'claude-code',
    });
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-agentseg-outside-'));
  });

  afterEach(() => {
    try { fs.rmSync(outside, { recursive: true, force: true }); } catch { /* best effort */ }
    workspace.cleanup();
  });

  it('a traversal agent name writes NOTHING outside the store (the reproduced defect)', () => {
    const traversals = [
      '../../../../PWNED',
      '..\\..\\PWNED-win',
      'a/b/c',
      '..',
      '/abs/PWNED',
    ];

    for (const agent of traversals) {
      saveRuntimeNote(note(`rtn_${traversals.indexOf(agent)}`, agent), workspace.dir);
    }

    assert.deepEqual(filesUnder(outside), [], 'nothing may land outside the store');
    // Nor beside the store, nor above .brainclaw/ inside it.
    const parent = path.dirname(workspace.dir);
    assert.ok(!fs.existsSync(path.join(parent, 'PWNED')), 'no directory beside the store');
    assert.deepEqual(
      fs.readdirSync(workspace.dir).filter((e) => e !== '.brainclaw'),
      [],
      'no directory created outside .brainclaw/ inside the store',
    );
    // The notes still exist — normalized, inside the runtime tree.
    const runtimeRoot = path.join(workspace.dir, '.brainclaw', 'coordination', 'runtime');
    assert.equal(filesUnder(runtimeRoot).filter((f) => f.endsWith('.json')).length, traversals.length);
  });

  it('every agent name brainclaw actually produces is left EXACTLY as it is', () => {
    // Verified against the real store: these are the on-disk directory names.
    for (const agent of ['claude-code', 'codex', 'github-copilot', 'sol', 'testuser', 'bclaw_coordinate', 'claude-sonnet']) {
      assert.equal(sanitizeAgentPathSegment(agent), agent, `${agent} must not be rewritten`);
    }
  });

  it('notes written under a NON-canonical raw directory stay readable and deletable', () => {
    // Simulate a store written before the normalization: the directory name is
    // 'Legacy.Agent', which normalizes to 'legacy_agent'.
    const raw = 'Legacy.Agent';
    assert.notEqual(sanitizeAgentPathSegment(raw), raw, 'this fixture needs a name the fix would rewrite');
    const legacyDir = path.join(workspace.dir, '.brainclaw', 'coordination', 'runtime', raw);
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyNote = note('rtn_legacy', raw);
    fs.writeFileSync(path.join(legacyDir, 'rtn_legacy.json'), JSON.stringify(legacyNote));

    // READ: the note must still be listed for that agent.
    const listed = listRuntimeNotes({ agent: raw }, workspace.dir);
    assert.ok(listed.some((n) => n.id === 'rtn_legacy'), 'a pre-normalization note must stay visible');

    // PATH: runtimeNotePath must resolve to where the file actually is.
    assert.equal(runtimeNotePath(legacyNote, workspace.dir), path.join(legacyDir, 'rtn_legacy.json'));

    // DELETE: it must remain deletable, not orphaned.
    assert.equal(deleteRuntimeNote(legacyNote, workspace.dir), true);
    assert.ok(!fs.existsSync(path.join(legacyDir, 'rtn_legacy.json')));
  });

  it('keeps contained raw legacy directories readable in all visibility trees', () => {
    const restoreHost = workspace.setHostId('Legacy Host');
    const raw = 'Legacy.Agent';
    try {
      for (const visibility of ['shared', 'machine', 'private'] as const) {
        const root = visibility === 'shared'
          ? path.join(workspace.dir, '.brainclaw', 'coordination', 'runtime')
          : path.join(workspace.dir, '.brainclaw', 'coordination', `runtime-${visibility === 'machine' ? 'hosts' : 'private'}`, 'legacy-host');
        const legacyDir = path.join(root, raw);
        const legacyNote = note(`rtn_legacy_${visibility}`, raw, visibility);
        fs.mkdirSync(legacyDir, { recursive: true });
        saveVersionedJsonFile('runtime_note', path.join(legacyDir, `${legacyNote.id}.json`), legacyNote);

        assert.ok(listRuntimeNotes({ agent: raw, visibility }, workspace.dir).some((entry) => entry.id === legacyNote.id));
        assert.equal(runtimeNotePath(legacyNote, workspace.dir), path.join(legacyDir, `${legacyNote.id}.json`));
        if (visibility === 'shared') {
          assert.ok(listSharedJournaledRuntimeNotes(workspace.dir).some((entry) => entry.id === legacyNote.id));
        }

        // Updating a legacy note migrates that id instead of making duplicate
        // raw + canonical records that would make a one-shot delete incomplete.
        const updated = { ...legacyNote, text: 'updated' };
        saveRuntimeNote(updated, workspace.dir);
        const canonicalPath = path.join(root, sanitizeAgentPathSegment(raw), `${legacyNote.id}.json`);
        assert.ok(fs.existsSync(canonicalPath));
        assert.ok(!fs.existsSync(path.join(legacyDir, `${legacyNote.id}.json`)));
        assert.deepEqual(listRuntimeNotes({ agent: raw, visibility }, workspace.dir).filter((entry) => entry.id === legacyNote.id).map((entry) => entry.text), ['updated']);
        if (visibility === 'shared') {
          assert.equal(listSharedJournaledRuntimeNotes(workspace.dir).filter((entry) => entry.id === legacyNote.id).length, 1);
        }
        assert.equal(deleteRuntimeNote(updated, workspace.dir), true);
      }
    } finally {
      restoreHost();
    }
  });

  it('never lets the raw legacy-read fallback escape the runtime root', () => {
    // Give the canonical runtime tree content so read resolution selects it.
    saveRuntimeNote(note('rtn_anchor', 'codex'), workspace.dir);
    const runtimeRoot = path.join(workspace.dir, '.brainclaw', 'coordination', 'runtime');
    const escapingAgent = path.relative(runtimeRoot, outside);
    const escapedNote = note('rtn_escape', escapingAgent);
    const outsideRecord = path.join(outside, 'rtn_escape.json');
    saveVersionedJsonFile('runtime_note', outsideRecord, escapedNote);

    // Before the containment guard, the raw fallback listed and deleted this
    // record outside the store. It must now use only its canonical in-store path.
    const canonicalPath = path.join(runtimeRoot, sanitizeAgentPathSegment(escapingAgent), 'rtn_escape.json');
    assert.equal(runtimeNotePath(escapedNote, workspace.dir), canonicalPath);
    assert.ok(!listRuntimeNotes({ agent: escapingAgent }, workspace.dir).some((entry) => entry.id === escapedNote.id));
    assert.equal(deleteRuntimeNote(escapedNote, workspace.dir), false);
    assert.ok(fs.existsSync(outsideRecord), 'the external file must not be touched');
  });

  it('a new note lands in the normalized directory and round-trips', () => {
    const agent = 'Weird Agent/Name';
    saveRuntimeNote(note('rtn_new', agent), workspace.dir);

    const expectedDir = path.join(workspace.dir, '.brainclaw', 'coordination', 'runtime', sanitizeAgentPathSegment(agent));
    assert.ok(fs.existsSync(path.join(expectedDir, 'rtn_new.json')), 'written to the normalized directory');
    assert.ok(listRuntimeNotes({ agent }, workspace.dir).some((n) => n.id === 'rtn_new'), 'and readable back by the same name');
  });

  it('keeps two names that need the same replacement in separate directories', () => {
    const dotted = 'a.b';
    const underscored = 'a_b';
    assert.notEqual(sanitizeAgentPathSegment(dotted), sanitizeAgentPathSegment(underscored));

    saveRuntimeNote(note('rtn_dotted', dotted), workspace.dir);
    saveRuntimeNote(note('rtn_underscored', underscored), workspace.dir);

    assert.deepEqual(listRuntimeNotes({ agent: dotted }, workspace.dir).map((entry) => entry.id), ['rtn_dotted']);
    assert.deepEqual(listRuntimeNotes({ agent: underscored }, workspace.dir).map((entry) => entry.id), ['rtn_underscored']);
  });

  it('the normalizer refuses to produce an empty or Win32-device directory name', () => {
    assert.equal(sanitizeAgentPathSegment(''), 'unknown-agent');
    assert.equal(sanitizeAgentPathSegment('   '), 'unknown-agent');
    assert.match(sanitizeAgentPathSegment('///'), /^____[0-9a-f]{16}$/);
    // `mkdir CON` fails on Windows: the device name must not survive.
    for (const device of ['CON', 'con', 'NUL', 'com1', 'LPT9']) {
      const segment = sanitizeAgentPathSegment(device);
      assert.notEqual(segment.toLowerCase(), device.toLowerCase(), `${device} must not stay a device name`);
    }
    // A name that merely contains a device word is untouched.
    assert.equal(sanitizeAgentPathSegment('console'), 'console');

    const oversized = sanitizeAgentPathSegment('a'.repeat(300));
    assert.ok(oversized.length <= 128, 'a path segment must remain below platform component limits');
    assert.match(oversized, /^[a-z0-9_-]+$/);
  });

  it('machine-visibility notes are normalized too (both trees, not just the shared one)', () => {
    saveRuntimeNote(note('rtn_host', '../../../../PWNED-HOST', 'machine'), workspace.dir);
    assert.deepEqual(filesUnder(outside), [], 'nothing outside the store from the host tree either');
    const hostRoot = path.join(workspace.dir, '.brainclaw', 'coordination', 'runtime-hosts');
    assert.equal(filesUnder(hostRoot).filter((f) => f.endsWith('.json')).length, 1);
  });
});
