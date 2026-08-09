/**
 * Fédération v2 — identité d'APPAREIL et trousseau multi-epoch (pln#651 étape 3).
 *
 * Création propre, AUCUNE migration (dec#156) : ce module ne lit ni `cloud_sync` ni
 * `BRAINCLAW_CLOUD_*` pour reconstruire un état. Le chemin v1 a été démoli en étape 2.
 *
 * ── POURQUOI DEUX PAIRES DE CLÉS ET NON UNE ────────────────────────────────────
 * L'appareil porte DEUX clés distinctes, et aucune ne se dérive de l'autre :
 *
 *   Ed25519 (~/.brainclaw/keys/<agentId>.ed25519.pem, agent-registry.ts)
 *     → QUI PARLE. Signature d'origine des enveloppes, preuve de possession
 *       pendant l'appairage. C'est l'identité que le Cloud a déjà enregistrée.
 *
 *   X25519 (~/.brainclaw/keys/<deviceId>.x25519.pem, ce module)
 *     → QUI PEUT LIRE. Destinataire des enveloppements HPKE qui remettent les
 *       clés privées d'epoch.
 *
 * Les dériver l'une de l'autre est tentant (une seule clé à sauvegarder) et faux :
 * cela lierait la capacité de LECTURE à la capacité de SIGNATURE, alors que le RFC
 * §5.1 en fait une propriété d'architecture — « écrire sans lire ». Un émetteur qui
 * ne doit pas lire reçoit la clé publique de projet et son accès de signature, rien
 * d'autre. Avec des clés dérivées, révoquer la lecture révoquerait l'écriture, et
 * la compromission de l'une livrerait l'autre.
 *
 * ── PLAFOND DE SÉCURITÉ, ÉCRIT ICI PARCE QUE C'EST ICI QU'ON LIT LA CLÉ ────────
 * `~/.brainclaw/keys/` est un répertoire du système de fichiers, lisible par TOUT
 * processus tournant sous le même UID. Sur Windows le mode 0600 de `fs.chmod` est
 * largement ignoré. Donc : la sécurité du chiffrement de bout en bout côté Cloud
 * NE DÉPASSE PAS celle du disque local. Un malware ayant l'UID de l'utilisateur lit
 * les clés d'epoch et déchiffre tout ce que l'appareil pouvait déchiffrer.
 *
 * Ce n'est pas un défaut à corriger dans ce step : TPM, enclave sécurisée et HSM
 * sont explicitement une v2 ultérieure (RFC §5.1). C'est un plafond à ÉNONCER, pour
 * qu'on ne vende pas au-delà de ce que la construction tient.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MEMORY_DIR } from './io.js';
import { nowISO } from './ids.js';
import { logger } from './logger.js';

/** Empreinte canonique d'une clé publique PEM — même règle que Ed25519 (agent-registry.ts). */
export function fingerprintKeyPem(publicKeyPem: string): string {
  return crypto.createHash('sha256').update(publicKeyPem.replace(/\r/g, '').trim()).digest('hex');
}

// ── Emplacements ──────────────────────────────────────────────────────────────

/** Racine neutre des secrets : ~/.brainclaw/ — JAMAIS le store de workspace. */
function keysRoot(home: string = os.homedir()): string {
  return path.join(home, MEMORY_DIR, 'keys');
}

/**
 * Clé privée X25519 de l'appareil.
 *
 * Voisine de la clé Ed25519 par CHOIX : un seul répertoire à protéger, à sauvegarder
 * et à effacer. Le suffixe distingue les deux algorithmes de façon lisible sans avoir
 * à ouvrir le fichier.
 */
export function deviceKeyPath(deviceId: string, home: string = os.homedir()): string {
  return path.join(keysRoot(home), `${deviceId}.x25519.pem`);
}

/**
 * Clés privées d'epoch, cloisonnées PAR PROJET CLOUD.
 *
 * Le cloisonnement n'est pas cosmétique : `disconnect` d'un projet doit pouvoir
 * effacer ses clés sans toucher à celles d'un autre projet auquel la même machine
 * est appairée. Un trousseau à plat rendrait cette suppression sélective fragile.
 */
export function epochKeyPath(cloudProjectId: string, epoch: number, home: string = os.homedir()): string {
  return path.join(keysRoot(home), 'epochs', cloudProjectId, `epoch-${epoch}.x25519.pem`);
}

// ── Identité d'appareil ───────────────────────────────────────────────────────

export interface DeviceKeyMaterial {
  device_id: string;
  /** SPKI PEM — c'est ce qui est publié, attesté et affiché à l'approbateur humain. */
  public_key_pem: string;
  fingerprint: string;
  created_at: string;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Écrit un secret sur disque en RESTREIGNANT les permissions AVANT d'écrire les
 * octets, pas après.
 *
 * `writeFileSync(p, data)` puis `chmodSync(p, 0o600)` laisse une fenêtre où le
 * fichier existe en 0644 avec la clé dedans. Le mode passé à l'ouverture ferme
 * cette fenêtre. Sur Windows le mode est largement ignoré — d'où le plafond
 * documenté en tête de module ; ce n'est pas une raison de l'omettre sur POSIX,
 * où il est effectif.
 */
function writeSecretFile(filepath: string, contents: string): void {
  ensureDir(path.dirname(filepath));
  fs.writeFileSync(filepath, contents, { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Retourne la clé X25519 de l'appareil, en la créant au premier appel.
 *
 * NE FAIT JAMAIS TOURNER une clé existante — même contrat que `ensureAgentSigningKey`
 * pour Ed25519, et pour la même raison en plus grave : une rotation silencieuse
 * casserait l'attestation déjà approuvée par un humain côté Cloud, et rendrait
 * ILLISIBLES toutes les enveloppes d'epoch déjà remises à l'ancienne clé. Une clé de
 * signature perdue empêche d'écrire ; une clé de déchiffrement perdue perd des données.
 */
export function ensureDeviceKey(deviceId: string, home: string = os.homedir()): DeviceKeyMaterial {
  const filepath = deviceKeyPath(deviceId, home);

  if (fs.existsSync(filepath)) {
    const privateKey = crypto.createPrivateKey(fs.readFileSync(filepath, 'utf-8'));
    const publicKeyPem = crypto
      // @types/node 26 a retiré la surcharge KeyObject de createPublicKey (régression :
      // Node accepte une clé privée pour en dériver la publique, comme documenté).
      // Même contournement que agent-registry.ts ; comportement d'exécution inchangé.
      .createPublicKey(privateKey as unknown as crypto.PublicKeyInput)
      .export({ type: 'spki', format: 'pem' })
      .toString();
    return {
      device_id: deviceId,
      public_key_pem: publicKeyPem,
      fingerprint: fingerprintKeyPem(publicKeyPem),
      created_at: fs.statSync(filepath).birthtime.toISOString(),
    };
  }

  const generated = crypto.generateKeyPairSync('x25519');
  const privateKeyPem = generated.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = generated.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  writeSecretFile(filepath, privateKeyPem);

  return {
    device_id: deviceId,
    public_key_pem: publicKeyPem,
    fingerprint: fingerprintKeyPem(publicKeyPem),
    created_at: nowISO(),
  };
}

/**
 * Charge la clé privée X25519 de l'appareil, ou `undefined` si absente.
 *
 * Ne CRÉE rien : un appelant qui a besoin de déchiffrer et ne trouve pas la clé doit
 * traiter cela comme un échec explicite, pas voir une clé fraîche se matérialiser et
 * échouer plus tard, plus loin, sur un déchiffrement incompréhensible.
 */
export function loadDevicePrivateKey(deviceId: string, home: string = os.homedir()): crypto.KeyObject | undefined {
  const filepath = deviceKeyPath(deviceId, home);
  if (!fs.existsSync(filepath)) return undefined;
  return crypto.createPrivateKey(fs.readFileSync(filepath, 'utf-8'));
}

// ── Trousseau multi-epoch ─────────────────────────────────────────────────────

/**
 * POURQUOI UN TROUSSEAU ET NON « LA CLÉ COURANTE ».
 *
 * La révocation est forward-only (dec#156, RFC §5.3) : révoquer un appareil crée un
 * epoch SUIVANT, et les écritures futures l'utilisent. Le passé reste scellé sous les
 * anciens epochs. Un appareil autorisé qui n'aurait que la clé courante deviendrait
 * incapable de relire l'historique du projet à chaque rotation.
 *
 * D'où Map<epoch, clé> : le courant pour écrire, tous les epochs détenus pour lire.
 */
export interface EpochKeyEntry {
  epoch: number;
  public_key_pem: string;
  fingerprint: string;
  /** Vrai quand la clé PRIVÉE est détenue localement — donc quand cet epoch est lisible. */
  readable: boolean;
}

/**
 * Enregistre la clé privée d'un epoch, remise par une enveloppe HPKE après approbation.
 *
 * REFUSE D'ÉCRASER un epoch déjà détenu. Deux clés différentes pour un même numéro
 * d'epoch signifie que quelque chose s'est mal passé en amont — le Cloud a resservi un
 * autre roster, ou deux appairages se marchent dessus. Écraser rendrait silencieusement
 * illisible tout ce qui a été scellé sous la première ; l'erreur est le bon comportement.
 * Ré-enregistrer la MÊME clé est en revanche idempotent : une reprise d'appairage
 * interrompu ne doit pas échouer (le step 4 exige une reprise sûre).
 */
export function storeEpochPrivateKey(
  cloudProjectId: string,
  epoch: number,
  privateKeyPem: string,
  home: string = os.homedir(),
): void {
  const filepath = epochKeyPath(cloudProjectId, epoch, home);
  if (fs.existsSync(filepath)) {
    const existing = fs.readFileSync(filepath, 'utf-8').replace(/\r/g, '').trim();
    if (existing === privateKeyPem.replace(/\r/g, '').trim()) return;
    throw new Error(
      `Refus d'écraser la clé de l'epoch ${epoch} du projet ${cloudProjectId} : ` +
      `une clé DIFFÉRENTE est déjà détenue. Écraser rendrait illisible tout ce qui a été ` +
      `scellé sous la clé actuelle. Vérifier le roster côté cloud avant de forcer.`,
    );
  }
  // Valider AVANT d'écrire : un PEM corrompu stocké se découvrirait au premier
  // déchiffrement, longtemps après, sans lien évident avec l'appairage qui l'a produit.
  const key = crypto.createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'x25519') {
    throw new Error(`Clé d'epoch invalide : attendu x25519, reçu ${key.asymmetricKeyType ?? 'inconnu'}`);
  }
  writeSecretFile(filepath, privateKeyPem);
}

/** Charge la clé privée d'un epoch, ou `undefined` si cet epoch n'est pas détenu. */
export function loadEpochPrivateKey(
  cloudProjectId: string,
  epoch: number,
  home: string = os.homedir(),
): crypto.KeyObject | undefined {
  const filepath = epochKeyPath(cloudProjectId, epoch, home);
  if (!fs.existsSync(filepath)) return undefined;
  try {
    return crypto.createPrivateKey(fs.readFileSync(filepath, 'utf-8'));
  } catch (err) {
    // Une clé illisible n'est PAS équivalente à une clé absente : la première est une
    // corruption à signaler, la seconde un état normal. On journalise et on renvoie
    // undefined pour que l'appelant refuse le déchiffrement — jamais un fallback muet.
    logger.warn(`Clé d'epoch ${epoch} illisible pour ${cloudProjectId}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * Énumère les epochs dont la clé privée est détenue localement — le trousseau réel,
 * lu SUR DISQUE et non déduit de l'état de connexion.
 *
 * La distinction compte : l'état de connexion dit ce que l'appareil CROIT détenir,
 * le disque dit ce qu'il détient VRAIMENT. `federation-state.ts` réconcilie les deux
 * plutôt que de faire confiance au JSON, parce qu'une restauration partielle de
 * sauvegarde produit exactement ce désaccord.
 */
export function heldEpochs(cloudProjectId: string, home: string = os.homedir()): number[] {
  const dir = path.dirname(epochKeyPath(cloudProjectId, 0, home));
  if (!fs.existsSync(dir)) return [];
  const epochs: number[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const match = /^epoch-(\d+)\.x25519\.pem$/.exec(entry);
    if (match) epochs.push(Number(match[1]));
  }
  return epochs.sort((a, b) => a - b);
}

/**
 * Efface les clés d'epoch d'un projet — appelé par `cloud disconnect`.
 *
 * CE QUE ÇA NE FAIT PAS, et que la commande appelante doit dire à l'humain : cela
 * n'efface pas les blobs déjà tirés et déchiffrés localement, ni ce qu'un autre
 * appareil détient. `disconnect` retire une autorisation locale ; il ne réécrit pas
 * le passé (RFC §5.2). Retourne le nombre de clés supprimées.
 */
export function forgetProjectEpochs(cloudProjectId: string, home: string = os.homedir()): number {
  const dir = path.dirname(epochKeyPath(cloudProjectId, 0, home));
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(dir)) {
    if (!/^epoch-\d+\.x25519\.pem$/.test(entry)) continue;
    fs.rmSync(path.join(dir, entry), { force: true });
    removed++;
  }
  try { fs.rmdirSync(dir); } catch { /* non vide ou déjà parti : sans conséquence */ }
  return removed;
}

/** Clé publique d'un epoch détenu, dérivée de la privée — utile pour afficher son empreinte. */
export function epochPublicKey(
  cloudProjectId: string,
  epoch: number,
  home: string = os.homedir(),
): { public_key_pem: string; fingerprint: string } | undefined {
  const priv = loadEpochPrivateKey(cloudProjectId, epoch, home);
  if (!priv) return undefined;
  const pem = crypto
    .createPublicKey(priv as unknown as crypto.PublicKeyInput)
    .export({ type: 'spki', format: 'pem' })
    .toString();
  return { public_key_pem: pem, fingerprint: fingerprintKeyPem(pem) };
}

/**
 * Fait naître la PREMIÈRE clé d'epoch d'un projet, si et seulement si personne n'en détient.
 *
 * ── POURQUOI CETTE FONCTION MANQUAIT, ET CE QUE SON ABSENCE PRODUISAIT ────────
 * Mesuré le 2026-08-09 : `storeEpochPrivateKey` n'avait AUCUN appelant de production — seuls
 * les tests en fabriquaient. Un projet fraîchement appairé restait donc à `current_epoch: 0`
 * avec `known_epochs: []`, et toute tentative de sceller échouait sur « clé d'epoch
 * introuvable ». La fédération ne pouvait rien émettre, non par refus mais par absence de
 * clé — un état qu'aucun message n'expliquait.
 *
 * ── QUI A LE DROIT DE CRÉER, ET POURQUOI C'EST ÉTROIT ─────────────────────────
 * Le PREMIER appareil d'un projet, et lui seul. Un appareil qui rejoint un projet existant
 * ne doit RIEN créer : il doit RECEVOIR la clé par une remise attestée (dec#159). En
 * fabriquer une localement produirait un second epoch portant le même numéro et une clé
 * différente — donc des enveloppes que personne d'autre ne peut lire, sans qu'aucune erreur
 * ne se déclenche à l'émission.
 *
 * C'est le cas dégénéré du modèle d'équipe, pas une branche parallèle : en solo, le premier
 * appareil est aussi le seul custodian.
 *
 * NE RÉÉCRIT JAMAIS : si une clé existe déjà pour cet epoch, elle est renvoyée telle quelle.
 * `storeEpochPrivateKey` refuse de son côté d'écraser une clé DIFFÉRENTE.
 */
export function ensureFirstEpochKey(
  cloudProjectId: string,
  epoch: number,
  home: string = os.homedir(),
): { created: boolean; public_key_pem: string; fingerprint: string } {
  const existing = epochPublicKey(cloudProjectId, epoch, home);
  if (existing) return { created: false, ...existing };

  const { privateKey } = crypto.generateKeyPairSync('x25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  storeEpochPrivateKey(cloudProjectId, epoch, pem, home);

  const materialized = epochPublicKey(cloudProjectId, epoch, home);
  if (!materialized) {
    // Vérifier APRÈS écriture plutôt que supposer : une clé qu'on croit détenir mais qui
    // n'est pas relisible produirait des enveloppes illisibles, découvertes bien plus tard.
    throw new Error(
      `Clé d'epoch ${epoch} écrite mais non relisible pour ${cloudProjectId} — ` +
        'ne pas émettre tant que la cause n\'est pas comprise.',
    );
  }
  return { created: true, ...materialized };
}
