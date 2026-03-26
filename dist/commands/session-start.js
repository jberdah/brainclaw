import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { memoryExists, resolveEntityDir } from '../core/io.js';
import { loadVersionedJsonFile, saveVersionedJsonFile } from '../core/migration.js';
import { buildOperationalIdentity, loadAllSessions, saveCurrentSession } from '../core/identity.js';
import { requireMinimumTrustLevel, requireRegisteredAgentIdentity, resolveCurrentModel } from '../core/agent-registry.js';
import { buildContext, renderContextPromptTemplate } from '../core/context.js';
import { writeContextMarker } from '../core/freshness.js';
import { saveRuntimeNote, generateRuntimeNoteId } from '../core/runtime.js';
import { nowISO, generateId } from '../core/ids.js';
import { appendAuditEntry } from '../core/audit.js';
import { SessionSnapshotSchema } from '../core/schema.js';
import { auditLocalAgentWorkspaceFiles } from '../core/agent-files.js';
import { buildAgentInventory, loadAgentInventory, saveAgentInventory, diffInventory } from '../core/agent-inventory.js';
function sessionsDir(cwd) {
    return resolveEntityDir('sessions', cwd ?? process.cwd(), 'read');
}
function sessionSnapshotPath(sessionId, cwd) {
    return path.join(sessionsDir(cwd), `${sessionId}.json`);
}
function createHash(data) {
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
        const chr = data.charCodeAt(i);
        hash = ((hash << 5) - hash) + chr;
        hash |= 0;
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}
export function runSessionStart(options = {}) {
    try {
        const snapshot = startSession(options);
        // --include-context: output full project context (replaces separate `brainclaw context` call)
        if (options.includeContext) {
            try {
                const cwd = options.cwd ?? process.cwd();
                const contextResult = buildContext({
                    target: options.context,
                    agent: snapshot.agent,
                    cwd,
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
            }
            catch (ctxErr) {
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
        if (options.context)
            console.log(`  Context target: ${options.context}`);
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
    }
    catch (e) {
        console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
    }
}
export function startSession(options = {}) {
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
    let initialContextHash;
    try {
        const ctx = buildContext({ target: options.context, agent: actor.agent, cwd: options.cwd });
        initialContextHash = createHash(JSON.stringify(ctx.selected));
    }
    catch { /* non-fatal */ }
    // Capture git HEAD SHA for later handoff generation
    let gitSha;
    try {
        gitSha = execSync('git rev-parse HEAD', { encoding: 'utf-8', cwd: options.cwd ?? process.cwd() }).trim();
    }
    catch { /* non-fatal — not a git repo */ }
    const model = options.model ?? resolveCurrentModel(options.cwd);
    const snapshot = {
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
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    saveVersionedJsonFile('session_snapshot', sessionSnapshotPath(snapshot.session_id, options.cwd), SessionSnapshotSchema.parse(snapshot));
    // Resolve git branch and worktree for session tracking
    let currentBranch;
    let currentWorktreePath;
    try {
        currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8', cwd: options.cwd ?? process.cwd() }).trim();
        currentWorktreePath = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', cwd: options.cwd ?? process.cwd() }).trim();
    }
    catch { /* non-fatal — not a git repo */ }
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
    appendAuditEntry({ action: 'session_start', actor: actor.agent, actor_id: actor.agent_id, item_id: snapshot.session_id, item_type: 'session' }, options.cwd);
    const agentGitHygiene = auditLocalAgentWorkspaceFiles(options.cwd ?? process.cwd());
    // Inventory reconciliation — detect new/disappeared agents on this machine
    let inventoryAdvisory;
    try {
        const previousInventory = loadAgentInventory();
        const currentInventory = buildAgentInventory();
        const diff = diffInventory(previousInventory, currentInventory);
        saveAgentInventory(currentInventory);
        const lines = [];
        if (diff.appeared.length > 0)
            lines.push(`New agents detected: ${diff.appeared.join(', ')}`);
        if (diff.disappeared.length > 0)
            lines.push(`Agents no longer detected: ${diff.disappeared.join(', ')}`);
        for (const vc of diff.version_changed) {
            lines.push(`${vc.name} version changed: ${vc.from ?? '?'} → ${vc.to ?? '?'}`);
        }
        if (lines.length > 0)
            inventoryAdvisory = lines;
    }
    catch { /* non-fatal — inventory scan failure should not block session start */ }
    // Shared checkout detection: warn if other active sessions share the same worktree
    let sharedCheckoutWarning;
    if (currentWorktreePath) {
        try {
            const allSessions = loadAllSessions(options.cwd);
            const ttlMs = 4 * 60 * 60 * 1000; // 4h
            const now = Date.now();
            const otherSessions = allSessions.filter(s => s.session_id !== snapshot.session_id
                && s.worktree_path === currentWorktreePath
                && (now - Date.parse(s.last_seen_at)) <= ttlMs
                && (!s.pid || isPidAlive(s.pid)));
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
        }
        catch { /* non-fatal */ }
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
    };
}
function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
export function loadSessionSnapshot(sessionId, cwd) {
    const p = sessionSnapshotPath(sessionId, cwd);
    if (!fs.existsSync(p))
        return undefined;
    try {
        return SessionSnapshotSchema.parse(loadVersionedJsonFile('session_snapshot', p).document);
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=session-start.js.map