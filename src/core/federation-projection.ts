/**
 * Le projecteur et ses trois filets — fédération v2 (pln#651 étape 5, RFC §4).
 *
 * C'est ici que la table de classification devient EXÉCUTABLE. Trois classes, et
 * « non classé » n'en est pas une quatrième : c'est un refus.
 *
 * ── POURQUOI TROIS FILETS ET NON UN SEUL ──────────────────────────────────────
 * Établi par quatre critiques sur quatre pendant l'idéation, chacune par un angle
 * différent :
 *   (i)   Zod fait `.strip()` PAR DÉFAUT — un champ nouveau passe la validation en
 *         silence, sans jamais lever ;
 *   (ii)  un test couvre la SORTIE, pas la CONSTRUCTION — N projecteurs, un seul testé,
 *         et les N-1 autres fuient (application littérale de trp#5a8fb7d9) ;
 *   (iii) `{...entity, ciphertext}` compile parfaitement et déverse tout.
 *
 * Et le typage seul ne borne RIEN. `pushToCloud(payload: { id: string })` suivi d'un
 * `JSON.stringify` sérialise chaque clé présente à L'EXÉCUTION : le typage structurel de
 * TypeScript est une BORNE INFÉRIEURE sur ce que l'objet contient, jamais une borne
 * supérieure. C'est la raison pour laquelle le filet 2 existe malgré le filet 1.
 *
 * FILET 1 — un builder nominal, marque de type non fabricable ailleurs, sélection
 *           explicite champ par champ, JAMAIS de spread.
 * FILET 2 — un parse `.strict()` à UN SEUL point de sortie que tout push traverse.
 * FILET 3 — fixture golden byte-exacte + test de complétude sur l'inventaire.
 *
 * ── CE QUI RESTE VISIBLE, ÉCRIT ET NON MASQUÉ ─────────────────────────────────
 * « Lane 3 » cache le libellé, pas le GRAPHE. Le nombre de lanes, la forme du graphe de
 * dépendances et la cardinalité restent lisibles par le Cloud. C'est assumé : le board
 * aveugle rend une structure, et une structure est une information. Le prétendre
 * autrement serait mentir sur la garantie.
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, canonicalSha256, b64url } from './federation-canonical.js';
import { seal, type SealedBlob, HPKE_SUITE } from './federation-hpke.js';

export const ENVELOPE_SCHEMA = 'brainclaw.federation-envelope/v1' as const;
export const AAD_PROTOCOL = 'brainclaw/federation/v1' as const;

/**
 * Types d'entités PROJETABLES. Une famille absente de cette liste n'est pas « à faire
 * plus tard » : son schéma entier est interdit de sortie (RFC §4.3). L'ajout d'une
 * famille est un acte délibéré qui passe par la table de classification.
 */
export const FEDERATED_KINDS = [
  'constraint', 'decision', 'trap', 'handoff', 'plan', 'plan_step', 'sequence',
  'claim', 'candidate', 'runtime_note', 'inbox_message', 'assignment',
  'agent_run', 'action_required', 'ai_task', 'runtime_event', 'lane_result',
] as const;
export type FederatedKind = (typeof FEDERATED_KINDS)[number];

// ── Champs INTERDITS DE SORTIR (RFC §4.2, classe 3) ──────────────────────────

/**
 * Ces noms ne doivent apparaître NI dans meta NI dans sealed. Leur présence fait échouer
 * la projection — un refus, pas une troncature.
 *
 * POURQUOI UNE LISTE DE NOMS ICI ALORS QUE J'AI ÉCRIT AILLEURS QU'UNE LISTE DE NOMS NE
 * SUFFIT PAS : elle ne suffit effectivement pas SEULE, et n'est pas seule. Le filet 1
 * empêche déjà tout champ non explicitement sélectionné d'entrer dans meta, et le filet 2
 * refuse toute clé inconnue à la sortie. Cette liste est un TROISIÈME contrôle qui vise
 * le SCELLÉ — la seule partie que les deux autres filets ne peuvent pas inspecter,
 * puisqu'ils la traitent comme opaque. Sans elle, `worktree_path` chiffré partirait quand
 * même : chiffré n'est pas « autorisé à sortir ».
 */
export const FORBIDDEN_LEAF_NAMES = new Set([
  'host_id', 'session_id', 'worktree_path', 'project_path', 'storage_dir', 'related_paths',
  'command', 'shell', 'pid', 'provider_run_id', 'base_sha', 'cwd',
  'api_key', 'apiKey', 'secret', 'token', 'password', 'private_key', 'privateKey',
  'env', 'environment',
]);

/** Motifs de VALEURS trahissant un chemin local, quel que soit le nom du champ. */
const LOCAL_PATH_PATTERNS = [
  /^[A-Za-z]:[\\/]/,          // C:\... ou C:/...
  /^\/(?:home|Users|root)\//, // /home/x, /Users/x, /root/x
  /\.brainclaw[\\/]worktrees/,
];

export class ProjectionRefused extends Error {
  constructor(message: string, readonly path: string) {
    super(message);
    this.name = 'ProjectionRefused';
  }
}

/**
 * Parcours RÉCURSIF refusant tout champ interdit, par son nom ou par la forme de sa
 * valeur.
 *
 * Appliqué au CLAIR AVANT scellement, donc y compris à ce qui partira chiffré. Le RFC est
 * explicite : la classe interdite est « absente de meta ET de sealed ». Un chemin de
 * worktree chiffré reste une donnée qui a quitté l'hôte, et le jour où la clé fuit, elle
 * a fui aussi. Le chiffrement protège le contenu ; il ne rend pas licite de l'envoyer.
 */
export function assertNoForbiddenLeaf(value: unknown, path = '$'): void {
  if (value === null || value === undefined) return;

  if (typeof value === 'string') {
    for (const pattern of LOCAL_PATH_PATTERNS) {
      if (pattern.test(value)) {
        throw new ProjectionRefused(
          `Chemin local détecté en ${path} — interdit de sortir, même scellé (RFC §4.2).`,
          path,
        );
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoForbiddenLeaf(v, `${path}[${i}]`));
    return;
  }

  if (typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_LEAF_NAMES.has(key)) {
        throw new ProjectionRefused(
          `Champ interdit '${key}' en ${path} — absent de meta ET de sealed (RFC §4.2).`,
          `${path}.${key}`,
        );
      }
      assertNoForbiddenLeaf(v, `${path}.${key}`);
    }
  }
}

// ── FILET 2 : le schéma strict du point de sortie unique ─────────────────────

/**
 * `.strict()` PARTOUT, et c'est le point.
 *
 * Zod `.strip()` — le défaut — accepterait un objet porteur d'une clé inconnue et la
 * retirerait SILENCIEUSEMENT du résultat. Le push passerait, et personne n'apprendrait
 * qu'un champ non classé a été ajouté au projecteur. `.strict()` LÈVE, ce qui transforme
 * l'oubli de classification en échec de CI plutôt qu'en fuite discrète.
 */
const CanonicalAadSchema = z.object({
  protocol: z.literal(AAD_PROTOCOL),
  cloud_project_id: z.string().min(1),
  object_id: z.string().min(1),
  base_rev: z.number().int().nonnegative(),
  object_type: z.enum(FEDERATED_KINDS),
  schema: z.literal(ENVELOPE_SCHEMA),
}).strict();

const PublicMetaSchema = z.object({
  id_opaque: z.string().uuid(),
  kind: z.enum(FEDERATED_KINDS),
  status: z.object({
    object: z.string().min(1),
    sync: z.enum(['pending', 'synced', 'conflict']).optional(),
  }).strict(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  rank: z.number().int().optional(),
  deps: z.array(z.object({ from: z.string().uuid(), to: z.string().uuid() }).strict()),
  // Jour UTC, JAMAIS l'heure. Une heure précise trahit le rythme de travail d'une
  // personne ; le jour ne dit que la cadence, ce que le RFC assume explicitement.
  timestamp_bucket_jour: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  base_rev: z.number().int().nonnegative(),
  aad: CanonicalAadSchema,
  // Ne contient NI nom NI empreinte de destinataire : la référence de paquet de clés
  // aurait divulgué le roster, canal de fuite que l'idéation avait manqué.
  wrap_hint: z.string().min(1),
  transport: z.object({
    operation_id: z.string().min(1),
    content_hash: z.string().min(1),
    idempotency_key: z.string().min(1),
  }).strict(),
}).strict();

const SealedSchema = z.object({
  alg: z.literal(HPKE_SUITE),
  enc: z.string().min(1),
  nonce: z.string().min(1),
  ciphertext: z.string().min(1),
}).strict();

export const FederationEnvelopeSchema = z.object({
  schema: z.literal(ENVELOPE_SCHEMA),
  meta: PublicMetaSchema,
  sealed: SealedSchema,
  key_epoch: z.number().int().nonnegative(),
  origin_sig: z.object({
    alg: z.literal('Ed25519'),
    key_id: z.string().min(1),
    value: z.string().min(1),
  }).strict(),
}).strict();

export type FederationEnvelope = z.infer<typeof FederationEnvelopeSchema>;
export type PublicMeta = z.infer<typeof PublicMetaSchema>;
export type CanonicalAad = z.infer<typeof CanonicalAadSchema>;

// ── FILET 1 : le builder nominal ─────────────────────────────────────────────

/**
 * Marque de type non fabricable hors de ce module.
 *
 * Un objet littéral de la bonne FORME n'est pas assignable à `PublicProjection` : le
 * symbole unique n'est exporté nulle part. Cela empêche un appelant de contourner
 * `toPublicProjection` en construisant « le même objet » à la main — le cas où le filet 1
 * serait présent mais inutilisé.
 */
declare const projectionBrand: unique symbol;
export type PublicProjection = PublicMeta & { readonly [projectionBrand]: true };

export interface ProjectionInput {
  kind: FederatedKind;
  idOpaque: string;
  cloudProjectId: string;
  baseRev: number;
  /** État métier NORMALISÉ — pas la valeur locale recopiée (RFC §4.2). */
  statusObject: string;
  syncState?: 'pending' | 'synced' | 'conflict';
  priority?: 'low' | 'medium' | 'high' | 'critical';
  rank?: number;
  deps?: Array<{ from: string; to: string }>;
  /** Date d'événement ; réduite au jour UTC par ce builder, jamais par l'appelant. */
  occurredAt: Date | string;
  wrapHint: string;
  operationId: string;
  sealed: SealedBlob;
}

/** Jour UTC. La troncature est faite ICI pour qu'aucun appelant ne puisse l'oublier. */
function dayBucket(when: Date | string): string {
  const d = typeof when === 'string' ? new Date(when) : when;
  if (Number.isNaN(d.getTime())) throw new ProjectionRefused('Date invalide pour le bucket jour.', '$.occurredAt');
  return d.toISOString().slice(0, 10);
}

/**
 * Construit la projection publique — SÉLECTION EXPLICITE, CHAMP PAR CHAMP.
 *
 * Aucun spread nulle part dans cette fonction, et c'est délibéré : `{...input}` suffirait
 * à déverser tout ce que l'appelant a mis dans l'objet. Chaque champ de meta est nommé
 * ici ou n'existe pas. Ajouter un champ à `PublicMetaSchema` sans l'ajouter ici produit
 * une erreur de compilation, et l'inverse un échec de parse `.strict()`.
 *
 * `priority` et `rank` ne sont posés QUE s'ils existent : l'absence d'un champ optionnel
 * est SIGNIFICATIVE (RFC §3). Inventer `priority: 'medium'` pour un objet qui n'en porte
 * pas créerait une fuite par normalisation — le Cloud croirait à une priorité choisie.
 */
export function toPublicProjection(input: ProjectionInput): PublicProjection {
  const aad: CanonicalAad = {
    protocol: AAD_PROTOCOL,
    cloud_project_id: input.cloudProjectId,
    object_id: input.idOpaque,
    base_rev: input.baseRev,
    object_type: input.kind,
    schema: ENVELOPE_SCHEMA,
  };

  const meta: PublicMeta = {
    id_opaque: input.idOpaque,
    kind: input.kind,
    status: input.syncState
      ? { object: input.statusObject, sync: input.syncState }
      : { object: input.statusObject },
    deps: (input.deps ?? []).map((d) => ({ from: d.from, to: d.to })),
    timestamp_bucket_jour: dayBucket(input.occurredAt),
    base_rev: input.baseRev,
    aad,
    wrap_hint: input.wrapHint,
    transport: {
      operation_id: input.operationId,
      // Dérivés du CIPHERTEXT, jamais du clair (RFC §3.2). En v1, content_hash portait
      // sur le corps sémantique en clair : le Cloud pouvait alors confirmer une
      // devinette sur un contenu à faible entropie en comparant des hachages.
      content_hash: canonicalSha256(input.sealed),
      idempotency_key: '',
    },
  };
  if (input.priority !== undefined) meta.priority = input.priority;
  if (input.rank !== undefined) meta.rank = input.rank;

  return meta as PublicProjection;
}

// ── Point de sortie UNIQUE ───────────────────────────────────────────────────

export interface BuildEnvelopeParams {
  kind: FederatedKind;
  idOpaque: string;
  cloudProjectId: string;
  baseRev: number;
  statusObject: string;
  syncState?: 'pending' | 'synced' | 'conflict';
  priority?: 'low' | 'medium' | 'high' | 'critical';
  rank?: number;
  deps?: Array<{ from: string; to: string }>;
  occurredAt: Date | string;
  wrapHint: string;
  operationId: string;
  keyEpoch: number;
  /** Contenu à sceller — contrôlé récursivement AVANT chiffrement. */
  content: unknown;
  recipientPublicKeyPem: string;
  /** Identité Ed25519 signataire ; `key_id` est un pseudonyme stable, pas un nom. */
  originKeyId: string;
  originPrivateKeyPem: string;
}

/**
 * LE SEUL point par lequel une enveloppe peut être produite.
 *
 * L'ordre des opérations est un contrat, pas un détail :
 *   1. refus des champs interdits sur le CLAIR (avant qu'ils ne deviennent illisibles) ;
 *   2. AAD canonique, lié au projet, à l'objet, à la révision et au type ;
 *   3. scellement HPKE avec cet AAD exact ;
 *   4. projection publique par le filet 1 ;
 *   5. dérivés de transport calculés sur le CIPHERTEXT ;
 *   6. signature d'origine sur meta ‖ sealed ‖ key_epoch ;
 *   7. parse `.strict()` — le filet 2 — qui refuse toute clé inconnue.
 *
 * Inverser 1 et 3 laisserait passer un champ interdit dans le blob chiffré.
 */
export function buildEnvelope(params: BuildEnvelopeParams): FederationEnvelope {
  // (1) Le contrôle porte sur le clair, y compris ce qui sera scellé.
  assertNoForbiddenLeaf(params.content, '$.content');

  // (2) AAD comme STRUCTURE canonique et non concaténation ambiguë : « a|b » et « a|b »
  // issus de découpages différents produisent la même chaîne, donc deux contextes
  // distincts indiscernables.
  const aad: CanonicalAad = {
    protocol: AAD_PROTOCOL,
    cloud_project_id: params.cloudProjectId,
    object_id: params.idOpaque,
    base_rev: params.baseRev,
    object_type: params.kind,
    schema: ENVELOPE_SCHEMA,
  };
  const aadBytes = new TextEncoder().encode(canonicalJson(aad));

  // (3)
  const sealed = seal({
    recipientPublicKeyPem: params.recipientPublicKeyPem,
    plaintext: new TextEncoder().encode(canonicalJson(params.content)),
    aadCanonicalBytes: aadBytes,
  });

  // (4)
  const meta = toPublicProjection({
    kind: params.kind,
    idOpaque: params.idOpaque,
    cloudProjectId: params.cloudProjectId,
    baseRev: params.baseRev,
    statusObject: params.statusObject,
    syncState: params.syncState,
    priority: params.priority,
    rank: params.rank,
    deps: params.deps,
    occurredAt: params.occurredAt,
    wrapHint: params.wrapHint,
    operationId: params.operationId,
    sealed,
  }) as PublicMeta;

  // (5) idempotency_key = SHA-256(canonical(sealed) || operation_id || origin_sig.key_id).
  // CLEFÉE par l'identité du signataire : deux agents qui pousseraient le même contenu
  // n'auraient pas la même clé, donc le Cloud ne peut pas déduire qu'ils poussent la
  // même chose.
  meta.transport.idempotency_key = b64url(
    new Uint8Array(
      crypto.createHash('sha256')
        .update(canonicalJson(sealed), 'utf-8')
        .update(params.operationId, 'utf-8')
        .update(params.originKeyId, 'utf-8')
        .digest(),
    ),
  );

  // (6) L'entrée couvre alg, enc, nonce ET ciphertext, plus key_epoch — pas seulement
  // « meta || ciphertext ». Le raccourci ne couvrirait pas les paramètres permettant
  // d'INTERPRÉTER le ciphertext, qu'un Cloud pourrait alors modifier sans casser la
  // signature.
  const signingInput = Buffer.concat([
    Buffer.from('brainclaw/federation-envelope/v1\0', 'utf-8'),
    Buffer.from(canonicalJson(meta), 'utf-8'),
    Buffer.from(canonicalJson(sealed), 'utf-8'),
    Buffer.from(canonicalJson(params.keyEpoch), 'utf-8'),
  ]);
  const signature = crypto.sign(null, signingInput, crypto.createPrivateKey(params.originPrivateKeyPem));

  const envelope = {
    schema: ENVELOPE_SCHEMA,
    meta,
    sealed,
    key_epoch: params.keyEpoch,
    origin_sig: { alg: 'Ed25519' as const, key_id: params.originKeyId, value: signature.toString('base64url') },
  };

  // (7) FILET 2 — fail-closed. Une clé inconnue lève ici plutôt que de partir sur le fil.
  return FederationEnvelopeSchema.parse(envelope);
}

/**
 * Octets exacts sur lesquels porte la signature d'origine.
 *
 * Exporté pour que le VÉRIFICATEUR les reconstruise avec la même fonction que
 * l'émetteur. Deux reconstructions indépendantes est précisément le défaut qui a rendu
 * l'attestation d'appairage insatisfiable côté Cloud : le vérificateur fabriquait un
 * champ que le signataire ne pouvait pas connaître.
 */
export function originSigningInput(meta: unknown, sealed: unknown, keyEpoch: number): Buffer {
  return Buffer.concat([
    Buffer.from('brainclaw/federation-envelope/v1\0', 'utf-8'),
    Buffer.from(canonicalJson(meta), 'utf-8'),
    Buffer.from(canonicalJson(sealed), 'utf-8'),
    Buffer.from(canonicalJson(keyEpoch), 'utf-8'),
  ]);
}

// ── Ids opaques ──────────────────────────────────────────────────────────────

/**
 * Ids RE-ROULÉS en UUID v4, mapping local↔cloud gardé LOCAL.
 *
 * Pourquoi ne pas simplement hacher l'id local : un hachage est déterministe, donc le
 * même objet exporté vers deux projets Cloud produirait le même identifiant, et un
 * observateur corrélerait les deux projets. Un UUID aléatoire par projet coupe cette
 * corrélation — c'est le sens de « stable dans un projet Cloud, pas cross-projet »
 * (RFC §4.1).
 */
export function newOpaqueId(): string {
  return crypto.randomUUID();
}
