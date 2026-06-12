/**
 * Canonical package matching for security allow/deny lists.
 *
 * Supports three entry forms:
 *   "name"                 — bare name; matches any ecosystem
 *   "ecosystem:name"       — ecosystem-scoped, any version
 *   "ecosystem:name@version" — exact (ecosystem, name, version) pin
 *
 * Matching is exact on each component (no substring). Bare names match by
 * package name only, which preserves backward compatibility with the MVP
 * config while making the comparison precise instead of "purl.includes(d)".
 */

export type Ecosystem = 'npm' | 'pypi';

export interface PackageSpec {
  depname: string;
  version: string; // 'latest' when unspecified
}

export interface ParsedListEntry {
  ecosystem: Ecosystem | null; // null = any ecosystem
  name: string;
  version: string | null; // null = any version
  raw: string;
}

const ECOSYSTEMS: ReadonlySet<string> = new Set(['npm', 'pypi']);

/**
 * Parse a package spec like "pkg", "pkg@1.0.0", "@scope/pkg",
 * "@scope/pkg@1.0.0", or pip-style "pkg==1.0.0".
 */
export function parsePackageSpec(spec: string): PackageSpec {
  const trimmed = spec.trim();

  // pip-style "name==version"
  const pipMatch = trimmed.match(/^([A-Za-z0-9._-]+)\s*==\s*([^\s,;]+)$/);
  if (pipMatch) {
    return { depname: pipMatch[1]!, version: pipMatch[2]! };
  }

  // npm scoped: @scope/pkg or @scope/pkg@version
  if (trimmed.startsWith('@')) {
    const lastAt = trimmed.lastIndexOf('@');
    if (lastAt > 0) {
      return { depname: trimmed.slice(0, lastAt), version: trimmed.slice(lastAt + 1) || 'latest' };
    }
    return { depname: trimmed, version: 'latest' };
  }

  // pkg@version
  if (trimmed.includes('@')) {
    const idx = trimmed.indexOf('@');
    return { depname: trimmed.slice(0, idx), version: trimmed.slice(idx + 1) || 'latest' };
  }

  return { depname: trimmed, version: 'latest' };
}

/**
 * Parse an allow/deny list entry. Accepts:
 *   "name"
 *   "ecosystem:name"
 *   "ecosystem:name@version"
 * Whitespace tolerated. Unknown ecosystem prefixes are treated as bare
 * names (so "lodash@1.0.0" still works as bare-name+version).
 */
export function parseListEntry(entry: string): ParsedListEntry {
  const raw = entry;
  const trimmed = entry.trim();
  if (!trimmed) {
    return { ecosystem: null, name: '', version: null, raw };
  }

  let ecosystem: Ecosystem | null = null;
  let remainder = trimmed;

  // Only treat "<prefix>:" as ecosystem when <prefix> is a known ecosystem.
  // This prevents misparsing of names that legitimately contain ":".
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx > 0) {
    const prefix = trimmed.slice(0, colonIdx).toLowerCase();
    if (ECOSYSTEMS.has(prefix)) {
      ecosystem = prefix as Ecosystem;
      remainder = trimmed.slice(colonIdx + 1);
    }
  }

  // Now extract optional @version from remainder. Handle scoped names
  // ("@scope/pkg") and pip "name==version" too.
  const pipMatch = remainder.match(/^([A-Za-z0-9._-]+)\s*==\s*([^\s,;]+)$/);
  if (pipMatch) {
    return { ecosystem, name: pipMatch[1]!, version: pipMatch[2]!, raw };
  }

  if (remainder.startsWith('@')) {
    const lastAt = remainder.lastIndexOf('@');
    if (lastAt > 0) {
      return {
        ecosystem,
        name: remainder.slice(0, lastAt),
        version: remainder.slice(lastAt + 1) || null,
        raw,
      };
    }
    return { ecosystem, name: remainder, version: null, raw };
  }

  if (remainder.includes('@')) {
    const idx = remainder.indexOf('@');
    return {
      ecosystem,
      name: remainder.slice(0, idx),
      version: remainder.slice(idx + 1) || null,
      raw,
    };
  }

  return { ecosystem, name: remainder, version: null, raw };
}

/**
 * Returns true if (ecosystem, name, version) matches the parsed entry.
 * Matching rules:
 *  - entry.ecosystem null → any ecosystem
 *  - entry.name must equal name exactly
 *  - entry.version null → any version; otherwise exact equality with
 *    "*" as a wildcard alias for "any version"
 */
export function matchesEntry(
  entry: ParsedListEntry,
  ecosystem: string,
  name: string,
  version: string,
): boolean {
  if (entry.name === '') return false;
  if (entry.name !== name) return false;
  if (entry.ecosystem !== null && entry.ecosystem !== ecosystem) return false;
  if (entry.version !== null && entry.version !== '*' && entry.version !== version) return false;
  return true;
}

export function matchesAnyEntry(
  entries: ParsedListEntry[],
  ecosystem: string,
  name: string,
  version: string,
): ParsedListEntry | null {
  for (const e of entries) {
    if (matchesEntry(e, ecosystem, name, version)) return e;
  }
  return null;
}
