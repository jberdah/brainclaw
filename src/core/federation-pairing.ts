/**
 * Cérémonie d'appairage — fédération v2 (pln#651 étape 4, RFC §5.2).
 *
 * C'est le chantier qui a motivé toute la recherche : l'enrôlement v1 était lourd et
 * fastidieux, et surtout il n'était pas sûr — présenter un PEM suffisait à activer un
 * agent. Ici, rejoindre un projet est une CÉRÉMONIE DE CLÉS.
 *
 * ── POURQUOI L'APPAIRAGE ET LA DISTRIBUTION DE CLÉS SONT UN SEUL CHANTIER ─────
 * On pourrait croire qu'un « enrôlement simple » d'abord, le chiffrement ensuite, serait
 * plus rapide. Ce serait faux deux fois. D'abord parce que la clé de chiffrement de
 * l'appareil doit être ATTESTÉE par son identité Ed25519 — sans quoi le Cloud, qui
 * orchestre l'appairage, peut insérer sa propre clé dans la liste d'enveloppement.
 * Ensuite parce que livrer les deux séparément produirait DEUX flux d'enrôlement et
 * imposerait de réenrôler tout le monde au moment de la bascule.
 *
 * ── INTERDIT DANS LE CHEMIN NOMINAL (dec#8) ──────────────────────────────────
 * Aucune clé d'API, aucun PEM, aucun agent_id, aucune variable d'environnement à copier
 * à la main. L'humain manipule UN code d'invitation et compare DEUX empreintes. Tout le
 * reste est dérivé localement ou négocié par le protocole.
 *
 * La clé d'API manuelle reste un mécanisme de compatibilité documenté, HORS de ce
 * parcours — et sa seule présence n'active plus rien (c'est le défaut v1 fermé en vague 1).
 */

import crypto from 'node:crypto';
import { nowISO } from './ids.js';
import { loadAgentSigningKey, ensureAgentSigningKey } from './agent-registry.js';
import { buildKeyAttestation, fingerprintPem } from './federation-attestation.js';
import {
  ensureDeviceKey,
  ensureFirstEpochKey,
  type DeviceKeyMaterial,
} from './federation-keyring.js';
import { logger } from './logger.js';
import {
  createConnectionState,
  loadConnectionState,
  saveConnectionState,
  newDeviceId,
  type FederationConnectionState,
  type DeviceRecord,
} from './federation-state.js';

export interface PairingTransport {
  /** POST JSON, retourne le corps parsé et le statut. Injecté pour être testable. */
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }>;
  get(path: string, headers?: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }>;
}

export class PairingError extends Error {
  constructor(message: string, readonly stage: string, readonly status?: number) {
    super(message);
    this.name = 'PairingError';
  }
}

/** Empreintes à MONTRER à l'humain pour qu'il les compare avec l'écran de l'approbateur. */
export interface PairingFingerprints {
  identity: string;
  encryption: string;
}

export interface PairingHandle {
  enrollment_id: string;
  cloud_project_id: string;
  device: DeviceKeyMaterial;
  fingerprints: PairingFingerprints;
  state: FederationConnectionState;
}

/**
 * Phases 1 à 3 du parcours : réclamer l'invitation, prouver la possession de l'identité,
 * attester la clé de chiffrement. Le tout SANS que l'humain ne copie autre chose que le
 * code d'invitation.
 *
 * REPRENABLE PAR CONSTRUCTION. Chaque phase est un appel distinct dont le résultat est
 * écrit avant la suivante, et la clé d'appareil n'est jamais régénérée si elle existe
 * (`ensureDeviceKey`). Une interruption laisse un enrollment en attente côté cloud, qui
 * expire proprement — jamais un orphelin non réclamable.
 */
export async function beginPairing(params: {
  inviteCode: string;
  agentId: string;
  transport: PairingTransport;
  cwd?: string;
  /** Identité d'appareil existante à réutiliser (reprise d'un appairage interrompu). */
  deviceId?: string;
}): Promise<PairingHandle> {
  const cwd = params.cwd ?? process.cwd();

  // (1) L'IDENTITÉ D'ABORD. `ensureAgentSigningKey` ne fait PAS tourner une clé
  // existante : une rotation silencieuse invaliderait l'empreinte déjà approuvée côté
  // cloud, et l'agent se retrouverait rejeté sans comprendre pourquoi.
  ensureAgentSigningKey(params.agentId);
  const identity = loadAgentSigningKey(params.agentId);
  if (!identity) {
    throw new PairingError(
      `Aucune clé d'identité Ed25519 pour l'agent '${params.agentId}'. La cérémonie ne peut pas commencer sans identité.`,
      'identity',
    );
  }

  // (2) RÉCLAMER L'INVITATION. Le code n'est jamais stocké — ni ici, ni côté cloud, qui
  // n'en garde que le SHA-256.
  const claimed = await params.transport.post('/api/v1/enrollments/claim', {
    invite_code: params.inviteCode,
    identity_public_key_pem: identity.publicKeyPem,
    agent_id: params.agentId,
  });
  if (claimed.status !== 200 && claimed.status !== 201) {
    throw new PairingError(describeError(claimed.body, "l'invitation n'a pas pu être réclamée"), 'claim', claimed.status);
  }

  const enrollmentId = asString(claimed.body['enrollment_id']);
  const cloudProjectId = asString(claimed.body['project_id']);
  const challenge = asString(claimed.body['pop_challenge']);
  if (!enrollmentId || !cloudProjectId || !challenge) {
    throw new PairingError('Réponse de claim incomplète (enrollment_id, project_id ou pop_challenge manquant).', 'claim');
  }

  // Le cloud renvoie l'empreinte qu'il a calculée. On la RECALCULE localement et on
  // compare : un désaccord signifie que la clé enregistrée n'est pas celle qu'on croit
  // avoir envoyée, ce qui invaliderait toute la chaîne d'attestation qui suit.
  const remoteIdentityFp = asString(claimed.body['identity_key_fingerprint']);
  const localIdentityFp = fingerprintPem(identity.publicKeyPem);
  if (remoteIdentityFp && remoteIdentityFp !== localIdentityFp) {
    throw new PairingError(
      `Empreinte d'identité divergente : le cloud a enregistré ${remoteIdentityFp}, cet appareil détient ${localIdentityFp}. ` +
      `Interrompre — la clé enregistrée n'est pas celle de cet appareil.`,
      'claim',
    );
  }

  // (3) LA CLÉ DE CHIFFREMENT DE L'APPAREIL. Distincte de l'identité, jamais dérivée
  // d'elle (RFC §5.1) — c'est ce qui rend « écrire sans lire » possible.
  const deviceId = params.deviceId ?? newDeviceId();
  const device = ensureDeviceKey(deviceId);

  // (4) PREUVE DE POSSESSION + ATTESTATION, EN UN SEUL ACTE. Les deux signatures sont
  // produites par la MÊME clé d'identité : c'est ce lien qui interdit à quiconque
  // d'attester une clé de chiffrement sans détenir l'identité approuvée.
  const challengeSignature = crypto
    .sign(null, Buffer.from(new TextEncoder().encode(challenge)), crypto.createPrivateKey(identity.privateKeyPem))
    .toString('base64');

  const attestation = buildKeyAttestation({
    enrollmentId,
    projectId: cloudProjectId,
    agentId: params.agentId,
    encryptionPublicKeyPem: device.public_key_pem,
    identityPrivateKeyPem: identity.privateKeyPem,
    // L'horodatage vient d'ICI et voyage avec la signature. Le serveur ne le fabrique
    // pas : il ne pourrait pas, l'appareil ayant signé avant qu'il ne l'apprenne.
    createdAt: nowISO(),
  });

  const proved = await params.transport.post(`/api/v1/enrollments/${enrollmentId}/prove`, {
    invite_code: params.inviteCode,
    challenge_signature: challengeSignature,
    encryption_public_key_pem: device.public_key_pem,
    attestation_signature: attestation.signature,
    attestation_created_at: attestation.created_at,
    key_type: 'encryption',
    key_purpose: 'envelope',
  });
  if (proved.status !== 200) {
    throw new PairingError(describeError(proved.body, "la preuve de possession a été refusée"), 'prove', proved.status);
  }

  // (5) ÉTAT LOCAL en 'pending'. Créer l'état ne vaut pas approbation — le passage à
  // 'active' appartient à la confirmation humaine, phase suivante.
  const deviceRecord: DeviceRecord = {
    device_id: deviceId,
    x25519_fingerprint: device.fingerprint,
    attested_by_ed25519: localIdentityFp,
    enrolled_at: nowISO(),
    // Le premier appareil est marqué récupération : sans cela, un projet mono-appareil
    // n'atteindrait jamais le quorum de RFC §5.3 et ne pourrait rien émettre. Le second
    // porteur reste exigé — `recoveryReadiness` continue de refuser tant qu'il manque.
    recovery: true,
  };
  const state = createConnectionState({
    cloudProjectId,
    device: deviceRecord,
    workspacePath: cwd,
    enrollmentId,
  });
  saveConnectionState(state, cwd);

  return {
    enrollment_id: enrollmentId,
    cloud_project_id: cloudProjectId,
    device,
    fingerprints: { identity: localIdentityFp, encryption: device.fingerprint },
    state,
  };
}

/**
 * Interroge l'état d'un enrollment en attente d'approbation.
 *
 * NE MATÉRIALISE RIEN. Le premier pull réel est en lecture seule et non destructif
 * (RFC §5.2 phase 4) ; cette fonction ne fait que lire un état de cérémonie.
 */
export async function checkPairingApproval(params: {
  enrollmentId: string;
  transport: PairingTransport;
  cwd?: string;
}): Promise<{ state: string; role?: string; approved: boolean }> {
  const res = await params.transport.get(`/api/v1/enrollments/${params.enrollmentId}`);
  if (res.status !== 200) {
    throw new PairingError(describeError(res.body, "l'état de l'enrôlement n'a pas pu être lu"), 'poll', res.status);
  }
  const enrollment = (res.body['enrollment'] ?? res.body) as Record<string, unknown>;
  const state = asString(enrollment['state']) ?? 'unknown';
  return { state, role: asString(enrollment['invited_role']), approved: state === 'active' };
}

/**
 * Bascule l'état local en 'active' une fois l'approbation obtenue.
 *
 * SÉPARÉ DU SONDAGE VOLONTAIREMENT : lire l'état distant et modifier l'état local sont
 * deux actes. Les fusionner ferait qu'une lecture de statut mute le workspace — un effet
 * de bord invisible dans une commande qu'on croit inoffensive.
 */
export function completePairing(params: {
  role?: string;
  cwd?: string;
}): FederationConnectionState {
  const cwd = params.cwd ?? process.cwd();
  const state = loadConnectionState(cwd);
  if (!state) {
    throw new PairingError("Aucun état d'appairage local — relancer `brainclaw cloud connect`.", 'complete');
  }
  // ── GENÈSE DE LA PREMIÈRE CLÉ D'EPOCH ───────────────────────────────────────
  //
  // Sans elle, l'appairage s'achevait sur `current_epoch: 0` et `known_epochs: []` : le
  // projet était « actif » et incapable de sceller quoi que ce soit, échouant sur « clé
  // d'epoch introuvable » sans qu'aucun message n'explique pourquoi. Mesuré le 2026-08-09 —
  // `storeEpochPrivateKey` n'avait aucun appelant de production.
  //
  // SEUL LE PREMIER APPAREIL crée. Un appareil qui rejoint un projet existant doit RECEVOIR
  // la clé par une remise attestée (dec#159) : en fabriquer une localement produirait un
  // second epoch au même numéro avec une clé différente, donc des enveloppes que personne
  // d'autre ne peut lire — et aucune erreur ne se déclencherait à l'émission.
  //
  // `peer_devices` vide est le signal disponible ici. Il est FAIBLE : un cloud hostile peut
  // prétendre qu'un projet peuplé est vide pour pousser ce client à forger un epoch
  // concurrent. Le roster signé de dec#159 est ce qui fermera ce trou ; en attendant, la
  // limite est nommée plutôt que tue.
  const isFirstDevice = (state.peer_devices?.length ?? 0) === 0;
  const epoch = state.keys.current_epoch > 0 ? state.keys.current_epoch : 1;
  let knownEpochs = state.keys.known_epochs;

  if (isFirstDevice) {
    const key = ensureFirstEpochKey(state.cloud_project_id, epoch);
    if (key.created) {
      logger.info(`Epoch ${epoch} créé pour ce projet — empreinte ${key.fingerprint}`);
    }
    knownEpochs = knownEpochs.includes(epoch) ? knownEpochs : [...knownEpochs, epoch];
  }

  const next: FederationConnectionState = {
    ...state,
    enrollment: { ...state.enrollment, stage: 'active', role: params.role ?? state.enrollment.role, updated_at: nowISO() },
    keys: { current_epoch: isFirstDevice ? epoch : state.keys.current_epoch, known_epochs: knownEpochs },
  };
  saveConnectionState(next, cwd);
  return next;
}

/**
 * Ce qu'un `disconnect` fait — et surtout ce qu'il NE FAIT PAS.
 *
 * Il retire l'autorisation LOCALE et demande la révocation distante. Il ne prétend pas
 * effacer les blobs déjà tirés ni les clés déjà lues par d'autres appareils (RFC §5.2).
 * Le dire est le contrat ; le taire laisserait croire à un effacement rétroactif que la
 * cryptographie ne permet pas.
 */
export async function requestRevocation(params: {
  enrollmentId: string;
  transport: PairingTransport;
  reason?: string;
}): Promise<{ revoked: boolean; detail?: string }> {
  try {
    const res = await params.transport.post(`/api/v1/enrollments/${params.enrollmentId}/revoke`, {
      reason: params.reason ?? 'disconnect local',
    });
    return { revoked: res.status === 200, detail: asString(res.body['error']) };
  } catch (err) {
    // Un cloud injoignable ne doit PAS empêcher de se déconnecter localement : sinon un
    // appareil perdu resterait autorisé faute de réseau. On rend l'échec, l'appelant
    // efface quand même le local et le dit à l'humain.
    return { revoked: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

// ── Aides ─────────────────────────────────────────────────────────────────────

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Remonte le message du serveur quand il y en a un, plutôt qu'un libellé générique. */
function describeError(body: Record<string, unknown>, fallback: string): string {
  const err = asString(body['error']);
  const code = asString(body['code']);
  if (err) return code ? `${err} (${code})` : err;
  return fallback;
}
