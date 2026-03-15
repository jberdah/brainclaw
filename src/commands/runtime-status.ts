import { resolveCurrentHostId } from '../core/host.js';
import { memoryExists } from '../core/io.js';
import { listRuntimeNotes } from '../core/runtime.js';
import type { MemoryVisibility } from '../core/schema.js';

export interface RuntimeStatusOptions {
  agent?: string;
  plan?: string;
  json?: boolean;
  visibility?: MemoryVisibility | 'all';
  host?: string;
  allHosts?: boolean;
}

export function runRuntimeStatus(options: RuntimeStatusOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const currentHost = resolveCurrentHostId();
  const notes = listRuntimeNotes({
    agent: options.agent,
    visibility: options.visibility,
    hostId: options.host,
    includeAllHosts: options.allHosts,
  });
  const filtered = options.plan ? notes.filter((note) => note.plan_id === options.plan) : notes;

  if (options.json) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  if (filtered.length === 0) {
    console.log('No runtime notes.');
    return;
  }

  // Group by agent
  const byAgent = new Map<string, typeof filtered>();
  for (const n of filtered) {
    const list = byAgent.get(n.agent) ?? [];
    list.push(n);
    byAgent.set(n.agent, list);
  }

  const scopeLabel = options.visibility ? ` visibility=${options.visibility}` : ' visibility=shared+machine(current-host)';
  const hostLabel = options.allHosts ? ' host=all' : ` host=${options.host ?? currentHost}`;
  console.log(`${filtered.length} runtime note(s) from ${byAgent.size} agent(s):${scopeLabel}${hostLabel}`);
  console.log('');
  for (const [agent, agentNotes] of byAgent) {
    console.log(`  ${agent}:`);
    for (const n of agentNotes.slice(-5)) {
      const tags = n.tags.length ? ` [${n.tags.join(', ')}]` : '';
      const plan = n.plan_id ? ` (plan ${n.plan_id})` : '';
      const scope = n.visibility === 'shared' ? ' [shared]' : ` [${n.visibility}:${n.host_id ?? 'unknown-host'}]`;
      console.log(`    [${n.id}] ${n.text}${plan}${scope}${tags}`);
    }
    if (agentNotes.length > 5) {
      console.log(`    ... and ${agentNotes.length - 5} more`);
    }
  }
}
