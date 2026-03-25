import { registerAgentIdentity, setCurrentAgentIdentity } from '../core/agent-registry.js';
import { memoryExists } from '../core/io.js';
export function runRegisterAgent(agentName, options = {}) {
    if (!memoryExists()) {
        console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
        process.exit(1);
    }
    const resolvedTrust = options.curator ? 'curator' : options.trustLevel;
    const agent = registerAgentIdentity({
        agentName,
        kind: options.kind ?? 'unknown',
        capabilities: options.capability,
        replaceCapabilities: options.replaceCapabilities,
        generateFingerprint: options.generateFingerprint,
        trustLevel: resolvedTrust,
    });
    if (options.setCurrent) {
        setCurrentAgentIdentity(agent);
    }
    if (options.json) {
        console.log(JSON.stringify({ ...agent, current: options.setCurrent ?? false }, null, 2));
        return;
    }
    const currentLabel = options.setCurrent ? ' [current]' : '';
    const capabilitiesLabel = agent.capabilities.length > 0 ? `, capabilities=${agent.capabilities.join(',')}` : '';
    const fingerprintLabel = agent.identity_key ? `, fp=${agent.identity_key.fingerprint.slice(0, 12)}` : '';
    console.log(`✔ Agent registered: ${agent.agent_name} (${agent.agent_id}, kind=${agent.kind}${capabilitiesLabel}${fingerprintLabel})${currentLabel}`);
}
//# sourceMappingURL=register-agent.js.map