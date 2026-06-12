import type { PreinstallConfig, PreinstallThresholds, PreinstallWeights } from './schema.js';
import type { PackageScores } from './socket-client.js';
import { matchesAnyEntry, parseListEntry, type ParsedListEntry } from './security-packages.js';

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

/**
 * Normalize weights so they sum to 1.0. Without this, custom configs like
 * `{ supply_chain: 1, vulnerability: 1 }` produce a composite that can
 * exceed 100, making thresholds meaningless. If all weights are zero the
 * defaults are used (degenerate config — fail open to the project default).
 */
export function normalizeWeights(weights?: Partial<PreinstallWeights>): PreinstallWeights {
  const merged = { ...DEFAULT_WEIGHTS, ...weights };
  const sum = merged.supply_chain + merged.vulnerability + merged.quality + merged.maintenance + merged.license;
  if (sum <= 0) return { ...DEFAULT_WEIGHTS };
  if (Math.abs(sum - 1) < 1e-9) return merged;
  return {
    supply_chain: merged.supply_chain / sum,
    vulnerability: merged.vulnerability / sum,
    quality: merged.quality / sum,
    maintenance: merged.maintenance / sum,
    license: merged.license / sum,
  };
}

/**
 * Clamp thresholds to the [0,100] band and enforce the invariant
 * `composite_warn <= composite_pass`. The CLI loader can call this so a
 * mis-configured YAML never produces a "composite=60 → block when
 * pass=50, warn=80" non-monotonic verdict.
 */
export function normalizeThresholds(thresholds?: Partial<PreinstallThresholds>): PreinstallThresholds {
  const t: PreinstallThresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  t.composite_pass = clamp(t.composite_pass);
  t.composite_warn = clamp(t.composite_warn);
  t.supply_chain_block = clamp(t.supply_chain_block);
  t.vulnerability_block = clamp(t.vulnerability_block);
  if (t.composite_warn > t.composite_pass) {
    t.composite_warn = t.composite_pass;
  }
  return t;
}

export function computeComposite(scores: PackageScores, weights?: Partial<PreinstallWeights>): number {
  const w = normalizeWeights(weights);
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
  const thresholds = normalizeThresholds(config?.thresholds);
  const weights = normalizeWeights(config?.weights);
  const allowlist = config?.allowlist ?? [];
  const denylist = config?.denylist ?? [];

  const pkgName = scores.purl.replace(/^pkg:\w+\//, '');
  const ecosystem = scores.purl.startsWith('pkg:pypi') ? 'pypi' : 'npm';
  const reasons: string[] = [];

  const parsedDeny: ParsedListEntry[] = denylist.map(parseListEntry);
  const parsedAllow: ParsedListEntry[] = allowlist.map(parseListEntry);

  // Denylist check — canonical (ecosystem, name, optional version) match.
  const denyHit = matchesAnyEntry(parsedDeny, ecosystem, pkgName, scores.version);
  if (denyHit) {
    return {
      package: pkgName,
      ecosystem,
      version: scores.version,
      scores,
      composite: 0,
      decision: 'block',
      reasons: [`Package "${pkgName}@${scores.version}" matches denylist entry "${denyHit.raw.trim()}"`],
    };
  }

  // Allowlist check — canonical match; skips scoring.
  const allowHit = matchesAnyEntry(parsedAllow, ecosystem, pkgName, scores.version);
  if (allowHit) {
    return {
      package: pkgName,
      ecosystem,
      version: scores.version,
      scores,
      composite: 100,
      decision: 'pass',
      reasons: [`Package "${pkgName}@${scores.version}" matches allowlist entry "${allowHit.raw.trim()}"`],
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
