import fs from 'node:fs';
import path from 'node:path';
import type { ZodType, ZodTypeDef } from 'zod';
import YAML from 'yaml';
import { memoryDir, memoryPath, readFileSync, writeFileAtomic, resolveEntityDir } from './io.js';
import {
  BootstrapApplicationReceiptSchema,
  BootstrapImportPlanDocumentSchema,
  AgentIdentityDocumentSchema,
  BootstrapProfileDocumentSchema,
  CandidateSchema,
  ClaimSchema,
  ConfigSchema,
  MemorySeedDocumentSchema,
  ConstraintSchema,
  CurrentSessionStateSchema,
  DecisionSchema,
  HandoffSchema,
  InstructionEntrySchema,
  PlanItemSchema,
  SequenceSchema,
  ProjectIdentityDocumentSchema,
  RuntimeNoteSchema,
  SessionSnapshotSchema,
  TrapSchema,
  AiSurfaceTaskRequestSchema,
  ProjectCapabilitySchema,
  ProjectToolSchema,
  InboxMessageSchema,
} from './schema.js';

export type VersionedDocumentType =
  | 'agent_identity'
  | 'bootstrap_application'
  | 'bootstrap_import_plan'
  | 'bootstrap_profile'
  | 'candidate'
  | 'claim'
  | 'config'
  | 'constraint'
  | 'current_session'
  | 'decision'
  | 'handoff'
  | 'instruction'
  | 'memory_seed'
  | 'plan'
  | 'sequence'
  | 'project_identity'
  | 'runtime_note'
  | 'ai_surface_task'
  | 'session_snapshot'
  | 'capability'
  | 'tool'
  | 'trap'
  | 'message';

export type MigrationErrorKind =
  | 'parse'
  | 'unknown_version'
  | 'migration_failed'
  | 'validation_failed';

export class MigrationError extends Error {
  constructor(
    public readonly kind: MigrationErrorKind,
    message: string,
    public readonly documentType: VersionedDocumentType,
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

export interface MigrationMetadata {
  detectedVersion: number;
  currentVersion: number;
  migrated: boolean;
}

export interface MigrationResult<T> {
  document: T;
  metadata: MigrationMetadata;
}

export interface MigrationCheckEntry {
  documentType: VersionedDocumentType;
  path: string;
  status: 'ok' | 'outdated' | 'invalid';
  detectedVersion?: number;
  currentVersion: number;
  error?: string;
}

interface MigrationRegistryEntry<T> {
  currentVersion: number;
  schema: ZodType<T, ZodTypeDef, unknown>;
  detectVersion: (raw: unknown) => number;
  migrate: (raw: unknown, fromVersion: number, toVersion: number) => unknown;
}

const CURRENT_SCHEMA_VERSION = 2;
const NON_MESSAGE_INBOX_SUBDIRS = new Set(['accepted', 'rejected', 'cross-project']);

const registry: Record<VersionedDocumentType, MigrationRegistryEntry<unknown>> = {
  agent_identity: createRegistryEntry(AgentIdentityDocumentSchema),
  bootstrap_application: createRegistryEntry(BootstrapApplicationReceiptSchema),
  bootstrap_import_plan: createRegistryEntry(BootstrapImportPlanDocumentSchema),
  bootstrap_profile: createRegistryEntry(BootstrapProfileDocumentSchema),
  candidate: createRegistryEntry(CandidateSchema),
  claim: createRegistryEntry(ClaimSchema),
  config: createRegistryEntry(ConfigSchema),
  constraint: createRegistryEntry(ConstraintSchema),
  current_session: createRegistryEntry(CurrentSessionStateSchema),
  decision: createRegistryEntry(DecisionSchema),
  handoff: createRegistryEntry(HandoffSchema),
  instruction: createRegistryEntry(InstructionEntrySchema),
  memory_seed: createRegistryEntry(MemorySeedDocumentSchema),
  plan: createRegistryEntry(PlanItemSchema),
  sequence: createRegistryEntry(SequenceSchema),
  project_identity: createRegistryEntry(ProjectIdentityDocumentSchema),
  runtime_note: createRegistryEntry(RuntimeNoteSchema),
  ai_surface_task: createRegistryEntry(AiSurfaceTaskRequestSchema),
  session_snapshot: createRegistryEntry(SessionSnapshotSchema),
  capability: createRegistryEntry(ProjectCapabilitySchema),
  tool: createRegistryEntry(ProjectToolSchema),
  trap: createRegistryEntry(TrapSchema),
  message: createRegistryEntry(InboxMessageSchema),
};

function createRegistryEntry<T>(schema: ZodType<T, ZodTypeDef, unknown>): MigrationRegistryEntry<T> {
  return {
    currentVersion: CURRENT_SCHEMA_VERSION,
    schema,
    detectVersion: detectDocumentVersion,
    migrate(raw: unknown, fromVersion: number, toVersion: number): unknown {
      let current = raw;
      for (let version = fromVersion; version < toVersion; version += 1) {
        if (version === 1) {
          current = addSchemaVersion(current, version + 1);
          continue;
        }
        throw new Error(`No migration path from v${version} to v${version + 1}`);
      }
      return current;
    },
  };
}

export function currentDocumentVersion(documentType: VersionedDocumentType): number {
  return registry[documentType].currentVersion;
}

export function detectDocumentVersion(raw: unknown): number {
  if (!isRecord(raw)) {
    return 1;
  }
  if (typeof raw.schema_version === 'number' && Number.isFinite(raw.schema_version)) {
    return raw.schema_version;
  }
  if (typeof raw.version === 'number' && Number.isFinite(raw.version)) {
    return raw.version;
  }
  return 1;
}

export function migrateVersionedDocument<T>(
  documentType: VersionedDocumentType,
  raw: unknown,
): MigrationResult<T> {
  const entry = registry[documentType] as MigrationRegistryEntry<T>;
  const detectedVersion = entry.detectVersion(raw);
  if (detectedVersion > entry.currentVersion) {
    throw new MigrationError(
      'unknown_version',
      `${documentType} uses unsupported schema version ${detectedVersion} (current ${entry.currentVersion})`,
      documentType,
    );
  }

  let migratedRaw = raw;
  if (detectedVersion < entry.currentVersion) {
    try {
      migratedRaw = entry.migrate(raw, detectedVersion, entry.currentVersion);
    } catch (error: unknown) {
      throw new MigrationError(
        'migration_failed',
        error instanceof Error ? error.message : String(error),
        documentType,
      );
    }
  }

  try {
    return {
      document: entry.schema.parse(migratedRaw),
      metadata: {
        detectedVersion,
        currentVersion: entry.currentVersion,
        migrated: detectedVersion < entry.currentVersion,
      },
    };
  } catch (error: unknown) {
    throw new MigrationError(
      'validation_failed',
      error instanceof Error ? error.message : String(error),
      documentType,
    );
  }
}

export function parseVersionedJsonDocumentFromString<T>(
  documentType: VersionedDocumentType,
  rawText: string,
): MigrationResult<T> {
  try {
    return migrateVersionedDocument<T>(documentType, JSON.parse(rawText));
  } catch (error: unknown) {
    if (error instanceof MigrationError) {
      throw error;
    }
    throw new MigrationError('parse', error instanceof Error ? error.message : String(error), documentType);
  }
}

export function parseVersionedYamlDocumentFromString<T>(
  documentType: VersionedDocumentType,
  rawText: string,
): MigrationResult<T> {
  try {
    return migrateVersionedDocument<T>(documentType, YAML.parse(rawText));
  } catch (error: unknown) {
    if (error instanceof MigrationError) {
      throw error;
    }
    throw new MigrationError('parse', error instanceof Error ? error.message : String(error), documentType);
  }
}

export function loadVersionedJsonFile<T>(documentType: VersionedDocumentType, filepath: string): MigrationResult<T> {
  return parseVersionedJsonDocumentFromString<T>(documentType, readFileSync(filepath));
}

export function loadVersionedYamlFile<T>(documentType: VersionedDocumentType, filepath: string): MigrationResult<T> {
  return parseVersionedYamlDocumentFromString<T>(documentType, readFileSync(filepath));
}

export function preparePersistedDocument<T>(documentType: VersionedDocumentType, document: T): T {
  return {
    ...(isRecord(document) ? document : {}),
    schema_version: currentDocumentVersion(documentType),
  } as T;
}

export function saveVersionedJsonFile<T>(documentType: VersionedDocumentType, filepath: string, document: T): void {
  writeFileAtomic(filepath, `${JSON.stringify(preparePersistedDocument(documentType, document), null, 2)}\n`);
}

export function saveVersionedYamlFile<T>(documentType: VersionedDocumentType, filepath: string, document: T): void {
  const yaml = YAML.stringify(preparePersistedDocument(documentType, document), { lineWidth: 0 });
  writeFileAtomic(filepath, yaml);
}

export function scanMigrationStatus(cwd?: string): MigrationCheckEntry[] {
  const baseDir = memoryDir(cwd);
  if (!fs.existsSync(baseDir)) {
    return [];
  }

  const entries: MigrationCheckEntry[] = [];
  collectSingle(entries, memoryPath('config.yaml', cwd), 'config', 'yaml');
  collectSingle(entries, memoryPath('project.identity.json', cwd), 'project_identity');
  collectSingle(entries, memoryPath('.current-session', cwd), 'current_session');
  collectSingle(entries, memoryPath(path.join('bootstrap', 'profile.json'), cwd), 'bootstrap_profile');
  collectSingle(entries, memoryPath(path.join('bootstrap', 'import-plan.json'), cwd), 'bootstrap_import_plan');
  collectSingle(entries, memoryPath(path.join('bootstrap', 'last-application.json'), cwd), 'bootstrap_application');

  const effectiveCwd = cwd ?? process.cwd();
  collectDirectory(entries, resolveEntityDir('constraints', effectiveCwd, 'read'), 'constraint');
  collectDirectory(entries, resolveEntityDir('decisions', effectiveCwd, 'read'), 'decision');
  collectDirectory(entries, resolveEntityDir('traps', effectiveCwd, 'read'), 'trap');
  collectDirectory(entries, resolveEntityDir('traps-hosts', effectiveCwd, 'read'), 'trap', true);
  collectDirectory(entries, resolveEntityDir('traps-private', effectiveCwd, 'read'), 'trap', true);
  collectDirectory(entries, resolveEntityDir('handoffs', effectiveCwd, 'read'), 'handoff');
  collectDirectory(entries, resolveEntityDir('plans', effectiveCwd, 'read'), 'plan');
  collectDirectory(entries, resolveEntityDir('sequences', effectiveCwd, 'read'), 'sequence');
  collectDirectory(entries, resolveEntityDir('inbox', effectiveCwd, 'read'), 'candidate');
  collectInboxMessages(entries, resolveEntityDir('inbox', effectiveCwd, 'read'));
  collectDirectory(entries, resolveEntityDir('inbox/accepted', effectiveCwd, 'read'), 'candidate');
  collectDirectory(entries, resolveEntityDir('inbox/rejected', effectiveCwd, 'read'), 'candidate');
  collectDirectory(entries, resolveEntityDir('claims', effectiveCwd, 'read'), 'claim');
  collectDirectory(entries, resolveEntityDir('runtime', effectiveCwd, 'read'), 'runtime_note', true);
  collectDirectory(entries, resolveEntityDir('runtime-hosts', effectiveCwd, 'read'), 'runtime_note', true);
  collectDirectory(entries, resolveEntityDir('runtime-private', effectiveCwd, 'read'), 'runtime_note', true);
  collectDirectory(entries, resolveEntityDir('surface-tasks', effectiveCwd, 'read'), 'ai_surface_task');
  collectDirectory(entries, resolveEntityDir('instructions', effectiveCwd, 'read'), 'instruction');
  collectDirectory(entries, path.join(resolveEntityDir('bootstrap', effectiveCwd, 'read'), 'seeds'), 'memory_seed');
  collectDirectory(entries, resolveEntityDir('agents', effectiveCwd, 'read'), 'agent_identity');
  collectDirectory(entries, resolveEntityDir('sessions', effectiveCwd, 'read'), 'session_snapshot');

  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function collectSingle(
  entries: MigrationCheckEntry[],
  filepath: string,
  documentType: VersionedDocumentType,
  format: 'json' | 'yaml' = 'json',
): void {
  if (!fs.existsSync(filepath)) {
    return;
  }
  entries.push(buildCheckEntry(filepath, documentType, format));
}

function collectDirectory(
  entries: MigrationCheckEntry[],
  dirPath: string,
  documentType: VersionedDocumentType,
  recursive = false,
): void {
  if (!fs.existsSync(dirPath)) {
    return;
  }
  for (const filepath of listJsonFiles(dirPath, recursive)) {
    entries.push(buildCheckEntry(filepath, documentType));
  }
}

function collectInboxMessages(entries: MigrationCheckEntry[], inboxRoot: string): void {
  if (!fs.existsSync(inboxRoot)) {
    return;
  }

  for (const entry of fs.readdirSync(inboxRoot).sort()) {
    const fullPath = path.join(inboxRoot, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    if (!stat.isDirectory() || NON_MESSAGE_INBOX_SUBDIRS.has(entry)) {
      continue;
    }

    for (const filepath of listJsonFiles(fullPath, true)) {
      entries.push(buildCheckEntry(filepath, 'message'));
    }
  }
}

function listJsonFiles(dirPath: string, recursive: boolean): string[] {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  const files: string[] = [];
  for (const entry of fs.readdirSync(dirPath).sort()) {
    const fullPath = path.join(dirPath, entry);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (recursive) {
        files.push(...listJsonFiles(fullPath, true));
      }
      continue;
    }
    if (entry.endsWith('.json')) {
      files.push(fullPath);
    }
  }
  return files;
}

function buildCheckEntry(
  filepath: string,
  documentType: VersionedDocumentType,
  format: 'json' | 'yaml' = 'json',
): MigrationCheckEntry {
  const relativePath = path.relative(process.cwd(), filepath).replace(/\\/g, '/');
  const currentVersion = currentDocumentVersion(documentType);

  try {
    const rawText = readFileSync(filepath);
    const rawValue = format === 'yaml' ? YAML.parse(rawText) : JSON.parse(rawText);
    const detectedVersion = detectDocumentVersion(rawValue);
    if (detectedVersion > currentVersion) {
      return {
        documentType,
        path: relativePath,
        status: 'invalid',
        detectedVersion,
        currentVersion,
        error: `unsupported schema version ${detectedVersion}`,
      };
    }
    return {
      documentType,
      path: relativePath,
      status: detectedVersion < currentVersion ? 'outdated' : 'ok',
      detectedVersion,
      currentVersion,
    };
  } catch (error: unknown) {
    return {
      documentType,
      path: relativePath,
      status: 'invalid',
      currentVersion,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function addSchemaVersion(raw: unknown, schemaVersion: number): unknown {
  if (!isRecord(raw)) {
    throw new Error('document is not an object');
  }
  return { ...raw, schema_version: schemaVersion };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
