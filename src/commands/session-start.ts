import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { memoryExists, resolveEntityDir } from '../core/io.js';
import { loadVersionedJsonFile, saveVersionedJsonFile } from '../core/migration.js';
import { buildOperationalIdentity, loadAllSessions, saveCurrentSession } from '../core/identity.js';
import { requireMinimumTrustLevel, resolveCurrentModel, resolveOrAutoRegisterAgentIdentity } from '../core/agent-registry.js';
import { buildContext, renderContextPromptTemplate } from '../core/context.js';
import { writeContextMarker } from '../core/freshness.js';
import { saveRuntimeNote, generateRuntimeNoteId } from '../core/runtime.js';
import { nowISO, generateId } from '../core/ids.js';
import { appendAuditEntry } from '../core/audit.js';
import { logHookDiagnostic } from '../core/hook-log.js';
import { releaseStaleClaimsFromOtherAgents } from '../core/claims.js';
import { SessionSnapshotSchema, type SessionSnapshot } from '../core/schema.js';
import { auditLocalAgentWorkspaceFiles } from '../core/agent-files.js';
import { buildAgentInventory, loadAgentInventory, saveAgentInventory, diffInventory } from '../core/agent-inventory.js';
import { checkMemoryPressure, enforceRuntimeNoteRetention, type MemoryPressureResult } from '../core/gc-semantic.js';
import { maybeCreateCheckpoint } from '../core/events/checkpoint.js';
import { pullSignalsFromLinkedProjects, markSignalProcessed } from '../core/federation-transport.js';
import { pullSignalsFromCloud, isCloudSyncEnabled } from '../core/federation-cloud.js';
import { materializeFederationSignal } from '../core/federation-materialize.js';

function sessionsDir(cwd?: string): string {
  return resolveEntityDir('sessions', cwd ?? process.cwd(), 'read');
}

function sessionSnapshotPath(sessionId: string, cwd?: string): string {
  return path.join(sessionsDir(cwd), `${sessionId}.json`);
}

export interface SessionStartOptions {
  agent?: string;
  agentId?: string;
  context?: string;
  model?: string;
  json?: boolean;
  /** Output full project context (like `brainclaw context`) after starting the session. */
  includeContext?: boolean;
  /**
   * Hook mode (trp#917): this command is running as a session hook, not an
   * interactive call. On any failure, degrade to exit 0 and log a line to
   * ~/.brainclaw/hook.log instead of erroring — an advisory hook must never
   * fail the agent's prompt loop.
   */
  hook?: boolean;
  cwd?: string;
  /**
   * Internal maintenance mode. `fast` keeps the critical session-start path short;
   * `full` also runs reconciliation and other best-effort maintenance work.
   */
  maintenanceMode?: 'fast' | 'full';
}

export interface SharedCheckoutWarning {
  worktree_path: string;
  other_sessions: Array<{
    session_id: string;
    agent: string;
    user?: string;
    branch?: string;
    pid?: number;
  }>;
}

export interface SessionStartResult extends SessionSnapshot {
  context_target?: string;
  agent_git_hygiene?: {
    missing_gitignore_paths: string[];
    tracked_paths: string[];
  };
  inventory_advisory?: string[];
  shared_checkout_warning?: SharedCheckoutWarning;
  stale_claims_released?: Array<{ id: string; agent: string; scope: string }>;
  memory_pressure?: MemoryPressureResult;
  /** True when the agent identity was auto-registered during this session start. */
  auto_registered?: boolean;
}

export async function runSessionStart(options: SessionStartOptions = {}): Promise<void> {
  try {
    const snapshot = await startSession({
      ...options,
      maintenanceMode: options.maintenanceMode ?? 'full',
    });

    // --include-context: output full project context (replaces separate `brainclaw context` call)
    if (options.includeContext) {
      try {
        const cwd = options.cwd ?? process.cwd();
        // Find the previous session for the same agent to auto-surface a context diff on resume.
        // We exclude the session just created so we always point at the prior one.
        const previousSession = loadAllSessions(cwd)
          .find((s) => s.agent === snapshot.agent && s.session_id !== snapshot.session_id);
        const contextResult = buildContext({
          target: options.context,
          agent: snapshot.agent,
          cwd,
          sinceSession: previousSession?.session_id,
        });
        console.log(renderContextPromptTemplate(contextResult, false));
        writeContextMarker({
          read_at: nowISO(),
          memory_version: contextResult.memory_version,
          host_id: contextResult.current_host,
          target: options.context,
          project: contextResult.project,
          all_hosts: false,
        }, cwd);
      } catch (ctxErr) {
        // Context build failure should not block session start output
        console.error(`⚠ Context build failed: ${ctxErr instanceof Error ? ctxErr.message : String(ctxErr)}`);
      }
      return;
    }

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
    if (snapshot.stale_claims_released) {
      console.warn(`⚠ Auto-released ${snapshot.stale_claims_released.length} stale claim(s):`);
      for (const c of snapshot.stale_claims_released) {
        console.warn(`  ${c.agent} → ${c.scope}`);
      }
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    if (options.hook) {
      // Advisory hook (trp#917): never fail the prompt loop. Log + exit 0.
      logHookDiagnostic(`session-start skipped: ${message}`);
      return;
    }
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

export async function startSession(options: SessionStartOptions = {}): Promise<SessionStartResult> {
  if (!memoryExists(options.cwd)) {
    throw new Error('.brainclaw/ not found. Run `brainclaw init` first.');
  }

  const { identity: registered, auto_registered: autoRegistered } = resolveOrAutoRegisterAgentIdentity({
    agentName: options.agent,
    agentId: options.agentId,
    cwd: options.cwd,
    allowCurrent: true,
    allowEnv: true,
  });
  requireMinimumTrustLevel(registered, 'contributor');
  const actor = buildOperationalIdentity(registered.agent_name, options.cwd, { agentId: registered.agent_id });

  const maintenanceMode = options.maintenanceMode ?? 'fast';

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
    git_sha: gitSha,
    ...(model ? { model } : {}),
  };

  // Persist snapshot
  const dir = sessionsDir(options.cwd);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  saveVersionedJsonFile('session_snapshot', sessionSnapshotPath(snapshot.session_id, options.cwd), SessionSnapshotSchema.parse(snapshot));
  // Resolve git branch and worktree for session tracking
  let currentBranch: string | undefined;
  let currentWorktreePath: string | undefined;
  try {
    currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8', cwd: options.cwd ?? process.cwd() }).trim();
    currentWorktreePath = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', cwd: options.cwd ?? process.cwd() }).trim();
  } catch { /* non-fatal — not a git repo */ }

  saveCurrentSession({
    schema_version: 2,
    session_id: snapshot.session_id,
    started_at: snapshot.started_at,
    last_seen_at: snapshot.started_at,
    agent: actor.agent,
    agent_id: actor.agent_id,
    host_id: actor.host_id,
    user: process.env.USER || process.env.USERNAME || os.userInfo().username || undefined,
    pid: process.pid,
    model: model ?? undefined,
    branch: currentBranch,
    worktree_path: currentWorktreePath,
    isolation_mode: 'shared-checkout',
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

  appendAuditEntry({ action: 'session_start', actor: actor.agent, actor_id: actor.agent_id, item_id: snapshot.session_id, item_type: 'session', session_id: snapshot.session_id, host_id: actor.host_id }, options.cwd);
  const agentGitHygiene = auditLocalAgentWorkspaceFiles(options.cwd ?? process.cwd());

  // Non-critical maintenance work lives behind the full mode only.
  let inventoryAdvisory: string[] | undefined;
  if (maintenanceMode === 'full') {
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

    // pln#564 step B — cap the runtime-note tree on session start (no LLM gate,
    // unlike the compaction-phase archiveSessionNotes). Keeps the newest N
    // session/lifecycle notes per agent + all genuine observations, parks the
    // rest. Bounds the buildContext read-path scan (trp_439fec51). Best-effort.
    try {
      enforceRuntimeNoteRetention({ cwd: options.cwd });
    } catch { /* non-fatal — retention sweep must never block session start */ }

    // pln#566 Inc0 — keep a recent journal-derived checkpoint available off the
    // hot path so the (capability-gated, OFF by default) checkpointRead read
    // path has something to serve once enabled. Gated by a growth threshold so
    // it only builds occasionally; journal-derived (F6). Best-effort.
    try {
      maybeCreateCheckpoint(options.cwd);
    } catch { /* non-fatal — checkpoint build must never block session start */ }
  }

  // Shared checkout detection: warn if other active sessions share the same worktree
  let sharedCheckoutWarning: SharedCheckoutWarning | undefined;
  if (currentWorktreePath) {
    try {
      const allSessions = loadAllSessions(options.cwd);
      const ttlMs = 4 * 60 * 60 * 1000; // 4h
      const now = Date.now();
      const otherSessions = allSessions.filter(s =>
        s.session_id !== snapshot.session_id
        && s.worktree_path === currentWorktreePath
        && (now - Date.parse(s.last_seen_at)) <= ttlMs
        && (!s.pid || isPidAlive(s.pid))
      );
      if (otherSessions.length > 0) {
        sharedCheckoutWarning = {
          worktree_path: currentWorktreePath,
          other_sessions: otherSessions.map(s => ({
            session_id: s.session_id,
            agent: s.agent,
            user: s.user,
            branch: s.branch,
            pid: s.pid,
          })),
        };
      }
    } catch { /* non-fatal */ }
  }

  // Stale claim auto-release. Phase 4 slice pln#388 stp_e2b10ab4: pass
  // the new session_id so same-agent prior-session claims can be swept
  // too — without it, a crash-recovered agent would keep its own orphaned
  // claims hanging until 24h.
  let staleClaimsReleased: Array<{ id: string; agent: string; scope: string }> | undefined;
  if (maintenanceMode === 'full') {
    try {
      const staleResult = releaseStaleClaimsFromOtherAgents(actor.agent, options.cwd, snapshot.session_id);
      if (staleResult.released.length > 0) {
        staleClaimsReleased = staleResult.released.map(c => ({ id: c.id, agent: c.agent, scope: c.scope }));
      }
    } catch { /* non-fatal */ }
  }

  // Memory pressure check: hint agent to run bclaw_compact if store is large
  let memoryPressure: MemoryPressureResult | undefined;
  if (maintenanceMode === 'full') {
    try {
      const pressure = checkMemoryPressure(options.cwd);
      if (pressure.memory_pressure) {
        memoryPressure = pressure;
      }
    } catch { /* non-fatal */ }
  }

  // Materialize incoming federation signals from linked projects (Phase 0 — local)
  if (maintenanceMode === 'full') {
    try {
      const federationSignals = pullSignalsFromLinkedProjects(options.cwd);
      let materialized = 0;
      for (const signal of federationSignals) {
        try {
          if (materializeFederationSignal(signal, options.cwd)) {
            materialized++;
          }
          markSignalProcessed(signal.from.project_path, signal.id);
        } catch { /* skip this signal — do not block session start */ }
      }
      if (materialized > 0) {
        console.log(`✔ Materialized ${materialized} federation signal(s) from linked projects`);
      }
    } catch { /* Non-fatal — federation pull failure should not block session start */ }
  }

  // Materialize incoming federation signals from cloud (Phase 1 — opt-in via cloud_sync.enabled)
  if (maintenanceMode === 'full' && isCloudSyncEnabled(options.cwd)) {
    try {
      const cloudSignals = await pullSignalsFromCloud(actor.agent, { limit: 100 }, options.cwd);
      let cloudMaterialized = 0;
      for (const signal of cloudSignals) {
        try {
          if (materializeFederationSignal(signal, options.cwd)) {
            cloudMaterialized++;
          }
          // No markSignalProcessed for cloud signals — cloud-side tracks delivery via the
          // inbox endpoint's own state (per-agent read cursor). If the cloud returns the
          // same signal twice, the idempotency_key field allows future dedup at materialize time.
        } catch { /* skip this signal — do not block session start */ }
      }
      if (cloudMaterialized > 0) {
        console.log(`✔ Materialized ${cloudMaterialized} federation signal(s) from cloud`);
      }
    } catch { /* Non-fatal — cloud pull failure should not block session start */ }
  }

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
    ...(sharedCheckoutWarning ? { shared_checkout_warning: sharedCheckoutWarning } : {}),
    ...(staleClaimsReleased ? { stale_claims_released: staleClaimsReleased } : {}),
    ...(memoryPressure ? { memory_pressure: memoryPressure } : {}),
    ...(autoRegistered ? { auto_registered: true } : {}),
  };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
