import type { Command } from 'commander';
import { runCloudStatus } from '../commands/cloud.js';

/**
 * Fédération v2 (pln#651 étape 3). Seul `status` existe à ce stade — voir
 * src/commands/cloud.ts pour pourquoi `connect`/`disconnect` attendent l'étape 4.
 */
export function registerCloudCommands(program: Command): void {
  const cloud = program
    .command('cloud')
    .description('Fédération cloud v2 : état de connexion, epochs de clés et sync');

  cloud
    .command('status')
    .description('Affiche le projet lié, le rôle, l\'epoch de clé courant et les trois états de sync')
    .option('--json', 'Sortie JSON')
    .action((options: { json?: boolean }) => {
      runCloudStatus({ json: options.json });
    });
}
