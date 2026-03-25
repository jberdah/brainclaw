import type { Config, State } from './schema.js';
export interface SecurityWarning {
    level: 'warn' | 'block';
    message: string;
}
/**
 * Scan a text string for sensitive patterns defined in the config.
 * Returns a list of warnings.
 */
export declare function scanText(text: string, config: Config): SecurityWarning[];
/**
 * Run doctor checks on the full state.
 */
export declare function doctorCheck(state: State, config: Config): SecurityWarning[];
//# sourceMappingURL=security.d.ts.map