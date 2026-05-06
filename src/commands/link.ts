import { requireInitialized } from '../core/guards.js';
import { resolveTargetStore, type StoreTarget } from '../core/store-resolution.js';
import {
  addCrossProjectLink,
  removeCrossProjectLink,
  resolveCrossProjectLinks,
} from '../core/cross-project.js';

export interface LinkOptions {
  name?: string;
  role?: 'subscriber' | 'publisher';
  channels?: string[];
  force?: boolean;
  json?: boolean;
  cwd?: string;
  store?: StoreTarget;
}

export function runLink(subcommand: string, args: string[], options: LinkOptions = {}): void {
  const cwd = resolveTargetStore(options.cwd ?? process.cwd(), options.store ?? 'local');
  requireInitialized(cwd);

  switch (subcommand) {
    case 'add': {
      const target = args[0];
      if (!target) {
        console.error('Error: link add requires <path>');
        console.error('Usage: brainclaw link add <path> [--name <slug>] [--role publisher|subscriber] [--channels candidate,handoff,runtime_note] [--force]');
        process.exit(1);
      }
      try {
        const link = addCrossProjectLink({
          path: target,
          name: options.name,
          role: options.role,
          channels: options.channels,
          force: options.force,
          cwd,
        });
        if (options.json) {
          console.log(JSON.stringify(link, null, 2));
        } else {
          console.log(`✔ Linked '${link.name ?? link.path}' (path=${link.path}, role=${link.role}${link.channels?.length ? `, channels=${link.channels.join(',')}` : ''})`);
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    case 'list':
    case 'ls': {
      const links = resolveCrossProjectLinks(cwd);
      if (options.json) {
        console.log(JSON.stringify(links, null, 2));
        return;
      }
      if (links.length === 0) {
        console.log('No cross-project links configured.');
        console.log('Add one with: brainclaw link add <path> [--role publisher|subscriber]');
        return;
      }
      console.log(`\n${links.length} cross-project link(s):\n`);
      for (const link of links) {
        const availability = link.available ? '✓' : '✗ (target not initialised)';
        const channels = link.channels?.length ? ` [${link.channels.join(',')}]` : '';
        console.log(`  ${link.projectName}  ${availability}`);
        console.log(`      path:  ${link.path}`);
        console.log(`      abs:   ${link.absolutePath}`);
        console.log(`      role:  ${link.role}${channels}`);
      }
      console.log('');
      break;
    }

    case 'remove':
    case 'rm': {
      const target = args[0];
      if (!target) {
        console.error('Error: link remove requires <name|path>');
        process.exit(1);
      }
      try {
        const removed = removeCrossProjectLink(target, cwd);
        if (options.json) {
          console.log(JSON.stringify(removed, null, 2));
        } else {
          console.log(`✔ Removed cross-project link '${removed.name ?? removed.path}'`);
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown link subcommand: ${subcommand}`);
      console.error('Usage: brainclaw link <add|list|remove> ...');
      process.exit(1);
  }
}
