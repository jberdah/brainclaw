/**
 * HPKE mode base — DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / ChaCha20-Poly1305.
 * Suite v1 du RFC fédération §3.1, conforme à la RFC 9180.
 *
 * ── POURQUOI CE CODE EXISTE PLUTÔT QU'UNE DÉPENDANCE ──────────────────────────
 * Node n'expose pas HPKE. Le projet tient à zéro dépendance d'exécution hors
 * commander/yaml/zod, et ajouter une bibliothèque de crypto pour un usage aussi restreint
 * — mode base, une suite, chiffrement à un coup — élargirait la surface d'audit bien
 * au-delà du besoin.
 *
 * CE QUI EST IMPLÉMENTÉ, ET CE QUI NE L'EST PAS. Uniquement le MODE BASE (`mode = 0x00`)
 * en un seul coup. Ni PSK, ni authentification de l'expéditeur, ni API à secret exporté,
 * ni chiffrements multiples sur un même contexte. L'authenticité de l'émetteur ne repose
 * PAS sur HPKE ici : elle vient de la signature Ed25519 d'origine, portée dans
 * l'enveloppe et vérifiée par tout lecteur (RFC §3.1). Confondre les deux serait une
 * erreur d'architecture — HPKE en mode base ne dit rien de QUI a chiffré.
 *
 * TOUTES LES CONSTANTES SONT CELLES DE LA RFC 9180 et sont vérifiées contre le vecteur de
 * test A.2 dans tests/unit/federation-hpke.test.ts. Un « ça a l'air juste » sur du code
 * cryptographique ne vaut rien : soit le vecteur officiel passe, soit l'implémentation
 * est fausse.
 */

import crypto from 'node:crypto';

// Identifiants d'algorithmes (RFC 9180 §7). Encodés en 16 bits gros-boutiste dans suite_id.
const KEM_ID = 0x0020;    // DHKEM(X25519, HKDF-SHA256)
const KDF_ID = 0x0001;    // HKDF-SHA256
const AEAD_ID = 0x0003;   // ChaCha20-Poly1305

const NH = 32;            // taille de sortie de SHA-256
const NK = 32;            // taille de clé ChaCha20-Poly1305
const NN = 12;            // taille de nonce ChaCha20-Poly1305
const MODE_BASE = 0x00;

export const HPKE_SUITE = 'HPKE-v1/X25519-HKDF-SHA256-CHACHA20POLY1305' as const;

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function u16(n: number): Uint8Array {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}

function ascii(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** RFC 9180 §4 : suite_id du KEM, distinct de celui du contexte HPKE. */
function kemSuiteId(): Uint8Array {
  return concat(ascii('KEM'), u16(KEM_ID));
}

/**
 * RFC 9180 §5.1 : suite_id du contexte, couvrant KEM, KDF et AEAD.
 *
 * `aeadId` est paramétrable UNIQUEMENT pour la validation par vecteurs. La RFC ne publie
 * en clair dans son corps que l'appendice A.1 (AES-128-GCM) ; pouvoir instancier le
 * schedule sous cet identifiant permet de vérifier toute la machinerie
 * labeled_extract/labeled_expand contre des valeurs officielles, plutôt que de se
 * contenter d'un aller-retour interne qui passerait tout aussi bien avec deux erreurs
 * symétriques. La suite de production reste figée à ChaCha20-Poly1305.
 */
function hpkeSuiteId(aeadId: number = AEAD_ID): Uint8Array {
  return concat(ascii('HPKE'), u16(KEM_ID), u16(KDF_ID), u16(aeadId));
}

function labeledExtract(suiteId: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array): Uint8Array {
  // labeled_ikm = "HPKE-v1" || suite_id || label || ikm  (RFC 9180 §4)
  const labeledIkm = concat(ascii('HPKE-v1'), suiteId, ascii(label), ikm);
  return new Uint8Array(crypto.createHmac('sha256', Buffer.from(salt)).update(Buffer.from(labeledIkm)).digest());
}

function labeledExpand(suiteId: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, length: number): Uint8Array {
  const labeledInfo = concat(u16(length), ascii('HPKE-v1'), suiteId, ascii(label), info);
  // HKDF-Expand (RFC 5869) : T(i) = HMAC(prk, T(i-1) || info || i)
  const out = new Uint8Array(length);
  let t = new Uint8Array(0);
  let off = 0;
  for (let i = 1; off < length; i++) {
    t = new Uint8Array(
      crypto.createHmac('sha256', Buffer.from(prk))
        .update(Buffer.from(concat(t, labeledInfo, new Uint8Array([i]))))
        .digest(),
    );
    const take = Math.min(t.length, length - off);
    out.set(t.subarray(0, take), off);
    off += take;
  }
  return out;
}

function extractAndExpand(dh: Uint8Array, kemContext: Uint8Array): Uint8Array {
  const suiteId = kemSuiteId();
  const eaePrk = labeledExtract(suiteId, new Uint8Array(0), 'eae_prk', dh);
  return labeledExpand(suiteId, eaePrk, 'shared_secret', kemContext, NH);
}

// ── Conversions de clés X25519 ────────────────────────────────────────────────

/**
 * Octets bruts (32) d'une clé publique X25519 depuis son PEM SPKI.
 *
 * L'en-tête SPKI d'une X25519 fait exactement 12 octets et est constant pour cet
 * algorithme ; les 32 derniers octets sont la clé. On prend la FIN du DER plutôt qu'un
 * décalage fixe depuis le début : le préfixe pourrait varier d'un encodeur à l'autre,
 * la longueur de la clé, non.
 */
export function rawPublicKey(pem: string): Uint8Array {
  const der = crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' });
  return new Uint8Array(der.subarray(der.length - 32));
}

function publicKeyFromRaw(raw: Uint8Array): crypto.KeyObject {
  // Préfixe SPKI de X25519 : SEQUENCE { SEQUENCE { OID 1.3.101.110 }, BIT STRING }
  const prefix = Buffer.from('302a300506032b656e032100', 'hex');
  return crypto.createPublicKey({
    key: Buffer.concat([prefix, Buffer.from(raw)]),
    format: 'der',
    type: 'spki',
  });
}

// ── KEM : encapsulation / décapsulation ───────────────────────────────────────

function encapsulate(recipientPublicPem: string): { sharedSecret: Uint8Array; enc: Uint8Array } {
  const ephemeral = crypto.generateKeyPairSync('x25519');
  const recipientKey = crypto.createPublicKey(recipientPublicPem);
  const dh = new Uint8Array(crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientKey }));

  const enc = new Uint8Array(
    ephemeral.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32),
  );
  const pkRm = rawPublicKey(recipientPublicPem);
  // kem_context = enc || pkRm — l'ordre est normatif ; l'inverser produit un secret
  // différent des deux côtés et un échec de déchiffrement sans explication.
  return { sharedSecret: extractAndExpand(dh, concat(enc, pkRm)), enc };
}

function decapsulate(enc: Uint8Array, recipientPrivateKey: crypto.KeyObject): Uint8Array {
  const ephemeralPublic = publicKeyFromRaw(enc);
  const dh = new Uint8Array(crypto.diffieHellman({ privateKey: recipientPrivateKey, publicKey: ephemeralPublic }));
  const pkRm = new Uint8Array(
    crypto.createPublicKey(recipientPrivateKey).export({ type: 'spki', format: 'der' }).subarray(-32),
  );
  return extractAndExpand(dh, concat(enc, pkRm));
}

// ── Contexte HPKE ─────────────────────────────────────────────────────────────

function keySchedule(
  sharedSecret: Uint8Array,
  info: Uint8Array,
  suite: { aeadId: number; nk: number; nn: number } = { aeadId: AEAD_ID, nk: NK, nn: NN },
): { key: Uint8Array; baseNonce: Uint8Array; keyScheduleContext: Uint8Array; secret: Uint8Array } {
  const suiteId = hpkeSuiteId(suite.aeadId);
  // En mode base, psk et psk_id sont vides — mais leurs hachages entrent QUAND MÊME dans
  // le contexte. Les omettre donnerait un contexte différent de toute autre
  // implémentation conforme.
  const pskIdHash = labeledExtract(suiteId, new Uint8Array(0), 'psk_id_hash', new Uint8Array(0));
  const infoHash = labeledExtract(suiteId, new Uint8Array(0), 'info_hash', info);
  const keyScheduleContext = concat(new Uint8Array([MODE_BASE]), pskIdHash, infoHash);
  const secret = labeledExtract(suiteId, sharedSecret, 'secret', new Uint8Array(0));
  return {
    key: labeledExpand(suiteId, secret, 'key', keyScheduleContext, suite.nk),
    baseNonce: labeledExpand(suiteId, secret, 'base_nonce', keyScheduleContext, suite.nn),
    keyScheduleContext,
    secret,
  };
}

// ── API publique ──────────────────────────────────────────────────────────────

export interface SealedBlob {
  alg: typeof HPKE_SUITE;
  /** Clé encapsulée, base64url. */
  enc: string;
  /** Nonce AEAD, base64url. Unique par `enc` (exigence du RFC). */
  nonce: string;
  /** Ciphertext AEAD suivi du tag, base64url. */
  ciphertext: string;
}

/**
 * Scelle un texte clair pour un destinataire, lié à un AAD.
 *
 * L'AAD est passé en OCTETS DÉJÀ CANONIQUES, jamais en objet : la canonicalisation
 * appartient à l'appelant, qui doit produire exactement les mêmes octets à la
 * vérification. L'accepter en objet ici inviterait deux canonicalisations différentes.
 *
 * `seq` vaut 0 : un contexte n'est utilisé que pour UN chiffrement. Le RFC interdit toute
 * répétition du couple de contexte de nonce, et la garantie la plus simple est qu'un
 * contexte ne serve jamais deux fois — chaque appel génère une clé éphémère neuve.
 */
export function seal(params: {
  recipientPublicKeyPem: string;
  plaintext: Uint8Array;
  aadCanonicalBytes: Uint8Array;
  info?: Uint8Array;
}): SealedBlob {
  const { sharedSecret, enc } = encapsulate(params.recipientPublicKeyPem);
  const { key, baseNonce } = keySchedule(sharedSecret, params.info ?? new Uint8Array(0));

  const cipher = crypto.createCipheriv('chacha20-poly1305', Buffer.from(key), Buffer.from(baseNonce), {
    authTagLength: 16,
  });
  cipher.setAAD(Buffer.from(params.aadCanonicalBytes), { plaintextLength: params.plaintext.length });
  const body = Buffer.concat([cipher.update(Buffer.from(params.plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    alg: HPKE_SUITE,
    enc: Buffer.from(enc).toString('base64url'),
    nonce: Buffer.from(baseNonce).toString('base64url'),
    ciphertext: Buffer.concat([body, tag]).toString('base64url'),
  };
}

/**
 * Ouvre un blob scellé. Échoue FERMÉ au moindre octet d'AAD différent.
 *
 * Toute erreur est convertie en `undefined` plutôt qu'en exception détaillée : distinguer
 * « mauvaise clé » de « AAD divergent » de « tag invalide » donnerait à un attaquant un
 * oracle sur la cause de l'échec. L'appelant apprend seulement que ça n'ouvre pas.
 */
export function open(params: {
  recipientPrivateKey: crypto.KeyObject;
  sealed: SealedBlob;
  aadCanonicalBytes: Uint8Array;
  info?: Uint8Array;
}): Uint8Array | undefined {
  try {
    if (params.sealed.alg !== HPKE_SUITE) return undefined;
    const enc = new Uint8Array(Buffer.from(params.sealed.enc, 'base64url'));
    const sharedSecret = decapsulate(enc, params.recipientPrivateKey);
    const { key, baseNonce } = keySchedule(sharedSecret, params.info ?? new Uint8Array(0));

    // Le nonce annoncé DOIT être celui dérivé du schedule. Accepter un nonce arbitraire
    // laisserait un émetteur en réutiliser un — la faute la plus grave possible sur un
    // AEAD à nonce, qui trahit le clair de deux messages d'un simple XOR.
    const announced = Buffer.from(params.sealed.nonce, 'base64url');
    if (!announced.equals(Buffer.from(baseNonce))) return undefined;

    const raw = Buffer.from(params.sealed.ciphertext, 'base64url');
    if (raw.length < 16) return undefined;
    const body = raw.subarray(0, raw.length - 16);
    const tag = raw.subarray(raw.length - 16);

    const decipher = crypto.createDecipheriv('chacha20-poly1305', Buffer.from(key), Buffer.from(baseNonce), {
      authTagLength: 16,
    });
    decipher.setAAD(Buffer.from(params.aadCanonicalBytes), { plaintextLength: body.length });
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
  } catch {
    return undefined;
  }
}

/** Exposé pour les vecteurs de test RFC 9180 ; hors de ce cadre, utiliser `seal`/`open`. */
export const __testing = { labeledExtract, labeledExpand, keySchedule, kemSuiteId, hpkeSuiteId, extractAndExpand };
