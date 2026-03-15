import type { Config, State } from './schema.js';

export interface SecurityWarning {
  level: 'warn' | 'block';
  message: string;
}

/**
 * Scan a text string for sensitive patterns defined in the config.
 * Returns a list of warnings.
 */
export function scanText(text: string, config: Config): SecurityWarning[] {
  const warnings: SecurityWarning[] = [];
  if (!config.redaction.enabled) return warnings;

  const isStrict = config.security?.strict_redaction ?? false;
  const level = isStrict ? 'block' : 'warn';

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
      const item = section.items[i];
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
