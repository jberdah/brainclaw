import { memoryExists } from '../core/io.js';
import { loadConfig } from '../core/config.js';
import { assessAgentIntegrationReadiness } from '../core/agent-integrations.js';
import { assessBrainclawVersion } from '../core/brainclaw-version.js';
import { buildExecutionContext, compactExecutionContext, renderExecutionContextSummary } from '../core/execution-context.js';
import { buildAgentToolingContext, renderAgentToolingSummary } from '../core/agent-context.js';

export interface EnvCommandOptions {
  json?: boolean;
  agentTooling?: boolean;
  cwd?: string;
}

export function runEnv(options: EnvCommandOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();
  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const executionContext = buildExecutionContext({ cwd });
  const config = loadConfig(cwd);
  const integrationReadiness = assessAgentIntegrationReadiness(config, cwd);
  const brainclawVersion = assessBrainclawVersion(config);
  const agentTooling = options.agentTooling ? buildAgentToolingContext({ cwd }) : undefined;

  if (options.json) {
    console.log(JSON.stringify({
      execution_context: executionContext,
      brainclaw_version: brainclawVersion,
      declared_agent_integrations: config.agent_integrations,
      integration_readiness: integrationReadiness,
      ...(agentTooling ? { agent_tooling: agentTooling } : {}),
    }, null, 2));
    return;
  }

  console.log(renderExecutionContextSummary(compactExecutionContext(executionContext), false));
  console.log(`Brainclaw CLI: ${brainclawVersion.cli_version}`);
  if (brainclawVersion.status !== 'ok') {
    console.log(brainclawVersion.message);
    if (brainclawVersion.upgrade_message) {
      console.log(`Upgrade benefits: ${brainclawVersion.upgrade_message}`);
    }
  }
  console.log(`Declared agent integrations: ${config.agent_integrations.declarations.length}`);
  const missingDeclarations = integrationReadiness.filter((entry) => !entry.ready);
  if (missingDeclarations.length > 0) {
    console.log(`Integrations missing activation: ${missingDeclarations.length}`);
  }
  if (agentTooling) {
    console.log('');
    console.log(renderAgentToolingSummary(agentTooling));
  }
}
