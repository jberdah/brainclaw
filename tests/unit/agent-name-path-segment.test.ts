import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deleteRuntimeNote, listRuntimeNotes, runtimeNotePath, saveRuntimeNote } from '../../src/core/runtime.js';
import { sanitizeAgentPathSegment } from '../../src/core/io.js';
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

  const note = (id: string, agent: string, visibility: 'shared' | 'machine' = 'shared'): RuntimeNote => ({
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

  it('a new note lands in the normalized directory and round-trips', () => {
    const agent = 'Weird Agent/Name';
    saveRuntimeNote(note('rtn_new', agent), workspace.dir);

    const expectedDir = path.join(workspace.dir, '.brainclaw', 'coordination', 'runtime', sanitizeAgentPathSegment(agent));
    assert.ok(fs.existsSync(path.join(expectedDir, 'rtn_new.json')), 'written to the normalized directory');
    assert.ok(listRuntimeNotes({ agent }, workspace.dir).some((n) => n.id === 'rtn_new'), 'and readable back by the same name');
  });

  it('the normalizer refuses to produce an empty or Win32-device directory name', () => {
    assert.equal(sanitizeAgentPathSegment(''), 'unknown-agent');
    assert.equal(sanitizeAgentPathSegment('   '), 'unknown-agent');
    assert.equal(sanitizeAgentPathSegment('///'), '___');
    // `mkdir CON` fails on Windows: the device name must not survive.
    for (const device of ['CON', 'con', 'NUL', 'com1', 'LPT9']) {
      const segment = sanitizeAgentPathSegment(device);
      assert.notEqual(segment.toLowerCase(), device.toLowerCase(), `${device} must not stay a device name`);
    }
    // A name that merely contains a device word is untouched.
    assert.equal(sanitizeAgentPathSegment('console'), 'console');
  });

  it('machine-visibility notes are normalized too (both trees, not just the shared one)', () => {
    saveRuntimeNote(note('rtn_host', '../../../../PWNED-HOST', 'machine'), workspace.dir);
    assert.deepEqual(filesUnder(outside), [], 'nothing outside the store from the host tree either');
    const hostRoot = path.join(workspace.dir, '.brainclaw', 'coordination', 'runtime-hosts');
    assert.equal(filesUnder(hostRoot).filter((f) => f.endsWith('.json')).length, 1);
  });
});
