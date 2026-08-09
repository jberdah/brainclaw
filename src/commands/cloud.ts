/**
 * `brainclaw cloud connect / status / disconnect` — fédération v2 (pln#651 étapes 3 et 4).
 *
 * `connect` n'est pas une écriture de configuration : c'est une CÉRÉMONIE DE CLÉS. Elle
 * réclame une invitation, prouve la possession de l'identité Ed25519, atteste la clé de
 * chiffrement X25519 de l'appareil, puis attend une approbation humaine qui compare des
 * empreintes. Ce qui la rend indissociable de la distribution des clés est écrit dans
 * src/core/federation-pairing.ts.
 *
 * L'HUMAIN NE COPIE QU'UN CODE D'INVITATION, et compare deux empreintes. Aucune clé
 * d'API, aucun PEM, aucun agent_id, aucune variable d'environnement (dec#8).
 *
 * dec#154 exige que l'état de sync soit VISIBLE : un état pending/synced/conflict que seul
 * le code consulte transformerait le relais cloud en autorité silencieuse. C'est ce que
 * `status` rend.
 */

import { summarizeConnection, loadConnectionState, saveConnectionState } from '../core/federation-state.js';
import { forgetProjectEpochs } from '../core/federation-keyring.js';
import {
  beginPairing,
  checkPairingApproval,
  completePairing,
  requestRevocation,
  PairingError,
  type PairingTransport,
} from '../core/federation-pairing.js';
import { resolveEffectiveCwd } from '../core/store-resolution.js';
import { nowISO } from '../core/ids.js';

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
  console.log(`  Appareil : ${summary.device_fingerprint?.slice(0, 16) ?? '—'}…`);
  console.log(`  Epoch    : ${summary.current_epoch} (lisibles : ${summary.readable_epochs.join(', ') || 'aucun'})`);
  // Les agents appairés, un par ligne : c'est ce qu'un singleton v2 ne pouvait pas montrer.
  if (summary.pairings.length > 0) {
    console.log(`  Agents   :`);
    for (const p of summary.pairings) {
      const active = p.stage === 'active' ? '' : ` (${p.stage})`;
      console.log(`    • ${p.agent_id}${p.role ? ` [${p.role}]` : ''}${active}`);
    }
  } else {
    console.log(`  Rôle     : ${summary.role ?? '—'}`);
  }
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

// ── Transport HTTP ────────────────────────────────────────────────────────────

/**
 * Transport réel. Injecté partout ailleurs pour que la cérémonie soit exerçable sans
 * réseau — les tests font tourner un cloud simulé qui VÉRIFIE réellement les signatures,
 * ce qu'un serveur acceptant tout ne prouverait pas.
 */
export function httpTransport(baseUrl: string): PairingTransport {
  const url = (p: string): string => `${baseUrl.replace(/\/+$/, '')}${p}`;
  const call = async (
    method: 'POST' | 'GET',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(url(path), {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // Une réponse non-JSON (page d'erreur de proxy, 502 HTML) ne doit pas lever une
    // exception de parsing qui masquerait le vrai statut HTTP — c'est lui qui porte
    // l'information utile.
    let parsed: Record<string, unknown> = {};
    try { parsed = (await res.json()) as Record<string, unknown>; } catch { /* corps non-JSON */ }
    return { status: res.status, body: parsed };
  };
  return {
    post: (path, body) => call('POST', path, body),
    get: (path) => call('GET', path),
  };
}

// ── connect ───────────────────────────────────────────────────────────────────

export interface CloudConnectOptions {
  inviteCode: string;
  url: string;
  agentId: string;
  cwd?: string;
  json?: boolean;
  /** Injecté par les tests ; en usage réel le transport HTTP est construit ici. */
  transport?: PairingTransport;
}

export async function runCloudConnect(options: CloudConnectOptions): Promise<void> {
  const cwd = options.cwd ?? resolveEffectiveCwd();
  const transport = options.transport ?? httpTransport(options.url);

  let handle;
  try {
    handle = await beginPairing({
      inviteCode: options.inviteCode,
      agentId: options.agentId,
      transport,
      cwd,
    });
  } catch (err) {
    if (err instanceof PairingError) {
      console.error(`Appairage interrompu à l'étape « ${err.stage} » : ${err.message}`);
      // Fail-closed : un appairage refusé ne laisse aucune trace locale, donc relancer la
      // commande est sûr et ne laisse pas d'orphelin à nettoyer.
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  if (options.json) {
    console.log(JSON.stringify({
      enrollment_id: handle.enrollment_id,
      cloud_project_id: handle.cloud_project_id,
      device_id: handle.device.device_id,
      fingerprints: handle.fingerprints,
      awaiting: 'human_approval',
    }, null, 2));
    return;
  }

  console.log('Preuve de possession acceptée. Attestation de clé enregistrée.');
  console.log('');
  console.log('  Projet cloud : ' + handle.cloud_project_id);
  console.log('  Enrôlement   : ' + handle.enrollment_id);
  // LE WORKSPACE APPAIRÉ EST AFFICHÉ, et ce n'est pas décoratif.
  //
  // `cloud connect` appaire le RÉPERTOIRE COURANT, en silence. Le 2026-08-09, un appairage
  // destiné au dépôt core a lié le dépôt cloud parce que le terminal s'y trouvait encore
  // après un `wrangler login` : côté serveur tout était correct et attesté, côté machine
  // l'état vivait dans le mauvais projet — et rien, nulle part, ne le disait.
  //
  // C'est le seul moment où un humain regarde l'écran pendant cette cérémonie. La ligne
  // est donc placée AVEC les empreintes qu'il doit comparer, pas dans un journal.
  console.log('  Workspace    : ' + cwd);
  console.log('');
  // CES DEUX EMPREINTES SONT LE CŒUR DE LA CÉRÉMONIE. La personne qui approuve voit les
  // mêmes à l'écran ; leur comparaison hors bande est ce qui ferme l'attaque de l'homme
  // du milieu sur l'appairage. Affichées EN ENTIER, pas tronquées : une comparaison sur
  // 16 caractères se collisionne bien plus facilement qu'elle n'en a l'air.
  console.log("  Empreinte d'identité     (Ed25519) : " + handle.fingerprints.identity);
  console.log('  Empreinte de chiffrement (X25519)  : ' + handle.fingerprints.encryption);
  console.log('');
  console.log('  → Faites vérifier CES DEUX EMPREINTES par la personne qui approuve.');
  console.log("    Si elles diffèrent de ce qu'elle voit, REFUSEZ : quelqu'un s'est interposé.");
  console.log('');
  console.log("  En attente d'approbation humaine. Constatez-la avec : brainclaw cloud await");
}

// ── attente d'approbation ─────────────────────────────────────────────────────

export interface CloudAwaitOptions {
  url: string;
  cwd?: string;
  transport?: PairingTransport;
}

/**
 * Constate l'approbation et bascule l'état local en actif.
 *
 * SÉPARÉ DE `connect` : l'approbation dépend d'un humain, dont le délai n'est pas borné.
 * Une commande qui bloquerait indéfiniment sur un tiers serait un mauvais citoyen dans un
 * script, et un appairage interrompu par un Ctrl-C doit rester reprenable.
 */
export async function runCloudAwait(options: CloudAwaitOptions): Promise<void> {
  const cwd = options.cwd ?? resolveEffectiveCwd();
  const state = loadConnectionState(cwd);
  if (!state?.enrollment.enrollment_id) {
    console.error("Aucun appairage en cours sur ce workspace. Lancez d'abord : brainclaw cloud connect");
    process.exitCode = 1;
    return;
  }

  const transport = options.transport ?? httpTransport(options.url);
  const result = await checkPairingApproval({ enrollmentId: state.enrollment.enrollment_id, transport, cwd });

  if (!result.approved) {
    console.log(`Toujours en attente (état distant : ${result.state}).`);
    return;
  }

  const next = completePairing({ role: result.role, cwd });
  console.log(`Appairage approuvé. Rôle : ${next.enrollment.role ?? '—'}.`);
  console.log('');
  // Le premier pull est en LECTURE SEULE et non destructif (RFC §5.2 phase 4) : rien
  // n'est matérialisé dans la mémoire locale tant que la vérification d'origine n'existe
  // pas. Le dire évite qu'on croie la synchronisation déjà active.
  console.log("  Aucune donnée n'est encore matérialisée : la vérification à la réception");
  console.log("  (signature d'origine, anti-rejeu) est livrée à l'étape suivante.");
}

// ── disconnect ────────────────────────────────────────────────────────────────

export interface CloudDisconnectOptions {
  url: string;
  cwd?: string;
  transport?: PairingTransport;
  forgetKeys?: boolean;
}

export async function runCloudDisconnect(options: CloudDisconnectOptions): Promise<void> {
  const cwd = options.cwd ?? resolveEffectiveCwd();
  const state = loadConnectionState(cwd);
  if (!state) {
    console.log("Ce workspace n'est pas appairé — rien à déconnecter.");
    return;
  }

  let revocationNote = "aucune révocation distante demandée (pas d'enrôlement connu)";
  if (state.enrollment.enrollment_id) {
    const transport = options.transport ?? httpTransport(options.url);
    const res = await requestRevocation({ enrollmentId: state.enrollment.enrollment_id, transport });
    revocationNote = res.revoked
      ? 'autorisation distante révoquée'
      : `révocation distante NON confirmée (${res.detail ?? 'raison inconnue'})`;
  }

  // L'état local passe en 'revoked' MÊME SI le cloud est injoignable : sinon un appareil
  // perdu resterait autorisé faute de réseau, exactement l'inverse de ce qu'une
  // révocation doit garantir.
  saveConnectionState(
    { ...state, enrollment: { ...state.enrollment, stage: 'revoked', updated_at: nowISO() } },
    cwd,
  );

  let keysNote = "trousseau conservé (utilisez --forget-keys pour l'effacer)";
  if (options.forgetKeys) {
    const removed = forgetProjectEpochs(state.cloud_project_id);
    keysNote = `${removed} clé(s) d'epoch effacée(s) — le passé scellé de ce projet devient illisible ici`;
  }

  console.log('Déconnecté.');
  console.log(`  ${revocationNote}`);
  console.log(`  ${keysNote}`);
  console.log('');
  // Énoncé plutôt que tu : prétendre l'inverse serait une promesse que la cryptographie
  // ne tient pas (RFC §5.2).
  console.log("  Ce qui N'EST PAS effacé : les données déjà tirées et déchiffrées localement,");
  console.log("  et ce que d'autres appareils détiennent déjà. Un disconnect retire une");
  console.log('  autorisation ; il ne réécrit pas le passé.');
}

// ── Projection : émettre puis pousser ────────────────────────────────────────

export interface CloudPushOptions {
  cwd?: string;
  url?: string;
  dryRun?: boolean;
  limit?: number;
  json?: boolean;
}

/**
 * `brainclaw cloud push` — projette les plans et la mémoire projet vers le cloud.
 *
 * DEUX TEMPS EXPLICITES, et jamais confondus dans l'affichage : ce qui a été SCELLÉ ET MIS
 * EN FILE, puis ce qui a été ENVOYÉ. Un objet peut être scellé sans partir (réseau coupé)
 * et l'opérateur doit le voir : afficher un seul nombre laisserait croire qu'une projection
 * mise en file est arrivée.
 *
 * Les refus des trois filets sont AFFICHÉS, un par un. Un objet refusé n'est pas un objet
 * en retard : c'est un objet qui ne partira jamais tant que la cause n'est pas corrigée.
 */
export async function runCloudPush(options: CloudPushOptions = {}): Promise<void> {
  const cwd = options.cwd ?? resolveEffectiveCwd();
  const { emitProjections } = await import('../core/federation-emit.js');
  const { pushPending } = await import('../core/federation-push.js');

  const emitted = emitProjections({ cwd, dryRun: options.dryRun });
  const pushed = await pushPending({ cwd, url: options.url, dryRun: options.dryRun, limit: options.limit });

  if (options.json) {
    console.log(JSON.stringify({ emitted, pushed, dry_run: Boolean(options.dryRun) }, null, 2));
    return;
  }

  const mode = options.dryRun ? ' (simulation — rien n\'a été écrit ni envoyé)' : '';
  console.log(`Projection${mode}`);
  console.log(`  collectés        : ${emitted.collected}`);
  console.log(`  mis en file      : ${emitted.enqueued}`);
  console.log(`  déjà en file     : ${emitted.skipped_duplicate}`);
  if (emitted.refused > 0) {
    console.log(`  REFUSÉS          : ${emitted.refused}`);
    for (const r of emitted.refusals) console.log(`    ${r.kind} ${r.id} — ${r.reason}`);
  }
  console.log(`  envoyés          : ${pushed.sent} / ${pushed.attempted}`);
  if (pushed.conflicts > 0) console.log(`  CONFLITS         : ${pushed.conflicts} (révision périmée — un renvoi échouerait pareil)`);
  if (pushed.failed > 0) {
    console.log(`  échecs           : ${pushed.failed} — restent en attente, la tentative est comptée`);
    for (const e of pushed.errors) console.log(`    ${e.idempotency_key} — ${e.status ?? 'réseau'} ${e.reason}`);
  }
}
