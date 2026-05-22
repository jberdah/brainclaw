import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readSurveySources } from '../../src/core/loops/index.js';

/**
 * pln#516 step 1 — `readSurveySources` IMPL tests.
 *
 * Covers the brief's eight acceptance cases: README + entry-point under cap,
 * PyInstaller .spec, package.json main, pyproject.toml [project.scripts],
 * byte-cap truncation, no-manifest, empty project, 1MB safety cap.
 */

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-survey-source-test-'));
}

describe('readSurveySources — README + entry point under cap', () => {
  it('includes both README.md and manifest-referenced entry point', () => {
    const cwd = tmpdir();
    fs.writeFileSync(path.join(cwd, 'README.md'), '# Project\n', 'utf8');
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ main: 'src/index.js' }),
      'utf8',
    );
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src', 'index.js'), 'console.log("hi");\n', 'utf8');

    const res = readSurveySources(cwd);
    assert.equal(res.cap_exceeded, false);
    assert.equal(res.excerpts.length, 2);
    assert.equal(res.excerpts[0].file, 'README.md');
    assert.equal(res.excerpts[0].body_truncated, false);
    assert.equal(res.excerpts[1].file, 'src/index.js');
    assert.equal(res.excerpts[1].body_truncated, false);
    assert.equal(res.cap_bytes, 50 * 1024);
  });
});

describe('readSurveySources — PyInstaller .spec', () => {
  it('detects Analysis([...]) first quoted entry point', () => {
    const cwd = tmpdir();
    const spec = `# -*- mode: python -*-
a = Analysis(
    ['app/main.py'],
    pathex=[],
    binaries=[],
)
`;
    fs.writeFileSync(path.join(cwd, 'app.spec'), spec, 'utf8');
    fs.mkdirSync(path.join(cwd, 'app'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'app', 'main.py'), 'print("hi")\n', 'utf8');

    const res = readSurveySources(cwd);
    assert.equal(res.excerpts.length, 1);
    assert.equal(res.excerpts[0].file, 'app/main.py');
    assert.equal(res.excerpts[0].body, 'print("hi")\n');
  });
});

describe('readSurveySources — package.json main', () => {
  it('detects main field as entry point', () => {
    const cwd = tmpdir();
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ main: 'src/index.js' }),
      'utf8',
    );
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src', 'index.js'), 'module.exports = {};\n', 'utf8');

    const res = readSurveySources(cwd);
    assert.equal(res.excerpts.length, 1);
    assert.equal(res.excerpts[0].file, 'src/index.js');
  });

  it('falls back to bin object first value when main absent', () => {
    const cwd = tmpdir();
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ bin: { mycli: 'src/cli.js' } }),
      'utf8',
    );
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src', 'cli.js'), '// cli\n', 'utf8');

    const res = readSurveySources(cwd);
    assert.equal(res.excerpts.length, 1);
    assert.equal(res.excerpts[0].file, 'src/cli.js');
  });
});

describe('readSurveySources — pyproject.toml [project.scripts]', () => {
  it('detects first script value as entry point', () => {
    const cwd = tmpdir();
    const py = `[project]
name = "myapp"
version = "0.1.0"

[project.scripts]
mycli = "mypackage.main:cli"
other = "mypackage.other:fn"
`;
    fs.writeFileSync(path.join(cwd, 'pyproject.toml'), py, 'utf8');
    fs.mkdirSync(path.join(cwd, 'mypackage'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'mypackage', 'main.py'), '# main\n', 'utf8');

    const res = readSurveySources(cwd);
    assert.equal(res.excerpts.length, 1);
    assert.equal(res.excerpts[0].file, 'mypackage/main.py');
  });
});

describe('readSurveySources — byte cap exceeded', () => {
  it('truncates first file, sets body_truncated/cap_exceeded, skips subsequent', () => {
    const cwd = tmpdir();
    const big = 'x'.repeat(20 * 1024);
    fs.writeFileSync(path.join(cwd, 'README.md'), big, 'utf8');
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ main: 'src/index.js' }),
      'utf8',
    );
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src', 'index.js'), 'console.log("hi");\n', 'utf8');

    const res = readSurveySources(cwd, { maxBytes: 1024 });
    assert.equal(res.cap_exceeded, true);
    assert.equal(res.excerpts.length, 1);
    assert.equal(res.excerpts[0].file, 'README.md');
    assert.equal(res.excerpts[0].body_truncated, true);
    assert.ok(res.excerpts[0].byte_count <= 1024);
    assert.ok(res.excerpts[0].byte_count > 0);
    assert.ok(res.reasoning_log.some((l) => l.includes('truncated')));
  });
});

describe('readSurveySources — no manifest', () => {
  it('includes only README when no manifest exists', () => {
    const cwd = tmpdir();
    fs.writeFileSync(path.join(cwd, 'README.md'), '# Title\n', 'utf8');

    const res = readSurveySources(cwd);
    assert.equal(res.excerpts.length, 1);
    assert.equal(res.excerpts[0].file, 'README.md');
    assert.ok(res.reasoning_log.some((l) => l.includes('no manifest-referenced entry point')));
  });
});

describe('readSurveySources — empty project', () => {
  it('returns empty excerpts with non-empty reasoning_log', () => {
    const cwd = tmpdir();
    const res = readSurveySources(cwd);
    assert.equal(res.excerpts.length, 0);
    assert.equal(res.total_byte_count, 0);
    assert.ok(res.reasoning_log.length > 0);
  });
});

describe('readSurveySources — 1MB individual safety cap', () => {
  it('skips files larger than 1MB and logs the reason', () => {
    const cwd = tmpdir();
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ main: 'big.py' }),
      'utf8',
    );
    const big = 'x'.repeat(2 * 1024 * 1024);
    fs.writeFileSync(path.join(cwd, 'big.py'), big, 'utf8');

    const res = readSurveySources(cwd);
    assert.equal(res.excerpts.length, 0);
    assert.equal(res.cap_exceeded, true);
    assert.ok(res.reasoning_log.some((l) => l.includes('big.py')));
    assert.ok(res.reasoning_log.some((l) => l.includes('1MB')));
  });
});
