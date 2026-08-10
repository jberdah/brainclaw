/**
 * Fédération v2 — ÉMISSION : projeter les plans et la mémoire projet vers l'outbox.
 *
 * ── CE QUE CE MODULE COMBLE ───────────────────────────────────────────────────
 * pln#651 a livré toutes les primitives — projecteur et ses trois filets, HPKE,
 * constructeur d'enveloppes, outbox, ingestion côté cloud, board aveugle — mais RIEN ne
 * les reliait. Mesuré le 2026-08-09 : `buildEnvelope` avait ZÉRO appelant de production,
 * `enqueue` aucun, et le cloud avait reçu zéro enveloppe. La fédération était complète et
 * inerte.
 *
 * ── PÉRIMÈTRE, DÉCIDÉ PAR L'OPÉRATEUR (2026-08-09) ────────────────────────────
 * « Tous les éléments liés au projet et aux plans. » Donc : les plans, leurs étapes, et la
 * mémoire projet (décisions, contraintes, pièges, handoffs, séquences, notes). PAS les
 * entités d'exécution — claims, assignations, runs, messages : elles décrivent QUI fait
 * QUOI SUR QUELLE MACHINE, c'est-à-dire précisément la classe que dec#154 garde locale.
 *
 * ── IDEMPOTENCE, ET POURQUOI ELLE EST DANS LA CLÉ ─────────────────────────────
 * La clé d'idempotence est `<id>@r<rev>`, et l'outbox en fait un NOM DE FICHIER. Émettre
 * deux fois le même objet à la même révision ne peut donc pas produire deux entrées, même
 * si l'émission est relancée au milieu. C'est le défaut que `materializeFederationSignal`
 * avait en v1 : il frappait un nouvel id à chaque passage, rendant le dédoublonnage
 * impossible par construction.
 *
 * ── CE MODULE N'ENVOIE RIEN ───────────────────────────────────────────────────
 * Il scelle et met en file. Le transport est un autre module : une file qui saurait aussi
 * parler au réseau serait un second chemin par lequel un objet peut sortir sans passer par
 * les filets.
 */

import { buildEnvelope, type FederatedKind } from './federation-projection.js';
import { enqueue } from './federation-outbox-v2.js';
import { loadConnectionState } from './federation-state.js';
import { epochPublicKey } from './federation-keyring.js';
import { loadAgentSigningKey, resolveCurrentAgentIdentity } from './agent-registry.js';
import { loadState } from './state.js';
import { listSequences } from './sequence.js';
import { opaqueIdFor } from './federation-opaque-ids.js';
import { logger } from './logger.js';

/**
 * Les familles projetées, et RIEN d'autre.
 *
 * L'absence de `claim`, `assignment`, `agent_run`, `inbox_message` n'est pas un oubli :
 * ce sont des entités d'exécution, dont les champs utiles (hôte, session, worktree,
 * commande, pid) sont exactement ceux que `FORBIDDEN_LEAF_NAMES` refuse. Les projeter
 * reviendrait à envoyer une coquille vide, ou à faire échouer la projection.
 */
export const PROJECTED_KINDS = [
  'plan', 'plan_step', 'decision', 'constraint', 'trap', 'handoff', 'sequence', 'runtime_note',
] as const satisfies readonly FederatedKind[];

export interface ProjectableItem {
  kind: FederatedKind;
  /** Id LOCAL. Il ne sort jamais : il sert à dériver l'id opaque et la clé d'idempotence. */
  id: string;
  rev: number;
  status: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  rank?: number;
  deps?: Array<{ from: string; to: string }>;
  occurredAt: string;
  /** Le clair à sceller — contrôlé récursivement par buildEnvelope AVANT chiffrement. */
  content: Record<string, unknown>;
}

export interface EmitResult {
  collected: number;
  enqueued: number;
  /** Déjà en file ou déjà émis à cette révision — une relance ne duplique pas. */
  skipped_duplicate: number;
  /** Refusés par un des trois filets. Comptés SÉPARÉMENT : un refus n'est pas un doublon. */
  refused: number;
  refusals: Array<{ kind: string; id: string; reason: string }>;
}

/** Normalise une priorité libre vers l'échelle publiée, sinon rien. */
function normalizePriority(value: unknown): ProjectableItem['priority'] {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical'
    ? value
    : undefined;
}

/**
 * Révision d'un objet.
 *
 * Le magasin ne porte pas de compteur de révision : on dérive donc la révision de
 * `updated_at`, en secondes depuis l'epoch Unix. Ce n'est PAS un numéro de version — c'est
 * un ordre monotone par objet, ce dont l'anti-rejeu a besoin (`acceptsRevision` refuse une
 * révision inférieure ou égale à la dernière vue). Deux mutations dans la même seconde
 * produisent la même révision et la seconde sera ignorée : acceptable ici, et préférable à
 * un compteur inventé côté émission qui divergerait entre deux machines.
 */
function revisionOf(item: { updated_at?: string; created_at?: string }): number {
  const stamp = item.updated_at ?? item.created_at;
  const ms = stamp ? Date.parse(stamp) : Number.NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/**
 * Rassemble ce qui doit partir, depuis le magasin local.
 *
 * Ne lit QUE les familles de PROJECTED_KINDS. Le contenu retenu par objet est délibérément
 * étroit : ce qui n'est pas nommé ici ne peut pas partir, même chiffré.
 */
export function collectProjectable(cwd: string = process.cwd()): ProjectableItem[] {
  const state = loadState(cwd);
  const items: ProjectableItem[] = [];

  for (const plan of state.plan_items ?? []) {
    const p = plan as unknown as Record<string, unknown>;
    const id = String(p['id'] ?? '');
    if (!id) continue;
    items.push({
      kind: 'plan',
      id,
      rev: revisionOf(p as never),
      status: String(p['status'] ?? 'todo'),
      priority: normalizePriority(p['priority']),
      occurredAt: String(p['updated_at'] ?? p['created_at'] ?? new Date(0).toISOString()),
      content: {
        text: p['text'] ?? '',
        type: p['type'] ?? undefined,
        tags: p['tags'] ?? undefined,
        short_label: p['short_label'] ?? undefined,
      },
    });

    // Les étapes sont projetées comme objets À PART ENTIÈRE, pas imbriquées dans le plan.
    // Une étape a son propre statut et son propre rang : l'imbriquer forcerait à réémettre
    // le plan entier — donc à re-sceller tout son texte — pour cocher une case.
    const steps = Array.isArray(p['steps']) ? (p['steps'] as Array<Record<string, unknown>>) : [];
    steps.forEach((step, index) => {
      const stepId = String(step['id'] ?? '');
      if (!stepId) return;
      items.push({
        kind: 'plan_step',
        id: stepId,
        rev: revisionOf(step as never),
        status: String(step['status'] ?? 'todo'),
        rank: index + 1,
        // Le lien vers le plan porteur est une DÉPENDANCE, pas un champ de contenu : il
        // décrit la structure, que le board aveugle doit pouvoir rendre sans déchiffrer.
        deps: [{ from: stepId, to: id }],
        occurredAt: String(step['updated_at'] ?? step['created_at'] ?? new Date(0).toISOString()),
        content: { text: step['text'] ?? '', assignee: step['assignee'] ?? undefined },
      });
    });
  }

  const memoryFamilies: Array<[FederatedKind, string]> = [
    ['decision', 'recent_decisions'],
    ['constraint', 'active_constraints'],
    ['trap', 'known_traps'],
    // ── DEUX NOMS DE CHAMP FAUX, DEUX FAMILLES MUETTES (corrigé 2026-08-10) ──────
    // `handoffs` n'existe pas dans l'état : le champ s'appelle `open_handoffs`. La boucle
    // faisait `if (!Array.isArray(rows)) continue;` — donc 438 handoffs de ce projet étaient
    // déclarés projetables et collectés à ZÉRO, sans la moindre erreur. Un nom de champ faux
    // ne casse rien : il rend simplement une famille entière invisible.
    ['handoff', 'open_handoffs'],
    ['runtime_note', 'runtime_notes'],
  ];
  for (const [kind, field] of memoryFamilies) {
    const rows = (state as unknown as Record<string, unknown>)[field];
    if (!Array.isArray(rows)) continue;
    for (const row of rows as Array<Record<string, unknown>>) {
      const id = String(row['id'] ?? '');
      if (!id) continue;
      items.push({
        kind,
        id,
        rev: revisionOf(row as never),
        status: String(row['status'] ?? 'active'),
        priority: normalizePriority(row['severity'] ?? row['priority']),
        occurredAt: String(row['updated_at'] ?? row['created_at'] ?? new Date(0).toISOString()),
        content: {
          text: row['text'] ?? '',
          tags: row['tags'] ?? undefined,
          short_label: row['short_label'] ?? undefined,
        },
      });
    }
  }

  // ── SÉQUENCES — déclarées projetables, sans AUCUN collecteur (corrigé 2026-08-10) ──
  //
  // `sequence` figurait dans PROJECTED_KINDS depuis l'origine, mais rien ne la ramassait :
  // ni la boucle des plans, ni celle des familles mémoire. 64 séquences de ce projet ne
  // sortaient donc jamais. Elles vivent dans des fichiers propres (coordination/sequences),
  // pas dans l'état agrégé — d'où l'oubli.
  //
  // Le CONTENU retenu reste étroit, comme partout ailleurs : nom et description. Les
  // `items` (les lanes, avec leurs planId locaux) NE SORTENT PAS — ils exposeraient des
  // identifiants locaux et la structure d'exécution, que la table de classification ne
  // range pas en clair. Le board rend une séquence et son état, pas son plan de bataille.
  for (const sequence of listSequences(cwd)) {
    const row = sequence as unknown as Record<string, unknown>;
    const id = String(row['id'] ?? '');
    if (!id) continue;
    items.push({
      kind: 'sequence',
      id,
      rev: revisionOf(row as never),
      status: String(row['status'] ?? 'draft'),
      occurredAt: String(row['updated_at'] ?? row['created_at'] ?? new Date(0).toISOString()),
      content: {
        text: row['name'] ?? '',
        tags: Array.isArray(row['tags']) ? row['tags'] : undefined,
        short_label: row['short_label'] ?? undefined,
      },
    });
  }

  return items;
}

export interface EmitOptions {
  cwd?: string;
  /** Restreint l'émission à certaines familles — utile pour un premier essai borné. */
  kinds?: readonly FederatedKind[];
  /** N'émet rien : compte seulement ce qui partirait. */
  dryRun?: boolean;
  /** Agent signataire ; par défaut l'agent courant résolu depuis le registre. */
  agentId?: string;
}

/**
 * Scelle et met en file tout ce qui doit partir.
 *
 * REFUSE PLUTÔT QUE DE DEVINER : sans appairage actif, sans clé d'epoch d'écriture, ou
 * sans identité signataire, la fonction lève. Émettre « au mieux » produirait des
 * enveloppes que personne ne peut lire, et le cloud les accepterait sans broncher.
 */
export function emitProjections(options: EmitOptions = {}): EmitResult {
  const cwd = options.cwd ?? process.cwd();
  const result: EmitResult = { collected: 0, enqueued: 0, skipped_duplicate: 0, refused: 0, refusals: [] };

  const state = loadConnectionState(cwd);
  if (!state || state.enrollment.stage !== 'active') {
    throw new Error(
      'Aucun appairage actif : lancez `brainclaw cloud connect` puis `brainclaw cloud await`. ' +
        'Rien n\'est émis tant que l\'appairage n\'est pas confirmé localement.',
    );
  }

  const epoch = state.keys.current_epoch;
  const recipient = epochPublicKey(state.cloud_project_id, epoch);
  if (!recipient) {
    throw new Error(
      `Clé d'epoch ${epoch} introuvable localement pour ce projet. Cet appareil ne peut pas ` +
        'sceller : il n\'a pas reçu la clé d\'écriture courante.',
    );
  }

  // L'identité SIGNATAIRE est celle de l'AGENT, pas de l'appareil : c'est l'agent qui répond
  // de l'origine d'une enveloppe. `DeviceRecord` ne porte volontairement pas d'agent_id —
  // un même appareil peut servir plusieurs agents, et lier l'origine à la machine plutôt
  // qu'à l'auteur rendrait la signature inutilisable pour dire QUI a émis.
  // ── L'AGENT QUI SIGNE EST CELUI QUI EST APPAIRÉ, PAS CELUI DU REGISTRE LOCAL ──
  //
  // Constaté en production le 2026-08-10 : `resolveCurrentAgentIdentity` rend l'agent du
  // registre du workspace (ici `agt_687aa…`), qui n'a AUCUN rapport avec l'agent enrôlé
  // côté cloud (`claude-code-frams99`). Émettre sous cette identité produisait « Identité
  // de signature Ed25519 introuvable » — et, si une clé avait existé, aurait produit des
  // enveloppes signées par une identité NON ATTESTÉE que le cloud aurait refusées en 422.
  //
  // Le signataire doit être une identité que le cloud reconnaît pour CE projet : c'est par
  // définition celle de l'appairage actif. Le registre local sert à d'autres fins et n'a
  // aucune raison de coïncider.
  const pairedAgentId = state.pairings?.find((p) => p.stage === 'active')?.agent_id;
  const agentId = options.agentId ?? pairedAgentId ?? resolveCurrentAgentIdentity(cwd)?.agent_id;
  if (!agentId) {
    throw new Error(
      'Agent courant non résolu : impossible de déterminer qui signe l\'origine des enveloppes.',
    );
  }
  const identity = loadAgentSigningKey(agentId);
  if (!identity) {
    throw new Error(
      `Identité de signature Ed25519 introuvable pour ${agentId} : impossible de signer l'origine.`,
    );
  }

  const wanted = new Set<string>(options.kinds ?? PROJECTED_KINDS);
  const items = collectProjectable(cwd).filter((i) => wanted.has(i.kind));
  result.collected = items.length;

  for (const item of items) {
    const idempotencyKey = `${item.id}@r${item.rev}`;
    try {
      const envelope = buildEnvelope({
        kind: item.kind,
        idOpaque: opaqueIdFor(state.cloud_project_id, item.id, cwd),
        cloudProjectId: state.cloud_project_id,
        baseRev: item.rev,
        statusObject: item.status,
        priority: item.priority,
        rank: item.rank,
        // Les DÉPENDANCES portent aussi des ids : les laisser en local exposerait la
        // structure du magasin, que le reste de la projection s'applique à cacher.
        deps: item.deps?.map((d) => ({
          from: opaqueIdFor(state.cloud_project_id, d.from, cwd),
          to: opaqueIdFor(state.cloud_project_id, d.to, cwd),
        })),
        occurredAt: item.occurredAt,
        wrapHint: `epoch:${epoch}`,
        operationId: idempotencyKey,
        keyEpoch: epoch,
        content: item.content,
        recipientPublicKeyPem: recipient.public_key_pem,
        originKeyId: identity.fingerprint,
        originPrivateKeyPem: identity.privateKeyPem,
      });

      if (options.dryRun) continue;

      const added = enqueue(
        { idempotency_key: idempotencyKey, operation_id: idempotencyKey, base_rev: item.rev, key_epoch: epoch, sealed: envelope, origin_agent_id: agentId },
        cwd,
      );
      if (added) result.enqueued += 1;
      else result.skipped_duplicate += 1;
    } catch (err) {
      // Un refus est COMPTÉ ET NOMMÉ, jamais avalé. Les trois filets refusent précisément
      // ce qui ne doit pas sortir : masquer leur verdict transformerait une protection en
      // perte silencieuse d'objets.
      result.refused += 1;
      result.refusals.push({
        kind: item.kind,
        id: item.id,
        reason: err instanceof Error ? err.message : String(err),
      });
      logger.warn(`Projection refusée — ${item.kind} ${item.id} : ${result.refusals.at(-1)?.reason}`);
    }
  }

  return result;
}
