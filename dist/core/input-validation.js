import { z } from 'zod';
export const TEXT_MAX_LENGTH = 2000;
export const TAG_MAX_LENGTH = 50;
export const TAG_MAX_COUNT = 20;
export const TextInputSchema = z.string().min(1, 'Text cannot be empty').max(TEXT_MAX_LENGTH, `Text cannot exceed ${TEXT_MAX_LENGTH} characters`);
export const TagArraySchema = z
    .array(z.string().min(1, 'Tag cannot be empty').max(TAG_MAX_LENGTH, `Tag cannot exceed ${TAG_MAX_LENGTH} characters`))
    .max(TAG_MAX_COUNT, `Cannot have more than ${TAG_MAX_COUNT} tags`);
export const TTL_PATTERN = /^(\d+)([mhd])$/;
export const TtlSchema = z
    .string()
    .regex(TTL_PATTERN, 'Invalid TTL format. Use <number><unit> where unit is m (minutes), h (hours), or d (days). Example: 30m, 2h, 7d');
function formatZodError(error, field) {
    return error.errors.map((e) => ({ field, message: e.message }));
}
/**
 * Validate CLI mutation inputs. On failure: prints error and calls process.exit(1).
 */
export function validateCliInput(text, tags) {
    const errors = [];
    const textResult = TextInputSchema.safeParse(text);
    if (!textResult.success) {
        errors.push(...formatZodError(textResult.error, 'text'));
    }
    if (tags !== undefined && tags.length > 0) {
        const tagsResult = TagArraySchema.safeParse(tags);
        if (!tagsResult.success) {
            errors.push(...formatZodError(tagsResult.error, 'tags'));
        }
    }
    if (errors.length > 0) {
        for (const e of errors) {
            console.error(`Error: ${e.message}`);
        }
        process.exit(1);
    }
}
/**
 * Validate CLI TTL argument. On failure: prints error and calls process.exit(1).
 */
export function validateCliTtl(ttl) {
    const result = TtlSchema.safeParse(ttl);
    if (!result.success) {
        console.error(`Error: ${result.error.errors[0]?.message ?? 'Invalid TTL'}`);
        process.exit(1);
    }
}
/**
 * Validate MCP mutation inputs. Returns { ok: true } or { ok: false, errors }.
 * Never calls process.exit — callers must handle the error response.
 */
export function validateMcpInput(text, tags) {
    const errors = [];
    const textResult = TextInputSchema.safeParse(text);
    if (!textResult.success) {
        errors.push(...formatZodError(textResult.error, 'text'));
    }
    if (tags !== undefined && tags.length > 0) {
        const tagsResult = TagArraySchema.safeParse(tags);
        if (!tagsResult.success) {
            errors.push(...formatZodError(tagsResult.error, 'tags'));
        }
    }
    if (errors.length > 0) {
        return { ok: false, errors };
    }
    return { ok: true };
}
/**
 * Validate a non-empty string field for MCP (scope, description, from, to).
 */
export function validateMcpField(value, fieldName) {
    if (!value.trim()) {
        return { ok: false, message: `${fieldName} cannot be empty` };
    }
    if (value.length > TEXT_MAX_LENGTH) {
        return { ok: false, message: `${fieldName} cannot exceed ${TEXT_MAX_LENGTH} characters` };
    }
    return { ok: true };
}
//# sourceMappingURL=input-validation.js.map