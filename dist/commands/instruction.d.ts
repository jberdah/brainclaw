import { type StoreTarget } from '../core/store-resolution.js';
import type { InstructionLayer } from '../core/schema.js';
export interface InstructionOptions {
    layer?: InstructionLayer;
    project?: string;
    agent?: string;
    tag?: string[];
    author?: string;
    supersedes?: string;
    cwd?: string;
    store?: StoreTarget;
}
export declare function runInstruction(text: string, options?: InstructionOptions): void;
//# sourceMappingURL=instruction.d.ts.map