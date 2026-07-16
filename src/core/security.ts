import type { Config, State } from './schema.js';
import { maskSecret, runEntropyDetector, runStructuralDetectors } from './security-detectors.js';

export interface SecurityWarning {
  level: 'warn' | 'block';
  message: string;
}

/**
 * Scan a text string for sensitive content. Four independent signal layers
 * run, each with its own enable-gate (S4 semantics, pln#623):
 *
 *   1. Redaction patterns — user-configured regexes from
 *      `config.redaction.patterns`. Gate: `config.redaction.enabled` (whole
 *      scan short-circuits off when false). The legacy MVP behavior.
 *   2. Structural detectors — exact token shapes for GitHub PATs, AWS access
 *      keys, JWTs, etc. High precision. Gate: `security.token_detection.enabled`
 *      (default on); individual detectors via `token_detection.detectors[id]`.
 *   3. Entropy detector — high-Shannon-entropy token-like substrings near a
 *      secret keyword. Gate: `security.token_detection.entropy.enabled` (nested
 *      under the token_detection gate; default on).
 *   4. Sensitive paths — literal mentions of `config.sensitive_paths` entries
 *      (`.env`, `secrets/`, …). Gate: `security.block_sensitive_paths` (default
 *      on).
 *
 * LEVEL (uniform across ALL four layers): a match surfaces as `warn`, and
 * escalates to `block` when `security.strict_redaction` is true (mode: strict).
 * Strict mode blocks every signal uniformly — there is no per-layer level
 * override. Detected/redacted excerpts in messages are always irreversibly
 * masked (see maskSecret); the redaction pattern itself is referenced by index
 * and masked, never echoed.
 */
export function scanText(text: string, config: Config): SecurityWarning[] {
  const warnings: SecurityWarning[] = [];
  if (!config.redaction.enabled) return warnings;

  const isStrict = config.security?.strict_redaction ?? false;
  const level: 'warn' | 'block' = isStrict ? 'block' : 'warn';

  for (const [i, pattern] of config.redaction.patterns.entries()) {
    try {
      // Strip Python-style inline flags (?i) etc. since we always use 'i' flag
      const cleanPattern = pattern.replace(/^\(\?[gimsuy]+\)/g, '');
      const re = new RegExp(cleanPattern, 'i');
      if (re.test(text)) {
        warnings.push({
          level,
          // The configured pattern may itself be a literal secret value, so
          // it is referenced by index and masked, never echoed verbatim.
          message: `Possible sensitive content matching redaction pattern #${i} ('${maskSecret(pattern)}') found in text`,
        });
      }
    } catch {
      // skip invalid regex patterns
    }
  }

  // Structural detectors — only run when token_detection is enabled.
  const td = config.security?.token_detection;
  if (td?.enabled !== false) {
    const disabled = td?.detectors;
    for (const m of runStructuralDetectors(text, disabled)) {
      warnings.push({
        level,
        message: `${m.label} (id=${m.detectorId}) detected: ${m.excerpt}`,
      });
    }

    if (td?.entropy?.enabled !== false) {
      const entropyMatches = runEntropyDetector(text, {
        enabled: td?.entropy?.enabled ?? true,
        minLength: td?.entropy?.min_length,
        minEntropy: td?.entropy?.min_entropy,
      });
      for (const m of entropyMatches) {
        warnings.push({
          level,
          message: `High-entropy token-shaped substring near a secret keyword (entropy=${m.entropy}): ${m.excerpt}`,
        });
      }
    }
  }

  const blockPaths = config.security?.block_sensitive_paths ?? true;
  if (blockPaths) {
    for (const sp of config.sensitive_paths) {
      if (text.includes(sp)) {
        warnings.push({
          // S3 (pln#623): the level is config-derived, not hardcoded. Like the
          // three detector layers above, a sensitive-path match surfaces as a
          // `warn` normally and escalates to `block` under strict_redaction —
          // strict mode blocks EVERY signal, uniformly. `block_sensitive_paths`
          // remains the enable-gate for this layer (default on).
          level,
          message: `Sensitive path '${sp}' mentioned in text`,
        });
      }
    }
  }

  return warnings;
}

/**
 * Run doctor checks on the full state.
 */
export function doctorCheck(state: State, config: Config): SecurityWarning[] {
  const warnings: SecurityWarning[] = [];

  const sections = [
    { name: 'active_constraints', items: state.active_constraints },
    { name: 'recent_decisions', items: state.recent_decisions },
    { name: 'known_traps', items: state.known_traps },
    { name: 'open_handoffs', items: state.open_handoffs },
  ] as const;

  for (const section of sections) {
    for (let i = 0; i < section.items.length; i++) {
      const item = section.items[i]!;
      const text = 'text' in item ? item.text : '';
      const textWarnings = scanText(text, config);
      for (const w of textWarnings) {
        warnings.push({
          level: w.level,
          message: `${w.message} in ${section.name}[${i}] (${item.id})`,
        });
      }
    }
  }

  return warnings;
}
