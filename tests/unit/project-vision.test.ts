import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readProjectVision } from '../../src/core/io.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brainclaw-test-'));
}

describe('readProjectVision', () => {
  let dir: string;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads PROJECT.md at workspace root', () => {
    dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'PROJECT.md'), '# My App\nA cool app.\n- Stage: dev\n');
    const vision = readProjectVision(dir);
    assert.ok(vision);
    assert.ok(vision.includes('My App'));
    assert.ok(vision.includes('cool app'));
  });

  it('returns undefined when no vision source exists', () => {
    dir = tmpDir();
    const vision = readProjectVision(dir);
    assert.equal(vision, undefined);
  });

  it('falls back to .brainclaw/project.md when no PROJECT.md', () => {
    dir = tmpDir();
    const brainclawDir = path.join(dir, '.brainclaw');
    fs.mkdirSync(brainclawDir, { recursive: true });
    fs.writeFileSync(path.join(brainclawDir, 'project.md'), '# Project Memory\n\nSome description here.\n\n## Shared instructions\n- ins_1\n');
    const vision = readProjectVision(dir);
    assert.ok(vision);
    assert.ok(vision.includes('Some description'));
  });

  it('prefers PROJECT.md over .brainclaw/project.md', () => {
    dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'PROJECT.md'), 'Canonical vision');
    const brainclawDir = path.join(dir, '.brainclaw');
    fs.mkdirSync(brainclawDir, { recursive: true });
    fs.writeFileSync(path.join(brainclawDir, 'project.md'), '# Legacy\nOld vision');
    const vision = readProjectVision(dir);
    assert.ok(vision);
    assert.ok(vision.includes('Canonical vision'));
    assert.ok(!vision.includes('Old vision'));
  });

  it('returns undefined for empty PROJECT.md', () => {
    dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'PROJECT.md'), '   \n\n  ');
    const vision = readProjectVision(dir);
    assert.equal(vision, undefined);
  });

  it('skips brainclaw sentinel lines in .brainclaw/project.md', () => {
    dir = tmpDir();
    const brainclawDir = path.join(dir, '.brainclaw');
    fs.mkdirSync(brainclawDir, { recursive: true });
    fs.writeFileSync(path.join(brainclawDir, 'project.md'), [
      '# Project Memory',
      '',
      '## Shared instructions',
      '- **[ins_1]** <global> Some instruction',
      '',
      '## Active claims',
      '- (none)',
    ].join('\n'));
    const vision = readProjectVision(dir);
    // All lines are headers, list items, or sentinels — no description paragraph
    assert.equal(vision, undefined);
  });

  // ── pln#490: hybrid inject-content / inject-pointer threshold ────────────

  it('inlines PROJECT.md content when line count is at or below the threshold', () => {
    dir = tmpDir();
    const lines = ['# Tiny App', '', 'Short pitch in a few lines.', '', '- Stage: dev', '- Stack: TS'];
    fs.writeFileSync(path.join(dir, 'PROJECT.md'), lines.join('\n'));
    const vision = readProjectVision(dir);
    assert.ok(vision);
    assert.ok(vision.includes('Tiny App'));
    assert.ok(vision.includes('Short pitch'));
    // Pointer mode would have replaced the content with the rigid string
    assert.ok(!vision.includes('MUST read'));
  });

  it('returns the rigid pointer when PROJECT.md exceeds the threshold (default 20 lines)', () => {
    dir = tmpDir();
    // 25 lines: 1 header + 24 body lines, beats the default 20-line threshold.
    const body = Array.from({ length: 24 }, (_, i) => `- rule ${i + 1}: stay sharp`);
    fs.writeFileSync(path.join(dir, 'PROJECT.md'), ['# Big App', ...body].join('\n'));
    const vision = readProjectVision(dir);
    assert.ok(vision);
    assert.ok(vision.includes('MUST read'));
    assert.ok(vision.includes('PROJECT.md'));
    // Content from the source file MUST NOT leak into the pointer payload —
    // the whole point is to keep agent surfaces lean.
    assert.ok(!vision.includes('rule 1:'));
    assert.ok(!vision.includes('rule 24:'));
  });

  it('honours a caller-supplied lower threshold', () => {
    dir = tmpDir();
    // 6 lines — would inline at default 20, but pointer at threshold=5.
    const lines = ['# App', '', 'Pitch line.', '', '- a', '- b'];
    fs.writeFileSync(path.join(dir, 'PROJECT.md'), lines.join('\n'));
    const vision = readProjectVision(dir, 5);
    assert.ok(vision);
    assert.ok(vision.includes('MUST read'));
    assert.ok(!vision.includes('Pitch line'));
  });

  it('treats the threshold as inclusive (exactly N lines still inlines)', () => {
    dir = tmpDir();
    const exactly20 = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(path.join(dir, 'PROJECT.md'), exactly20.join('\n'));
    const vision = readProjectVision(dir);
    assert.ok(vision);
    assert.ok(vision.includes('line 1'));
    assert.ok(vision.includes('line 20'));
    assert.ok(!vision.includes('MUST read'));
  });
});
