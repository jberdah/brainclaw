import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROTOCOL_SKILLS, renderProtocolSkill } from '../../src/core/protocol-skills.js';
import { ensureProtocolSkills, writeDetectedAgentAutoConfig } from '../../src/core/agent-files.js';

function tmpDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-pskills-')); }

const cleanup: string[] = [];
afterEach(() => { while (cleanup.length) fs.rmSync(cleanup.pop()!, { recursive: true, force: true }); });

const IDS = ['brainclaw-session', 'brainclaw-memory-capture', 'brainclaw-multi-agent'];

describe('protocol-skills pack (pln#519)', () => {
  it('manifest ships exactly the 3 capped workflows, all brainclaw-namespaced', () => {
    assert.equal(PROTOCOL_SKILLS.length, 3, 'hard cap of 3 for this version (design §E.2)');
    assert.deepEqual(PROTOCOL_SKILLS.map(s => s.id).sort(), [...IDS].sort());
    for (const s of PROTOCOL_SKILLS) {
      assert.ok(s.id.startsWith('brainclaw-'), `${s.id} must be brainclaw-namespaced to avoid .agents/skills collisions`);
      assert.ok(s.description.length > 20 && s.body.length > 200);
    }
  });

  it('guard-rail: skills carry NO dynamic state (no literal entity ids in bodies)', () => {
    // Design §E.1: a skill that bakes in a concrete claim/loop/plan id is wrong —
    // those must be live lookups. Placeholders like `dec_…`/`asgn_…` are fine.
    const literalId = /\b(clm|lop|pln|dec|trp|cst|asgn|run|cnd)_[0-9a-f]{6,}\b/;
    for (const s of PROTOCOL_SKILLS) {
      assert.ok(!literalId.test(s.body), `${s.id} body must not contain a concrete entity id`);
    }
  });

  it('renderProtocolSkill emits valid frontmatter with protocol flag + version', () => {
    const out = renderProtocolSkill(PROTOCOL_SKILLS[0], '9.9.9');
    assert.match(out, /^---\n/);
    assert.match(out, /\nname: brainclaw-session\n/);
    assert.match(out, /\n {2}protocol: true\n/);
    assert.match(out, /\n {2}brainclaw_version: 9\.9\.9\n/);
    assert.match(out, /\n---\n\n# brainclaw-session/);
  });

  it('ensureProtocolSkills writes all 3 to .agents/skills/<id>/SKILL.md', () => {
    const dir = tmpDir(); cleanup.push(dir);
    const results = ensureProtocolSkills(dir);
    assert.equal(results.length, 3);
    for (const id of IDS) {
      const fp = path.join(dir, '.agents', 'skills', id, 'SKILL.md');
      assert.ok(fs.existsSync(fp), `${id} written`);
      const content = fs.readFileSync(fp, 'utf-8');
      assert.match(content, new RegExp(`name: ${id}`));
      assert.match(content, /protocol: true/);
      assert.match(content, /brainclaw_version: \d+\.\d+\.\d+/);
    }
    assert.ok(results.every(r => r.kind === 'skill' && r.created));
  });

  it('is idempotent — a second run rewrites nothing', () => {
    const dir = tmpDir(); cleanup.push(dir);
    ensureProtocolSkills(dir);
    const second = ensureProtocolSkills(dir);
    assert.ok(second.every(r => !r.created && !r.updated), 'unchanged re-run is a no-op');
  });

  it('a skill-capable agent (cursor) gets the 3 protocol skills via the auto-config orchestrator', () => {
    const dir = tmpDir(); cleanup.push(dir);
    const results = writeDetectedAgentAutoConfig('cursor', dir);
    for (const id of IDS) {
      assert.ok(
        results.some(r => r.relativePath === `.agents/skills/${id}/SKILL.md`),
        `cursor auto-config must include ${id}`,
      );
    }
    // And the universal profile skill is still there alongside the protocols.
    assert.ok(results.some(r => r.relativePath === '.agents/skills/brainclaw/SKILL.md'));
  });
});
