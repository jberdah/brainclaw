import type { PreinstallConfig, PreinstallThresholds, PreinstallWeights } from './schema.js';
import type { PackageScores } from './socket-client.js';

export type SecurityDecision = 'pass' | 'warn' | 'block';
export type SecurityMode = 'advisory' | 'enforced';

export interface SecurityVerdict {
  package: string;
  ecosystem: string;
  version: string;
  scores: PackageScores;
  composite: number;
  decision: SecurityDecision;
  reasons: string[];
}

/**
 * Map an intrinsic verdict (pass/warn/block) to the effective decision under
 * a given mode. In advisory mode, a block is downgraded to warn so the
 * operator sees the issue but the wrapper does not abort the install.
 */
export function applyMode(decision: SecurityDecision, mode: SecurityMode): SecurityDecision {
  if (mode === 'enforced') return decision;
  return decision === 'block' ? 'warn' : decision;
}

/**
 * Map an effective decision to a CLI exit code.
 *   pass  -> 0
 *   warn  -> 1   (wrapper continues, but surfaces the warning)
 *   block -> 2   (wrapper aborts the install)
 */
export function decisionExitCode(decision: SecurityDecision): number {
  if (decision === 'block') return 2;
  if (decision === 'warn') return 1;
  return 0;
}

const DEFAULT_WEIGHTS: PreinstallWeights = {
  supply_chain: 0.35,
  vulnerability: 0.30,
  quality: 0.15,
  maintenance: 0.15,
  license: 0.05,
};

const DEFAULT_THRESHOLDS: PreinstallThresholds = {
  composite_pass: 70,
  composite_warn: 50,
  supply_chain_block: 30,
  vulnerability_block: 20,
};

export function computeComposite(scores: PackageScores, weights?: Partial<PreinstallWeights>): number {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  return Math.round(
    (scores.supplyChain * w.supply_chain +
      scores.vulnerability * w.vulnerability +
      scores.quality * w.quality +
      scores.maintenance * w.maintenance +
      scores.license * w.license) * 10,
  ) / 10;
}

export function evaluatePackage(
  scores: PackageScores,
  config?: Partial<Pick<PreinstallConfig, 'thresholds' | 'weights' | 'allowlist' | 'denylist'>>,
): SecurityVerdict {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...config?.thresholds };
  const weights = { ...DEFAULT_WEIGHTS, ...config?.weights };
  const allowlist = config?.allowlist ?? [];
  const denylist = config?.denylist ?? [];

  const pkgName = scores.purl.replace(/^pkg:\w+\//, '');
  const ecosystem = scores.purl.startsWith('pkg:pypi') ? 'pypi' : 'npm';
  const reasons: string[] = [];

  // Denylist check (exact match on package name)
  if (denylist.some(d => pkgName === d || scores.purl.includes(d))) {
    return {
      package: pkgName,
      ecosystem,
      version: scores.version,
      scores,
      composite: 0,
      decision: 'block',
      reasons: [`Package "${pkgName}" is on the denylist`],
    };
  }

  // Allowlist check (skip scoring)
  if (allowlist.some(a => pkgName === a || scores.purl.includes(a))) {
    return {
      package: pkgName,
      ecosystem,
      version: scores.version,
      scores,
      composite: 100,
      decision: 'pass',
      reasons: [`Package "${pkgName}" is on the allowlist`],
    };
  }

  const composite = computeComposite(scores, weights);

  // Hard blocks on individual scores
  if (scores.supplyChain < thresholds.supply_chain_block) {
    reasons.push(`supply_chain=${scores.supplyChain} < ${thresholds.supply_chain_block} (hard block)`);
  }
  if (scores.vulnerability < thresholds.vulnerability_block) {
    reasons.push(`vulnerability=${scores.vulnerability} < ${thresholds.vulnerability_block} (hard block)`);
  }

  if (reasons.length > 0) {
    return { package: pkgName, ecosystem, version: scores.version, scores, composite, decision: 'block', reasons };
  }

  // Composite-based decision
  if (composite < thresholds.composite_warn) {
    reasons.push(`composite=${composite} < ${thresholds.composite_warn} (block threshold)`);
    return { package: pkgName, ecosystem, version: scores.version, scores, composite, decision: 'block', reasons };
  }

  if (composite < thresholds.composite_pass) {
    reasons.push(`composite=${composite} < ${thresholds.composite_pass} (warn threshold)`);
    return { package: pkgName, ecosystem, version: scores.version, scores, composite, decision: 'warn', reasons };
  }

  return { package: pkgName, ecosystem, version: scores.version, scores, composite, decision: 'pass', reasons: [] };
}

export function evaluateBatch(
  scoresList: PackageScores[],
  config?: Partial<Pick<PreinstallConfig, 'thresholds' | 'weights' | 'allowlist' | 'denylist'>>,
): SecurityVerdict[] {
  return scoresList.map(s => evaluatePackage(s, config));
}

export function worstDecision(verdicts: SecurityVerdict[]): SecurityDecision {
  if (verdicts.some(v => v.decision === 'block')) return 'block';
  if (verdicts.some(v => v.decision === 'warn')) return 'warn';
  return 'pass';
}
