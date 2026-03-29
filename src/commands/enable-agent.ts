import { registerAgentIdentity, setCurrentAgentIdentity } from '../core/agent-registry.js';
import { loadConfig, saveConfig } from '../core/config.js';
import { describeAutoConfigWrite, writeDetectedAgentAutoConfig } from '../core/agent-files.js';
import { isAgentIntegrationName, upsertAgentIntegrationDeclaration } from '../core/agent-integrations.js';
import { memoryExists } from '../core/io.js';
import type { AgentKind } from '../core/schema.js';
import { writeAgentExportForAgent } from './export.js';
import { writeDetectedAgentHooks } from './hooks.js';

export interface EnableAgentOptions {
  kind?: AgentKind;
  contextProfile?: string;
  capability?: string[];
  replaceCapabilities?: boolean;
  generateFingerprint?: boolean;
  setCurrent?: boolean;
  json?: boolean;
  cwd?: string;
}

export function runEnableAgent(agentName: string, options: EnableAgentOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();
  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  if (!isAgentIntegrationName(agentName)) {
    console.error(`Error: unsupported agent '${agentName}'. Use \`brainclaw register-agent\` for identity-only registration.`);
    process.exit(1);
  }

  const agent = registerAgentIdentity({
    agentName,
    kind: options.kind ?? 'agent',
    contextProfile: options.contextProfile,
    capabilities: options.capability,
    replaceCapabilities: options.replaceCapabilities,
    generateFingerprint: options.generateFingerprint,
    cwd,
  });

  if (options.setCurrent) {
    setCurrentAgentIdentity(agent, cwd);
  }

  const config = loadConfig(cwd);
  upsertAgentIntegrationDeclaration(config, agentName, 'manual');
  saveConfig(config, cwd);

  const exportResult = writeAgentExportForAgent(agentName, cwd);
  // Windsurf uses .windsurfrules for both native rules and session hooks.
  // Avoid clobbering the exported rules file during activation.
  const hookResults = agentName === 'windsurf'
    ? []
    : writeDetectedAgentHooks(agentName, config.project_name, cwd)
      .filter((hook) => hook.relativePath !== exportResult?.relativePath);
  const autoConfigResults = writeDetectedAgentAutoConfig(agentName, cwd);
  const messages = autoConfigResults.map(describeAutoConfigWrite).filter((message): message is string => Boolean(message));

  if (options.json) {
    console.log(JSON.stringify({
      agent,
      current: options.setCurrent ?? false,
      declaration_added: true,
      export: exportResult,
      hooks: hookResults,
      auto_config: autoConfigResults,
    }, null, 2));
    return;
  }

  console.log(`✔ Agent enabled: ${agent.agent_name} (${agent.agent_id})${options.setCurrent ? ' [current]' : ''}`);
  if (exportResult) {
    console.log(`✔ Agent instructions written to ${exportResult.relativePath} (${exportResult.created ? 'created' : 'updated'})`);
  }
  for (const hook of hookResults) {
    console.log(`✔ Session hook written to ${hook.relativePath} (${hook.created ? 'created' : 'updated'})`);
  }
  for (const message of messages) {
    console.log(message);
  }
}
