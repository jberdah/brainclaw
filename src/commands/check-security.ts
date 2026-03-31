import path from 'node:path';
import { memoryExists, memoryPath } from '../core/io.js';
import { loadConfig } from '../core/config.js';
import { SecurityCache } from '../core/security-cache.js';
import { querySocketScores, type PackageQuery } from '../core/socket-client.js';
import { evaluateBatch, worstDecision, type SecurityVerdict } from '../core/security-scoring.js';

export interface CheckSecurityCommandOptions {
  packages: string;
  ecosystem?: 'npm' | 'pypi';
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
  const packageNames = options.packages.split(',').map(p => p.trim()).filter(Boolean);

  if (packageNames.length === 0) {
    console.error('No packages specified.');
    process.exit(1);
  }

  // Build cache
  const cachePath = memoryPath('security/cache.json', options.cwd);
  const cache = new SecurityCache(cachePath, preinstall.cache_ttl_hours);

  // Separate cached vs uncached
  const queries: PackageQuery[] = [];
  const cachedResults: Array<{ query: PackageQuery; scores: ReturnType<typeof cache.get> }> = [];

  for (const name of packageNames) {
    const [depname, version] = name.includes('@') && !name.startsWith('@')
      ? name.split('@') as [string, string]
      : name.startsWith('@')
        ? [name.slice(0, name.lastIndexOf('@')) || name, name.slice(name.lastIndexOf('@') + 1) || 'latest']
        : [name, 'latest'];

    const cached = cache.get(ecosystem, depname, version);
    const query: PackageQuery = { depname, ecosystem, ...(version !== 'latest' ? { version } : {}) };

    if (cached) {
      cachedResults.push({ query, scores: cached });
    } else {
      queries.push(query);
    }
  }

  // Fetch uncached from Socket
  let fetchedScores: Awaited<ReturnType<typeof querySocketScores>> = [];
  if (queries.length > 0) {
    try {
      fetchedScores = await querySocketScores(queries, { endpoint: preinstall.socket_endpoint });
      // Update cache
      for (const s of fetchedScores) {
        const eco = s.purl.startsWith('pkg:pypi') ? 'pypi' : 'npm';
        const depname = s.purl.replace(/^pkg:\w+\//, '');
        cache.set(eco, depname, s.version, s);
      }
      cache.flush();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (preinstall.fallback_on_error === 'block') {
        console.error(`Socket MCP error: ${msg} — blocking (fallback=block)`);
        process.exit(2);
      }
      if (preinstall.fallback_on_error === 'warn') {
        console.error(`Socket MCP error: ${msg} — allowing with warning (fallback=warn)`);
      }
      // fallback=pass: silent continue
      if (cachedResults.length === 0) {
        process.exit(preinstall.fallback_on_error === 'warn' ? 1 : 0);
      }
    }
  }

  // Combine cached + fetched scores
  const allScores = [
    ...cachedResults.filter(c => c.scores !== null).map(c => c.scores!),
    ...fetchedScores,
  ];

  const verdicts = evaluateBatch(allScores, preinstall);
  const worst = worstDecision(verdicts);

  if (options.json) {
    console.log(JSON.stringify({ verdicts, decision: worst }, null, 2));
  } else {
    printVerdicts(verdicts);
  }

  // Exit codes: 0=pass, 1=warn, 2=block
  if (worst === 'block') process.exit(2);
  if (worst === 'warn') process.exit(1);
  process.exit(0);
}

function printVerdicts(verdicts: SecurityVerdict[]): void {
  if (verdicts.length === 0) {
    console.log('No packages to check.');
    return;
  }

  for (const v of verdicts) {
    const icon = v.decision === 'pass' ? '\u2705' : v.decision === 'warn' ? '\u26A0\uFE0F' : '\uD83D\uDED1';
    console.log(`${icon} ${v.ecosystem}/${v.package}@${v.version} — composite=${v.composite} [${v.decision.toUpperCase()}]`);
    console.log(`   SC=${v.scores.supplyChain} vuln=${v.scores.vulnerability} qual=${v.scores.quality} maint=${v.scores.maintenance} lic=${v.scores.license}`);
    for (const r of v.reasons) {
      console.log(`   \u2192 ${r}`);
    }
  }
}
