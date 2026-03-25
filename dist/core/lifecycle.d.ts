export type TriggeredItemType = 'trap' | 'constraint' | 'decision' | 'instruction';
export interface TriggeredItem {
    type: TriggeredItemType;
    id: string;
    text: string;
}
/**
 * Returns all memory items tagged with the given trigger tag.
 * Supports: traps, constraints, decisions, instructions.
 *
 * Convention: trigger tags take the form "trigger:<event>"
 * e.g. "trigger:post-claim", "trigger:pre-session-end", "trigger:post-session-start"
 */
export declare function getTriggeredItems(tag: string, cwd?: string): TriggeredItem[];
/**
 * Renders triggered items as a text block for inclusion in MCP responses.
 * Returns empty string if no items found.
 */
export declare function renderTriggeredItems(items: TriggeredItem[]): string;
//# sourceMappingURL=lifecycle.d.ts.map