import fs from 'node:fs';

/**
 * Package extraction sources for `check-security`.
 *
 * Three input modes are supported and may be combined:
 *  - `packages` — comma-separated specs (e.g. "axios,express@1.2.3")
 *  - `requirements` — path to a pip-style requirements.txt
 *  - `lockfile` — path to a package-lock.json (npm) or yarn.lock
 *
 * The extractor only enumerates package identifiers. Version-range
 * resolution and transitive dependency walking are intentionally out of
 * scope (the supply-chain scoring service receives one spec per package).
 */

export interface CollectOptions {
  packages?: string;
  requirements?: string;
  lockfile?: string;
  defaultEcosystem?: 'npm' | 'pypi';
}

export function collectPackages(opts: CollectOptions): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const push = (spec: string) => {
    const trimmed = spec.trim();
    if (!trimmed) return;
    // Skip local paths and URLs — they aren't registry packages.
    if (isLocalOrUrl(trimmed)) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };

  if (opts.packages) {
    for (const item of opts.packages.split(',')) push(item);
  }

  if (opts.requirements) {
    for (const item of parseRequirementsFile(opts.requirements)) push(item);
  }

  if (opts.lockfile) {
    for (const item of parseLockfile(opts.lockfile)) push(item);
  }

  return out;
}

/**
 * Return true for arguments that look like a filesystem path or URL
 * rather than a registry package name. Mirrors the heuristic the
 * wrapper scripts use when intercepting install commands.
 */
export function isLocalOrUrl(spec: string): boolean {
  if (!spec) return false;
  if (spec === '.' || spec === '..') return true;
  if (spec.startsWith('./') || spec.startsWith('../')) return true;
  if (spec.startsWith('/')) return true; // absolute POSIX path
  if (/^[A-Za-z]:[\\/]/.test(spec)) return true; // Windows drive path
  if (/^[a-z]+:\/\//.test(spec)) return true; // http(s)/git/file URLs
  if (spec.startsWith('git+') || spec.startsWith('git@')) return true;
  if (spec.endsWith('.tar.gz') || spec.endsWith('.tgz') || spec.endsWith('.whl')) return true;
  return false;
}

/**
 * Parse a pip requirements.txt file. Supports the subset of syntax that
 * actually shows up in install gates:
 *   - one spec per line; "name", "name==version", "name~=version"
 *   - comments (#) and blank lines
 *   - continuation lines with trailing backslash
 *   - line options (-r/--requirement, -e/--editable, -i/--index-url, etc.)
 *     are skipped, with -r/--requirement recursively included.
 */
export function parseRequirementsFile(filePath: string): string[] {
  const raw = readFileOrThrow(filePath, 'requirements file');
  const out: string[] = [];
  const lines = unfoldContinuations(raw).split(/\r?\n/);
  for (const line of lines) {
    const stripped = line.replace(/\s*#.*$/, '').trim();
    if (!stripped) continue;

    if (stripped.startsWith('-r ') || stripped.startsWith('--requirement ')) {
      // Recursive include — keep it bounded but useful.
      const nested = stripped.replace(/^(-r|--requirement)\s+/, '').trim();
      if (nested) {
        try { out.push(...parseRequirementsFile(resolveSibling(filePath, nested))); }
        catch { /* missing nested file is non-fatal */ }
      }
      continue;
    }
    if (stripped.startsWith('-')) continue; // -e, -i, --index-url, etc.

    // Drop env-marker portion: "pkg==1.0 ; python_version>'3.7'"
    const noMarker = stripped.split(';')[0]!.trim();
    if (!noMarker) continue;

    // Strip extras: "pkg[extra1,extra2]==1.0"
    const noExtras = noMarker.replace(/\[[^\]]*\]/g, '');

    // Keep only "name" or "name==version" forms; reject URL/path specs and
    // ranges we cannot translate to an exact spec ("~=", ">=", "<=", "<", ">", "!=", "===").
    const exact = noExtras.match(/^([A-Za-z0-9._-]+)\s*==\s*([^\s,;]+)\s*$/);
    if (exact) { out.push(`${exact[1]}==${exact[2]}`); continue; }

    const bare = noExtras.match(/^([A-Za-z0-9._-]+)\s*$/);
    if (bare) { out.push(bare[1]!); continue; }

    // For range specs, keep the name (range resolution is outside our scope).
    const nameOnly = noExtras.match(/^([A-Za-z0-9._-]+)/);
    if (nameOnly) { out.push(nameOnly[1]!); }
  }
  return out;
}

/**
 * Parse a lockfile to extract top-level direct-dependency package names.
 * Supports:
 *   - npm package-lock.json (v1, v2, v3): uses `packages[""].dependencies`
 *     and `packages[""].devDependencies` when present (v2+), else falls
 *     back to top-level `dependencies` (v1).
 *   - npm shrinkwrap.json: same shape as package-lock.
 *
 * Transitive deps are deliberately excluded; the gate is for what the
 * operator is asking to install, not the full resolved graph.
 */
export function parseLockfile(filePath: string): string[] {
  const raw = readFileOrThrow(filePath, 'lockfile');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (err) {
    throw new Error(`Failed to parse lockfile ${filePath}: ${(err as Error).message}`, { cause: err });
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const obj = parsed as Record<string, unknown>;

  const out: string[] = [];

  // npm package-lock v2+
  const packages = obj['packages'];
  if (packages && typeof packages === 'object') {
    const root = (packages as Record<string, unknown>)[''];
    if (root && typeof root === 'object') {
      const deps = (root as Record<string, unknown>)['dependencies'];
      const devDeps = (root as Record<string, unknown>)['devDependencies'];
      collectLockDeps(deps, out);
      collectLockDeps(devDeps, out);
    }
  }

  // npm package-lock v1 fallback
  if (out.length === 0) {
    const deps = obj['dependencies'];
    if (deps && typeof deps === 'object') {
      for (const [name, meta] of Object.entries(deps as Record<string, unknown>)) {
        const v = meta && typeof meta === 'object' ? (meta as Record<string, unknown>)['version'] : undefined;
        out.push(typeof v === 'string' ? `${name}@${v}` : name);
      }
    }
  }

  return out;
}

function collectLockDeps(deps: unknown, out: string[]): void {
  if (!deps || typeof deps !== 'object') return;
  for (const [name, range] of Object.entries(deps as Record<string, unknown>)) {
    if (typeof range === 'string' && /^\d/.test(range)) {
      out.push(`${name}@${range}`);
    } else {
      out.push(name);
    }
  }
}

function unfoldContinuations(raw: string): string {
  return raw.replace(/\\\r?\n/g, ' ');
}

function readFileOrThrow(p: string, label: string): string {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch (err) {
    throw new Error(`Could not read ${label} at ${p}: ${(err as Error).message}`, { cause: err });
  }
}

function resolveSibling(parent: string, nested: string): string {
  // Tolerate both absolute and relative includes without pulling in `node:path`.
  if (nested.startsWith('/') || /^[A-Za-z]:[\\/]/.test(nested)) return nested;
  const sep = parent.includes('\\') ? '\\' : '/';
  const dir = parent.replace(/[\\/][^\\/]*$/, '');
  return dir + sep + nested;
}
