import type { Config, State } from './schema.js';
import { runEntropyDetector, runStructuralDetectors } from './security-detectors.js';

export interface SecurityWarning {
  level: 'warn' | 'block';
  message: string;
}

/**
 * Scan a text string for sensitive content. Three signal layers run:
 *   1. User-configured regex patterns from `config.redaction.patterns`
 *      (the legacy MVP behavior).
 *   2. Structural detectors — exact token shapes for GitHub PATs, AWS
 *      access keys, JWTs, etc. High precision; on by default.
 *   3. Entropy detector — flags high-entropy token-like substrings near
 *      a sensitive keyword. Tunable, on by default.
 *
 * In strict mode all signals escalate to `block`; otherwise `warn`.
 */
export function scanText(text: string, config: Config): SecurityWarning[] {
  const warnings: SecurityWarning[] = [];
  if (!config.redaction.enabled) return warnings;

  const isStrict = config.security?.strict_redaction ?? false;
  const level: 'warn' | 'block' = isStrict ? 'block' : 'warn';

  for (const pattern of config.redaction.patterns) {
    try {
      // Strip Python-style inline flags (?i) etc. since we always use 'i' flag
      const cleanPattern = pattern.replace(/^\(\?[gimsuy]+\)/g, '');
      const re = new RegExp(cleanPattern, 'i');
      if (re.test(text)) {
        warnings.push({
          level,
          message: `Possible sensitive content matching pattern '${pattern}' found in text`,
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
          level: 'warn',
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
