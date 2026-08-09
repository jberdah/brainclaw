/**
 * Fédération v2 — TRANSPORT : drainer l'outbox vers le cloud.
 *
 * ── POURQUOI CE MODULE EST SÉPARÉ DE L'ÉMISSION ───────────────────────────────
 * `federation-emit.ts` scelle et met en file ; celui-ci envoie. La séparation n'est pas
 * cosmétique : une file qui saurait aussi parler au réseau serait un SECOND chemin par
 * lequel un objet pourrait sortir sans passer par les trois filets du projecteur. Ici, tout
 * ce qui part a déjà été scellé — ce module ne voit que des `sealed` opaques et ne peut donc
 * pas divulguer de clair, même par erreur de programmation.
 *
 * ── CE QU'IL FAIT DE L'ÉCHEC ──────────────────────────────────────────────────
 * Une entrée qui échoue RESTE en attente, avec son erreur enregistrée. Elle n'est ni
 * supprimée ni déplacée en `conflict` : un échec réseau n'est pas un conflit de révision, et
 * les confondre ferait disparaître de la file une opération jamais émise.
 *
 * Seul un 409 fait passer en `conflict` — c'est le cas où le cloud dit « ta base_rev est
 * périmée », donc un désaccord d'état qu'un renvoi ne résoudra pas.
 */

import { list, transition } from './federation-outbox-v2.js';
import { loadConnectionState } from './federation-state.js';
import { logger } from './logger.js';

export interface PushResult {
  attempted: number;
  sent: number;
  conflicts: number;
  failed: number;
  errors: Array<{ idempotency_key: string; status?: number; reason: string }>;
}

export interface PushOptions {
  cwd?: string;
  /** Adresse du déploiement ; à défaut, celle enregistrée à l'appairage. */
  url?: string;
  /** N'envoie rien : rapporte ce qui partirait. */
  dryRun?: boolean;
  /** Borne le lot — utile pour un premier essai observable. */
  limit?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Envoie les enveloppes en attente.
 *
 * REFUSE plutôt que de deviner : sans appairage actif, sans URL, la fonction lève. Pousser
 * vers une adresse devinée enverrait des enveloppes chiffrées à un tiers — inintelligibles
 * pour lui, mais c'est une fuite de métadonnées et de trafic, pas un non-événement.
 */
export async function pushPending(options: PushOptions = {}): Promise<PushResult> {
  const cwd = options.cwd ?? process.cwd();
  const doFetch = options.fetchImpl ?? fetch;
  const result: PushResult = { attempted: 0, sent: 0, conflicts: 0, failed: 0, errors: [] };

  const state = loadConnectionState(cwd);
  if (!state || state.enrollment.stage !== 'active') {
    throw new Error(
      'Aucun appairage actif : rien n\'est envoyé tant que l\'appairage n\'est pas confirmé localement.',
    );
  }

  // MANQUE MESURÉ (2026-08-09) : `FederationConnectionState` ne persiste AUCUNE adresse de
  // cloud — ni à la racine, ni dans `sync`. L'appairage prend `--url` puis l'oublie. Chaque
  // commande doit donc la repasser. C'est un défaut d'ergonomie à corriger côté appairage,
  // pas ici : deviner une adresse enverrait le trafic d'un projet à un tiers — illisible
  // pour lui, mais une fuite de métadonnées et de trafic n'est pas un non-événement.
  const base = (options.url ?? '').replace(/\/+$/, '');
  if (!base) {
    throw new Error(
      'Adresse du cloud inconnue : passez --url. Elle n\'est pas conservée par l\'appairage ' +
        '(état de connexion sans champ d\'URL), et aucune adresse n\'est devinée.',
    );
  }

  const pending = list('pending', cwd);
  const batch = options.limit ? pending.slice(0, options.limit) : pending;
  result.attempted = batch.length;
  if (options.dryRun) return result;

  const endpoint = `${base}/api/v1/projects/${state.cloud_project_id}/projection/envelopes`;

  for (const entry of batch) {
    try {
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // La clé d'idempotence voyage AUSSI en en-tête : le cloud doit pouvoir
          // dédoublonner sans ouvrir le corps, qu'il ne peut de toute façon pas lire.
          'idempotency-key': entry.idempotency_key,
        },
        body: JSON.stringify({ envelope: entry.sealed, key_epoch: entry.key_epoch, base_rev: entry.base_rev }),
      });

      if (res.ok || res.status === 202) {
        transition(entry.idempotency_key, 'pending', 'synced', cwd);
        result.sent += 1;
        continue;
      }

      if (res.status === 409) {
        // Désaccord de révision : un renvoi à l'identique échouera pareil. L'entrée passe
        // en `conflict` pour être VUE, pas retentée en boucle.
        transition(entry.idempotency_key, 'pending', 'conflict', cwd, (e) => ({
          ...e,
          last_error: `409 conflit de révision (base_rev=${entry.base_rev})`,
        }));
        result.conflicts += 1;
        result.errors.push({ idempotency_key: entry.idempotency_key, status: 409, reason: 'conflit de révision' });
        continue;
      }

      const body = await res.text();
      result.failed += 1;
      result.errors.push({
        idempotency_key: entry.idempotency_key,
        status: res.status,
        reason: body.slice(0, 200),
      });
      // RESTE en attente : un refus temporaire ne doit pas faire disparaître l'opération.
      transition(entry.idempotency_key, 'pending', 'pending', cwd, (e) => ({
        ...e,
        attempts: e.attempts + 1,
        last_error: `HTTP ${res.status}`,
      }));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      result.failed += 1;
      result.errors.push({ idempotency_key: entry.idempotency_key, reason });
      transition(entry.idempotency_key, 'pending', 'pending', cwd, (e) => ({
        ...e,
        attempts: e.attempts + 1,
        last_error: reason,
      }));
      logger.warn(`Envoi échoué (${entry.idempotency_key}) : ${reason}`);
    }
  }

  return result;
}
