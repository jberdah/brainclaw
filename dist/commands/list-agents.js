import { listAgentIdentities, resolveCurrentAgentIdentity } from '../core/agent-registry.js';
import { memoryExists } from '../core/io.js';
import { buildReputationSnapshot, toPublicReputationSummary } from '../core/reputation.js';
export function runListAgents(options = {}) {
    if (!memoryExists()) {
        console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
        process.exit(1);
    }
    const agents = listAgentIdentities();
    const current = resolveCurrentAgentIdentity();
    const reputation = options.withReputation ? buildReputationSnapshot() : undefined;
    const reputationById = new Map((reputation?.agents ?? []).map((agent) => [agent.agent_id ?? agent.key, toPublicReputationSummary(agent)]));
    if (options.json) {
        console.log(JSON.stringify({
            current_agent_id: current?.agent_id,
            current_agent: current?.agent_name,
            agents: options.withReputation
                ? agents.map((agent) => ({
                    ...agent,
                    reputation: reputationById.get(agent.agent_id),
                }))
                : agents,
        }, null, 2));
        return;
    }
    if (agents.length === 0) {
        console.log('No registered agents.');
        return;
    }
    console.log(`${agents.length} registered agent(s):`);
    for (const agent of agents) {
        const currentLabel = current?.agent_id === agent.agent_id ? ' [current]' : '';
        const reputationLabel = options.withReputation
            ? (() => {
                const summary = reputationById.get(agent.agent_id);
                return summary ? ` trust=${summary.internal_trust} cq=${summary.contribution_quality} rv=${summary.review_reliability} ct=${summary.continuity_hygiene}` : '';
            })()
            : '';
        const capabilitiesLabel = agent.capabilities.length > 0 ? ` caps=${agent.capabilities.join(',')}` : '';
        const fingerprintLabel = agent.identity_key ? ` fp=${agent.identity_key.fingerprint.slice(0, 12)}` : '';
        console.log(`  - ${agent.agent_name} (${agent.agent_id}, kind=${agent.kind})${currentLabel}${reputationLabel}${capabilitiesLabel}${fingerprintLabel}`);
    }
}
//# sourceMappingURL=list-agents.js.map