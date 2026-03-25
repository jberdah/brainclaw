import type { HandoffStatus } from '../core/schema.js';
export interface UpdateHandoffOptions {
    status?: HandoffStatus;
    to?: string;
}
export declare function runUpdateHandoff(id: string, options?: UpdateHandoffOptions): void;
//# sourceMappingURL=update-handoff.d.ts.map