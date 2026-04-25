import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isMissingWorkerFailure } from '../../src/commands/mcp.js';

describe('commands/mcp missing worker detection', () => {
  const missingPath = path.resolve('dist/commands/mcp-worker.js');

  it('detects direct missing-worker module failures', () => {
    const error = Object.assign(
      new Error(`Cannot find module '${missingPath}'`),
      { code: 'MODULE_NOT_FOUND' },
    );

    assert.equal(isMissingWorkerFailure(error, missingPath), true);
  });

  it('does not misclassify transitive import failures inside the worker', () => {
    const error = Object.assign(
      new Error(`Cannot find module './state.js' imported from ${missingPath}`),
      { code: 'ERR_MODULE_NOT_FOUND' },
    );

    assert.equal(isMissingWorkerFailure(error, missingPath), false);
  });

  it('ignores unrelated runtime errors', () => {
    const error = new Error('Worker exited unexpectedly with code 1');

    assert.equal(isMissingWorkerFailure(error, missingPath), false);
  });
});
