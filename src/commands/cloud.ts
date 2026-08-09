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

/** Une invitation n'est volontairement valable que quinze minutes. */
export const INVITATION_TTL_MS = 15 * 60 * 1_000;
export const APPROVAL_POLL_INTERVAL_MS = 5_000;
export const AGENT_ID_PATTERN = /^[a-zA-Z0-9_-]{4,64}$/;

const ACTIVATION_URL_FORM = 'https://app.brainclaw.dev/a#<code>';
const DEFAULT_CLOUD_URL_FORM = 'https://<votre-déploiement>.workers.dev';

/**
 * Données locales extraites d'une entrée d'activation. Le fragment reste toujours
 * local : seul `url`, qui est une origine sans fragment, est ensuite donné au transport.
 */
export interface ActivationInput {
  inviteCode: string;
  url?: string;
}

/**
 * Accepte le code historique ou l'URL d'activation. Une URL est délibérément limitée
 * à `/a#<code>` : cela évite de prendre un code depuis une URL de route API ou de le
 * transmettre par erreur dans un chemin ou une query string.
 */
export function parseActivationInput(input: string): ActivationInput {
  const value = input.trim();
  if (!value) {
    throw new Error(`Code ou URL d'activation attendu (ex. ${ACTIVATION_URL_FORM}).`);
  }
  if (!/^[a-z][a-z\d+.-]*:/i.test(value)) return { inviteCode: value };

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`URL d'activation invalide. Forme attendue : ${ACTIVATION_URL_FORM}.`);
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    || parsed.pathname !== '/a'
    || parsed.search
    || parsed.username
    || parsed.password
    || !parsed.hash.slice(1)
  ) {
    throw new Error(`URL d'activation invalide. Forme attendue : ${ACTIVATION_URL_FORM}.`);
  }

  let inviteCode: string;
  try {
    inviteCode = decodeURIComponent(parsed.hash.slice(1));
  } catch {
    throw new Error(`Code d'activation invalide dans l'URL. Forme attendue : ${ACTIVATION_URL_FORM}.`);
  }
  if (!inviteCode) {
    throw new Error(`Code d'activation manquant dans l'URL. Forme attendue : ${ACTIVATION_URL_FORM}.`);
  }
  return { inviteCode, url: parsed.origin };
}

/** Valide avant toute construction ou utilisation de transport réseau. */
export function validateAgentId(agentId: string): string {
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new Error("Identifiant d'agent invalide : utilisez 4 à 64 caractères parmi a-z, A-Z, 0-9, _ et -.");
  }
  return agentId;
}

/**
 * Normalise l'origine de déploiement et n'accepte jamais un fragment : le code
 * d'invitation ne doit pas pouvoir passer au transport HTTP.
 */
export function normalizeCloudUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Adresse cloud invalide. Utilisez une origine HTTPS, par ex. ${DEFAULT_CLOUD_URL_FORM}.`);
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(`Adresse cloud invalide. Utilisez une origine HTTPS, par ex. ${DEFAULT_CLOUD_URL_FORM}.`);
  }
  return parsed.origin;
}

/** Résout l'option explicite, sinon l'origine mémorisée lors de l'appairage v3. */
export function resolveCloudUrl(
  explicitUrl: string | undefined,
  state: ReturnType<typeof loadConnectionState>,
): string {
  const url = explicitUrl ?? state?.cloud_url;
  if (!url) {
    throw new Error(`Adresse cloud inconnue. Donnez --url ${DEFAULT_CLOUD_URL_FORM} ou utilisez l'URL d'activation ${ACTIVATION_URL_FORM}.`);
  }
  return normalizeCloudUrl(url);
}

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

export interface CloudApprovalPollingOptions {
  enrollmentId: string;
  cwd: string;
  transport: PairingTransport;
  /** Horloge et attente injectables : les tests ne dorment jamais réellement. */
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  pollIntervalMs?: number;
  timeoutMs?: number;
  onPending?: (state: string, remainingMs: number) => void;
}

export type CloudApprovalResult = Awaited<ReturnType<typeof checkPairingApproval>> & { timedOut: boolean };

const sleepFor = (delayMs: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, delayMs));

/** Affichage concis du délai restant, sans prétendre connaître l'heure serveur. */
export function formatApprovalTimeRemaining(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`;
}

/**
 * L'approbation est humaine, mais son attente est bornée par le TTL de l'invitation.
 * Le transport et l'horloge sont injectables afin que le comportement temporel reste
 * testable sans requête ni temporisation réelle.
 */
export async function waitForPairingApproval(options: CloudApprovalPollingOptions): Promise<CloudApprovalResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepFor;
  const timeoutMs = Math.max(0, Math.min(options.timeoutMs ?? INVITATION_TTL_MS, INVITATION_TTL_MS));
  const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? APPROVAL_POLL_INTERVAL_MS);
  const deadline = now() + timeoutMs;

  while (true) {
    const result = await checkPairingApproval({
      enrollmentId: options.enrollmentId,
      transport: options.transport,
      cwd: options.cwd,
    });
    if (result.approved) return { ...result, timedOut: false };

    const remainingMs = deadline - now();
    if (remainingMs <= 0) return { ...result, timedOut: true };
    options.onPending?.(result.state, remainingMs);
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
}

// ── connect ───────────────────────────────────────────────────────────────────

export interface CloudConnectOptions {
  /** Code nu historique ou URL `https://…/a#<code>`. */
  inviteCode: string;
  /** Facultatif avec une URL d'activation ou un appairage déjà mémorisé. */
  url?: string;
  agentId: string;
  cwd?: string;
  json?: boolean;
  /** Injecté par les tests ; en usage réel le transport HTTP est construit ici. */
  transport?: PairingTransport;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

function reportApprovalTimeout(): void {
  console.error("L'approbation n'est pas arrivée avant l'expiration de l'invitation (15 min).");
  console.error("Relancez `brainclaw cloud connect` avec une nouvelle URL d'activation. `cloud await` reste disponible après une interruption.");
  process.exitCode = 1;
}

function completeApprovedPairing(cwd: string, role: Awaited<ReturnType<typeof checkPairingApproval>>['role']): void {
  const next = completePairing({ role, cwd });
  console.log(`Appairage approuvé. Rôle : ${next.enrollment.role ?? '—'}.`);
  console.log('');
  // Le premier pull est en LECTURE SEULE et non destructif (RFC §5.2 phase 4) : rien
  // n'est matérialisé dans la mémoire locale tant que la vérification d'origine n'existe
  // pas. Le dire évite qu'on croie la synchronisation déjà active.
  console.log("  Aucune donnée n'est encore matérialisée : la vérification à la réception");
  console.log("  (signature d'origine, anti-rejeu) est livrée à l'étape suivante.");
}

export async function runCloudConnect(options: CloudConnectOptions): Promise<void> {
  const cwd = options.cwd ?? resolveEffectiveCwd();
  const activation = parseActivationInput(options.inviteCode);
  // Cette validation doit rester avant le moindre appel du transport : un identifiant
  // invalide ne doit jamais consommer une invitation ni créer une candidature distante.
  const agentId = validateAgentId(options.agentId);
  const existing = loadConnectionState(cwd);
  const explicitUrl = options.url ? normalizeCloudUrl(options.url) : undefined;
  if (activation.url && explicitUrl && activation.url !== explicitUrl) {
    throw new Error("L'origine de `--url` ne correspond pas à celle de l'URL d'activation.");
  }
  const url = activation.url ?? resolveCloudUrl(explicitUrl, existing);
  const transport = options.transport ?? httpTransport(url);

  let handle;
  try {
    handle = await beginPairing({
      inviteCode: activation.inviteCode,
      agentId,
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

  const pending = loadConnectionState(cwd);
  if (!pending) throw new Error("L'état d'appairage n'a pas pu être enregistré localement.");
  // V3 mémorise l'ORIGINE uniquement, jamais l'URL d'activation ni son fragment/code.
  saveConnectionState({ ...pending, cloud_url: url }, cwd);

  if (!options.json) {
    console.log('Preuve de possession acceptée. Attestation de clé enregistrée.');
    console.log('');
    console.log('  Projet cloud : ' + handle.cloud_project_id);
    console.log('  Enrôlement   : ' + handle.enrollment_id);
    console.log('  Workspace    : ' + cwd);
    console.log('');
    console.log("  Empreinte d'identité     (Ed25519) : " + handle.fingerprints.identity);
    console.log('  Empreinte de chiffrement (X25519)  : ' + handle.fingerprints.encryption);
    console.log('');
    console.log('  → Faites vérifier CES DEUX EMPREINTES par la personne qui approuve.');
    console.log("    Si elles diffèrent de ce qu'elle voit, REFUSEZ : quelqu'un s'est interposé.");
    console.log('');
    console.log("  En attente d'approbation humaine (expiration de l'invitation dans 15 min 00 s).");
  }

  const result = await waitForPairingApproval({
    enrollmentId: handle.enrollment_id,
    transport,
    cwd,
    now: options.now,
    sleep: options.sleep,
    pollIntervalMs: options.pollIntervalMs,
    timeoutMs: options.timeoutMs,
    onPending: options.json
      ? undefined
      : (state, remainingMs) => console.log(`  Toujours en attente (${state}) — expiration dans ${formatApprovalTimeRemaining(remainingMs)}.`),
  });
  if (!result.approved) {
    if (options.json) {
      console.log(JSON.stringify({
        enrollment_id: handle.enrollment_id,
        cloud_project_id: handle.cloud_project_id,
        awaiting: result.state,
        expired: result.timedOut,
      }, null, 2));
    }
    reportApprovalTimeout();
    return;
  }

  if (options.json) {
    const next = completePairing({ role: result.role, cwd });
    console.log(JSON.stringify({
      enrollment_id: handle.enrollment_id,
      cloud_project_id: handle.cloud_project_id,
      device_id: handle.device.device_id,
      fingerprints: handle.fingerprints,
      role: next.enrollment.role,
      approved: true,
    }, null, 2));
    return;
  }
  completeApprovedPairing(cwd, result.role);
}

// ── attente d'approbation ─────────────────────────────────────────────────────

export interface CloudAwaitOptions {
  url?: string;
  cwd?: string;
  transport?: PairingTransport;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

/**
 * Reprend un appairage interrompu. Comme `connect`, l'attente est bornée au TTL de
 * quinze minutes : elle ne bloque donc pas indéfiniment un terminal ou un script.
 */
export async function runCloudAwait(options: CloudAwaitOptions = {}): Promise<void> {
  const cwd = options.cwd ?? resolveEffectiveCwd();
  const state = loadConnectionState(cwd);
  if (!state?.enrollment.enrollment_id) {
    console.error("Aucun appairage en cours sur ce workspace. Lancez d'abord : brainclaw cloud connect");
    process.exitCode = 1;
    return;
  }

  const url = resolveCloudUrl(options.url, state);
  const transport = options.transport ?? httpTransport(url);
  const result = await waitForPairingApproval({
    enrollmentId: state.enrollment.enrollment_id,
    transport,
    cwd,
    now: options.now,
    sleep: options.sleep,
    pollIntervalMs: options.pollIntervalMs,
    timeoutMs: options.timeoutMs,
    onPending: (remoteState, remainingMs) => console.log(`Toujours en attente (état distant : ${remoteState}) — expiration dans ${formatApprovalTimeRemaining(remainingMs)}.`),
  });
  if (!result.approved) {
    reportApprovalTimeout();
    return;
  }
  completeApprovedPairing(cwd, result.role);
}
// ── disconnect ────────────────────────────────────────────────────────────────

export interface CloudDisconnectOptions {
  url?: string;
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
    const url = resolveCloudUrl(options.url, state);
    const transport = options.transport ?? httpTransport(url);
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
export interface CloudPullOptions {
  cwd?: string;
  url?: string;
  limit?: number;
  json?: boolean;
}

/** Réception v2 : delta reçu et écritures locales sont affichés séparément. */
export async function runCloudPull(options: CloudPullOptions = {}): Promise<void> {
  const cwd = options.cwd ?? resolveEffectiveCwd();
  const { pullFederationDelta } = await import('../core/federation-pull.js');
  const url = resolveCloudUrl(options.url, loadConnectionState(cwd));
  const pulled = await pullFederationDelta({ cwd, url, limit: options.limit });
  if (options.json) {
    console.log(JSON.stringify(pulled, null, 2));
    return;
  }
  console.log('Réception fédérée');
  console.log(`  reçues          : ${pulled.received}`);
  console.log(`  vérifiées        : ${pulled.verified}`);
  console.log(`  matérialisées    : ${pulled.materialized}`);
  if (pulled.unreadable_epoch_absent.length) {
    console.log(`  ILLISIBLES       : ${pulled.unreadable_epoch_absent.length} — conservées, jamais jetées`);
    for (const item of pulled.unreadable_epoch_absent) console.log(`    epoch ${item.key_epoch ?? '?'} — ${item.reason}`);
  }
  if (pulled.deferred.length) {
    console.log(`  différées        : ${pulled.deferred.length}`);
    for (const item of pulled.deferred) console.log(`    ${item.idempotency_key ?? 'sans clé'} — ${item.reason}`);
  }
  if (pulled.rejected.length) {
    console.log(`  REJETÉES         : ${pulled.rejected.length}`);
    for (const item of pulled.rejected) console.log(`    ${item.idempotency_key ?? 'sans clé'} — ${item.reason}`);
  }
  console.log(`  curseur feed     : ${pulled.feed_cursor ?? 'inchangé'}`);
  console.log('');
  console.log(`  ⚠ ${pulled.roster_limitation}`);
}
/**
 * `brainclaw cloud push` — projette les plans et la mémoire projet vers le cloud.
 * Les états de mise en file et d'envoi sont volontairement affichés séparément.
 */export async function runCloudPush(options: CloudPushOptions = {}): Promise<void> {
  const cwd = options.cwd ?? resolveEffectiveCwd();
  const { emitProjections } = await import('../core/federation-emit.js');
  const { pushPending } = await import('../core/federation-push.js');
  const url = resolveCloudUrl(options.url, loadConnectionState(cwd));

  const emitted = emitProjections({ cwd, dryRun: options.dryRun });
  const pushed = await pushPending({ cwd, url, dryRun: options.dryRun, limit: options.limit });

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
