import { memoryExists } from '../core/io.js';
import { readUnseenEvents, buildNotificationSummary } from '../core/event-log.js';
import { resolveCurrentAgentName } from '../core/agent-registry.js';

export interface CheckEventsOptions {
  agent?: string;
  json?: boolean;
}

export function runCheckEvents(options: CheckEventsOptions = {}): void {
  if (!memoryExists()) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const agent = options.agent ?? resolveCurrentAgentName();
  const events = readUnseenEvents(agent);

  if (events.length === 0) {
    if (options.json) {
      console.log(JSON.stringify({ agent, unseen: 0 }));
    } else {
      console.log('No unseen events.');
    }
    return;
  }

  const summary = buildNotificationSummary(events) ?? {};

  if (options.json) {
    console.log(JSON.stringify({ agent, unseen: events.length, summary, events }));
    return;
  }

  console.log(`${events.length} unseen event(s) since last read:\n`);
  for (const [key, count] of Object.entries(summary)) {
    console.log(`  ${key}: ${count}`);
  }
  console.log('');
  for (const evt of events) {
    const id = evt.item_id ? ` [${evt.item_id.slice(0, 12)}]` : '';
    const sum = evt.summary ? ` — ${evt.summary}` : '';
    console.log(`  ${evt.ts}  ${evt.agent}  ${evt.action}:${evt.item_type}${id}${sum}`);
  }
}
