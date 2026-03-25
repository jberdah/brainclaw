import type { State } from './schema.js';
export declare function generateMarkdown(state: State, cwd?: string): string;
/**
 * Rebuild `.brainclaw/project.md` from canonical state.
 *
 * This is a **derived view** — it can always be regenerated from the
 * canonical JSON files. Call this once at the end of a top-level mutation,
 * not inside every nested helper. Best-effort: failures are logged but
 * never propagate to the caller.
 */
export declare function rebuildProjectMd(state: State, cwd?: string): void;
//# sourceMappingURL=markdown.d.ts.map