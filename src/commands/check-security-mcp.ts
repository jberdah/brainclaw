import { memoryExists, memoryPath } from '../core/io.js';
import { loadConfig } from '../core/config.js';
import { SecurityCache } from '../core/security-cache.js';
import { querySocketScores, type PackageQuery, type PackageScores } from '../core/socket-client.js';
import {
  applyMode,
  evaluateBatch,
  worstDecision,
  type SecurityDecision,
  type SecurityMode,
} from '../core/security-scoring.js';
import { parsePackageSpec } from '../core/security-packages.js';
import { collectPackages } from '../core/security-extract.js';
import { createTrap } from '../core/operations/memory-write.js';

interface McpToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
}

export async function handleCheckSecurity(args: Record<string, unknown>, cwd: string): Promise<McpToolResult> {
  if (!memoryExists(cwd)) {
    return { content: [{ type: 'text', text: 'Error: .brainclaw/ not found. Run brainclaw init first.' }] };
  }

  const config = loadConfig(cwd);
  const preinstall = config.security?.preinstall;

  if (!preinstall?.enabled) {
    return { content: [{ type: 'text', text: 'Security preinstall checks are not enabled. Set security.preinstall.enabled: true in config.yaml.' }] };
  }

  const ecosystem = (String(args.ecosystem ?? 'npm').trim()) as 'npm' | 'pypi';
  const modeArg = args.mode ? String(args.mode).trim() : undefined;
  const effectiveMode: SecurityMode = (modeArg === 'enforced' || modeArg === 'advisory')
    ? modeArg
    : (preinstall.mode ?? 'advisory');

  let packageSpecs: string[];
  try {
    packageSpecs = collectPackages({
      packages: args.packages ? String(args.packages) : undefined,
      requirements: args.requirements ? String(args.requirements) : undefined,
      lockfile: args.lockfile ? String(args.lockfile) : undefined,
      defaultEcosystem: ecosystem,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error: ${msg}` }] };
  }

  if (packageSpecs.length === 0) {
    return { content: [{ type: 'text', text: 'Error: no packages specified (pass --packages, --requirements, or --lockfile).' }] };
  }

  // Build cache
  const cachePath = memoryPath('security/cache.json', cwd);
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

  const allScores = [...cachedScores, ...fetchedScores];

  if (allScores.length === 0 && fetchError) {
    const fallback = preinstall.fallback_on_error;
    const fallbackVerdict: SecurityDecision = fallback === 'block' ? 'block' : fallback === 'warn' ? 'warn' : 'pass';
    const effective = applyMode(fallbackVerdict, effectiveMode);
    return {
      content: [{ type: 'text', text: `Socket MCP error: ${fetchError}\nFallback policy: ${fallback} (mode=${effectiveMode}) → ${effective.toUpperCase()}` }],
      structuredContent: {
        error: fetchError,
        fallback,
        mode: effectiveMode,
        decision: fallbackVerdict,
        effective_decision: effective,
      },
    };
  }

  const verdicts = evaluateBatch(allScores, preinstall);
  const intrinsic = worstDecision(verdicts);
  const effective = applyMode(intrinsic, effectiveMode);

  // Build text output
  const lines: string[] = [];
  if (fetchError) {
    lines.push(`⚠ Socket MCP partial error: ${fetchError} (${cachedScores.length} results from cache)`);
    lines.push('');
  }

  for (const v of verdicts) {
    const icon = v.decision === 'pass' ? '✅' : v.decision === 'warn' ? '⚠️' : '🛑';
    lines.push(`${icon} ${v.ecosystem}/${v.package}@${v.version} — composite=${v.composite} [${v.decision.toUpperCase()}]`);
    lines.push(`   SC=${v.scores.supplyChain} vuln=${v.scores.vulnerability} qual=${v.scores.quality} maint=${v.scores.maintenance} lic=${v.scores.license}`);
    for (const r of v.reasons) {
      lines.push(`   → ${r}`);
    }
  }

  // Auto-create traps for WARN and BLOCK verdicts
  const trapsCreated: string[] = [];
  for (const v of verdicts) {
    if (v.decision === 'pass') continue;
    const severity = v.decision === 'block' ? 'high' : 'medium';
    const trapText = `Security ${v.decision.toUpperCase()}: ${v.ecosystem}/${v.package}@${v.version} — composite=${v.composite}, SC=${v.scores.supplyChain}, vuln=${v.scores.vulnerability}. ${v.reasons.join('; ')}`;
    try {
      const result = createTrap({
        text: trapText,
        author: 'brainclaw-security',
        severity: severity as 'high' | 'medium',
        tags: ['security', 'supply-chain', `decision:${v.decision}`, v.ecosystem],
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      }, cwd);
      trapsCreated.push(result.id);
    } catch {
      // Non-critical: trap creation failure should not block the security check
    }
  }

  if (trapsCreated.length > 0) {
    lines.push('');
    lines.push(`Created ${trapsCreated.length} security trap(s): ${trapsCreated.join(', ')}`);
  }

  lines.push('');
  if (intrinsic !== effective) {
    lines.push(`Verdict: ${intrinsic.toUpperCase()} — downgraded to ${effective.toUpperCase()} by mode=${effectiveMode}.`);
  } else {
    lines.push(`Verdict: ${intrinsic.toUpperCase()} (mode=${effectiveMode})`);
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: {
      verdicts: verdicts.map(v => ({
        package: v.package,
        ecosystem: v.ecosystem,
        version: v.version,
        composite: v.composite,
        decision: v.decision,
        reasons: v.reasons,
        scores: {
          supplyChain: v.scores.supplyChain,
          vulnerability: v.scores.vulnerability,
          quality: v.scores.quality,
          maintenance: v.scores.maintenance,
          license: v.scores.license,
        },
      })),
      decision: intrinsic,
      effective_decision: effective,
      mode: effectiveMode,
      ...(fetchError ? { fetch_error: fetchError } : {}),
    },
  };
}
