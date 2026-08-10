/**
 * Bounded, local TypeScript/JavaScript resolver configuration.
 *
 * Only root tsconfig/jsconfig, local extends, baseUrl and paths are supported.
 * Package extends and node_modules are deliberately never read. Any malformed,
 * escaping, cyclic, or ambiguous configuration is invalid so callers abstain.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_EXTENDS_DEPTH = 8;
const CONFIG_FILENAMES = ['tsconfig.json', 'jsconfig.json'] as const;

export interface TypeScriptPathMapping {
  readonly pattern: string;
  /** Project-relative candidate bases; a `*` is substituted at resolution time. */
  readonly targets: readonly string[];
}

/** Read-only snapshot shared by refresh freshness and the TypeScript provider. */
export interface TypeScriptResolutionConfig {
  readonly kind: 'typescript-resolution-config';
  /** Raw bytes of every config consulted, including malformed configs. */
  readonly fingerprint: string;
  readonly valid: boolean;
  /** Project-relative baseUrl, or null when no baseUrl was declared. */
  readonly baseUrl: string | null;
  readonly paths: readonly TypeScriptPathMapping[];
}

interface JsonObject {
  readonly [key: string]: unknown;
}

interface MergedOptions {
  baseUrl: string | null;
  paths: TypeScriptPathMapping[];
}

interface ReadState {
  readonly root: string;
  readonly seen: Set<string>;
  readonly fingerprintParts: string[];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

function configFingerprint(parts: readonly string[]): string {
  return `sha256:${crypto.createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex')}`;
}

/** Strip JSONC comments without changing comment-looking text inside strings. */
function stripJsonComments(source: string): string | null {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      i++;
      while (i + 1 < source.length && source[i + 1] !== '\n' && source[i + 1] !== '\r') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      if (close < 0) return null;
      i = close + 1;
      continue;
    }
    out += ch;
  }
  return inString ? null : out;
}

/** JSONC permits trailing commas; remove them only outside quoted strings. */
function stripTrailingCommas(source: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let next = i + 1;
      while (next < source.length && /\s/.test(source[next]!)) next++;
      if (source[next] === '}' || source[next] === ']') continue;
    }
    out += ch;
  }
  return out;
}

function parseJsonc(source: string): JsonObject | null {
  const withoutComments = stripJsonComments(source);
  if (withoutComments === null) return null;
  try {
    const parsed: unknown = JSON.parse(stripTrailingCommas(withoutComments));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isWithin(root: string, absolute: string): boolean {
  const rel = path.relative(root, absolute);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

function projectRelative(root: string, absolute: string): string | null {
  return isWithin(root, absolute) ? toPosix(path.relative(root, absolute)) : null;
}

/** Resolve a config-local directory, refusing absolute and project-escaping values. */
function localDirectory(root: string, configDir: string, value: string): string | null {
  if (path.isAbsolute(value)) return null;
  return projectRelative(root, path.resolve(configDir, value));
}

function starCount(value: string): number {
  return [...value].filter((c) => c === '*').length;
}

function parsePaths(
  raw: unknown,
  root: string,
  configDir: string,
  baseUrl: string | null,
): TypeScriptPathMapping[] | null {
  if (!isObject(raw)) return null;
  const targetDir = baseUrl === null ? configDir : path.resolve(root, baseUrl);
  const mappings: TypeScriptPathMapping[] = [];
  for (const pattern of Object.keys(raw).sort()) {
    const values = raw[pattern];
    const stars = starCount(pattern);
    if (pattern.length === 0 || stars > 1 || !Array.isArray(values) || values.length === 0) return null;
    const targets: string[] = [];
    for (const value of values) {
      if (typeof value !== 'string' || starCount(value) > 1 || (stars === 0 && starCount(value) !== 0)) return null;
      const target = localDirectory(root, targetDir, value);
      if (target === null) return null;
      targets.push(target);
    }
    mappings.push({ pattern, targets });
  }
  return mappings;
}

function localExtendsPath(root: string, configDir: string, value: string): string | null {
  // Bare values name packages; never follow them, even if node_modules is present.
  if (!value.startsWith('./') && !value.startsWith('../')) return null;
  const candidate = path.resolve(configDir, value);
  if (!isWithin(root, candidate)) return null;
  const jsonPath = path.extname(candidate) ? candidate : `${candidate}.json`;
  return isWithin(root, jsonPath) ? jsonPath : null;
}

function readConfig(filename: string, depth: number, state: ReadState): { valid: boolean; options: MergedOptions } {
  const empty = { baseUrl: null, paths: [] };
  if (depth > MAX_EXTENDS_DEPTH || state.seen.has(filename) || !isWithin(state.root, filename)) {
    return { valid: false, options: empty };
  }
  state.seen.add(filename);
  let source: string;
  try {
    source = fs.readFileSync(filename, 'utf8');
  } catch {
    return { valid: false, options: empty };
  }
  state.fingerprintParts.push(`${projectRelative(state.root, filename) ?? filename}\u0000${source}`);
  const json = parseJsonc(source);
  if (!json) return { valid: false, options: empty };

  const configDir = path.dirname(filename);
  let inherited: MergedOptions = empty;
  if (json.extends !== undefined) {
    if (typeof json.extends !== 'string') return { valid: false, options: empty };
    const parent = localExtendsPath(state.root, configDir, json.extends);
    if (!parent) return { valid: false, options: empty };
    const parentResult = readConfig(parent, depth + 1, state);
    if (!parentResult.valid) return { valid: false, options: empty };
    inherited = parentResult.options;
  }

  if (json.compilerOptions !== undefined && !isObject(json.compilerOptions)) return { valid: false, options: empty };
  const options = json.compilerOptions ?? {};
  let baseUrl = inherited.baseUrl;
  if (options.baseUrl !== undefined) {
    if (typeof options.baseUrl !== 'string') return { valid: false, options: empty };
    baseUrl = localDirectory(state.root, configDir, options.baseUrl);
    if (baseUrl === null) return { valid: false, options: empty };
  }
  let paths = inherited.paths;
  if (options.paths !== undefined) {
    const parsedPaths = parsePaths(options.paths, state.root, configDir, baseUrl);
    if (!parsedPaths) return { valid: false, options: empty };
    paths = parsedPaths;
  }
  return { valid: true, options: { baseUrl, paths } };
}

/**
 * Read exactly one root configuration. Two root configs are intentionally
 * ambiguous: TypeScript tooling can choose based on invocation, Code Map cannot.
 */
export function loadTypeScriptResolutionConfig(projectRoot: string): TypeScriptResolutionConfig {
  const root = path.resolve(projectRoot);
  const found = CONFIG_FILENAMES.map((name) => path.join(root, name)).filter((filename) => fs.existsSync(filename));
  if (found.length === 0) {
    return { kind: 'typescript-resolution-config', fingerprint: configFingerprint([]), valid: true, baseUrl: null, paths: [] };
  }
  if (found.length > 1) {
    const parts = found.map((filename) => {
      try {
        return `${path.basename(filename)}\u0000${fs.readFileSync(filename, 'utf8')}`;
      } catch {
        return `${path.basename(filename)}\u0000<unreadable>`;
      }
    });
    return { kind: 'typescript-resolution-config', fingerprint: configFingerprint(parts), valid: false, baseUrl: null, paths: [] };
  }
  const state: ReadState = { root, seen: new Set(), fingerprintParts: [] };
  const result = readConfig(found[0]!, 0, state);
  return {
    kind: 'typescript-resolution-config',
    fingerprint: configFingerprint(state.fingerprintParts),
    valid: result.valid,
    baseUrl: result.valid ? result.options.baseUrl : null,
    paths: result.valid ? result.options.paths : [],
  };
}

export function isTypeScriptResolutionConfig(value: unknown): value is TypeScriptResolutionConfig {
  return !!value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'typescript-resolution-config';
}

function matchPattern(pattern: string, specifier: string): string | null {
  const star = pattern.indexOf('*');
  if (star < 0) return pattern === specifier ? '' : null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

/** Map a bare specifier to project-relative candidate bases, or no candidates. */
export function typeScriptSpecifierBases(
  specifier: string,
  config: TypeScriptResolutionConfig | undefined,
): readonly string[] {
  if (!config?.valid) return [];
  const matches = config.paths
    .map((mapping) => ({ mapping, wildcard: matchPattern(mapping.pattern, specifier) }))
    .filter((match): match is { mapping: TypeScriptPathMapping; wildcard: string } => match.wildcard !== null);
  // Overlapping paths patterns are intentionally not ranked: ambiguity abstains.
  if (matches.length > 1) return [];
  if (matches.length === 1) {
    const { mapping, wildcard } = matches[0]!;
    return mapping.targets.map((target) => target.replace('*', wildcard));
  }
  return config.baseUrl === null ? [] : [path.posix.join(config.baseUrl, specifier)];
}
