import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../io.js';

/**
 * Store schema version tracker — distinct from the MCP SCHEMA_VERSION
 * constant (which tracks what the *server* expects). This file tracks
 * what the *store* is currently at.
 *
 * Lives at `.brainclaw/schema-version.json`. Absent = implicit 0.6.0
 * (the pre-migration baseline).
 *
 * The history trail records every upgrade transition so an operator
 * can audit what ran, when, and which patches landed — useful when
 * dogfooding across two installations and comparing them.
 */

export const SCHEMA_VERSION_FILE = 'schema-version.json';

/** Implicit baseline when `.brainclaw/schema-version.json` is absent. */
export const IMPLICIT_BASELINE_VERSION = '0.6.0';

/** Target of a `--to=1.0` upgrade (migration-complete marker). */
export const V1_TARGET_SCHEMA_VERSION = '0.8.0';

export const SchemaVersionTransitionSchema = z.object({
  from: z.string(),
  to: z.string(),
  at: z.string().datetime(),
  patches: z.array(z.string()),
  reason: z.string().optional(),
});
export type SchemaVersionTransition = z.infer<typeof SchemaVersionTransitionSchema>;

export const SchemaVersionFileSchema = z.object({
  schema_version: z.literal(1),
  current: z.string(),
  history: z.array(SchemaVersionTransitionSchema),
});
export type SchemaVersionFile = z.infer<typeof SchemaVersionFileSchema>;

export interface ReadSchemaVersionResult {
  present: boolean;
  current: string;
  history: SchemaVersionTransition[];
}

export function schemaVersionFilePath(storePath: string): string {
  return path.join(storePath, SCHEMA_VERSION_FILE);
}

export function readSchemaVersion(storePath: string): ReadSchemaVersionResult {
  const file = schemaVersionFilePath(storePath);
  if (!fs.existsSync(file)) {
    return { present: false, current: IMPLICIT_BASELINE_VERSION, history: [] };
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const parsed = SchemaVersionFileSchema.parse(raw);
  return { present: true, current: parsed.current, history: parsed.history };
}

export interface BumpSchemaVersionOptions {
  storePath: string;
  to: string;
  patches: string[];
  reason?: string;
  now?: () => Date;
  dryRun?: boolean;
}

export interface BumpSchemaVersionResult {
  status: 'noop' | 'bumped' | 'planned';
  from: string;
  to: string;
  filePath: string;
  transitions: number;
}

/**
 * Record a schema-version transition. Idempotent — if the store is
 * already at the target version the call is a noop. Otherwise,
 * appends a transition entry to the history and writes the file
 * atomically.
 */
export function bumpSchemaVersion(options: BumpSchemaVersionOptions): BumpSchemaVersionResult {
  const now = (options.now ?? (() => new Date()))();
  const file = schemaVersionFilePath(options.storePath);
  const existing = readSchemaVersion(options.storePath);

  if (existing.current === options.to) {
    return {
      status: 'noop',
      from: existing.current,
      to: options.to,
      filePath: file,
      transitions: existing.history.length,
    };
  }

  if (options.dryRun) {
    return {
      status: 'planned',
      from: existing.current,
      to: options.to,
      filePath: file,
      transitions: existing.history.length + 1,
    };
  }

  const transition: SchemaVersionTransition = {
    from: existing.current,
    to: options.to,
    at: now.toISOString(),
    patches: options.patches,
    reason: options.reason,
  };

  const next: SchemaVersionFile = {
    schema_version: 1,
    current: options.to,
    history: [...existing.history, transition],
  };

  writeFileAtomic(file, JSON.stringify(next, null, 2));

  return {
    status: 'bumped',
    from: existing.current,
    to: options.to,
    filePath: file,
    transitions: next.history.length,
  };
}
