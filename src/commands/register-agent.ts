import { registerAgentIdentity, setCurrentAgentIdentity } from '../core/agent-registry.js';
import { memoryExists } from '../core/io.js';
import type { AgentKind } from '../core/schema.js';

export interface RegisterAgentOptions {
  kind?: AgentKind;
  setCurrent?: boolean;
  json?: boolean;
}

export function runRegisterAgent(agentName: string, options: RegisterAgentOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const agent = registerAgentIdentity({
    agentName,
    kind: options.kind ?? 'unknown',
  });

  if (options.setCurrent) {
    setCurrentAgentIdentity(agent);
  }

  if (options.json) {
    console.log(JSON.stringify({ ...agent, current: options.setCurrent ?? false }, null, 2));
    return;
  }

  const currentLabel = options.setCurrent ? ' [current]' : '';
  console.log(`✔ Agent registered: ${agent.agent_name} (${agent.agent_id}, kind=${agent.kind})${currentLabel}`);
}
