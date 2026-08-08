/**
 * Vérification à la réception — fédération v2 (pln#651 étape 6, RFC §6).
 *
 * ── LE TROU QUE CE MODULE FERME ───────────────────────────────────────────────
 * Avant lui, `pullSignalsFromCloud` faisait un simple `as { messages: … }` sans AUCUNE
 * vérification, puis `materializeFederationSignal` écrivait dans la mémoire locale via
 * saveCandidate et saveRuntimeNote. La signature Ed25519 existante était TRANSPORT
 * uniquement, edge→cloud, dans des en-têtes : elle n'était pas persistée dans l'enveloppe
 * et ne disait rien de l'origine du contenu.
 *
 * Conséquence : un cloud malveillant ne lisait pas la roadmap — elle est chiffrée — mais
 * pouvait INJECTER des candidates et des runtime_notes dans la mémoire de chaque agent
 * enrôlé. Soit un canal d'injection de prompt vers toute la flotte. Trois critiques sur
 * quatre l'ont classé bloquant, par trois angles distincts.
 *
 * Chiffrer les LECTURES en laissant les ÉCRITURES forgeables par l'opérateur qu'on
 * prétend neutraliser est le défaut structurel fermé ici.
 *
 * ── CE QUE LE CLOUD PEUT ENCORE FAIRE, ET QU'IL FAUT DIRE ─────────────────────
 * Il peut RETARDER ou OMETTRE une enveloppe. Aucune cryptographie ne l'en empêche : un
 * relais qui ne relaie pas est indétectable de l'intérieur. Ce qu'il ne peut plus faire,
 * c'est injecter, rejouer une ancienne révision comme courante, ou réordonner des
 * métadonnées sans être vu.
 */

import crypto from 'node:crypto';
import { canonicalJson } from './federation-canonical.js';
import { open as hpkeOpen } from './federation-hpke.js';
import {
  FederationEnvelopeSchema,
  originSigningInput,
  type FederationEnvelope,
  type FederatedKind,
} from './federation-projection.js';
import { acceptsRevision, recordRevision, type FederationConnectionState } from './federation-state.js';

/**
 * Roster attesté : l'ensemble des identités habilitées à ÉCRIRE pour ce projet.
 *
 * `key_id` est un pseudonyme stable ; la valeur est le PEM public Ed25519 attesté au
 * moment de l'appairage. Le vérificateur résout DANS CE ROSTER et jamais contre un `from`
 * autorapporté ni un en-tête HTTP — les deux étant fournis par la partie dont on se
 * méfie (RFC §3.1).
 */
export interface AttestedRoster {
  /** key_id → PEM public Ed25519. Une clé absente = émetteur inconnu = refus. */
  keys: Map<string, string>;
  /** key_id révoqués. Vérifiés SÉPARÉMENT de l'absence : révoqué ≠ jamais connu. */
  revoked?: Set<string>;
}

export type RejectionReason =
  | 'schema_invalid'         // l'enveloppe n'a pas la forme stricte attendue
  | 'unknown_signer'         // key_id absent du roster attesté
  | 'revoked_signer'         // key_id présent mais révoqué
  | 'bad_signature'          // la signature ne couvre pas ces octets
  | 'aad_mismatch'           // l'AAD de meta ne correspond pas à l'objet annoncé
  | 'replay_or_rollback'     // révision inférieure ou égale au high-water mark
  | 'duplicate'              // déjà matérialisé (idempotency_key connue)
  | 'undecryptable'          // AEAD refusé : clé absente, AAD divergent ou tag invalide
  | 'payload_type_mismatch'; // le clair ne correspond pas au kind annoncé

export interface VerificationRejected {
  ok: false;
  reason: RejectionReason;
  detail: string;
}

export interface VerificationAccepted {
  ok: true;
  envelope: FederationEnvelope;
  /** Clair vérifié. L'appelant matérialise à partir de CECI, jamais de l'enveloppe brute. */
  content: unknown;
  kind: FederatedKind;
  idempotencyKey: string;
  /** État de connexion avec la barrière anti-rejeu avancée. À persister par l'appelant. */
  nextState: FederationConnectionState;
}

export type VerificationResult = VerificationAccepted | VerificationRejected;

function reject(reason: RejectionReason, detail: string): VerificationRejected {
  return { ok: false, reason, detail };
}

/**
 * Vérifie la signature d'origine sur les octets canoniques complets.
 *
 * Toute exception — PEM illisible, signature mal encodée, mauvaise longueur — rend
 * `false` sans distinction. Laisser remonter l'erreur, ou différencier les causes,
 * donnerait un oracle sur la RAISON du refus ; du point de vue de l'appelant il n'y a
 * qu'un seul fait utile : ces octets ne sont pas signés par cette clé.
 */
function verifyOriginSignature(env: FederationEnvelope, signerPem: string): boolean {
  try {
    return crypto.verify(
      null,
      originSigningInput(env.meta, env.sealed, env.key_epoch),
      crypto.createPublicKey(signerPem),
      Buffer.from(env.origin_sig.value, 'base64url'),
    );
  } catch {
    return false;
  }
}

/**
 * Vérifie une enveloppe entrante. AUCUNE écriture locale n'a lieu ici — la fonction est
 * pure vis-à-vis du disque et rend un verdict.
 *
 * L'ORDRE DES CONTRÔLES EST UN CONTRAT (RFC §6) : parse strict → résolution du signataire
 * → signature → AAD → révocation → déchiffrement → cohérence du clair → anti-rejeu →
 * dédoublonnage. Déchiffrer AVANT d'avoir vérifié la signature exposerait le déchiffreur
 * à un ciphertext choisi par l'attaquant ; vérifier l'anti-rejeu avant la signature
 * laisserait un cloud faire avancer la barrière avec des révisions forgées, condamnant
 * les révisions légitimes qui suivent.
 */
export function verifyInbound(params: {
  raw: unknown;
  roster: AttestedRoster;
  state: FederationConnectionState;
  /** Clé privée X25519 de l'epoch correspondant. Absente = enveloppe non lisible ici. */
  epochPrivateKey?: crypto.KeyObject;
  /** Clés d'idempotence déjà matérialisées, pour le dédoublonnage (RFC §6.6). */
  seenIdempotencyKeys?: Set<string>;
}): VerificationResult {
  // (1) Parse STRICT. Une clé inconnue est refusée, pas retirée en silence : c'est le
  // pendant entrant du filet 2 du projecteur.
  const parsed = FederationEnvelopeSchema.safeParse(params.raw);
  if (!parsed.success) {
    return reject('schema_invalid', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const env = parsed.data;

  // (2) Résoudre le signataire DANS LE ROSTER ATTESTÉ.
  const signerPem = params.roster.keys.get(env.origin_sig.key_id);
  if (!signerPem) {
    return reject('unknown_signer', `key_id '${env.origin_sig.key_id}' absent du roster attesté.`);
  }
  // Révoqué et inconnu sont distingués : un opérateur doit pouvoir voir qu'un membre
  // révoqué continue d'émettre, ce qu'un « inconnu » générique masquerait.
  if (params.roster.revoked?.has(env.origin_sig.key_id)) {
    return reject('revoked_signer', `key_id '${env.origin_sig.key_id}' révoqué.`);
  }

  // (3) Signature sur les octets canoniques COMPLETS : meta, sealed (alg, enc, nonce,
  // ciphertext) et key_epoch. Couvrir meta est ce qui rend le réordonnancement de
  // priorité, de dépendances ou de statut détectable — le Cloud peut lire ces champs,
  // il ne peut pas les changer.
  if (!verifyOriginSignature(env, signerPem)) {
    return reject('bad_signature', "la signature d'origine ne couvre pas ces octets.");
  }

  // (4) L'AAD doit DÉCRIRE l'objet annoncé. Sans ce contrôle, une enveloppe légitime pour
  // l'objet A, correctement signée, pourrait être présentée comme concernant l'objet B :
  // la signature resterait valide puisqu'elle couvre meta, mais meta lui-même mentirait
  // sur sa cohérence interne.
  const aad = env.meta.aad;
  if (
    aad.object_id !== env.meta.id_opaque
    || aad.base_rev !== env.meta.base_rev
    || aad.object_type !== env.meta.kind
    || aad.cloud_project_id !== params.state.cloud_project_id
  ) {
    return reject('aad_mismatch', "l'AAD ne décrit pas l'objet annoncé par meta.");
  }

  // (5) Déchiffrement. Échoue FERMÉ : `hpkeOpen` ne distingue pas les causes, pour ne pas
  // offrir d'oracle sur la raison de l'échec.
  if (!params.epochPrivateKey) {
    return reject('undecryptable', `aucune clé détenue pour l'epoch ${env.key_epoch}.`);
  }
  const plaintext = hpkeOpen({
    recipientPrivateKey: params.epochPrivateKey,
    sealed: env.sealed,
    aadCanonicalBytes: new TextEncoder().encode(canonicalJson(aad)),
  });
  if (!plaintext) {
    return reject('undecryptable', 'AEAD refusé (clé, AAD ou tag).');
  }

  let content: unknown;
  try {
    content = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return reject('payload_type_mismatch', 'le clair déchiffré n\'est pas du JSON.');
  }
  if (content === null || typeof content !== 'object') {
    return reject('payload_type_mismatch', 'le clair déchiffré n\'est pas un objet.');
  }

  // (6) ANTI-REJEU. L'AEAD détecte l'ALTÉRATION, pas le REJEU d'un ciphertext valide et
  // ancien. Sans high-water mark, un cloud peut resservir un état antérieur comme s'il
  // était courant, et rien dans la cryptographie ne s'y oppose.
  //
  // Le dédoublonnage est vérifié AVANT le rejeu : une enveloppe DÉJÀ matérialisée a
  // légitimement une révision égale au high-water mark. La confondre avec un rejeu
  // rendrait tout retour d'un retry indistinguable d'une attaque.
  const idempotencyKey = env.meta.transport.idempotency_key;
  if (params.seenIdempotencyKeys?.has(idempotencyKey)) {
    return reject('duplicate', `opération déjà matérialisée (${idempotencyKey}).`);
  }
  if (!acceptsRevision(params.state, env.meta.id_opaque, env.meta.base_rev)) {
    const seen = params.state.sync.high_water[env.meta.id_opaque];
    return reject(
      'replay_or_rollback',
      `révision ${env.meta.base_rev} refusée pour ${env.meta.id_opaque} : high-water mark à ${seen}.`,
    );
  }

  return {
    ok: true,
    envelope: env,
    content,
    kind: env.meta.kind,
    idempotencyKey,
    nextState: recordRevision(params.state, env.meta.id_opaque, env.meta.base_rev),
  };
}

/**
 * Vérifie un lot d'enveloppes et rend le verdict de chacune.
 *
 * L'ÉTAT AVANCE AU FIL DU LOT, et l'ordre compte : deux révisions du même objet dans un
 * même lot doivent être appliquées dans l'ordre croissant, sinon la seconde est refusée
 * comme rollback — ce qui est le comportement voulu. Un lot est traité comme une suite
 * d'opérations, jamais comme un ensemble à réordonner selon ce que le Cloud propose.
 *
 * Le dédoublonnage accumule les clés vues DANS le lot en plus de celles déjà connues :
 * un cloud qui livrerait deux fois la même opération dans un seul lot serait sinon
 * accepté deux fois.
 */
export function verifyInboundBatch(params: {
  envelopes: unknown[];
  roster: AttestedRoster;
  state: FederationConnectionState;
  epochKeys: Map<number, crypto.KeyObject>;
  seenIdempotencyKeys?: Set<string>;
}): { results: VerificationResult[]; nextState: FederationConnectionState; accepted: number; rejected: number } {
  const seen = new Set(params.seenIdempotencyKeys ?? []);
  let state = params.state;
  const results: VerificationResult[] = [];
  let accepted = 0;

  for (const raw of params.envelopes) {
    // L'epoch est lu sur l'enveloppe AVANT vérification, uniquement pour choisir une clé.
    // Ce n'est pas une décision de confiance : une valeur mensongère mène simplement à
    // une clé qui n'ouvrira pas, donc à un refus.
    const epoch = typeof (raw as { key_epoch?: unknown })?.key_epoch === 'number'
      ? (raw as { key_epoch: number }).key_epoch
      : undefined;

    const result = verifyInbound({
      raw,
      roster: params.roster,
      state,
      epochPrivateKey: epoch === undefined ? undefined : params.epochKeys.get(epoch),
      seenIdempotencyKeys: seen,
    });
    results.push(result);

    if (result.ok) {
      // L'état n'avance QUE sur acceptation. Une enveloppe refusée ne doit laisser aucune
      // trace : ni barrière avancée, ni clé d'idempotence enregistrée. Sinon un cloud
      // hostile empoisonnerait l'état avec des enveloppes invalides et condamnerait les
      // révisions légitimes qui suivent.
      state = result.nextState;
      seen.add(result.idempotencyKey);
      accepted++;
    }
  }

  return { results, nextState: state, accepted, rejected: results.length - accepted };
}
