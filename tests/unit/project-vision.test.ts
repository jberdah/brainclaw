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
});
