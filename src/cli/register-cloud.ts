import type { Command } from 'commander';
import {
  runCloudStatus,
  runCloudConnect,
  runCloudAwait,
  runCloudDisconnect,
  runCloudPush,
} from '../commands/cloud.js';

/** Adresse du cloud. Fournie par `--url`, sans quoi la commande demande de la préciser. */
const DEFAULT_URL_HINT = 'https://<votre-déploiement>.workers.dev';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/**
 * Fédération v2 (pln#651 étapes 3 et 4).
 *
 * `connect` est une CÉRÉMONIE DE CLÉS, pas une écriture de configuration — voir
 * src/core/federation-pairing.ts. L'humain ne manipule qu'un code d'invitation et compare
 * deux empreintes ; aucune clé d'API, aucun PEM, aucune variable d'environnement (dec#8).
 */
export function registerCloudCommands(program: Command): void {
  const cloud = program
    .command('cloud')
    .description('Fédération cloud v2 : appairage attesté, état de connexion, epochs de clés');

  cloud
    .command('status')
    .description("Affiche le projet lié, le rôle, l'epoch de clé courant et les trois états de sync")
    .option('--json', 'Sortie JSON')
    .action((options: { json?: boolean }) => {
      runCloudStatus({ json: options.json });
    });

  cloud
    .command('push')
    .description('Projette les plans et la mémoire projet vers le cloud : scelle, met en file, puis envoie')
    .requiredOption('--url <url>', `Adresse du déploiement cloud (ex. ${DEFAULT_URL_HINT})`)
    .option('--dry-run', "N'écrit ni n'envoie rien : rapporte ce qui partirait")
    .option('--limit <n>', 'Borne le lot envoyé', (v: string) => Number.parseInt(v, 10))
    .option('--json', 'Sortie JSON')
    .action(async (options: { url: string; dryRun?: boolean; limit?: number; json?: boolean }) => {
      try {
        await runCloudPush(options);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });

  cloud
    .command('connect <invite-code>')
    .description("Rejoint un projet cloud : réclame l'invitation, prouve la possession de l'identité et atteste la clé de chiffrement de cet appareil")
    .requiredOption('--url <url>', `Adresse du déploiement cloud (ex. ${DEFAULT_URL_HINT})`)
    .requiredOption('--agent <id>', "Identifiant d'agent à enrôler (opaque, 4 à 64 caractères)")
    .option('--json', 'Sortie JSON')
    .action(async (inviteCode: string, options: { url: string; agent: string; json?: boolean }) => {
      await runCloudConnect({
        inviteCode,
        url: options.url,
        agentId: options.agent,
        json: options.json,
      }).catch((err: unknown) => fail(`Erreur : ${err instanceof Error ? err.message : String(err)}`));
    });

  cloud
    .command('await')
    .description("Constate l'approbation humaine et active l'appairage local")
    // Commande DISTINCTE de connect : l'approbation dépend d'un humain dont le délai
    // n'est pas borné. Bloquer indéfiniment sur un tiers ferait un mauvais citoyen dans
    // un script, et une interruption doit rester reprenable.
    .requiredOption('--url <url>', 'Adresse du déploiement cloud')
    .action(async (options: { url: string }) => {
      await runCloudAwait({ url: options.url })
        .catch((err: unknown) => fail(`Erreur : ${err instanceof Error ? err.message : String(err)}`));
    });

  cloud
    .command('disconnect')
    .description("Retire l'autorisation locale et demande la révocation distante")
    .requiredOption('--url <url>', 'Adresse du déploiement cloud')
    // Effacer le trousseau rend DÉFINITIVEMENT illisible tout ce qui a été scellé sous
    // ces epochs. Ce n'est donc pas le défaut : on le demande explicitement.
    .option('--forget-keys', "Efface aussi les clés d'epoch de ce projet (le passé scellé devient illisible ici)")
    .action(async (options: { url: string; forgetKeys?: boolean }) => {
      await runCloudDisconnect({ url: options.url, forgetKeys: options.forgetKeys })
        .catch((err: unknown) => fail(`Erreur : ${err instanceof Error ? err.message : String(err)}`));
    });
}
