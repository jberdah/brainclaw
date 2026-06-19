// §10: oversized file — the test drives this fixture with sizeBytes far above
// maxParseFileBytes so the legacy extractor returns skipped_too_large (a single
// file node, a diagnostic, NO symbol extraction). The body is irrelevant: the
// oversized branch short-circuits before the source is ever parsed.
export function neverParsed(): void {}
