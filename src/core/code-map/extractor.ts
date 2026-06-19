/**
 * Code Map extractor — THIN backward-compat surface (spec §3, §9 cutover).
 *
 * P1a cutover (Sprint 4): the legacy 540-line imperative extractor has been
 * replaced by the query-driven provider pipeline. The real `extractFile` now
 * lives on the CORE (`core.ts` → registry → provider.extractDraft → refine →
 * finalize). This module keeps the historical import surface stable:
 *
 *  - `extractFile`            re-exported from `core.ts` (provider pipeline).
 *  - `ExtractInput` / `ExtractResult`  the public extraction shapes (owned here so
 *                            `core.ts`, `finalizer.ts`, and the oracle tests keep
 *                            importing them from this module).
 *  - `hashContent`           sha256 of file contents (used by refresh.ts + query.ts).
 *
 * The legacy imperative bodies (handleFunctionDeclaration / handleClassDeclaration
 * / classifySubtype / returnsJsx / handleImport / markOrAddExport / …) are GONE.
 * The oracle (`oracle.test.ts`) now exercises this re-export and so doubles as a
 * provider-path regression guard against the frozen `oracle-golden.json`.
 */
import crypto from 'node:crypto';
import type { CodeEdge, CodeLang, CodeNode } from './types.js';

export interface ExtractInput {
  projectId: string;
  /** Normalized POSIX relative path (store identity). */
  path: string;
  lang: CodeLang;
  source: string;
  sizeBytes: number;
  maxParseFileBytes: number;
  /** Bounds parse + query execution (NOT refine/finalize); from extractor config. */
  maxQueryWaitMs?: number;
}

export interface ExtractResult {
  parseStatus: 'parsed' | 'skipped_too_large' | 'parse_error' | 'skipped_unsupported';
  nodes: CodeNode[];
  edges: CodeEdge[];
  diagnostics: Array<Record<string, unknown>>;
}

// The query-driven CORE entrypoint, re-exported under the historical name so all
// existing importers (refresh.ts, oracle.test.ts, …) keep resolving `extractFile`
// here. core.ts imports the types above (type-only → erased, so no runtime cycle).
export { extractFile } from './core.js';

/** sha256 of file contents (file_hash on the shard). */
export function hashContent(source: string): string {
  return `sha256:${crypto.createHash('sha256').update(source, 'utf-8').digest('hex')}`;
}
