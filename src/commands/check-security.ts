import { memoryExists, memoryPath } from '../core/io.js';
import { loadConfig } from '../core/config.js';
import { SecurityCache } from '../core/security-cache.js';
import { querySocketScores, type PackageQuery, type PackageScores } from '../core/socket-client.js';
import {
  applyMode,
  decisionExitCode,
  evaluateBatch,
  worstDecision,
  type SecurityDecision,
  type SecurityMode,
  type SecurityVerdict,
} from '../core/security-scoring.js';
import { parsePackageSpec } from '../core/security-packages.js';
import { collectPackages } from '../core/security-extract.js';

export interface CheckSecurityCommandOptions {
  packages?: string;
  ecosystem?: 'npm' | 'pypi';
  mode?: SecurityMode;
  requirements?: string;
  lockfile?: string;
  json?: boolean;
  cwd?: string;
}

export async function runCheckSecurity(options: CheckSecurityCommandOptions): Promise<void> {
  if (!memoryExists(options.cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const config = loadConfig(options.cwd);
  const preinstall = config.security?.preinstall;

  if (!preinstall?.enabled) {
    console.error('Security preinstall checks are not enabled. Set security.preinstall.enabled: true in config.yaml');
    process.exit(1);
  }

  const ecosystem = options.ecosystem ?? 'npm';
  const effectiveMode: SecurityMode = options.mode ?? preinstall.mode ?? 'advisory';

  let packageSpecs: string[];
  try {
    packageSpecs = collectPackages({
      packages: options.packages,
      requirements: options.requirements,
      lockfile: options.lockfile,
      defaultEcosystem: ecosystem,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }

  if (packageSpecs.length === 0) {
    console.error('No packages specified.');
    process.exit(1);
  }

  // Build cache
  const cachePath = memoryPath('security/cache.json', options.cwd);
  const cache = new SecurityCache(cachePath, preinstall.cache_ttl_hours);

  // Separate cached vs uncached
  const queries: PackageQuery[] = [];
  const cachedScores: PackageScores[] = [];

  for (const spec of packageSpecs) {
    const { depname, version } = parsePackageSpec(spec);
    const cached = cache.get(ecosystem, depname, version);
    if (cached) {
      cachedScores.push(cached);
    } else {
      queries.push({ depname, ecosystem, ...(version !== 'latest' ? { version } : {}) });
    }
  }

  // Fetch uncached from Socket
  let fetchedScores: PackageScores[] = [];
  let fetchError: string | null = null;
  if (queries.length > 0) {
    try {
      fetchedScores = await querySocketScores(queries, { endpoint: preinstall.socket_endpoint });
      for (const s of fetchedScores) {
        const eco = s.purl.startsWith('pkg:pypi') ? 'pypi' : 'npm';
        const depname = s.purl.replace(/^pkg:\w+\//, '');
        cache.set(eco, depname, s.version, s);
      }
      cache.flush();
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err);
    }
  }

  // Decide what to do on offline / fetch failure.
  // fallback_on_error semantics:
  //   block — abort regardless of mode (operator opted into strictness)
  //   warn  — surface warning, continue with whatever cache we have
  //   pass  — silent, continue with cache (or treat as pass if no data)
  if (fetchError && cachedScores.length === 0) {
    const fallback = preinstall.fallback_on_error;
    if (options.json) {
      console.log(JSON.stringify({
        verdicts: [],
        decision: fallbackDecision(fallback),
        effective_decision: applyMode(fallbackDecision(fallback), effectiveMode),
        mode: effectiveMode,
        fetch_error: fetchError,
      }, null, 2));
    } else {
      console.error(`Socket MCP error: ${fetchError}`);
      console.error(`Fallback policy: ${fallback} — no cached results to fall back to.`);
    }
    process.exit(decisionExitCode(applyMode(fallbackDecision(fallback), effectiveMode)));
  }

  if (fetchError) {
    // Partial failure: we have some cache, surface a warning.
    if (!options.json) {
      console.error(`Warning: Socket MCP error: ${fetchError} (continuing with ${cachedScores.length} cached result(s))`);
    }
  }

  const allScores = [...cachedScores, ...fetchedScores];
  const verdicts = evaluateBatch(allScores, preinstall);
  const intrinsic = worstDecision(verdicts);
  const effective = applyMode(intrinsic, effectiveMode);

  if (options.json) {
    console.log(JSON.stringify({
      verdicts,
      decision: intrinsic,
      effective_decision: effective,
      mode: effectiveMode,
      ...(fetchError ? { fetch_error: fetchError } : {}),
    }, null, 2));
  } else {
    printVerdicts(verdicts, intrinsic, effective, effectiveMode);
  }

  process.exit(decisionExitCode(effective));
}

function fallbackDecision(fallback: 'warn' | 'pass' | 'block'): SecurityDecision {
  if (fallback === 'block') return 'block';
  if (fallback === 'warn') return 'warn';
  return 'pass';
}

function printVerdicts(
  verdicts: SecurityVerdict[],
  intrinsic: SecurityDecision,
  effective: SecurityDecision,
  mode: SecurityMode,
): void {
  if (verdicts.length === 0) {
    console.log('No packages to check.');
    return;
  }

  for (const v of verdicts) {
    const icon = v.decision === 'pass' ? '✅' : v.decision === 'warn' ? '⚠️' : '🛑';
    console.log(`${icon} ${v.ecosystem}/${v.package}@${v.version} — composite=${v.composite} [${v.decision.toUpperCase()}]`);
    console.log(`   SC=${v.scores.supplyChain} vuln=${v.scores.vulnerability} qual=${v.scores.quality} maint=${v.scores.maintenance} lic=${v.scores.license}`);
    for (const r of v.reasons) {
      console.log(`   → ${r}`);
    }
  }

  // Surface the mode-aware outcome so operators see what would have happened.
  if (intrinsic !== effective) {
    console.log('');
    console.log(`Verdict: ${intrinsic.toUpperCase()} — downgraded to ${effective.toUpperCase()} by mode=advisory.`);
    console.log('   Switch to enforced mode (brainclaw setup-security --mode enforced) to block on this verdict.');
  } else if (verdicts.length > 0) {
    console.log('');
    console.log(`Verdict: ${intrinsic.toUpperCase()} (mode=${mode})`);
  }
}
