import { loadState, saveState } from '../core/state.js';
import { resolveCurrentAgentName } from '../core/agent-registry.js';
import { resolveCurrentHostId } from '../core/host.js';
import { loadConfig } from '../core/config.js';
import { generateMarkdown } from '../core/markdown.js';
import { nowISO } from '../core/ids.js';
import { scanText } from '../core/security.js';
import { memoryExists, memoryPath, writeFileAtomic } from '../core/io.js';
import { generateTrapIdWithLabel, saveOperationalTrap } from '../core/traps.js';
import { validateCliInput, validateCliTtl } from '../core/input-validation.js';
import { resolveTargetStore, type StoreTarget } from '../core/store-resolution.js';
import type { Trap, Severity, MemoryVisibility, TrapStatus } from '../core/schema.js';

export interface TrapOptions {
  status?: TrapStatus;
  severity?: Severity;
  tag?: string[];
  path?: string[];
  author?: string;
  visibility?: MemoryVisibility;
  host?: string;
  ttl?: string;
  cwd?: string;
  store?: StoreTarget;
  plan?: string;
}

export function runTrap(text: string, options: TrapOptions = {}): void {
  const cwd = resolveTargetStore(options.cwd ?? process.cwd(), options.store ?? 'local');

  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  validateCliInput(text, options.tag);
  if (options.ttl) {
    validateCliTtl(options.ttl);
  }

  const config = loadConfig(cwd);
  const warnings = scanText(text, config);
  for (const w of warnings) {
    console.warn(`⚠ ${w.message}`);
    if (w.level === 'block') {
      console.error('Blocked: strict redaction is enabled. Entry not added.');
      process.exit(1);
    }
  }

  const state = loadState(cwd);
  const { id, short_label } = generateTrapIdWithLabel();
  const visibility = options.visibility ?? 'shared';
  const hostId = visibility === 'shared' ? undefined : resolveCurrentHostId(options.host);

  const entry: Trap = {
    id,
    short_label,
    text,
    created_at: nowISO(),
    author: options.author ?? resolveCurrentAgentName(cwd),
    status: options.status ?? 'active',
    severity: options.severity ?? 'medium',
    tags: options.tag ?? [],
    related_paths: options.path,
    plan_id: options.plan,
    visibility,
    host_id: hostId,
    expires_at: options.ttl ? parseTtl(options.ttl) : undefined,
  };

  if (visibility === 'shared') {
    state.known_traps.push(entry);
    saveState(state, cwd);
    writeFileAtomic(memoryPath('project.md', cwd), generateMarkdown(state, cwd));
  } else {
    saveOperationalTrap(entry, cwd);
  }

  const scopeInfo = visibility === 'shared' ? 'shared' : `${visibility}:${hostId}`;
  const storeLabel = options.store && options.store !== 'local' ? ` [store:${options.store}]` : '';
  console.log(`✔ Trap added: [${id}] (${scopeInfo}) ${text}${storeLabel}`);
}



/** Parse a TTL string like "30m", "2h", "7d" and return an ISO expiry timestamp. */
function parseTtl(ttl: string): string | undefined {
  const match = /^(\d+)([mhd])$/.exec(ttl.trim().toLowerCase());
  if (!match) return undefined;
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;
  const ms = unit === 'm' ? value * 60_000
    : unit === 'h' ? value * 3_600_000
    : value * 86_400_000;
  return new Date(Date.now() + ms).toISOString();
}
