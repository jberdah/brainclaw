import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { memoryExists, resolveEntityDir } from '../core/io.js';
import { loadVersionedJsonFile, saveVersionedJsonFile } from '../core/migration.js';
import { buildOperationalIdentity, saveCurrentSession } from '../core/identity.js';
import { requireMinimumTrustLevel, requireRegisteredAgentIdentity, resolveCurrentModel } from '../core/agent-registry.js';
import { buildContext } from '../core/context.js';
import { saveRuntimeNote, generateRuntimeNoteId } from '../core/runtime.js';
import { nowISO, generateId } from '../core/ids.js';
import { appendAuditEntry } from '../core/audit.js';
import { SessionSnapshotSchema, type SessionSnapshot } from '../core/schema.js';
import { auditLocalAgentWorkspaceFiles } from '../core/agent-files.js';
import { buildAgentInventory, loadAgentInventory, saveAgentInventory, diffInventory } from '../core/agent-inventory.js';

function sessionsDir(cwd?: string): string {
  return resolveEntityDir('sessions', cwd ?? process.cwd(), 'read');
}

function sessionSnapshotPath(sessionId: string, cwd?: string): string {
  return path.join(sessionsDir(cwd), `${sessionId}.json`);
}

function createHash(data: string): string {
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const chr = data.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export interface SessionStartOptions {
  agent?: string;
  agentId?: string;
  context?: string;
  model?: string;
  json?: boolean;
  cwd?: string;
}

export interface SessionStartResult extends SessionSnapshot {
  context_target?: string;
  agent_git_hygiene?: {
    missing_gitignore_paths: string[];
    tracked_paths: string[];
  };
  inventory_advisory?: string[];
}

export function runSessionStart(options: SessionStartOptions = {}): void {
  try {
    const snapshot = startSession(options);
    if (options.json) {
      console.log(JSON.stringify(snapshot, null, 2));
      return;
    }

    console.log(`✔ Session started: ${snapshot.session_id} (${snapshot.agent})`);
    if (options.context) console.log(`  Context target: ${options.context}`);
    if (snapshot.agent_git_hygiene && (snapshot.agent_git_hygiene.missing_gitignore_paths.length > 0 || snapshot.agent_git_hygiene.tracked_paths.length > 0)) {
      console.warn('⚠ Local Brainclaw agent files in this repo should stay unversioned.');
      if (snapshot.agent_git_hygiene.missing_gitignore_paths.length > 0) {
        console.warn(`  Missing .gitignore entries: ${snapshot.agent_git_hygiene.missing_gitignore_paths.join(', ')}`);
        console.warn('  Fix: run `brainclaw doctor --fix-agent-ignore`');
      }
      if (snapshot.agent_git_hygiene.tracked_paths.length > 0) {
        console.warn(`  Tracked local agent files: ${snapshot.agent_git_hygiene.tracked_paths.join(', ')}`);
        console.warn('  After fixing .gitignore, untrack them with `git rm --cached <path>` as needed.');
      }
    }
    if (snapshot.inventory_advisory) {
      for (const line of snapshot.inventory_advisory) {
        console.warn(`⚠ ${line}`);
      }
    }
  } catch (e: unknown) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

export function startSession(options: SessionStartOptions = {}): SessionStartResult {
  if (!memoryExists(options.cwd)) {
    throw new Error('.brainclaw/ not found. Run `brainclaw init` first.');
  }

  const registered = requireRegisteredAgentIdentity({
    agentName: options.agent,
    agentId: options.agentId,
    cwd: options.cwd,
    allowCurrent: true,
    allowEnv: true,
  });
  requireMinimumTrustLevel(registered, 'contributor');
  const actor = buildOperationalIdentity(registered.agent_name, options.cwd, { agentId: registered.agent_id });

  // Capture initial context snapshot
  let initialContextHash: string | undefined;
  try {
    const ctx = buildContext({ target: options.context, agent: actor.agent, cwd: options.cwd });
    initialContextHash = createHash(JSON.stringify(ctx.selected));
  } catch { /* non-fatal */ }

  // Capture git HEAD SHA for later handoff generation
  let gitSha: string | undefined;
  try {
    gitSha = execSync('git rev-parse HEAD', { encoding: 'utf-8', cwd: options.cwd ?? process.cwd() }).trim();
  } catch { /* non-fatal — not a git repo */ }

  const model = options.model ?? resolveCurrentModel(options.cwd);

  const snapshot: SessionSnapshot = {
    schema_version: 2,
    session_id: actor.session_id ?? generateId('sessions'),
    agent: actor.agent,
    agent_id: actor.agent_id,
    started_at: nowISO(),
    context_target: options.context,
    initial_context_hash: initialContextHash,
    git_sha: gitSha,
    ...(model ? { model } : {}),
  };

  // Persist snapshot
  const dir = sessionsDir(options.cwd);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  saveVersionedJsonFile('session_snapshot', sessionSnapshotPath(snapshot.session_id, options.cwd), SessionSnapshotSchema.parse(snapshot));
  saveCurrentSession({
    schema_version: 2,
    session_id: snapshot.session_id,
    started_at: snapshot.started_at,
    last_seen_at: snapshot.started_at,
    agent: actor.agent,
    agent_id: actor.agent_id,
    host_id: actor.host_id,
  }, options.cwd);

  // Write session_start runtime note
  const noteId = generateRuntimeNoteId();
  saveRuntimeNote({
    id: noteId,
    agent: actor.agent,
    agent_id: actor.agent_id,
    project_id: actor.project_id,
    session_id: snapshot.session_id,
    text: `Session started${options.context ? ` — context: ${options.context}` : ''}`,
    created_at: nowISO(),
    tags: ['session'],
    visibility: 'shared',
    note_type: 'session_start',
  }, options.cwd);

  appendAuditEntry({ action: 'session_start', actor: actor.agent, actor_id: actor.agent_id, item_id: snapshot.session_id, item_type: 'session' }, options.cwd);
  const agentGitHygiene = auditLocalAgentWorkspaceFiles(options.cwd ?? process.cwd());

  // Inventory reconciliation — detect new/disappeared agents on this machine
  let inventoryAdvisory: string[] | undefined;
  try {
    const previousInventory = loadAgentInventory();
    const currentInventory = buildAgentInventory();
    const diff = diffInventory(previousInventory, currentInventory);
    saveAgentInventory(currentInventory);

    const lines: string[] = [];
    if (diff.appeared.length > 0) lines.push(`New agents detected: ${diff.appeared.join(', ')}`);
    if (diff.disappeared.length > 0) lines.push(`Agents no longer detected: ${diff.disappeared.join(', ')}`);
    for (const vc of diff.version_changed) {
      lines.push(`${vc.name} version changed: ${vc.from ?? '?'} → ${vc.to ?? '?'}`);
    }
    if (lines.length > 0) inventoryAdvisory = lines;
  } catch { /* non-fatal — inventory scan failure should not block session start */ }

  return {
    ...snapshot,
    ...(agentGitHygiene.isGitRepo && (agentGitHygiene.missingGitignorePaths.length > 0 || agentGitHygiene.trackedPaths.length > 0)
      ? {
          agent_git_hygiene: {
            missing_gitignore_paths: agentGitHygiene.missingGitignorePaths,
            tracked_paths: agentGitHygiene.trackedPaths,
          },
        }
      : {}),
    ...(inventoryAdvisory ? { inventory_advisory: inventoryAdvisory } : {}),
  };
}

export function loadSessionSnapshot(sessionId: string, cwd?: string): SessionSnapshot | undefined {
  const p = sessionSnapshotPath(sessionId, cwd);
  if (!fs.existsSync(p)) return undefined;
  try {
    return SessionSnapshotSchema.parse(loadVersionedJsonFile<SessionSnapshot>('session_snapshot', p).document);
  } catch {
    return undefined;
  }
}
