import { type StoreTarget } from '../core/store-resolution.js';
import type { ConstraintStatus, HandoffStatus, TrapStatus } from '../core/schema.js';
import { type ConstraintOptions } from './constraint.js';
import { type DecisionOptions } from './decision.js';
import { type TrapOptions } from './trap.js';
type MemoryKind = 'decision' | 'constraint' | 'trap' | 'handoff';
export interface MemoryCommandOptions extends DecisionOptions, ConstraintOptions, Omit<TrapOptions, 'status'> {
    json?: boolean;
    type?: MemoryKind;
    text?: string;
    status?: ConstraintStatus | HandoffStatus | TrapStatus;
    project?: string;
    from?: string;
    to?: string;
    captureDiff?: boolean;
    store?: StoreTarget;
    cwd?: string;
}
export declare function runMemoryCommand(subcommand: string, args: string[], options?: MemoryCommandOptions): void;
export {};
//# sourceMappingURL=memory.d.ts.map