import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — .mjs script without type declarations
import { runParallelTests } from '../../scripts/run-tests.mjs';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('scripts/run-tests', () => {
  it('runs multiple e2e files in parallel when pool capacity is available', async () => {
    let active = 0;
    let maxActive = 0;
    const launched: string[] = [];

    const tests = [
      { filepath: '/tmp/e2e-a.test.js', label: 'e2e-a.test.js', kind: 'e2e', timeoutMs: 90000 },
      { filepath: '/tmp/e2e-b.test.js', label: 'e2e-b.test.js', kind: 'e2e', timeoutMs: 90000 },
    ];

    const results = await runParallelTests(tests, {
      concurrency: 3,
      runFile: async (test: { label: string; filepath: string; kind: string; timeoutMs: number }) => {
        launched.push(test.label);
        active++;
        maxActive = Math.max(maxActive, active);
        await wait(40);
        active--;
        return {
          ...test,
          ok: true,
          reason: 'PASS',
          durationMs: 40,
          output: '',
        };
      },
    });

    assert.deepEqual(launched.sort(), ['e2e-a.test.js', 'e2e-b.test.js']);
    assert.equal(maxActive, 2);
    assert.equal(results.length, 2);
    assert.equal(results.every((result: { ok: boolean }) => result.ok), true);
  });
});
