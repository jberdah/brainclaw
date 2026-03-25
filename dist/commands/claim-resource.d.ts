import { type ClaimOptions } from './claim.js';
import { type ReleaseClaimOptions } from './release-claim.js';
interface ClaimResourceOptions extends ClaimOptions, ReleaseClaimOptions {
    json?: boolean;
    all?: boolean;
}
export declare function runClaimResource(subcommand: string, args: string[], options: ClaimResourceOptions): void;
export {};
//# sourceMappingURL=claim-resource.d.ts.map