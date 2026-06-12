import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyMode, decisionExitCode, type SecurityDecision } from '../../src/core/security-scoring.js';

/**
 * Contract test for the advisory/enforced wrapper interface:
 *
 *   exit 0 — pass (silent; wrapper continues install)
 *   exit 1 — warn (wrapper prints warning; install continues)
 *   exit 2 — block (wrapper aborts install)
 *
 * Pre-fix, the CLI always emitted exit 2 for a block verdict regardless
 * of mode, so advisory mode silently behaved like enforced. This test
 * pins the table so a regression is caught.
 */
describe('advisory/enforced exit-code contract', () => {
  const cases: Array<{ verdict: SecurityDecision; mode: 'advisory' | 'enforced'; expected: number }> = [
    { verdict: 'pass',  mode: 'advisory', expected: 0 },
    { verdict: 'pass',  mode: 'enforced', expected: 0 },
    { verdict: 'warn',  mode: 'advisory', expected: 1 },
    { verdict: 'warn',  mode: 'enforced', expected: 1 },
    { verdict: 'block', mode: 'advisory', expected: 1 }, // KEY: advisory downgrades
    { verdict: 'block', mode: 'enforced', expected: 2 }, // KEY: enforced aborts
  ];

  for (const c of cases) {
    it(`${c.verdict}/${c.mode} → exit ${c.expected}`, () => {
      assert.equal(decisionExitCode(applyMode(c.verdict, c.mode)), c.expected);
    });
  }
});
