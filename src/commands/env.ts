import { memoryExists } from '../core/io.js';
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
  const agentTooling = options.agentTooling ? buildAgentToolingContext({ cwd }) : undefined;

  if (options.json) {
    console.log(JSON.stringify({
      execution_context: executionContext,
      ...(agentTooling ? { agent_tooling: agentTooling } : {}),
    }, null, 2));
    return;
  }

  console.log(renderExecutionContextSummary(compactExecutionContext(executionContext), false));
  if (agentTooling) {
    console.log('');
    console.log(renderAgentToolingSummary(agentTooling));
  }
}
