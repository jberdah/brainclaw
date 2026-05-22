import fs from 'node:fs';
import path from 'node:path';

/**
 * pln#516 step 1 — bootstrap `survey` source reader.
 *
 * Reads README + the manifest-referenced entry point of a project so the
 * `survey` phase signals_report carries actual implementation excerpts, not
 * just the topology + manifest names. Empirically (TranslaVox cold-start
 * run_4b0500c6, can_0160d6c4): two claude-code sessions independently missed
 * a complete GCP Speech-to-Text + Translate pipeline because `app/main.py`
 * was never inspected. The fix is targeted reading of manifest-declared
 * entry points up to a byte cap — NOT a broad glob.
 *
 * The bootstrap champion (the agent driving the loop) is the caller; the
 * engine does NOT invoke this automatically. The champion uses the returned
 * excerpts to populate the source_excerpts portion of its signals_report
 * artifact body (the artifact schema itself stays RefBasedArtifactBody —
 * see types.ts).
 */

export interface SurveySourceExcerpt {
  file: string;
  byte_count: number;
  body_truncated: boolean;
  body: string;
}

export interface SurveySourceResult {
  excerpts: SurveySourceExcerpt[];
  total_byte_count: number;
  cap_exceeded: boolean;
  cap_bytes: number;
  reasoning_log: string[];
}

export interface ReadSurveySourcesOptions {
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 50 * 1024;
const MAX_INDIVIDUAL_FILE_BYTES = 1024 * 1024;

export function readSurveySources(
  cwd: string,
  opts?: ReadSurveySourcesOptions,
): SurveySourceResult {
  const cap = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const log: string[] = [];
  const result: SurveySourceResult = {
    excerpts: [],
    total_byte_count: 0,
    cap_exceeded: false,
    cap_bytes: cap,
    reasoning_log: log,
  };

  let rootEntries: fs.Dirent[];
  try {
    rootEntries = fs.readdirSync(cwd, { withFileTypes: true });
  } catch (err) {
    log.push(`could not read project root: ${(err as Error).message}`);
    return result;
  }

  const readmeFiles: string[] = [];
  const licenseFiles: string[] = [];
  for (const entry of rootEntries) {
    if (!entry.isFile()) continue;
    const upper = entry.name.toUpperCase();
    if (/^README.*\.MD$/.test(upper)) {
      readmeFiles.push(entry.name);
    } else if (/^LICENSE(\.MD|\.TXT)?$/.test(upper)) {
      licenseFiles.push(entry.name);
    }
  }
  readmeFiles.sort();
  licenseFiles.sort();

  const candidates: string[] = [...readmeFiles, ...licenseFiles];

  const entryPoint = detectEntryPoint(cwd, rootEntries, log);
  if (entryPoint) {
    if (!candidates.includes(entryPoint)) candidates.push(entryPoint);
  } else {
    log.push('no manifest-referenced entry point found');
  }

  for (const relPath of candidates) {
    const absPath = path.join(cwd, relPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch (err) {
      log.push(`skipped ${relPath}: ${(err as Error).message}`);
      continue;
    }
    if (!stat.isFile()) {
      log.push(`skipped ${relPath}: not a regular file`);
      continue;
    }
    if (stat.size > MAX_INDIVIDUAL_FILE_BYTES) {
      log.push(
        `skipped ${relPath}: size ${stat.size} bytes exceeds 1MB individual safety cap`,
      );
      result.cap_exceeded = true;
      continue;
    }

    let content: string;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch (err) {
      log.push(`skipped ${relPath}: UTF-8 read failed (${(err as Error).message})`);
      continue;
    }

    const remaining = cap - result.total_byte_count;
    if (remaining <= 0) {
      log.push(`skipped ${relPath}: cap of ${cap} bytes already reached`);
      result.cap_exceeded = true;
      break;
    }

    const normalized = relPath.replace(/\\/g, '/');
    const fileBytes = Buffer.byteLength(content, 'utf8');
    if (fileBytes <= remaining) {
      result.excerpts.push({
        file: normalized,
        byte_count: fileBytes,
        body_truncated: false,
        body: content,
      });
      result.total_byte_count += fileBytes;
      log.push(`included ${normalized} (${fileBytes} bytes)`);
    } else {
      const truncated = truncateToBytes(content, remaining);
      const truncatedBytes = Buffer.byteLength(truncated, 'utf8');
      result.excerpts.push({
        file: normalized,
        byte_count: truncatedBytes,
        body_truncated: true,
        body: truncated,
      });
      result.total_byte_count += truncatedBytes;
      result.cap_exceeded = true;
      log.push(
        `truncated ${normalized} from ${fileBytes} to ${truncatedBytes} bytes to fit cap of ${cap}`,
      );
      break;
    }
  }

  return result;
}

function truncateToBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

function detectEntryPoint(
  cwd: string,
  rootEntries: fs.Dirent[],
  log: string[],
): string | undefined {
  const fileNames = new Set<string>();
  for (const entry of rootEntries) {
    if (entry.isFile()) fileNames.add(entry.name);
  }

  for (const name of fileNames) {
    if (name.endsWith('.spec')) {
      const found = parsePyinstallerSpec(path.join(cwd, name), log);
      if (found) return found;
    }
  }

  if (fileNames.has('package.json')) {
    const found = parsePackageJson(path.join(cwd, 'package.json'), log);
    if (found) return found;
  }

  if (fileNames.has('pyproject.toml')) {
    const found = parsePyproject(path.join(cwd, 'pyproject.toml'), log);
    if (found) return found;
  }

  if (fileNames.has('Cargo.toml')) {
    const found = parseCargoToml(path.join(cwd, 'Cargo.toml'), cwd, log);
    if (found) return found;
  }

  if (fileNames.has('go.mod')) {
    if (fileNames.has('main.go')) return 'main.go';
    const found = findGoCmdMain(cwd);
    if (found) return found;
  }

  return undefined;
}

function parsePyinstallerSpec(file: string, log: string[]): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    log.push(`pyinstaller .spec read failed: ${(err as Error).message}`);
    return undefined;
  }
  const m = /Analysis\(\s*\[\s*['"]([^'"]+)['"]/.exec(text);
  return m ? m[1] : undefined;
}

function parsePackageJson(file: string, log: string[]): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    log.push(`package.json parse failed: ${(err as Error).message}`);
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.main === 'string') return obj.main;
  if (typeof obj.bin === 'string') return obj.bin;
  if (obj.bin && typeof obj.bin === 'object') {
    for (const v of Object.values(obj.bin as Record<string, unknown>)) {
      if (typeof v === 'string') return v;
    }
  }
  return undefined;
}

function parsePyproject(file: string, log: string[]): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    log.push(`pyproject.toml read failed: ${(err as Error).message}`);
    return undefined;
  }
  for (const header of ['[project.scripts]', '[tool.poetry.scripts]']) {
    const idx = text.indexOf(header);
    if (idx === -1) continue;
    const rest = text.slice(idx + header.length);
    const nextSectionRel = rest.search(/\n\s*\[/);
    const section = nextSectionRel >= 0 ? rest.slice(0, nextSectionRel) : rest;
    for (const line of section.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const m = /^[A-Za-z_][\w-]*\s*=\s*['"]([^'"]+)['"]/.exec(trimmed);
      if (m) return moduleSpecToPath(m[1]);
    }
  }
  return undefined;
}

function moduleSpecToPath(spec: string): string {
  const modulePart = spec.split(':')[0];
  return modulePart.split('.').join('/') + '.py';
}

function parseCargoToml(file: string, cwd: string, log: string[]): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    log.push(`Cargo.toml read failed: ${(err as Error).message}`);
    return undefined;
  }
  const binMatch = /\[\[bin\]\][\s\S]*?path\s*=\s*['"]([^'"]+)['"]/.exec(text);
  if (binMatch) return binMatch[1];
  if (fs.existsSync(path.join(cwd, 'src', 'main.rs'))) return 'src/main.rs';
  return undefined;
}

function findGoCmdMain(cwd: string): string | undefined {
  const cmdDir = path.join(cwd, 'cmd');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(cmdDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(cmdDir, entry.name, 'main.go');
    if (fs.existsSync(candidate)) return path.posix.join('cmd', entry.name, 'main.go');
  }
  return undefined;
}
