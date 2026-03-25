import { memoryExists } from '../core/io.js';
import { loadCandidate, archiveCandidate, resolveIdOrAlias } from '../core/candidates.js';
import { nowISO } from '../core/ids.js';
import { appendAuditEntry } from '../core/audit.js';
import { requireMinimumTrustLevel, requireRegisteredAgentIdentity } from '../core/agent-registry.js';
export function runReject(id, reason, by, cwd) {
    try {
        rejectCandidate(id, reason, by, cwd);
        console.log(`✔ Candidate [${id}] rejected and archived.`);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`Error: ${msg}`);
        process.exit(1);
    }
}
export function rejectCandidate(id, reason, by, cwd, byId) {
    if (!memoryExists(cwd)) {
        throw new Error('.brainclaw/ not found. Run `brainclaw init` first.');
    }
    const resolvedId = resolveIdOrAlias(id, cwd);
    const candidate = loadCandidate(resolvedId, cwd);
    if (candidate.status !== 'pending') {
        throw new Error(`Candidate '${resolvedId}' is already ${candidate.status}.`);
    }
    const actorIdentity = requireRegisteredAgentIdentity({
        agentName: by,
        agentId: byId,
        cwd,
        allowCurrent: true,
        allowEnv: true,
    });
    requireMinimumTrustLevel(actorIdentity, 'trusted');
    const actor = actorIdentity.agent_name;
    candidate.status = 'rejected';
    candidate.resolved_at = nowISO();
    candidate.resolved_by = actor;
    if (reason) {
        candidate.resolution_reason = reason;
    }
    archiveCandidate(candidate, 'rejected', cwd);
    appendAuditEntry({
        actor,
        actor_id: actorIdentity.agent_id,
        action: 'reject',
        item_id: resolvedId,
        item_type: candidate.type,
        reason,
    }, cwd);
    return { candidate_id: resolvedId, actor };
}
//# sourceMappingURL=reject.js.map