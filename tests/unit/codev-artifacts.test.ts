import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writePhaseArtifact } from '../../src/core/codev-responses.js';
import { postPhase, CODEV_INBOX_HEAD_CHARS } from '../../src/commands/codev.js';
import { getThread, readInbox } from '../../src/core/messaging.js';

function createTestStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-codev-art-'));
  const brainclawDir = path.join(dir, '.brainclaw');
  fs.mkdirSync(path.join(brainclawDir, 'coordination', 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(brainclawDir, 'config.yaml'), 'project_id: prj_test\n');
  return dir;
}

describe('codev phase artifacts (pln#627 Phase C)', () => {
  let testDir: string;
  beforeEach(() => { testDir = createTestStore(); });
  afterEach(() => { fs.rmSync(testDir, { recursive: true, force: true }); });

  describe('writePhaseArtifact', () => {
    it('persists the full body under coordination/ideation/<slug>/phases and returns a pointer', () => {
      const body = 'A'.repeat(200_000); // 200 KB — the kind of dump that used to land in the inbox
      const { path: full, relPath, charCount } = writePhaseArtifact('codev:2026-07-24:topic', 'synthesis', body, testDir);

      assert.equal(charCount, 200_000);
      assert.equal(relPath, 'coordination/ideation/codev_2026-07-24_topic/phases/synthesis.md');
      assert.ok(fs.existsSync(full));
      assert.equal(fs.readFileSync(full, 'utf8').length, 200_000);
    });
  });

  describe('postPhase', () => {
    it('routes a large body to the artifact store and posts only a bounded head + pointer', () => {
      const body = 'B'.repeat(200_000);
      const result = postPhase({
        agent: 'codex',
        threadId: 'codev:2026-07-24:big',
        label: 'exposition',
        text: body,
        tags: ['codev', 'phase:exposition'],
        cwd: testDir,
      });

      // The inbox message is now a few KB, not 200 KB.
      const stored = readInbox({ agent: 'codex', includeAll: true, markAsRead: false }, testDir).messages[0]!;
      assert.ok(stored.text.length < CODEV_INBOX_HEAD_CHARS + 500, 'inbox body must be bounded to head + pointer');
      assert.match(stored.text, /full phase body \(200000 chars\) at coordination\/ideation\//);
      assert.equal(stored.ref, 'coordination/ideation/codev_2026-07-24_big/phases/exposition.md');
      assert.equal((stored.payload as Record<string, unknown>).artifact_path, stored.ref);
      assert.equal((stored.payload as Record<string, unknown>).char_count, 200_000);
      assert.equal(result.id, stored.id);

      // The full body remains readable from the artifact store.
      const artifactPath = path.join(testDir, '.brainclaw', stored.ref!);
      assert.equal(fs.readFileSync(artifactPath, 'utf8').length, 200_000);
    });

    it('preserves the thread readback CoDev relies on (first 3000 chars byte-identical)', () => {
      const body = Array.from({ length: 5000 }, (_, i) => `line-${i}`).join('\n');
      postPhase({ agent: 'codex', threadId: 'codev:2026-07-24:read', label: 'contract', text: body, tags: ['codev', 'phase:contract'], cwd: testDir });

      const fromThread = getThread('codev:2026-07-24:read', testDir, { truncateText: 3000 })[0]!;
      assert.equal(fromThread.text.slice(0, 3000), body.slice(0, 3000));
    });

    it('leaves a small body inline with no pointer footer', () => {
      const body = 'short exposition body';
      postPhase({ agent: 'codex', threadId: 'codev:2026-07-24:small', label: 'exposition', text: body, tags: ['codev'], cwd: testDir });
      const stored = readInbox({ agent: 'codex', includeAll: true, markAsRead: false }, testDir).messages[0]!;
      assert.equal(stored.text, body);
      assert.doesNotMatch(stored.text, /full phase body/);
    });
  });
});
