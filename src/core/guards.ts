/**
 * Shared guard utilities for CLI commands.
 *
 * These replace the duplicated memoryExists + process.exit(1) pattern
 * found across 70+ command files.
 *
 * @module
 */

import { memoryExists } from './io.js';

/**
 * Abort the CLI process if .brainclaw/ is not found at the given path.
 */
export function requireInitialized(cwd: string): void {
  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }
}
