import { runBootstrapProfile } from '../../bootstrap.js';
import type { MemorySeedConfidence, MemorySeedKind, MemorySeedSourceKind } from '../../schema.js';

/**
 * pln#557 step 4 — deterministic-scanner baseline for the bootstrap-loop
 * `survey` phase.
 *
 * The two bootstrap pipelines did not talk to each other: runBootstrapProfile
 * (the 2227-line deterministic scanner — toolchain, scripts, topology,
 * hotspots, native instruction files) produced structured signals that never
 * reached the loop's survey phase, so survey quality depended entirely on the
 * champion re-discovering the repo by hand (TranslaVox miss, can_0160d6c4).
 *
 * This hook runs the scanner (reusing the cached profile when the source
 * fingerprint matches) and compacts the result into a baseline the champion
 * ENRICHES into its signals_report — it is attached at loop-open time as a
 * `signals_baseline` artifact (freeform body, deliberately NOT
 * `signals_report` so the survey advance-gate is not auto-traversed). The
 * scanner thereby becomes an internal helper of the loop instead of a second
 * competing front door.
 */

export interface SurveyBaselineSeed {
  kind: MemorySeedKind;
  text: string;
  source_kind: MemorySeedSourceKind;
  source_ref: string;
  confidence: MemorySeedConfidence;
}

export interface SurveySignalsBaseline {
  generated_at: string;
  source: 'deterministic_scanner';
  summary: string;
  workspace_kind?: 'empty' | 'existing';
  onboarding_mode?: string;
  confidence?: string;
  sources_scanned: string[];
  native_instruction_files: string[];
  gaps: string[];
  seed_count: number;
  /** Top seeds (capped) — the full set lives in the bootstrap seed store. */
  seeds: SurveyBaselineSeed[];
  seeds_truncated: boolean;
}

export interface BuildSurveyBaselineOptions {
  maxSeeds?: number;
  /** Byte budget for the serialized baseline (loop artifact bodies cap at 4 KiB). */
  maxBytes?: number;
}

const DEFAULT_MAX_SEEDS = 20;
const DEFAULT_MAX_BYTES = 3800;

export function buildSurveySignalsBaseline(
  cwd: string,
  opts: BuildSurveyBaselineOptions = {},
): SurveySignalsBaseline {
  const maxSeeds = opts.maxSeeds ?? DEFAULT_MAX_SEEDS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  const result = runBootstrapProfile({ cwd });
  const baseline: SurveySignalsBaseline = {
    generated_at: new Date().toISOString(),
    source: 'deterministic_scanner',
    summary: result.profile.summary,
    workspace_kind: result.profile.workspace_kind,
    onboarding_mode: result.profile.onboarding_mode,
    confidence: result.profile.confidence,
    sources_scanned: result.profile.sources_scanned,
    native_instruction_files: result.profile.native_instruction_files,
    gaps: result.profile.gaps,
    seed_count: result.seeds.length,
    seeds: result.seeds.slice(0, maxSeeds).map((seed) => ({
      kind: seed.seed_kind,
      text: seed.text,
      source_kind: seed.source_kind,
      source_ref: seed.source_ref,
      confidence: seed.confidence,
    })),
    seeds_truncated: result.seeds.length > maxSeeds,
  };

  // Fit the byte budget by shedding seeds from the tail; the histogram-level
  // fields are small and always kept.
  while (baseline.seeds.length > 0 && Buffer.byteLength(JSON.stringify(baseline), 'utf8') > maxBytes) {
    baseline.seeds.pop();
    baseline.seeds_truncated = true;
  }

  return baseline;
}
