import { memoryExists } from '../core/io.js';
import { resolveCurrentAgentIdentity, resolveExistingCurrentAgent } from '../core/agent-registry.js';
import { loadConfig } from '../core/config.js';
import { resolveCurrentHostId } from '../core/host.js';
import { buildOperationalIdentity } from '../core/identity.js';
import { buildExecutionContext, compactExecutionContext } from '../core/execution-context.js';
import { buildAgentToolingContext } from '../core/agent-context.js';

export interface WhoamiOptions {
  json?: boolean;
  cwd?: string;
}

export function runWhoami(options: WhoamiOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();
  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const config = loadConfig(cwd);
  const hostId = resolveCurrentHostId();
  const executionContext = compactExecutionContext(buildExecutionContext({ cwd }));
  const agentTooling = buildAgentToolingContext({ cwd });

  let identity;
  try {
    identity = buildOperationalIdentity(undefined, cwd);
  } catch { /* no agent configured */ }

  const agent = identity
    ? resolveCurrentAgentIdentity(cwd)
    : undefined;

  const result = {
    resolved_agent: identity?.agent ?? null,
    agent_id: identity?.agent_id ?? null,
    host_id: hostId,
    session_id: identity?.session_id ?? null,
    project_id: identity?.project_id ?? null,
    project_name: config.project_name,
    storage_dir: config.storage_dir,
    trust_level: agent?.trust_level ?? 'contributor',
    capabilities: agent?.capabilities ?? [],
    kind: agent?.kind ?? 'unknown',
    identity_key: agent?.identity_key ?? null,
    env_agent: process.env.BRAINCLAW_AGENT ?? null,
    env_session: process.env.BRAINCLAW_SESSION_ID ?? null,
    env_host: process.env.BRAINCLAW_HOST_ID ?? null,
    execution_context: executionContext,
    agent_tooling: {
      agents_md_present: agentTooling.agents_md_present,
      agents_md_title: agentTooling.agents_md_title,
      agents_rules: agentTooling.agents_rules,
      skills: agentTooling.skills,
      mcp_servers: agentTooling.mcp_servers,
    },
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Identity resolved for: ${result.resolved_agent ?? '(no agent)'}`);
  if (result.agent_id) console.log(`  Agent ID   : ${result.agent_id}`);
  console.log(`  Trust level: ${result.trust_level}`);
  if (result.capabilities.length > 0) console.log(`  Capabilities: ${result.capabilities.join(', ')}`);
  if (result.identity_key?.fingerprint) console.log(`  Fingerprint: ${result.identity_key.fingerprint}`);
  console.log(`  Kind       : ${result.kind}`);
  console.log(`  Host ID    : ${result.host_id}`);
  if (result.session_id) console.log(`  Session ID : ${result.session_id}`);
  console.log(`  Project    : ${result.project_name} (${result.project_id ?? 'n/a'})`);
  console.log(`  Storage    : ${result.storage_dir}`);
  console.log(`  Branch     : ${result.execution_context.branch ?? '(none)'}`);
  console.log(`  Git status : ${result.execution_context.git_status}`);
  if (result.execution_context.toolchains.length > 0) {
    const primary = result.execution_context.toolchains[0]!;
    console.log(`  Toolchain  : ${primary.name}${primary.version ? ` ${primary.version}` : ''}`);
  }
  if (result.agent_tooling.agents_rules.length > 0) {
    console.log(`  Agent rule : ${result.agent_tooling.agents_rules[0]}`);
  }
  console.log(`  Skills     : ${result.agent_tooling.skills.length}`);
  console.log(`  MCP servers: ${result.agent_tooling.mcp_servers.length}`);
  const missingServer = result.agent_tooling.mcp_servers.find((server) => server.availability === 'missing_command');
  if (missingServer) {
    console.log(`  MCP issue  : ${missingServer.name} missing ${missingServer.command ?? 'command'}`);
  }
}
