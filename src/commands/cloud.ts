/**
 * `brainclaw cloud status` — surface observable de l'état de connexion (pln#651 étape 3).
 *
 * `connect` et `disconnect` appartiennent à l'étape 4 : ce sont des CÉRÉMONIES DE CLÉS,
 * pas de simples écritures d'état. Les livrer ici, avant l'attestation, produirait un
 * enrôlement « simple » qu'il faudrait refaire — et imposerait de réenrôler tout le monde
 * (RFC §5.2). `status` est la seule des trois qui ne mute rien, donc la seule qui puisse
 * exister avant.
 *
 * POURQUOI CETTE COMMANDE EST LE CRITÈRE DE SORTIE ET NON UN CONFORT : dec#154 exige que
 * l'état de sync soit VISIBLE. Un état pending/synced/conflict que seul le code consulte
 * transformerait le relais cloud en autorité silencieuse.
 */

import { summarizeConnection } from '../core/federation-state.js';
import { resolveEffectiveCwd } from '../core/store-resolution.js';

export interface CloudStatusOptions {
  json?: boolean;
  cwd?: string;
}

export function runCloudStatus(options: CloudStatusOptions = {}): void {
  const cwd = options.cwd ?? resolveEffectiveCwd();
  const summary = summarizeConnection(cwd);

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (summary.stage === 'unpaired') {
    console.log('Cloud : non appairé.');
    console.log("  Aucun sync n'a lieu tant qu'aucun appairage n'a été fait explicitement.");
    // Énoncé volontairement, parce que c'est le défaut que la v2 ferme : en v1 la seule
    // présence de BRAINCLAW_CLOUD_API_KEY valait consentement, et jusqu'à 100 signaux
    // étaient tirés puis écrits dans le store local à chaque démarrage de session.
    return;
  }

  console.log(`Cloud : ${summary.stage}${summary.connected ? '' : ' (pas encore actif)'}`);
  console.log(`  Projet   : ${summary.cloud_project_id ?? '—'}`);
  console.log(`  Rôle     : ${summary.role ?? '—'}`);
  console.log(`  Appareil : ${summary.device_fingerprint?.slice(0, 16) ?? '—'}…`);
  console.log(`  Epoch    : ${summary.current_epoch} (lisibles : ${summary.readable_epochs.join(', ') || 'aucun'})`);
  console.log(`  Sync     : ${summary.sync.pending} en attente · ${summary.sync.synced} synchronisé(s) · ${summary.sync.conflict} conflit(s)`);
  if (summary.last_pull_at) console.log(`  Dernier pull : ${summary.last_pull_at}`);

  if (!summary.recovery.ready) {
    console.log('');
    console.log(`  ⚠ Récupération : ${summary.recovery.reason}`);
  }

  if (summary.sync.conflict > 0) {
    console.log('');
    // Un conflit ne se résout JAMAIS par last-write-wins silencieux (dec#154) : il est
    // présenté, avec une proposition, et attend une décision.
    console.log(`  ${summary.sync.conflict} opération(s) en conflit attendent une résolution explicite.`);
  }
}
