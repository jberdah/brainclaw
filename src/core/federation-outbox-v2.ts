/**
 * Fédération v2 — outbox locale (pln#651 étape 3).
 *
 * Création propre : l'outbox v1 (`federation-outbox.ts`) a été SUPPRIMÉE en étape 2 avec
 * ses 112 enveloppes en attente, dont 50 portaient un `worktree_path` absolu et 48 le nom
 * d'hôte de la machine (dec#156-d). Rien n'est repris d'elle — ni format, ni contenu.
 *
 * ── CE QUE CETTE OUTBOX SAIT, ET CE QU'ELLE NE SAIT PAS ───────────────────────
 * Elle stocke des enveloppes DÉJÀ SCELLÉES et suit leur état. Elle ne construit pas
 * l'enveloppe, ne chiffre pas, ne classe pas les champs : c'est l'étape 5 (le projecteur
 * et ses trois filets). La séparation est délibérée — une file d'attente qui saurait
 * aussi fabriquer son contenu serait un second chemin de sérialisation, donc un second
 * endroit où un champ non classé peut fuir.
 *
 * Conséquence testable : ce module n'accepte QUE la partie `sealed` opaque et des
 * métadonnées de transport. Il n'a aucun accès au clair, donc il ne peut pas le divulguer.
 */

import fs from 'node:fs';
import path from 'node:path';
import { memoryDir, writeFileAtomic } from './io.js';
import { nowISO } from './ids.js';
import { logger } from './logger.js';
import type { SyncState } from './federation-state.js';

/** Les trois répertoires SONT les trois états — l'état est le chemin, pas un champ. */
const STATE_DIRS: Record<SyncState, string> = {
  pending: 'outbox',
  synced: 'sent',
  conflict: 'conflict',
};

export const OUTBOX_ENTRY_SCHEMA = 'brainclaw.federation-outbox-entry/v2';

export interface OutboxEntry {
  schema: typeof OUTBOX_ENTRY_SCHEMA;
  /** Clé d'idempotence de l'enveloppe (RFC §3.2) — l'identité de l'opération sur le fil. */
  idempotency_key: string;
  operation_id: string;
  /** Révision sur laquelle l'opération s'appuie ; un base_rev périmé produit un conflit. */
  base_rev?: number;
  /** Epoch de scellement — indispensable pour savoir sous quelle clé relire. */
  key_epoch: number;
  /**
   * L'enveloppe scellée, OPAQUE pour ce module. Typée `unknown` volontairement : lui
   * donner une forme lisible inviterait un futur appelant à la lire, la muter, ou à
   * `{...sealed, extra}` — le troisième filet de l'étape 5 existe pour cette raison.
   */
  sealed: unknown;
  /**
   * Agent d'ORIGINE tel que le cloud le connaît — distinct de l'empreinte du signataire.
   * L'enveloppe ne porte qu'un `key_id` ; le cloud, lui, vérifie DEUX choses : que l'agent
   * a un enrôlement actif (`origin_agent_id`) ET que l'empreinte de la clé signataire
   * correspond à son identité attestée. Les confondre rend un 422
   * SIGNER_FINGERPRINT_MISMATCH parfaitement opaque.
   */
  origin_agent_id?: string;
  attempts: number;
  last_error?: string;
  created_at: string;
  updated_at: string;
}

function stateDir(state: SyncState, cwd: string): string {
  return path.join(memoryDir(cwd), 'coordination', 'federation', STATE_DIRS[state]);
}

function entryPath(state: SyncState, idempotencyKey: string, cwd: string): string {
  return path.join(stateDir(state, cwd), `${idempotencyKey}.json`);
}

/**
 * Met une enveloppe scellée en file d'attente.
 *
 * IDEMPOTENT PAR CONSTRUCTION : la clé d'idempotence est le NOM DU FICHIER, donc un
 * double enqueue de la même opération ne peut pas produire deux entrées. C'est ce que
 * `materializeFederationSignal` ne faisait pas — il frappait un nouvel id et un nouveau
 * created_at à chaque passage, rendant le dédoublonnage absent par construction (étape 6).
 *
 * Une entrée déjà `synced` n'est pas remise en attente : la retransmission d'une opération
 * confirmée est exactement le rejeu contre lequel l'étape 6 protège à la réception ; il
 * n'y a pas de raison de l'émettre depuis ici.
 */
export function enqueue(entry: Omit<OutboxEntry, 'schema' | 'attempts' | 'created_at' | 'updated_at'>, cwd: string = process.cwd()): boolean {
  for (const state of ['synced', 'pending', 'conflict'] as SyncState[]) {
    if (fs.existsSync(entryPath(state, entry.idempotency_key, cwd))) return false;
  }
  const now = nowISO();
  const full: OutboxEntry = { schema: OUTBOX_ENTRY_SCHEMA, ...entry, attempts: 0, created_at: now, updated_at: now };
  const filepath = entryPath('pending', entry.idempotency_key, cwd);
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  writeFileAtomic(filepath, `${JSON.stringify(full, null, 2)}\n`);
  return true;
}

/**
 * Déplace une entrée d'un état vers un autre.
 *
 * Le déplacement est un `rename` : une entrée ne peut pas exister dans deux états à la
 * fois, même si le processus meurt au milieu. Une copie-puis-suppression laisserait une
 * fenêtre où l'opération est comptée deux fois — et les compteurs de `status` mentiraient
 * précisément pendant l'incident où on les consulte.
 */
export function transition(
  idempotencyKey: string,
  from: SyncState,
  to: SyncState,
  cwd: string = process.cwd(),
  mutate?: (entry: OutboxEntry) => OutboxEntry,
): boolean {
  const src = entryPath(from, idempotencyKey, cwd);
  if (!fs.existsSync(src)) return false;
  const dest = entryPath(to, idempotencyKey, cwd);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  if (mutate) {
    try {
      const entry = JSON.parse(fs.readFileSync(src, 'utf-8')) as OutboxEntry;
      const next = mutate({ ...entry, updated_at: nowISO() });
      writeFileAtomic(dest, `${JSON.stringify(next, null, 2)}\n`);
      // MISE À JOUR SUR PLACE — `from === to` est un cas LÉGITIME et non un no-op : c'est
      // ainsi qu'un échec d'envoi incrémente `attempts` et enregistre `last_error` sans
      // quitter la file d'attente.
      //
      // Sans cette garde, `src` et `dest` sont le MÊME chemin : on écrit le fichier puis on
      // le SUPPRIME aussitôt. L'entrée disparaît exactement au moment où l'on voulait
      // seulement noter que son envoi a échoué — donc l'opération jamais émise perd sa
      // seule trace, et précisément lors de l'incident où elle compte.
      // Trouvé par le test « un 500 laisse aussi en attente » (2026-08-09).
      if (path.resolve(src) !== path.resolve(dest)) fs.rmSync(src, { force: true });
      return true;
    } catch (err) {
      logger.warn(`Entrée d'outbox illisible (${idempotencyKey}) : ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  fs.renameSync(src, dest);
  return true;
}

/** Entrées d'un état donné, triées par date de création. */
export function list(state: SyncState, cwd: string = process.cwd()): OutboxEntry[] {
  const dir = stateDir(state, cwd);
  if (!fs.existsSync(dir)) return [];
  const entries: OutboxEntry[] = [];
  let legacy = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')) as Partial<OutboxEntry>;
      // ── DÉBRIS v1 DANS LE MÊME RÉPERTOIRE ────────────────────────────────────
      //
      // dec#156 a abandonné le format v1 SANS migration — mais la v2 réutilise le même
      // chemin sur disque, et les entrées v1 y sont restées. Elles n'ont ni `schema` ni
      // `created_at` (leurs champs sont op/entity_type/enqueued_at/last_status).
      //
      // Sans ce filtre, le tri par `created_at` lève « Cannot read properties of
      // undefined (reading 'localeCompare') » et `brainclaw cloud status` PLANTE —
      // c'est-à-dire la toute première commande qu'on lance après un appairage réussi.
      // Constaté sur un magasin réel portant 129 entrées v1 (2026-08-09).
      //
      // Elles sont IGNORÉES, pas supprimées : ce sont des opérations peut-être jamais
      // émises, et les effacer ici retirerait leur seule trace. Le compte est journalisé
      // pour que leur présence reste visible plutôt que devinée.
      if (parsed.schema !== OUTBOX_ENTRY_SCHEMA || typeof parsed.created_at !== 'string') {
        legacy += 1;
        continue;
      }
      entries.push(parsed as OutboxEntry);
    } catch {
      // Une entrée corrompue est ignorée à la lecture mais reste sur disque : la
      // supprimer ici effacerait la seule trace d'une opération peut-être jamais émise.
      logger.warn(`Entrée d'outbox ignorée (illisible) : ${name}`);
    }
  }
  if (legacy > 0) {
    logger.warn(
      `${legacy} entrée(s) d'outbox au format v1 ignorée(s) dans « ${STATE_DIRS[state]} » — ` +
        `abandonnées par dec#156, conservées sur disque, sans effet sur la fédération v2.`,
    );
  }
  return entries.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/**
 * Compte les trois états EN LES LISANT SUR DISQUE.
 *
 * Les compteurs de `connection.json` sont un cache d'affichage ; ceci est la vérité. Le
 * critère de sortie de l'étape 3 dit « observables par une commande » — observer un
 * compteur qu'on a soi-même incrémenté n'observe rien, c'est se relire. En cas d'écart,
 * c'est ce comptage qui gagne.
 */
export function counters(cwd: string = process.cwd()): Record<SyncState, number> {
  return {
    pending: list('pending', cwd).length,
    synced: list('synced', cwd).length,
    conflict: list('conflict', cwd).length,
  };
}
