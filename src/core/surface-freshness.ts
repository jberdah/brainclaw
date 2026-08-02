/**
 * pln#638 volet 2b — lazy freshness reconcile for generated guidance surfaces.
 *
 * WHY THIS EXISTS. 2a made the live header HONEST: it stopped claiming
 * "auto-refreshed" and started naming its real triggers (session-end, handoff,
 * `brainclaw refresh`) plus the version and timestamp that wrote it. Honesty alone
 * does not help an agent tier that never fires any of those triggers, though — it
 * just tells that tier, truthfully, that the file might be arbitrarily old. 2b
 * closes the loop by USING the stamp: compare it against the running version and
 * say so, once, at a path we already visit.
 *
 * NO DAEMON, NO WATCHER — the validated lazy-reconcile pattern. The check is a
 * pure comparison plus a directory scan of a registry that already exists
 * (`AGENT_EXPORT_REGISTRY` / `LIVE_COMPANION_EXPORT_REGISTRY`), so it is DERIVED
 * rather than enumerated. That is review finding F1 applied here: a hand-kept
 * list of generated surfaces would itself be an unguarded generated surface, and
 * would reproduce the exact defect this plan exists to fix.
 *
 * ADVISORY, AND SILENT ON DOUBT. A surface with no stamp is not stale — it is
 * unknown (it may predate the stamp, or be hand-written by the operator). Only a
 * stamp that PARSES and names a DIFFERENT version is reported. Nothing here
 * rewrites a file: regeneration stays the explicit act it always was.
 *
 * @module
 */
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_EXPORT_REGISTRY, LIVE_COMPANION_EXPORT_REGISTRY } from './agent-files.js';
import type { StructuredWarningInput } from './warnings.js';

/**
 * Matches the provenance line emitted by `renderLiveHeader`
 * (instruction-templates.ts) and by the protocol-skill front-matter.
 *
 * Deliberately tolerant about what follows the version: the timestamp format is
 * not what this parser is for, and a stricter pattern would go stale the first
 * time the header gains a field.
 */
const PROVENANCE_RE = /Written by brainclaw v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/;

/** `brainclaw_version: X` in a generated SKILL.md front-matter. */
const SKILL_PROVENANCE_RE = /^\s*brainclaw_version:\s*v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*$/m;

export interface SurfaceProvenance {
  /** The brainclaw version stamped in the file, when one is present and parses. */
  version?: string;
}

/** Read the provenance stamp out of a generated surface's content. Never throws. */
export function parseSurfaceProvenance(content: string): SurfaceProvenance {
  const header = PROVENANCE_RE.exec(content);
  if (header?.[1]) return { version: header[1] };
  const skill = SKILL_PROVENANCE_RE.exec(content);
  if (skill?.[1]) return { version: skill[1] };
  return {};
}

export type SurfaceFreshness =
  | { kind: 'fresh'; version: string }
  | { kind: 'stale'; stampedVersion: string; currentVersion: string }
  /** No parseable stamp: could predate the stamp, or be operator-authored. */
  | { kind: 'unknown'; reason: string };

/**
 * Compare one surface's stamp against the running version.
 *
 * An UNKNOWN stamp is never reported as stale. Treating "no stamp" as "out of
 * date" would fire on every hand-written AGENTS.md in every project that ever
 * adopted brainclaw — the false-positive failure mode that teaches agents to
 * ignore a channel.
 */
export function assessSurfaceFreshness(content: string, currentVersion: string): SurfaceFreshness {
  const { version } = parseSurfaceProvenance(content);
  if (!version) return { kind: 'unknown', reason: 'no brainclaw provenance stamp' };
  if (version === currentVersion) return { kind: 'fresh', version };
  return { kind: 'stale', stampedVersion: version, currentVersion };
}

/**
 * Which regeneration path owns a surface. The two kinds have DIFFERENT recovery
 * commands (trp_6a49f976): stable surfaces are rewritten by `export`, live
 * companions only by `refresh` (or session-end/handoff/state changes) — an
 * `export` run leaves every live companion exactly as stale as it was.
 */
export type SurfaceKind = 'stable' | 'live';

/** The command that regenerates every stable surface. `export --write` alone is rejected by the CLI (a mode flag is required — see runExport). */
export const STABLE_SURFACE_REFRESH_COMMAND = 'brainclaw export --all --write';

/** The command that regenerates every live companion. */
export const LIVE_SURFACE_REFRESH_COMMAND = 'brainclaw refresh';

/** One generated surface found on disk with a stamp older than the running version. */
export interface StaleSurface {
  /** Path relative to the project root. */
  relativePath: string;
  stampedVersion: string;
  kind: SurfaceKind;
}

/**
 * The set of surfaces this project could have on disk, derived from the export
 * registries rather than listed here. Deduplicated because several agents share
 * a target (four of them write AGENTS.md); a path claimed by both registries
 * counts as stable, since `export` regenerates it.
 */
function candidateSurfaces(): Array<{ relativePath: string; kind: SurfaceKind }> {
  const stable = new Set(AGENT_EXPORT_REGISTRY.map((t) => t.relativePath));
  const live = new Set(LIVE_COMPANION_EXPORT_REGISTRY.map((t) => t.relativePath));
  return [
    ...[...stable].map((relativePath) => ({ relativePath, kind: 'stable' as const })),
    ...[...live].filter((p) => !stable.has(p)).map((relativePath) => ({ relativePath, kind: 'live' as const })),
  ];
}

export interface ReconcileSurfaceFreshnessResult {
  stale: StaleSurface[];
  /** Surfaces that exist and carry the running version. */
  freshCount: number;
  /** Surfaces that exist with no parseable stamp — reported for diagnostics only. */
  unknownCount: number;
}

/**
 * Scan the project's generated surfaces and report the ones stamped with a
 * different brainclaw version.
 *
 * Cheap by construction: it only stats/reads files the registries name (~25
 * paths, most absent in any given project), and reads at most the head of each —
 * the stamp is in the header, so there is no reason to pull a whole file into
 * memory. Never throws; an unreadable file is simply not reported.
 */
export function reconcileSurfaceFreshness(cwd: string, currentVersion: string): ReconcileSurfaceFreshnessResult {
  const result: ReconcileSurfaceFreshnessResult = { stale: [], freshCount: 0, unknownCount: 0 };
  for (const { relativePath, kind } of candidateSurfaces()) {
    const full = path.join(cwd, relativePath);
    let head: string;
    try {
      if (!fs.existsSync(full)) continue;
      // The stamp lives in the header; 4KB covers it with room to spare.
      const fd = fs.openSync(full, 'r');
      try {
        const buf = Buffer.alloc(4096);
        const read = fs.readSync(fd, buf, 0, buf.length, 0);
        head = buf.subarray(0, read).toString('utf-8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue; // unreadable → not reported, never a crash
    }
    const verdict = assessSurfaceFreshness(head, currentVersion);
    if (verdict.kind === 'stale') result.stale.push({ relativePath, stampedVersion: verdict.stampedVersion, kind });
    else if (verdict.kind === 'fresh') result.freshCount += 1;
    else result.unknownCount += 1;
  }
  return result;
}

/**
 * Build the advisory for a stale-surface scan, or `undefined` when there is
 * nothing to say.
 *
 * NO `next_actions`, deliberately. The recovery is a CLI command, and there is
 * no MCP tool that performs it — `bclaw_setup` is the onboarding wizard and
 * takes no write flag. Pointing at it anyway would ship a next_action whose
 * args the engine rejects, which is the precise class of drift this plan exists
 * to eliminate; and per pln#634's own rule, a builder with no genuine follow-up
 * returns nothing rather than inventing one. The command therefore travels in
 * the message, where it is true.
 *
 * WHICH command depends on what is stale (trp_6a49f976): this advisory shipped
 * in 1.20.0 recommending `brainclaw export --write`, which the CLI rejects
 * (a mode flag is required) and which — even corrected to `--all` — never
 * touches live companions, the very files the first real-world firing listed.
 * The recovery must be per kind, and only for the kinds actually stale.
 */
export function staleSurfaceWarning(
  result: ReconcileSurfaceFreshnessResult,
  currentVersion: string,
): StructuredWarningInput | undefined {
  if (result.stale.length === 0) return undefined;
  const shown = result.stale.slice(0, 8);
  const overflow = result.stale.length - shown.length;
  const kinds = new Set(result.stale.map((s) => s.kind));
  const commands = [
    ...(kinds.has('stable') ? [STABLE_SURFACE_REFRESH_COMMAND] : []),
    ...(kinds.has('live') ? [LIVE_SURFACE_REFRESH_COMMAND] : []),
  ];
  const recovery = kinds.size === 2
    ? ` Run \`${STABLE_SURFACE_REFRESH_COMMAND}\` (stable surfaces) and \`${LIVE_SURFACE_REFRESH_COMMAND}\` (live companions) to refresh them.`
    : ` Run \`${commands[0]}\` to refresh them.`;
  return {
    code: 'generated_surfaces_stale',
    message:
      `${result.stale.length} generated guidance surface(s) were written by an older brainclaw than v${currentVersion}: `
      + shown.map((s) => `${s.relativePath} (v${s.stampedVersion})`).join(', ')
      + (overflow > 0 ? ` (+${overflow} more)` : '')
      + '. An agent tier that never triggers a regeneration is reading them as-is.'
      + recovery,
    data: {
      current_version: currentVersion,
      stale_surfaces: shown.map((s) => ({ path: s.relativePath, stamped_version: s.stampedVersion, kind: s.kind })),
      ...(overflow > 0 ? { stale_surfaces_omitted: overflow } : {}),
      // Kept as a single runnable string for consumers that shipped against
      // 1.20.0; refresh_commands is the structured form.
      refresh_command: commands.join(' && '),
      refresh_commands: commands,
    },
  };
}
