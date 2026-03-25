/** Generate a concurrence-safe prefixed ID using 4 random bytes. */
export declare function generateId(section: string): string;
/**
 * Atomically increment the per-prefix counter and return the next short label.
 * Best-effort: if the counter file is unavailable the call still succeeds.
 */
export declare function getNextShortLabel(prefix: string, cwd?: string): string;
/**
 * Generate both a concurrence-safe hash ID and a human-readable short label.
 * The hash ID is the canonical storage key; the short label is for display and aliased lookups.
 */
export declare function generateIdWithLabel(section: string, cwd?: string): {
    id: string;
    short_label: string;
};
export declare function nowISO(): string;
//# sourceMappingURL=ids.d.ts.map