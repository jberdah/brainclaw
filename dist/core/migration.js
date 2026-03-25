import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { memoryDir, memoryPath, readFileSync, writeFileAtomic, resolveEntityDir } from './io.js';
import { BootstrapApplicationReceiptSchema, BootstrapImportPlanDocumentSchema, AgentIdentityDocumentSchema, BootstrapProfileDocumentSchema, CandidateSchema, ClaimSchema, ConfigSchema, MemorySeedDocumentSchema, ConstraintSchema, CurrentSessionStateSchema, DecisionSchema, HandoffSchema, InstructionEntrySchema, PlanItemSchema, ProjectIdentityDocumentSchema, RuntimeNoteSchema, SessionSnapshotSchema, TrapSchema, AiSurfaceTaskRequestSchema, } from './schema.js';
export class MigrationError extends Error {
    kind;
    documentType;
    constructor(kind, message, documentType) {
        super(message);
        this.kind = kind;
        this.documentType = documentType;
        this.name = 'MigrationError';
    }
}
const CURRENT_SCHEMA_VERSION = 2;
const registry = {
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
    project_identity: createRegistryEntry(ProjectIdentityDocumentSchema),
    runtime_note: createRegistryEntry(RuntimeNoteSchema),
    ai_surface_task: createRegistryEntry(AiSurfaceTaskRequestSchema),
    session_snapshot: createRegistryEntry(SessionSnapshotSchema),
    trap: createRegistryEntry(TrapSchema),
};
function createRegistryEntry(schema) {
    return {
        currentVersion: CURRENT_SCHEMA_VERSION,
        schema,
        detectVersion: detectDocumentVersion,
        migrate(raw, fromVersion, toVersion) {
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
export function currentDocumentVersion(documentType) {
    return registry[documentType].currentVersion;
}
export function detectDocumentVersion(raw) {
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
export function migrateVersionedDocument(documentType, raw) {
    const entry = registry[documentType];
    const detectedVersion = entry.detectVersion(raw);
    if (detectedVersion > entry.currentVersion) {
        throw new MigrationError('unknown_version', `${documentType} uses unsupported schema version ${detectedVersion} (current ${entry.currentVersion})`, documentType);
    }
    let migratedRaw = raw;
    if (detectedVersion < entry.currentVersion) {
        try {
            migratedRaw = entry.migrate(raw, detectedVersion, entry.currentVersion);
        }
        catch (error) {
            throw new MigrationError('migration_failed', error instanceof Error ? error.message : String(error), documentType);
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
    }
    catch (error) {
        throw new MigrationError('validation_failed', error instanceof Error ? error.message : String(error), documentType);
    }
}
export function parseVersionedJsonDocumentFromString(documentType, rawText) {
    try {
        return migrateVersionedDocument(documentType, JSON.parse(rawText));
    }
    catch (error) {
        if (error instanceof MigrationError) {
            throw error;
        }
        throw new MigrationError('parse', error instanceof Error ? error.message : String(error), documentType);
    }
}
export function parseVersionedYamlDocumentFromString(documentType, rawText) {
    try {
        return migrateVersionedDocument(documentType, YAML.parse(rawText));
    }
    catch (error) {
        if (error instanceof MigrationError) {
            throw error;
        }
        throw new MigrationError('parse', error instanceof Error ? error.message : String(error), documentType);
    }
}
export function loadVersionedJsonFile(documentType, filepath) {
    return parseVersionedJsonDocumentFromString(documentType, readFileSync(filepath));
}
export function loadVersionedYamlFile(documentType, filepath) {
    return parseVersionedYamlDocumentFromString(documentType, readFileSync(filepath));
}
export function preparePersistedDocument(documentType, document) {
    return {
        ...(isRecord(document) ? document : {}),
        schema_version: currentDocumentVersion(documentType),
    };
}
export function saveVersionedJsonFile(documentType, filepath, document) {
    writeFileAtomic(filepath, `${JSON.stringify(preparePersistedDocument(documentType, document), null, 2)}\n`);
}
export function saveVersionedYamlFile(documentType, filepath, document) {
    const yaml = YAML.stringify(preparePersistedDocument(documentType, document), { lineWidth: 0 });
    writeFileAtomic(filepath, yaml);
}
export function scanMigrationStatus(cwd) {
    const baseDir = memoryDir(cwd);
    if (!fs.existsSync(baseDir)) {
        return [];
    }
    const entries = [];
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
    collectDirectory(entries, resolveEntityDir('inbox', effectiveCwd, 'read'), 'candidate');
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
function collectSingle(entries, filepath, documentType, format = 'json') {
    if (!fs.existsSync(filepath)) {
        return;
    }
    entries.push(buildCheckEntry(filepath, documentType, format));
}
function collectDirectory(entries, dirPath, documentType, recursive = false) {
    if (!fs.existsSync(dirPath)) {
        return;
    }
    for (const filepath of listJsonFiles(dirPath, recursive)) {
        entries.push(buildCheckEntry(filepath, documentType));
    }
}
function listJsonFiles(dirPath, recursive) {
    if (!fs.existsSync(dirPath)) {
        return [];
    }
    const files = [];
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
function buildCheckEntry(filepath, documentType, format = 'json') {
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
    }
    catch (error) {
        return {
            documentType,
            path: relativePath,
            status: 'invalid',
            currentVersion,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
function addSchemaVersion(raw, schemaVersion) {
    if (!isRecord(raw)) {
        throw new Error('document is not an object');
    }
    return { ...raw, schema_version: schemaVersion };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=migration.js.map