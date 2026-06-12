import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMode,
  computeComposite,
  decisionExitCode,
  evaluatePackage,
  evaluateBatch,
  normalizeThresholds,
  normalizeWeights,
  worstDecision,
  type SecurityVerdict,
} from '../../src/core/security-scoring.js';
import type { PackageScores } from '../../src/core/socket-client.js';

function makeScores(overrides: Partial<PackageScores> = {}): PackageScores {
  return {
    purl: 'pkg:npm/test-pkg',
    version: '1.0.0',
    supplyChain: 90,
    vulnerability: 100,
    quality: 90,
    maintenance: 90,
    license: 100,
    ...overrides,
  };
}

describe('security-scoring', () => {
  describe('computeComposite', () => {
    it('computes weighted composite with default weights', () => {
      const scores = makeScores({
        supplyChain: 100,
        vulnerability: 100,
        quality: 100,
        maintenance: 100,
        license: 100,
      });
      assert.equal(computeComposite(scores), 100);
    });

    it('weights supply chain highest', () => {
      const highSC = makeScores({ supplyChain: 100, vulnerability: 50, quality: 50, maintenance: 50, license: 50 });
      const lowSC = makeScores({ supplyChain: 50, vulnerability: 100, quality: 100, maintenance: 100, license: 100 });
      // highSC: 100*0.35 + 50*0.30 + 50*0.15 + 50*0.15 + 50*0.05 = 35+15+7.5+7.5+2.5 = 67.5
      // lowSC:  50*0.35 + 100*0.30 + 100*0.15 + 100*0.15 + 100*0.05 = 17.5+30+15+15+5 = 82.5
      assert.equal(computeComposite(highSC), 67.5);
      assert.equal(computeComposite(lowSC), 82.5);
    });
  });

  describe('evaluatePackage', () => {
    it('returns pass for high-scoring package', () => {
      const scores = makeScores();
      const verdict = evaluatePackage(scores);
      assert.equal(verdict.decision, 'pass');
      assert.equal(verdict.reasons.length, 0);
    });

    it('returns block for supply_chain hard block (axios attack scenario)', () => {
      // Simulates axios@1.14.1 with supply_chain=0
      const scores = makeScores({
        purl: 'pkg:npm/axios',
        version: '1.14.1',
        supplyChain: 0,
        vulnerability: 100,
        quality: 100,
        maintenance: 94,
        license: 100,
      });
      const verdict = evaluatePackage(scores);
      assert.equal(verdict.decision, 'block');
      assert.ok(verdict.reasons.some(r => r.includes('supply_chain=0')));
      assert.ok(verdict.reasons.some(r => r.includes('hard block')));
    });

    it('returns block for malware dropper (plain-crypto-js scenario)', () => {
      const scores = makeScores({
        purl: 'pkg:npm/plain-crypto-js',
        version: '4.2.1',
        supplyChain: 0,
        vulnerability: 100,
        quality: 99,
        maintenance: 90,
        license: 100,
      });
      const verdict = evaluatePackage(scores);
      assert.equal(verdict.decision, 'block');
    });

    it('returns pass for clean axios version', () => {
      const scores = makeScores({
        purl: 'pkg:npm/axios',
        version: '1.14.0',
        supplyChain: 90,
        vulnerability: 100,
        quality: 100,
        maintenance: 94,
        license: 100,
      });
      const verdict = evaluatePackage(scores);
      assert.equal(verdict.decision, 'pass');
    });

    it('returns warn for composite in warn zone', () => {
      const scores = makeScores({
        supplyChain: 50,
        vulnerability: 60,
        quality: 50,
        maintenance: 50,
        license: 50,
      });
      // composite = 50*0.35 + 60*0.30 + 50*0.15 + 50*0.15 + 50*0.05 = 17.5+18+7.5+7.5+2.5 = 53
      const verdict = evaluatePackage(scores);
      assert.equal(verdict.decision, 'warn');
      assert.ok(verdict.reasons.some(r => r.includes('warn threshold')));
    });

    it('returns block for composite below warn threshold', () => {
      const scores = makeScores({
        supplyChain: 35,
        vulnerability: 40,
        quality: 30,
        maintenance: 30,
        license: 30,
      });
      const verdict = evaluatePackage(scores);
      assert.equal(verdict.decision, 'block');
    });

    it('returns block for vulnerability hard block', () => {
      const scores = makeScores({
        supplyChain: 90,
        vulnerability: 10,
        quality: 90,
        maintenance: 90,
        license: 90,
      });
      const verdict = evaluatePackage(scores);
      assert.equal(verdict.decision, 'block');
      assert.ok(verdict.reasons.some(r => r.includes('vulnerability=10')));
    });

    it('respects denylist', () => {
      const scores = makeScores({ purl: 'pkg:npm/evil-pkg' });
      const verdict = evaluatePackage(scores, { denylist: ['evil-pkg'] });
      assert.equal(verdict.decision, 'block');
      assert.ok(verdict.reasons.some(r => r.includes('denylist')));
    });

    it('respects allowlist', () => {
      const scores = makeScores({ purl: 'pkg:npm/internal-pkg', supplyChain: 10 });
      const verdict = evaluatePackage(scores, { allowlist: ['internal-pkg'] });
      assert.equal(verdict.decision, 'pass');
      assert.ok(verdict.reasons.some(r => r.includes('allowlist')));
    });

    it('handles pypi ecosystem', () => {
      const scores = makeScores({ purl: 'pkg:pypi/torch', supplyChain: 73 });
      const verdict = evaluatePackage(scores);
      assert.equal(verdict.ecosystem, 'pypi');
      assert.equal(verdict.decision, 'pass');
    });

    it('custom thresholds override defaults', () => {
      const scores = makeScores({ supplyChain: 75, vulnerability: 80, quality: 70, maintenance: 70, license: 80 });
      // With default thresholds this would pass (composite ~76)
      const verdictDefault = evaluatePackage(scores);
      assert.equal(verdictDefault.decision, 'pass');

      // With strict thresholds
      const verdictStrict = evaluatePackage(scores, {
        thresholds: { composite_pass: 80, composite_warn: 70, supply_chain_block: 30, vulnerability_block: 20 },
      });
      assert.equal(verdictStrict.decision, 'warn');
    });
  });

  describe('evaluateBatch', () => {
    it('evaluates multiple packages', () => {
      const verdicts = evaluateBatch([
        makeScores({ purl: 'pkg:npm/safe', supplyChain: 99 }),
        makeScores({ purl: 'pkg:npm/risky', supplyChain: 0 }),
      ]);
      assert.equal(verdicts.length, 2);
      assert.equal(verdicts[0].decision, 'pass');
      assert.equal(verdicts[1].decision, 'block');
    });
  });

  describe('worstDecision', () => {
    it('returns block if any block', () => {
      const verdicts = [
        { decision: 'pass' } as SecurityVerdict,
        { decision: 'block' } as SecurityVerdict,
      ];
      assert.equal(worstDecision(verdicts), 'block');
    });

    it('returns warn if any warn and no block', () => {
      const verdicts = [
        { decision: 'pass' } as SecurityVerdict,
        { decision: 'warn' } as SecurityVerdict,
      ];
      assert.equal(worstDecision(verdicts), 'warn');
    });

    it('returns pass if all pass', () => {
      const verdicts = [
        { decision: 'pass' } as SecurityVerdict,
        { decision: 'pass' } as SecurityVerdict,
      ];
      assert.equal(worstDecision(verdicts), 'pass');
    });
  });

  describe('applyMode', () => {
    it('keeps the verdict unchanged in enforced mode', () => {
      assert.equal(applyMode('pass', 'enforced'), 'pass');
      assert.equal(applyMode('warn', 'enforced'), 'warn');
      assert.equal(applyMode('block', 'enforced'), 'block');
    });

    it('downgrades block to warn in advisory mode', () => {
      assert.equal(applyMode('block', 'advisory'), 'warn');
    });

    it('leaves warn and pass unchanged in advisory mode', () => {
      assert.equal(applyMode('warn', 'advisory'), 'warn');
      assert.equal(applyMode('pass', 'advisory'), 'pass');
    });
  });

  describe('decisionExitCode', () => {
    it('maps verdicts to exit codes', () => {
      assert.equal(decisionExitCode('pass'), 0);
      assert.equal(decisionExitCode('warn'), 1);
      assert.equal(decisionExitCode('block'), 2);
    });
  });

  describe('normalizeWeights', () => {
    it('keeps weights that already sum to 1', () => {
      const w = normalizeWeights({ supply_chain: 0.5, vulnerability: 0.5, quality: 0, maintenance: 0, license: 0 });
      const sum = w.supply_chain + w.vulnerability + w.quality + w.maintenance + w.license;
      assert.ok(Math.abs(sum - 1) < 1e-9);
    });

    it('rescales weights that do not sum to 1', () => {
      // user supplies extreme values: each at 1.0 would naively let composite reach 500.
      const w = normalizeWeights({ supply_chain: 1, vulnerability: 1, quality: 1, maintenance: 1, license: 1 });
      const sum = w.supply_chain + w.vulnerability + w.quality + w.maintenance + w.license;
      assert.ok(Math.abs(sum - 1) < 1e-9);
      assert.ok(Math.abs(w.supply_chain - 0.2) < 1e-9);
    });

    it('falls back to defaults when all weights are zero', () => {
      const w = normalizeWeights({ supply_chain: 0, vulnerability: 0, quality: 0, maintenance: 0, license: 0 });
      const sum = w.supply_chain + w.vulnerability + w.quality + w.maintenance + w.license;
      assert.ok(Math.abs(sum - 1) < 1e-9);
      // default supply_chain is 0.35
      assert.ok(Math.abs(w.supply_chain - 0.35) < 1e-9);
    });

    it('composite stays in [0,100] under custom weights', () => {
      const scores = {
        purl: 'pkg:npm/x', version: '1.0.0',
        supplyChain: 100, vulnerability: 100, quality: 100, maintenance: 100, license: 100,
      };
      // With normalization, even a degenerate weight set should still produce <=100.
      const c = computeComposite(scores, { supply_chain: 10, vulnerability: 10, quality: 0, maintenance: 0, license: 0 });
      assert.ok(c <= 100);
      assert.ok(c >= 0);
    });
  });

  describe('normalizeThresholds', () => {
    it('clamps values outside [0,100]', () => {
      const t = normalizeThresholds({ composite_pass: 150, composite_warn: -20, supply_chain_block: 999, vulnerability_block: -5 });
      assert.equal(t.composite_pass, 100);
      assert.equal(t.composite_warn, 0);
      assert.equal(t.supply_chain_block, 100);
      assert.equal(t.vulnerability_block, 0);
    });

    it('enforces composite_warn <= composite_pass', () => {
      const t = normalizeThresholds({ composite_pass: 50, composite_warn: 80, supply_chain_block: 30, vulnerability_block: 20 });
      assert.ok(t.composite_warn <= t.composite_pass);
      assert.equal(t.composite_warn, 50);
    });

    it('passes through valid thresholds unchanged', () => {
      const t = normalizeThresholds({ composite_pass: 70, composite_warn: 50, supply_chain_block: 30, vulnerability_block: 20 });
      assert.equal(t.composite_pass, 70);
      assert.equal(t.composite_warn, 50);
    });
  });

  describe('canonical allow/deny matching', () => {
    it('denylist rejects exact (ecosystem, name) without ecosystem prefix', () => {
      const scores = makeScores({ purl: 'pkg:npm/evil-pkg' });
      const v = evaluatePackage(scores, { denylist: ['evil-pkg'] });
      assert.equal(v.decision, 'block');
    });

    it('denylist does NOT match by substring (the MVP bug)', () => {
      // 'lodash' must not match 'lodash-foo'
      const scores = makeScores({ purl: 'pkg:npm/lodash-foo' });
      const v = evaluatePackage(scores, { denylist: ['lodash'] });
      assert.notEqual(v.decision, 'block');
    });

    it('denylist matches with ecosystem:name', () => {
      const scores = makeScores({ purl: 'pkg:npm/axios', version: '1.14.1' });
      const v = evaluatePackage(scores, { denylist: ['npm:axios'] });
      assert.equal(v.decision, 'block');
    });

    it('denylist scoped to ecosystem does not bleed across', () => {
      const npmScores = makeScores({ purl: 'pkg:npm/requests', version: '1.0.0' });
      const pyScores = makeScores({ purl: 'pkg:pypi/requests', version: '2.31.0' });
      const denylist = ['pypi:requests'];
      assert.notEqual(evaluatePackage(npmScores, { denylist }).decision, 'block');
      assert.equal(evaluatePackage(pyScores, { denylist }).decision, 'block');
    });

    it('denylist version pin matches exact version only', () => {
      const v1 = makeScores({ purl: 'pkg:npm/axios', version: '1.14.1' });
      const v2 = makeScores({ purl: 'pkg:npm/axios', version: '1.14.0' });
      const denylist = ['npm:axios@1.14.1'];
      assert.equal(evaluatePackage(v1, { denylist }).decision, 'block');
      assert.notEqual(evaluatePackage(v2, { denylist }).decision, 'block');
    });

    it('allowlist matches with ecosystem:name@version', () => {
      const scores = makeScores({ purl: 'pkg:npm/internal-pkg', version: '2.0.0', supplyChain: 0 });
      const v = evaluatePackage(scores, { allowlist: ['npm:internal-pkg@2.0.0'] });
      assert.equal(v.decision, 'pass');
    });
  });
});
