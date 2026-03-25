import type { InstructionLayer } from '../core/schema.js';
export interface ListInstructionsOptions {
    json?: boolean;
    layer?: InstructionLayer;
    project?: string;
    agent?: string;
    active?: boolean;
    resolved?: boolean;
    for?: string;
}
export declare function runListInstructions(options?: ListInstructionsOptions): void;
//# sourceMappingURL=list-instructions.d.ts.map