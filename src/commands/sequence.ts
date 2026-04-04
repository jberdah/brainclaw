import { resolveCurrentAgentName } from '../core/agent-registry.js';
import { requireInitialized } from '../core/guards.js';
import { validateCliInput } from '../core/input-validation.js';
import { createSequence, listSequences, loadSequence, updateSequence } from '../core/sequence.js';
import type { SequenceItemInput, SequenceStatus } from '../core/schema.js';

interface SequenceOptions {
  json?: boolean;
  description?: string;
  status?: SequenceStatus;
  owner?: string;
  items?: string;
  author?: string;
  name?: string;
  tag?: string[];
  cwd?: string;
}

const KNOWN_SUBCOMMANDS = new Set(['create', 'list', 'ls', 'show', 'update']);

function parseItems(raw?: string): SequenceItemInput[] | undefined {
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new Error(`Invalid --items JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Invalid --items JSON: expected an array');
  }

  return parsed as SequenceItemInput[];
}

export function runSequenceResource(subcommand: string, args: string[], options: SequenceOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();
  requireInitialized(cwd);

  const normalized = subcommand.trim().toLowerCase();
  if (!KNOWN_SUBCOMMANDS.has(normalized)) {
    console.error(`Error: unknown sequence subcommand "${subcommand}".`);
    console.error('  Available: create, list, show, update');
    process.exit(1);
  }

  if (normalized === 'create') {
    const name = args.join(' ').trim();
    if (!name) {
      console.error('Error: sequence create requires <name>');
      process.exit(1);
    }

    validateCliInput(name, options.tag);
    const items = parseItems(options.items);
    const result = createSequence({
      name,
      description: options.description,
      status: options.status,
      owner: options.owner,
      items,
      author: options.author ?? resolveCurrentAgentName(cwd),
      tags: options.tag,
    }, cwd);
    console.log(`✔ Sequence added: [${result.id}] ${name}`);
    return;
  }

  if (normalized === 'list' || normalized === 'ls') {
    const sequences = listSequences(cwd).filter((sequence) => !options.status || sequence.status === options.status);
    if (options.json) {
      console.log(JSON.stringify(sequences, null, 2));
      return;
    }
    if (sequences.length === 0) {
      console.log('No sequences found.');
      return;
    }
    console.log(`${sequences.length} sequence(s):`);
    for (const sequence of sequences) {
      console.log(`[${sequence.id}] ${sequence.name} (${sequence.status}, items=${sequence.items.length})`);
    }
    return;
  }

  if (normalized === 'show') {
    const id = args[0];
    if (!id) {
      console.error('Error: sequence show requires <id>.');
      process.exit(1);
    }
    const sequence = loadSequence(id, cwd);
    if (options.json) {
      console.log(JSON.stringify(sequence, null, 2));
      return;
    }
    console.log(`Sequence: ${sequence.id}`);
    console.log(`  Name:        ${sequence.name}`);
    console.log(`  Status:      ${sequence.status}`);
    if (sequence.owner) console.log(`  Owner:       ${sequence.owner}`);
    if (sequence.description) console.log(`  Description: ${sequence.description}`);
    console.log(`  Updated:     ${sequence.updated_at}`);
    if (sequence.items.length > 0) {
      console.log('  Items:');
      for (const item of sequence.items) {
        const lane = item.lane ? ` lane=${item.lane}` : '';
        const hardAfter = item.hard_after.length ? ` hard_after=${item.hard_after.join(',')}` : '';
        const softAfter = item.soft_after.length ? ` soft_after=${item.soft_after.join(',')}` : '';
        console.log(`    #${item.rank} ${item.planId}${lane}${hardAfter}${softAfter}`);
      }
    }
    return;
  }

  const id = args[0];
  if (!id) {
    console.error('Error: sequence update requires <id>.');
    process.exit(1);
  }

  const items = options.items ? parseItems(options.items) : undefined;
  const sequence = updateSequence({
    id,
    name: options.name,
    description: options.description,
    status: options.status,
    owner: options.owner,
    items,
    tags: options.tag,
  }, cwd);
  console.log(`✔ Sequence updated: [${sequence.id}] ${sequence.name}`);
}
