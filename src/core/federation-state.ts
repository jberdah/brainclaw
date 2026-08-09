/**
 * Fédération v2 — état local de connexion (pln#651 étape 3).
 *
 * Création propre, AUCUNE migration (dec#156) : ce module ne lit ni `cloud_sync` ni
 * `BRAINCLAW_CLOUD_*`. Le chemin v1 a été démoli en étape 2, et le défaut vivant qu'il
 * portait — la SEULE PRÉSENCE d'une variable d'environnement valant consentement au
 * sync — ne doit pas se reconstituer ici. Le consentement est un fichier écrit par une
 * cérémonie d'appairage explicite (étape 4), rien d'autre.
 *
 * ── OÙ VIT QUOI, ET POURQUOI ──────────────────────────────────────────────────
 *   `.brainclaw/coordination/federation/connection.json`  (workspace, ce module)
 *       Le lien workspace ↔ cloud_project_id, l'identité d'appareil PUBLIQUE, les
 *       epochs connus, la position de sync, les états visibles. AUCUN SECRET.
 *
 *   `~/.brainclaw/keys/`                                   (federation-keyring.ts)
 *       Les clés privées. Hors du store, parce qu'un store de workspace se copie,
 *       se synchronise et — dans d'autres projets que celui-ci — se committe.
 *
 * La frontière est vérifiée par un test, pas seulement par cette phrase : le pack de
 * l'étape 8 injecte une sentinelle et exige qu'aucun octet de clé privée n'atteigne
 * `.brainclaw/`.
 *
 * ── LES TROIS ÉTATS SONT UNE EXIGENCE, PAS UN CONFORT (dec#154) ───────────────
 * « Le Cloud est une projection et un relais ; le local est la source de vérité. » Une
 * opération venue du Cloud se matérialise dans le journal local AVEC UN ÉTAT VISIBLE :
 * pending / synced / conflict. Un état invisible transformerait le relais en autorité
 * silencieuse — exactement ce que dec#154 refuse.
 */

import fs from 'node:fs';
import path from 'node:path';
import { memoryDir, writeFileAtomic } from './io.js';
import { generateId, nowISO } from './ids.js';
import { heldEpochs } from './federation-keyring.js';
import { counters as outboxCounters } from './federation-outbox-v2.js';
import { logger } from './logger.js';

const CONNECTION_FILE = 'connection.json';
export const FEDERATION_STATE_SCHEMA = 'brainclaw.federation-connection/v3';
/** Schéma v2 — singleton mono-agent. Lu en tolérance, jamais écrit (trp#1625). */
const FEDERATION_STATE_SCHEMA_V2 = 'brainclaw.federation-connection/v2';

/** Nombre d'appareils de récupération exigés avant la première enveloppe (RFC §5.3). */
export const REQUIRED_RECOVERY_DEVICES = 2;

// ── Types ─────────────────────────────────────────────────────────────────────

/** Les trois états de synchronisation rendus observables (dec#154). */
export type SyncState = 'pending' | 'synced' | 'conflict';

export type EnrollmentStage =
  | 'unpaired'      // aucun appairage entamé
  | 'pending'       // enrollment créé côté cloud, en attente d'approbation
  | 'attested'      // clé X25519 attestée et preuve de possession fournie
  | 'active'        // approuvé, credentials détenus
  | 'revoked';      // autorisation coupée côté cloud

export interface DeviceRecord {
  device_id: string;
  /** Empreinte de la clé X25519 — affichée à l'humain qui approuve (RFC §5.2). */
  x25519_fingerprint: string;
  /** Empreinte Ed25519 ATTESTANTE. Sans elle, la clé de chiffrement est orpheline. */
  attested_by_ed25519: string;
  enrolled_at: string;
  /**
   * Appareil de RÉCUPÉRATION : compte dans le quorum de RFC §5.3.
   * Deux appareils peuvent appartenir à la même personne, mais leurs clés privées ne
   * doivent pas partager un même stockage — une contrainte que le code ne peut pas
   * vérifier et que l'humain doit assumer ; la commande le dit au moment d'enrôler.
   */
  recovery: boolean;
  revoked_at?: string;
}

/** Position de sync : curseur d'efficacité + barrières de sûreté par objet. */
export interface SyncPosition {
  /**
   * Curseur de feed — OPTIMISATION, pas garantie. Il évite de retirer tout l'historique
   * à chaque pull. Un cloud malveillant peut le faire régresser ; c'est le high-water
   * mark par objet qui refuse alors le rollback, pas ce curseur (RFC §6).
   */
  feed_cursor?: string;
  /**
   * Barrière de sûreté ANTI-REJEU : plus haute révision acceptée par objet.
   * L'AEAD détecte l'altération mais PAS le rejeu d'un ciphertext valide et ancien.
   * Une révision inférieure ou égale est refusée à la réception (étape 6).
   */
  high_water: Record<string, number>;
  last_pull_at?: string;
  last_push_at?: string;
}

/**
 * Un enrôlement d'AGENT sur l'appareil courant. La v3 en porte une LISTE — un appareil
 * héberge plusieurs agents, chacun avec sa propre identité Ed25519, tous partageant la clé
 * X25519 de l'appareil (dec#161). Avant la v3, un second appairage écrasait le premier
 * (trp#1625).
 */
export interface PairingRecord {
  /** Identité de l'agent appairé — c'est ce que le singleton v2 ne mémorisait pas. */
  agent_id: string;
  stage: EnrollmentStage;
  enrollment_id?: string;
  role?: string;
  updated_at: string;
}

export interface FederationConnectionState {
  schema: typeof FEDERATION_STATE_SCHEMA;
  /** Identifiant OPAQUE côté cloud. Le mapping local↔cloud reste local (RFC §7). */
  cloud_project_id: string;
  /**
   * Adresse du déploiement, persistée à l'appairage (pln#655). Absente d'un état v2 —
   * `--url` reste alors requis jusqu'au prochain appairage qui la renseigne.
   */
  cloud_url?: string;
  /** Chemin absolu du workspace lié — détecte un état copié dans un autre dossier. */
  workspace_path: string;
  /**
   * MIROIR du pairing courant, conservé pour les lecteurs mono-agent (emit, push, status
   * hérités). N'est PAS la source de vérité — `pairings` l'est. Les écrivains le
   * maintiennent égal au dernier pairing touché ; le lire reste correct pour le cas solo.
   * Toute logique multi-agents doit passer par `pairings` / `pairingForAgent`.
   */
  enrollment: {
    stage: EnrollmentStage;
    enrollment_id?: string;
    /** Rôle obtenu, affiché par `status` (critère de sortie de l'étape 4). */
    role?: string;
    updated_at: string;
  };
  /** SOURCE DE VÉRITÉ des enrôlements d'agents sur cet appareil (v3). */
  pairings: PairingRecord[];
  device: DeviceRecord;
  /** Autres appareils connus du projet — sert au quorum de récupération. */
  peer_devices: DeviceRecord[];
  keys: {
    /** Epoch d'ÉCRITURE courant. Les lectures utilisent le trousseau complet. */
    current_epoch: number;
    /** Epochs que cet appareil croit détenir — réconcilié avec le disque au chargement. */
    known_epochs: number[];
  };
  sync: SyncPosition;
  /** Compteurs des trois états, pour un affichage sans parcourir l'outbox entière. */
  counters: Record<SyncState, number>;
  created_at: string;
  updated_at: string;
}

// ── Emplacement ───────────────────────────────────────────────────────────────

export function connectionStatePath(cwd: string = process.cwd()): string {
  return path.join(memoryDir(cwd), 'coordination', 'federation', CONNECTION_FILE);
}

// ── Lecture ───────────────────────────────────────────────────────────────────

/**
 * Charge l'état de connexion, ou `undefined` si le workspace n'est pas appairé.
 *
 * FAIL-CLOSED SUR ÉTAT ILLISIBLE : un JSON corrompu renvoie `undefined` et journalise,
 * il ne renvoie PAS un état par défaut. Un défaut fabriqué ferait croire à un appairage
 * avec un `current_epoch` de 0, et l'appelant tenterait de sceller sous une clé
 * inexistante. « Pas appairé » est une réponse sûre ; « appairé, epoch 0 » ne l'est pas.
 */
export function loadConnectionState(cwd: string = process.cwd()): FederationConnectionState | undefined {
  const filepath = connectionStatePath(cwd);
  if (!fs.existsSync(filepath)) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  } catch (err) {
    logger.warn(`État de connexion fédération illisible (${filepath}): ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }

  const state = raw as Partial<FederationConnectionState> & { schema?: string };
  const knownSchema = state.schema === FEDERATION_STATE_SCHEMA || state.schema === FEDERATION_STATE_SCHEMA_V2;
  if (!knownSchema || !state.cloud_project_id || !state.device?.device_id) {
    // Un schéma inconnu (v1) n'est PAS migré (dec#156) : abandonné, pas déprécié. Mais la
    // v2 EST lue — c'est le format vivant sur les machines déjà appairées ; le refuser
    // détruirait leur appairage au premier chargement après mise à jour.
    logger.warn(`État de connexion fédération ignoré : schéma '${String(state.schema)}' non reconnu.`);
    return undefined;
  }

  return normalizeState(projectToV3(state), cwd);
}

/**
 * Projette un état v2 (singleton) vers la forme v3 (liste de pairings) À LA LECTURE.
 *
 * Un v2 n'a pas de `pairings` ni de `cloud_url` ni d'agent mémorisé. On dérive un pairing
 * unique de son `enrollment` — l'agent est marqué inconnu, faute de l'information : le
 * singleton v2 ne l'a jamais stockée, et l'inventer serait mentir. Un état déjà v3 passe
 * inchangé. Rien n'est réécrit sur disque ici : la conversion n'a lieu qu'en mémoire, et
 * la prochaine ÉCRITURE (un appairage, une révocation) persistera la forme v3.
 */
function projectToV3(
  state: Partial<FederationConnectionState> & { schema?: string },
): FederationConnectionState {
  if (Array.isArray(state.pairings)) {
    return { ...(state as FederationConnectionState), schema: FEDERATION_STATE_SCHEMA };
  }
  const enrollment = state.enrollment ?? { stage: 'unpaired' as EnrollmentStage, updated_at: nowISO() };
  const derived: PairingRecord = {
    agent_id: '(inconnu — appairé en v2)',
    stage: enrollment.stage,
    enrollment_id: enrollment.enrollment_id,
    role: enrollment.role,
    updated_at: enrollment.updated_at,
  };
  return {
    ...(state as FederationConnectionState),
    schema: FEDERATION_STATE_SCHEMA,
    pairings: enrollment.enrollment_id || enrollment.stage !== 'unpaired' ? [derived] : [],
  };
}

// ── Manipulation des pairings (v3) ─────────────────────────────────────────────

/** Le pairing d'un agent donné, ou `undefined`. */
export function pairingForAgent(
  state: FederationConnectionState,
  agentId: string,
): PairingRecord | undefined {
  return state.pairings.find((p) => p.agent_id === agentId);
}

/** Y a-t-il au moins un pairing actif ? Décide notamment la genèse d'epoch (premier appareil). */
export function hasActivePairing(state: FederationConnectionState): boolean {
  return state.pairings.some((p) => p.stage === 'active');
}

/**
 * Ajoute ou met à jour le pairing d'un agent, SANS toucher aux autres, et maintient le
 * miroir `enrollment` sur le pairing touché. Retourne un nouvel état (immuable).
 *
 * C'est l'unique porte par laquelle un pairing entre ou change : centraliser le maintien
 * du miroir ici évite qu'un écrivain oublie de le synchroniser et fasse diverger la vue
 * mono-agent de la source de vérité.
 */
export function upsertPairing(
  state: FederationConnectionState,
  pairing: PairingRecord,
): FederationConnectionState {
  const others = state.pairings.filter((p) => p.agent_id !== pairing.agent_id);
  return {
    ...state,
    pairings: [...others, pairing],
    enrollment: {
      stage: pairing.stage,
      enrollment_id: pairing.enrollment_id,
      role: pairing.role,
      updated_at: pairing.updated_at,
    },
    updated_at: nowISO(),
  };
}

/**
 * Réconcilie l'état déclaré avec le DISQUE.
 *
 * `known_epochs` dit ce que l'appareil croit détenir ; `heldEpochs()` lit ce qu'il
 * détient réellement. Le désaccord n'est pas théorique : une restauration partielle de
 * sauvegarde, ou un `disconnect` interrompu, produit exactement cela. Faire confiance au
 * JSON conduirait à tenter un déchiffrement sous une clé absente et à rendre l'erreur au
 * mauvais endroit — loin de la cause.
 */
function normalizeState(state: FederationConnectionState, cwd: string): FederationConnectionState {
  const onDisk = heldEpochs(state.cloud_project_id);
  const declared = state.keys?.known_epochs ?? [];
  const missing = declared.filter((e) => !onDisk.includes(e));
  if (missing.length > 0) {
    logger.warn(
      `Trousseau incomplet pour ${state.cloud_project_id} : epoch(s) ${missing.join(', ')} déclaré(s) ` +
      `mais absent(s) de ~/.brainclaw/keys/. Ces révisions ne sont pas déchiffrables sur cet appareil.`,
    );
  }
  return {
    ...state,
    workspace_path: state.workspace_path ?? path.resolve(cwd),
    peer_devices: state.peer_devices ?? [],
    keys: {
      current_epoch: state.keys?.current_epoch ?? 0,
      // Le disque fait autorité sur ce qui est LISIBLE.
      known_epochs: onDisk,
    },
    sync: {
      feed_cursor: state.sync?.feed_cursor,
      high_water: state.sync?.high_water ?? {},
      last_pull_at: state.sync?.last_pull_at,
      last_push_at: state.sync?.last_push_at,
    },
    counters: {
      pending: state.counters?.pending ?? 0,
      synced: state.counters?.synced ?? 0,
      conflict: state.counters?.conflict ?? 0,
    },
  };
}

// ── Écriture ──────────────────────────────────────────────────────────────────

/**
 * Persiste l'état de connexion de façon atomique.
 *
 * REFUSE D'ÉCRIRE UN SECRET : le contrôle ci-dessous n'est pas de la paranoïa décorative.
 * `{...state, private_key}` compile, et une clé privée sérialisée dans un fichier du
 * store serait ensuite copiée par tout ce qui copie un store. C'est le même raisonnement
 * que les trois filets de l'étape 5 : le typage TypeScript est une BORNE INFÉRIEURE, pas
 * une garantie d'exécution — chaque clé présente à l'exécution est sérialisée.
 */
export function saveConnectionState(state: FederationConnectionState, cwd: string = process.cwd()): void {
  assertNoSecret(state);
  const next: FederationConnectionState = { ...state, updated_at: nowISO() };
  const filepath = connectionStatePath(cwd);
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  writeFileAtomic(filepath, `${JSON.stringify(next, null, 2)}\n`);
}

const SECRET_MARKERS = ['PRIVATE KEY', 'BEGIN OPENSSH', 'BEGIN RSA', 'BEGIN EC PARAMETERS'];

/**
 * Refuse tout état contenant du matériel de clé privée, quel que soit le NOM du champ.
 *
 * Le contrôle porte sur le CONTENU sérialisé et non sur une liste de champs interdits :
 * une liste de noms ne rattrape pas un champ ajouté demain, alors qu'un PEM privé porte
 * toujours son en-tête. C'est le même choix que le filet 2 de l'étape 5 — fail-closed sur
 * ce qui sort, pas allowlist sur ce qu'on a pensé à interdire.
 */
function assertNoSecret(state: FederationConnectionState): void {
  const serialized = JSON.stringify(state);
  for (const marker of SECRET_MARKERS) {
    if (serialized.includes(marker)) {
      throw new Error(
        `Refus d'écrire l'état de connexion : du matériel de clé privée ('${marker}') s'y trouve. ` +
        `Les secrets vont dans ~/.brainclaw/keys/ via federation-keyring.ts, jamais dans le store de workspace.`,
      );
    }
  }
}

/**
 * Crée l'état de connexion initial d'un workspace fraîchement appairé.
 *
 * `stage: 'pending'` et non `'active'` : créer l'état ne vaut pas approbation. Le passage
 * à `active` appartient à la cérémonie de l'étape 4, après preuve de possession ET
 * approbation humaine. Un état créé optimiste rejouerait le défaut de la v1 — un artefact
 * local suffisant à déclencher du sync.
 */
export function createConnectionState(params: {
  cloudProjectId: string;
  device: DeviceRecord;
  workspacePath?: string;
  enrollmentId?: string;
  cloudUrl?: string;
  /** Agent du premier pairing. Optionnel pour la compat des appelants v2 existants. */
  agentId?: string;
}): FederationConnectionState {
  const now = nowISO();
  const firstPairing: PairingRecord | undefined = params.agentId
    ? { agent_id: params.agentId, stage: 'pending', enrollment_id: params.enrollmentId, updated_at: now }
    : undefined;
  return {
    schema: FEDERATION_STATE_SCHEMA,
    cloud_project_id: params.cloudProjectId,
    cloud_url: params.cloudUrl,
    workspace_path: path.resolve(params.workspacePath ?? process.cwd()),
    enrollment: { stage: 'pending', enrollment_id: params.enrollmentId, updated_at: now },
    pairings: firstPairing ? [firstPairing] : [],
    device: params.device,
    peer_devices: [],
    // 0 = « aucun epoch » et non « premier epoch ». Le premier epoch remis est le 1 ;
    // sceller sous l'epoch 0 doit être impossible, pas silencieusement plausible.
    keys: { current_epoch: 0, known_epochs: [] },
    sync: { high_water: {} },
    counters: { pending: 0, synced: 0, conflict: 0 },
    created_at: now,
    updated_at: now,
  };
}

/**
 * Identifiant d'appareil, indépendant de l'identité d'agent (RFC §5.1).
 *
 * Un agent peut tourner sur plusieurs machines et une machine porter plusieurs agents ;
 * c'est l'APPAREIL qui détient une clé de déchiffrement et qu'on révoque en cas de perte.
 * Réutiliser l'agent_id ferait qu'une révocation coupe l'agent partout à la fois.
 */
export function newDeviceId(): string {
  return generateId('federation_devices');
}

// ── Anti-rejeu ────────────────────────────────────────────────────────────────

/**
 * Décide si une révision entrante est acceptable pour un objet donné.
 *
 * STRICTEMENT SUPÉRIEURE (RFC §6.5) : l'égalité est refusée ici, et le dédoublonnage
 * d'une enveloppe déjà connue se fait par `idempotency_key` à l'étape 6 — deux
 * mécanismes distincts pour deux questions distinctes. Confondre les deux ferait
 * accepter un rejeu de même révision porteur d'un contenu différent.
 */
export function acceptsRevision(state: FederationConnectionState, objectId: string, incomingRev: number): boolean {
  const seen = state.sync.high_water[objectId];
  return seen === undefined || incomingRev > seen;
}

/** Avance la barrière anti-rejeu. Ne régresse JAMAIS, même si l'appelant le demande. */
export function recordRevision(
  state: FederationConnectionState,
  objectId: string,
  rev: number,
): FederationConnectionState {
  const seen = state.sync.high_water[objectId];
  if (seen !== undefined && rev <= seen) return state;
  return { ...state, sync: { ...state.sync, high_water: { ...state.sync.high_water, [objectId]: rev } } };
}

// ── Quorum de récupération ────────────────────────────────────────────────────

export interface RecoveryReadiness {
  ready: boolean;
  enrolled: number;
  required: number;
  reason?: string;
}

/**
 * Un projet ne peut émettre sa PREMIÈRE enveloppe v2 qu'après l'enrôlement de deux
 * appareils de récupération indépendamment attestés (RFC §5.3).
 *
 * POURQUOI CETTE PORTE EXISTE ICI, dans l'état et non dans la commande : un enrôlement
 * par appareil sans scénario de perte produit des workspaces DÉFINITIVEMENT illisibles.
 * Si tous les porteurs sont perdus, le passé scellé est irrécupérable par construction —
 * aucun reset côté Cloud ne le restaure. La porte est donc au plus près de la donnée qui
 * la conditionne, pour qu'un second appelant ne puisse pas l'oublier.
 *
 * Les appareils révoqués ne comptent pas : deux porteurs dont un révoqué n'offrent aucun
 * chemin de remplacement.
 */
export function recoveryReadiness(state: FederationConnectionState): RecoveryReadiness {
  const all = [state.device, ...state.peer_devices];
  const enrolled = all.filter((d) => d.recovery && !d.revoked_at).length;
  if (enrolled >= REQUIRED_RECOVERY_DEVICES) {
    return { ready: true, enrolled, required: REQUIRED_RECOVERY_DEVICES };
  }
  return {
    ready: false,
    enrolled,
    required: REQUIRED_RECOVERY_DEVICES,
    reason:
      `${enrolled}/${REQUIRED_RECOVERY_DEVICES} appareil(s) de récupération attesté(s). ` +
      `Sans un second porteur, la perte de cet appareil rendrait le passé scellé irrécupérable — ` +
      `aucune restauration côté cloud ne le ramènerait.`,
  };
}

// ── Résumé observable ─────────────────────────────────────────────────────────

export interface ConnectionSummary {
  connected: boolean;
  cloud_project_id?: string;
  stage: EnrollmentStage;
  role?: string;
  current_epoch: number;
  readable_epochs: number[];
  device_fingerprint?: string;
  cloud_url?: string;
  /** Tous les agents appairés sur cet appareil (v3) — vide sur un état v2 non projeté. */
  pairings: Array<{ agent_id: string; stage: EnrollmentStage; role?: string }>;
  sync: Record<SyncState, number>;
  last_pull_at?: string;
  recovery: RecoveryReadiness;
}

/**
 * Ce que `brainclaw cloud status` rend — le critère de sortie « les trois états de sync
 * sont observables par une commande ».
 *
 * DEUX SOURCES, ET LES DEUX SONT LE DISQUE, PAS LA DÉCLARATION :
 *   `readable_epochs` vient de `heldEpochs()` via la réconciliation du chargement ;
 *   `sync` vient du comptage réel de l'outbox, pas des compteurs de `connection.json`.
 *
 * Les compteurs persistés restent un cache d'affichage bon marché pour les appelants qui
 * n'ont pas besoin d'exactitude. Un STATUT, lui, est consulté précisément quand on doute :
 * s'il relisait un compteur que le code a lui-même incrémenté, il n'observerait rien et
 * rassurerait à tort au pire moment.
 */
export function summarizeConnection(cwd: string = process.cwd()): ConnectionSummary {
  const state = loadConnectionState(cwd);
  const sync = outboxCounters(cwd);
  if (!state) {
    return {
      connected: false,
      stage: 'unpaired',
      current_epoch: 0,
      readable_epochs: [],
      pairings: [],
      sync,
      recovery: { ready: false, enrolled: 0, required: REQUIRED_RECOVERY_DEVICES },
    };
  }
  return {
    // Connecté dès qu'AU MOINS UN agent est actif, OU que le miroir l'indique. Le OR est
    // une ceinture de sécurité pour l'affichage : un état projeté depuis v2, ou construit
    // à la main, peut porter un miroir actif sans pairing correspondant. Mieux vaut
    // afficher « connecté » et laisser l'opérateur voir que masquer un appairage réel.
    connected: hasActivePairing(state) || state.enrollment.stage === 'active',
    cloud_project_id: state.cloud_project_id,
    stage: state.enrollment.stage,
    role: state.enrollment.role,
    current_epoch: state.keys.current_epoch,
    readable_epochs: state.keys.known_epochs,
    device_fingerprint: state.device.x25519_fingerprint,
    cloud_url: state.cloud_url,
    pairings: state.pairings.map((p) => ({ agent_id: p.agent_id, stage: p.stage, role: p.role })),
    sync,
    last_pull_at: state.sync.last_pull_at,
    recovery: recoveryReadiness(state),
  };
}
