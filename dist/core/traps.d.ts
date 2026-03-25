import { type MemoryVisibility, type Trap } from './schema.js';
export interface TrapListOptions {
    visibility?: Extract<MemoryVisibility, 'machine' | 'private'> | 'all';
    hostId?: string;
    includeAllHosts?: boolean;
}
export declare function isTrapExpired(trap: Trap, nowIso?: string): boolean;
export declare function isTrapActive(trap: Trap, nowIso?: string): boolean;
export declare function listOperationalTraps(options?: TrapListOptions, cwd?: string): Trap[];
export declare function saveOperationalTrap(trap: Trap, cwd?: string): void;
export declare function generateTrapId(): string;
export declare function generateTrapIdWithLabel(cwd?: string): {
    id: string;
    short_label: string;
};
//# sourceMappingURL=traps.d.ts.map