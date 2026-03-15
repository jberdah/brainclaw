import { memoryExists } from '../core/io.js';
import { buildContext, renderContextMarkdown, renderContextPromptTemplate } from '../core/context.js';
import { writeContextMarker } from '../core/freshness.js';
import { nowISO } from '../core/ids.js';
import { logger } from '../core/logger.js';

export interface ContextCommandOptions {
  for?: string;
  project?: string;
  agent?: string;
  host?: string;
  allHosts?: boolean;
  json?: boolean;
  template?: boolean;
  compactTemplate?: boolean;
  explain?: boolean;
  includePending?: boolean;
  profile?: 'dev' | 'openclaw' | 'ops' | 'research';
  maxItems?: number;
  maxChars?: number;
  digest?: boolean;
  bootstrap?: boolean;
  refreshBootstrap?: boolean;
  cwd?: string;
}

export function runContext(options: ContextCommandOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();
  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const result = buildContext({
    target: options.for,
    project: options.project,
    agent: options.agent,
    host: options.host,
    allHosts: options.allHosts,
    includePending: options.includePending,
    profile: options.profile,
    maxItems: options.maxItems,
    maxChars: options.maxChars,
    digest: options.digest,
    bootstrap: options.bootstrap,
    refreshBootstrap: options.refreshBootstrap,
    cwd,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (options.template) {
    const compact = options.compactTemplate || result.profile === 'openclaw';
    console.log(renderContextPromptTemplate(result, compact));
  } else {
    console.log(renderContextMarkdown(result, options.explain));
  }

  writeLastContextMarker(result, options, cwd);
}

function writeLastContextMarker(result: ReturnType<typeof buildContext>, options: ContextCommandOptions, cwd?: string): void {
  try {
    writeContextMarker({
      read_at: nowISO(),
      memory_version: result.memory_version,
      host_id: result.current_host,
      target: options.for,
      project: result.project,
      all_hosts: options.allHosts ?? false,
    }, cwd);
  } catch (err) {
    logger.debug('Failed to write context marker:', err);
  }
}
