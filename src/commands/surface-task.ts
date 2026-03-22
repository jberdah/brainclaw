import { buildOperationalIdentity } from '../core/identity.js';
import { memoryExists } from '../core/io.js';
import { generateIdWithLabel, nowISO } from '../core/ids.js';
import { requireMinimumTrustLevel, requireRegisteredAgentIdentity } from '../core/agent-registry.js';
import { saveAiSurfaceTask } from '../core/ai-surface-tasks.js';
import type { AiSurfaceTaskKind, AiSurfaceTaskRequest } from '../core/schema.js';

export interface SurfaceTaskOptions {
  target?: string;
  instructions?: string;
  kind?: AiSurfaceTaskKind;
  output?: string[];
  tag?: string[];
  path?: string[];
  agent?: string;
  agentId?: string;
  cwd?: string;
}

export function runSurfaceTask(title: string, options: SurfaceTaskOptions = {}): void {
  if (!memoryExists(options.cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }
  if (!options.target) {
    console.error('Error: surface-task create requires --target <surface>.');
    process.exit(1);
  }
  if (!options.instructions?.trim()) {
    console.error('Error: surface-task create requires --instructions <text>.');
    process.exit(1);
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
  });

  const ids = generateIdWithLabel('ai_surface_tasks', options.cwd);
  const timestamp = nowISO();
  const task: AiSurfaceTaskRequest = {
    id: ids.id,
    short_label: ids.short_label,
    title: title.trim(),
    instructions: options.instructions.trim(),
    target_surface: options.target.trim(),
    kind: options.kind ?? 'custom',
    created_at: timestamp,
    updated_at: timestamp,
    author: actor.agent,
    author_id: actor.agent_id,
    project_id: actor.project_id,
    session_id: actor.session_id,
    status: 'queued',
    requested_outputs: options.output ?? [],
    related_paths: options.path,
    tags: options.tag ?? [],
  };

  saveAiSurfaceTask(task, options.cwd);

  console.log(`✔ Surface task queued: [${task.id}] ${task.title}`);
  console.log(`  Target: ${task.target_surface} (${task.kind})`);
  if (task.requested_outputs.length > 0) {
    console.log(`  Outputs: ${task.requested_outputs.join(', ')}`);
  }
}
