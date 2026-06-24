/**
 * `brainclaw move <entity> <id> --to <project>` — id-preserving cross-project
 * relocation (pln#595). Thin CLI adapter over core relocateEntity().
 */
import os from 'node:os';
import { relocateEntity } from '../core/operations/relocate.js';
import type { EntityName } from '../core/entity-registry.js';

interface MoveOptions {
  to?: string;
  from?: string;
  force?: boolean;
  json?: boolean;
  cwd?: string;
}

export function runMove(entity: string, id: string, options: MoveOptions): void {
  if (!options.to) {
    console.error('Error: --to <project> is required.');
    process.exit(1);
  }
  try {
    const result = relocateEntity({
      entity: entity as EntityName,
      id,
      toProject: options.to,
      fromProject: options.from,
      force: options.force,
      cwd: options.cwd ?? process.cwd(),
      actor: process.env.BRAINCLAW_AGENT_NAME || os.userInfo().username || 'unknown',
    });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`✔ Moved ${result.entity} ${result.id} (${result.subdir}) → ${result.to}`);
    for (const w of result.warnings) console.log(`  ⚠ ${w}`);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}
