import { buildOperationalIdentity } from '../core/identity.js';
import { memoryExists } from '../core/io.js';
import { loadConfig } from '../core/config.js';
import { getAgentTrustLevel, requireMinimumTrustLevel, requireRegisteredAgentIdentity } from '../core/agent-registry.js';
import { saveRuntimeNote, generateRuntimeNoteId } from '../core/runtime.js';
import { loadState } from '../core/state.js';
import { nowISO } from '../core/ids.js';
import { createCandidateFromInput } from './reflect.js';
import { suggestCandidateTypes } from './reflect-runtime-note.js';
import { validateCliInput, validateCliTtl } from '../core/input-validation.js';
export function runRuntimeNote(text, options) {
    validateCliInput(text, options.tag);
    if (options.ttl) {
        validateCliTtl(options.ttl);
    }
    try {
        return createRuntimeNote(text, options, true);
    }
    catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}
export function createRuntimeNote(text, options, printSuccess = false) {
    if (!memoryExists(options.cwd)) {
        throw new Error('.brainclaw/ not found. Run `brainclaw init` first.');
    }
    const registeredAgent = requireRegisteredAgentIdentity({
        agentName: options.agent,
        agentId: options.agentId,
        cwd: options.cwd,
        allowCurrent: true,
        allowEnv: true,
    });
    requireMinimumTrustLevel(registeredAgent, 'contributor');
    const actor = buildOperationalIdentity(registeredAgent.agent_name, options.cwd, {
        agentId: registeredAgent.agent_id,
        sessionId: options.sessionId,
    });
    const state = loadState(options.cwd);
    const plan = options.plan ? state.plan_items.find((item) => item.id === options.plan) : undefined;
    if (options.plan && !plan) {
        throw new Error(`Plan item '${options.plan}' not found.`);
    }
    const id = generateRuntimeNoteId();
    const visibility = options.visibility ?? 'shared';
    const hostId = options.host ?? actor.host_id;
    const expiresAt = options.ttl ? parseTtl(options.ttl) : undefined;
    const note = {
        id,
        agent: actor.agent,
        agent_id: actor.agent_id,
        project_id: actor.project_id,
        session_id: actor.session_id,
        text,
        created_at: nowISO(),
        project: options.project ?? plan?.project,
        plan_id: options.plan,
        tags: options.tag ?? [],
        visibility,
        host_id: hostId,
        expires_at: expiresAt,
        note_type: 'observation',
        model: options.model,
    };
    saveRuntimeNote(note, options.cwd);
    const result = maybeAutoReflectRuntimeNote(note, options);
    const scopeInfo = visibility === 'shared' ? 'shared' : `${visibility}:${hostId}`;
    const ttlInfo = expiresAt ? ` (expires ${expiresAt})` : '';
    if (printSuccess) {
        console.log(`✔ Runtime note added: [${id}] (${actor.agent}, ${scopeInfo}) ${text}${ttlInfo}`);
        if (result.autoReflectAttempted) {
            if (result.promotedItemId) {
                console.log(`  Auto-reflect: promoted ${result.detectedType} via candidate [${result.candidateId}] -> [${result.promotedItemId}]`);
            }
            else if (result.candidateId) {
                console.log(`  Auto-reflect: created pending ${result.detectedType} candidate [${result.candidateId}]`);
            }
            else if (result.skipReason) {
                console.log(`  Auto-reflect skipped: ${result.skipReason}`);
            }
        }
    }
    return {
        noteId: id,
        agent: actor.agent,
        sessionId: actor.session_id,
        scopeInfo,
        expiresAt,
        ...result,
    };
}
function maybeAutoReflectRuntimeNote(note, options) {
    const config = loadConfig(options.cwd);
    const trustLevel = getAgentTrustLevel(note.agent_id ?? note.agent, options.cwd);
    const autoReflectRequested = Boolean(options.autoReflect)
        || (config.auto_reflect_notes === true && (trustLevel === 'trusted' || trustLevel === 'curator'));
    if (!autoReflectRequested) {
        return { autoReflectAttempted: false };
    }
    if (trustLevel === 'observer') {
        return { autoReflectAttempted: true, skipReason: 'observer_not_allowed' };
    }
    const suggestions = suggestCandidateTypes(note.text, note.tags);
    const detected = suggestions.find((entry) => entry.type !== 'handoff');
    if (!detected || detected.score < 4) {
        return { autoReflectAttempted: true, skipReason: 'low_confidence' };
    }
    const creation = createCandidateFromInput(note.text, detected.type, {
        tag: note.tags,
        author: note.agent,
        authorId: note.agent_id,
        projectId: note.project_id,
        hostId: note.host_id,
        sessionId: note.session_id,
        source: `runtime-note:${note.agent}:${note.id}`,
        cwd: options.cwd,
    }, false, false, true);
    return {
        autoReflectAttempted: true,
        detectedType: detected.type,
        candidateId: creation.candidateId,
        promotedItemId: creation.promotedItemId,
        contradictionsDetected: creation.contradictionsDetected?.map((item) => ({
            severity: item.severity,
            reason: item.reason,
            conflicts_with: item.conflicts_with,
        })),
        contradictionSummary: creation.contradictionSummary,
        promotionBlockedReason: creation.promotionBlockedReason,
    };
}
/** Parse a TTL string like "30m", "2h", "7d" and return an ISO expiry timestamp. */
function parseTtl(ttl) {
    const match = /^(\d+)([mhd])$/.exec(ttl.trim().toLowerCase());
    if (!match)
        return undefined;
    const value = parseInt(match[1], 10);
    const unit = match[2];
    const ms = unit === 'm' ? value * 60_000
        : unit === 'h' ? value * 3_600_000
            : value * 86_400_000;
    return new Date(Date.now() + ms).toISOString();
}
//# sourceMappingURL=runtime-note.js.map