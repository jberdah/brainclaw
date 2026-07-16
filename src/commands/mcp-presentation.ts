/**
 * MCP presentation — renderers that turn built context objects into the
 * strings served over the MCP surface.
 *
 * Extracted from mcp.ts (pln#622 PR1). Importing core/ here is the
 * legitimate downward direction (commands → core); this module must not
 * import mcp.js (assembly point) — enforced by
 * tests/unit/mcp-dependency-direction.test.ts.
 *
 * @module
 */
import { buildContext, renderContextMarkdown, renderContextPromptTemplate, renderContextBriefing } from '../core/context.js';
import type { ContextFormat } from './mcp-contract.js';

export function renderContextForMcp(
  result: ReturnType<typeof buildContext>,
  format: ContextFormat,
  options: { explain?: boolean; compactTemplate?: boolean },
): string {
  // Briefing profile always uses its own ultra-compact renderer
  if (result.profile === 'briefing') {
    return renderContextBriefing(result);
  }
  if (format === 'json') {
    return JSON.stringify(result, null, 2);
  }
  if (format === 'template') {
    const compact = options.compactTemplate || result.profile === 'openclaw';
    return renderContextPromptTemplate(result, compact);
  }
  return renderContextMarkdown(result, options.explain);
}
