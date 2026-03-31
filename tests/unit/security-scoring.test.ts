import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeComposite,
  evaluatePackage,
  evaluateBatch,
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
});
