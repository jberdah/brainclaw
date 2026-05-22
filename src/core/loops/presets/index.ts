import { BOOTSTRAP_PRESET, type LoopPreset } from './bootstrap.js';

/**
 * pln#511 step 2 — loop preset registry.
 *
 * The bclaw_coordinate(intent='ideate') handler resolves a caller-supplied
 * `preset` string against this map. Adding a new preset is a one-line
 * change here (plus the preset module itself). The handler intentionally
 * does not import individual presets — only this registry — so unknown
 * names produce a deterministic `unknown_preset` error referencing the
 * keys exported from this file.
 */
export const PRESETS: Readonly<Record<string, LoopPreset>> = Object.freeze({
  bootstrap: BOOTSTRAP_PRESET,
});

export type PresetName = keyof typeof PRESETS;

export { BOOTSTRAP_PRESET, type LoopPreset };
