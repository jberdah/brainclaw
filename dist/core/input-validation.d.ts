import { z } from 'zod';
export declare const TEXT_MAX_LENGTH = 2000;
export declare const TAG_MAX_LENGTH = 50;
export declare const TAG_MAX_COUNT = 20;
export declare const TextInputSchema: z.ZodString;
export declare const TagArraySchema: z.ZodArray<z.ZodString, "many">;
export declare const TTL_PATTERN: RegExp;
export declare const TtlSchema: z.ZodString;
export interface ValidationError {
    field: string;
    message: string;
}
/**
 * Validate CLI mutation inputs. On failure: prints error and calls process.exit(1).
 */
export declare function validateCliInput(text: string, tags?: string[]): void;
/**
 * Validate CLI TTL argument. On failure: prints error and calls process.exit(1).
 */
export declare function validateCliTtl(ttl: string): void;
/**
 * Validate MCP mutation inputs. Returns { ok: true } or { ok: false, errors }.
 * Never calls process.exit — callers must handle the error response.
 */
export declare function validateMcpInput(text: string, tags?: string[]): {
    ok: true;
} | {
    ok: false;
    errors: ValidationError[];
};
/**
 * Validate a non-empty string field for MCP (scope, description, from, to).
 */
export declare function validateMcpField(value: string, fieldName: string): {
    ok: true;
} | {
    ok: false;
    message: string;
};
//# sourceMappingURL=input-validation.d.ts.map