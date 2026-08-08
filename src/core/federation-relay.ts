/**
 * Commandes cloud matérialisées localement — le RELAIS (pln#651 étape 7, dec#154).
 *
 * ── CE QUI SURVIT INTACT AU CHIFFREMENT ───────────────────────────────────────
 * À écrire d'emblée, pour qu'on ne « résolve » pas un faux problème : `base_rev` compare
 * un IDENTIFIANT DE RÉVISION, pas du contenu. L'idempotence, `operation_id`, la
 * provenance et l'audit ne référencent que des ids et des actions. Rien de tout cela n'a
 * besoin de lire le clair, et le chiffrement ne gêne donc en rien ce module.
 *
 * LE RELAIS N'ÉCRIT JAMAIS DE CONTENU. Le contenu reste en écriture depuis le local
 * uniquement. Une commande venue du dashboard porte sur des MÉTADONNÉES : priorité,
 * ordre, rang, statut, métadonnées de roadmap. C'est la conséquence directe de dec#154 —
 * « le Cloud est une projection et un relais ; le local est la source de vérité ».
 *
 * ── LA TROISIÈME CLASSE D'APPELANTS (dec#155) ─────────────────────────────────
 * Le relais cloud n'a NI session, NI cwd, NI contexte ambiant : seulement un id d'entité
 * et un `base_rev`. C'est le cas le plus pur du routage autoritatif par l'entité, déjà en
 * place côté core depuis la 1.21.0.
 *
 * NE PAS RÉINVENTER DE RÉSOLUTION AMBIANTE POUR LUI. La tentation est réelle — « si le
 * projet n'est pas précisé, prendre le projet actif » — et c'est exactement la dérive que
 * pln#648/649 ont corrigée pour le routage local. Une commande sans cible résoluble est
 * REFUSÉE, jamais devinée.
 *
 * ── LES CONFLITS ──────────────────────────────────────────────────────────────
 * Présentés avec une proposition de résolution, JAMAIS de last-write-wins silencieux. Et
 * c'est le contrat de refus de T3 exprimé sur un autre transport : une divergence PROUVÉE
 * refuse et nomme ; une ABSENCE retombe sur la réponse ambiante. Le même mécanisme, pas
 * un second.
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { memoryDir, writeFileAtomic } from './io.js';
import { nowISO } from './ids.js';
import { canonicalJson } from './federation-canonical.js';
import { logger } from './logger.js';
import type { SyncState } from './federation-state.js';

const JOURNAL_DIR = ['coordination', 'federation', 'commands'];

/**
 * Les seuls champs qu'une commande cloud peut toucher.
 *
 * LISTE FERMÉE ET NON EXTENSIBLE PAR CONFIGURATION : c'est la traduction exécutable de
 * « le relais n'écrit jamais de contenu ». Ajouter `text` ou `description` ici ferait du
 * Cloud une source d'écriture de contenu et retournerait dec#154.
 */
export const RELAYABLE_FIELDS = ['priority', 'rank', 'status'] as const;
export type RelayableField = (typeof RELAYABLE_FIELDS)[number];

export const CloudCommandSchema = z.object({
  /** Identité de l'opération, créée par l'émetteur et REJOUÉE à l'identique en cas de retry. */
  operation_id: z.string().min(1),
  /** Cible : un id d'entité opaque. Pas de projet, pas de cwd, pas de session (dec#155). */
  object_id: z.string().min(1),
  /** Révision sur laquelle l'émetteur s'appuie. Un décalage produit un conflit VISIBLE. */
  base_rev: z.number().int().nonnegative(),
  field: z.enum(RELAYABLE_FIELDS),
  value: z.union([z.string(), z.number()]),
  /** Identité Ed25519 de l'émetteur — audité, pas cru sur parole. */
  issued_by: z.string().min(1),
  issued_at: z.string().min(1),
}).strict();

export type CloudCommand = z.infer<typeof CloudCommandSchema>;

export interface JournalEntry {
  operation_id: string;
  object_id: string;
  base_rev: number;
  field: RelayableField;
  value: string | number;
  issued_by: string;
  issued_at: string;
  state: SyncState;
  materialized_at: string;
  /** Renseigné pour un conflit : ce que le local sait, et ce qui est proposé. */
  conflict?: {
    local_rev: number;
    proposal: string;
  };
}

export type ApplyOutcome =
  | { status: 'applied'; entry: JournalEntry }
  | { status: 'duplicate'; entry: JournalEntry }
  | { status: 'conflict'; entry: JournalEntry }
  | { status: 'refused'; reason: string };

function journalDir(cwd: string): string {
  return path.join(memoryDir(cwd), ...JOURNAL_DIR);
}

/**
 * Le journal est indexé par `operation_id` — c'est ce qui rend le rejeu inoffensif.
 *
 * Un index par (object_id, base_rev) ne suffirait pas : deux commandes distinctes peuvent
 * légitimement viser la même révision d'un même objet (changer la priorité, puis le rang).
 */
function entryPath(cwd: string, operationId: string): string {
  // Le nom de fichier est assaini : un operation_id venu du réseau ne doit pas pouvoir
  // écrire hors du répertoire du journal via '../'.
  const safe = operationId.replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(journalDir(cwd), `${safe}.json`);
}

export function loadJournalEntry(cwd: string, operationId: string): JournalEntry | undefined {
  const filepath = entryPath(cwd, operationId);
  if (!fs.existsSync(filepath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf-8')) as JournalEntry;
  } catch (err) {
    // Une entrée illisible n'est PAS traitée comme absente : la traiter ainsi ferait
    // réappliquer une commande déjà appliquée, ce que tout ce module cherche à empêcher.
    logger.warn(`Entrée de journal illisible (${operationId}) : ${err instanceof Error ? err.message : String(err)}`);
    // `cause` conservée : sans elle, un opérateur voit « journal corrompu » sans savoir
    // si c'est un JSON tronqué, un encodage cassé ou un disque plein.
    throw new Error(`Journal corrompu pour l'opération ${operationId} — refus d'appliquer à l'aveugle.`, { cause: err });
  }
}

function writeEntry(cwd: string, entry: JournalEntry): void {
  const filepath = entryPath(cwd, entry.operation_id);
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  writeFileAtomic(filepath, `${JSON.stringify(entry, null, 2)}\n`);
}

/**
 * Applique une commande cloud au journal local.
 *
 * `resolveLocalRev` est INJECTÉ plutôt que lu ici : ce module ne connaît pas le stockage
 * des entités, et lui donner cette connaissance en ferait un second chemin d'écriture sur
 * la mémoire — précisément ce que « le relais n'écrit jamais de contenu » interdit. Il
 * écrit le journal ; c'est l'appelant qui, à partir du journal, applique un changement de
 * métadonnée par la voie locale normale.
 *
 * TROIS ISSUES ET AUCUN ÉCRASEMENT SILENCIEUX :
 *   applied   — base_rev correspond, l'effet est enregistré ;
 *   duplicate — operation_id déjà connu, aucun second effet (idempotence) ;
 *   conflict  — base_rev périmé : l'entrée est écrite en état `conflict` AVEC une
 *               proposition, et attend une décision humaine.
 */
export function applyCloudCommand(params: {
  raw: unknown;
  cwd: string;
  /** Révision locale courante de l'objet, ou undefined si l'objet est inconnu ici. */
  resolveLocalRev: (objectId: string) => number | undefined;
}): ApplyOutcome {
  const parsed = CloudCommandSchema.safeParse(params.raw);
  if (!parsed.success) {
    return { status: 'refused', reason: `commande invalide : ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}` };
  }
  const cmd = parsed.data;

  // IDEMPOTENCE D'ABORD. Rejouer une commande déjà appliquée doit être un no-op, y compris
  // si la révision locale a changé entre-temps — sinon un retry réseau produirait un
  // conflit fantôme sur une opération pourtant déjà réussie.
  const existing = loadJournalEntry(params.cwd, cmd.operation_id);
  if (existing) {
    return { status: 'duplicate', entry: existing };
  }

  const localRev = params.resolveLocalRev(cmd.object_id);
  if (localRev === undefined) {
    // TROISIÈME CLASSE D'APPELANTS (dec#155) : pas de repli ambiant. Un objet inconnu est
    // refusé et nommé, jamais rattaché au « projet actif » par défaut.
    return { status: 'refused', reason: `objet '${cmd.object_id}' inconnu localement — aucune résolution ambiante pour le relais cloud (dec#155).` };
  }

  const base: Omit<JournalEntry, 'state'> = {
    operation_id: cmd.operation_id,
    object_id: cmd.object_id,
    base_rev: cmd.base_rev,
    field: cmd.field,
    value: cmd.value,
    issued_by: cmd.issued_by,
    issued_at: cmd.issued_at,
    materialized_at: nowISO(),
  };

  if (cmd.base_rev !== localRev) {
    // CONFLIT VISIBLE, jamais un écrasement. La proposition est formulée ici parce que
    // c'est ici qu'on connaît les deux révisions ; la rendre plus tard obligerait
    // l'interface à re-déduire ce que le journal savait déjà.
    const entry: JournalEntry = {
      ...base,
      state: 'conflict',
      conflict: {
        local_rev: localRev,
        proposal: localRev > cmd.base_rev
          ? `Le local a avancé (rév. ${localRev} > ${cmd.base_rev}). Rejouer la commande sur la révision ${localRev}, ou l'abandonner si le changement local la rend caduque.`
          : `La commande s'appuie sur une révision (${cmd.base_rev}) postérieure au local (${localRev}) — le local a probablement été restauré. Vérifier avant d'appliquer.`,
      },
    };
    writeEntry(params.cwd, entry);
    return { status: 'conflict', entry };
  }

  const entry: JournalEntry = { ...base, state: 'pending' };
  writeEntry(params.cwd, entry);
  return { status: 'applied', entry };
}

/** Marque une entrée synchronisée une fois l'effet local réellement appliqué. */
export function markCommandSynced(cwd: string, operationId: string): boolean {
  const entry = loadJournalEntry(cwd, operationId);
  if (!entry) return false;
  writeEntry(cwd, { ...entry, state: 'synced' });
  return true;
}

/**
 * Résout un conflit par une DÉCISION EXPLICITE.
 *
 * Il n'existe volontairement aucune résolution automatique : dec#154 dit « jamais de
 * last-write-wins silencieux », et un mode « auto » finirait par être le défaut.
 */
export function resolveCommandConflict(params: {
  cwd: string;
  operationId: string;
  decision: 'accept' | 'discard';
}): JournalEntry | undefined {
  const entry = loadJournalEntry(params.cwd, params.operationId);
  if (!entry || entry.state !== 'conflict') return undefined;
  const resolved: JournalEntry = {
    ...entry,
    state: params.decision === 'accept' ? 'pending' : 'synced',
    conflict: undefined,
  };
  writeEntry(params.cwd, resolved);
  return resolved;
}

/** Entrées du journal dans un état donné — sert à rendre les conflits visibles. */
export function listCommands(cwd: string, state?: SyncState): JournalEntry[] {
  const dir = journalDir(cwd);
  if (!fs.existsSync(dir)) return [];
  const out: JournalEntry[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')) as JournalEntry;
      if (!state || entry.state === state) out.push(entry);
    } catch {
      logger.warn(`Entrée de journal ignorée (illisible) : ${name}`);
    }
  }
  return out.sort((a, b) => a.materialized_at.localeCompare(b.materialized_at));
}

/**
 * Empreinte d'audit d'une commande — ce qui a été demandé, par qui, sur quelle révision.
 *
 * Calculée sur les octets CANONIQUES pour qu'elle soit reproductible des deux côtés : un
 * audit qu'on ne peut pas recalculer identiquement ne prouve rien.
 */
export function commandAuditDigest(cmd: CloudCommand): string {
  return canonicalJson({
    operation_id: cmd.operation_id,
    object_id: cmd.object_id,
    base_rev: cmd.base_rev,
    field: cmd.field,
    value: cmd.value,
    issued_by: cmd.issued_by,
  });
}
