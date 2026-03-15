import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { runContext } from '../../src/commands/context.js';

describe('0.6.8 graceful degradation (context on uninitialized project)', () => {
  it('exits cleanly (no throw) when .brainclaw/ absent, plain text output', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-nodot-'));
    const logs: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    try {
      // Should not throw and not call process.exit
      runContext({ cwd: tmpDir });
      assert.ok(logs.length > 0, 'should produce output');
      assert.ok(
        logs.some((l) => l.includes('brainclaw init') || l.includes('not initialized')),
        `expected init hint in output, got: ${logs.join('\n')}`
      );
    } finally {
      console.log = originalLog;
      console.error = originalError;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('outputs structured JSON when --json and no .brainclaw/', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-nodot-json-'));
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    try {
      runContext({ cwd: tmpDir, json: true });
      assert.ok(logs.length > 0, 'should produce JSON output');
      const parsed = JSON.parse(logs[0]);
      assert.equal(parsed.initialized, false);
      assert.ok(typeof parsed.action_required === 'string');
    } finally {
      console.log = originalLog;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
