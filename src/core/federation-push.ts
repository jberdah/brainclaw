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

import crypto from 'node:crypto';
import { list, transition, type OutboxEntry } from './federation-outbox-v2.js';
import { loadConnectionState } from './federation-state.js';
import { loadAgentSigningKey } from './agent-registry.js';
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
  /** Agent signataire du transport ; par défaut celui porté par les entrées d'outbox. */
  agentId?: string;
  fetchImpl?: typeof fetch;
  /**
   * Clé d'API porteuse, si le déploiement en exige une.
   *
   * TENSION DE CONCEPTION NOMMÉE PLUTÔT QUE CONTOURNÉE : dec#8 bannit les clés d'API du
   * parcours d'appairage — l'humain ne manipule qu'un code d'invitation et compare des
   * empreintes. Mais l'endpoint d'ingestion du cloud exige aujourd'hui une clé d'API
   * (401 « Missing API key »), et l'appairage attesté n'en produit aucune.
   *
   * L'appareil possède pourtant déjà de quoi s'authentifier : son identité Ed25519 est
   * attestée côté cloud, et chaque enveloppe est SIGNÉE par elle. La signature d'origine
   * est donc l'authentification naturelle de ce chemin — la clé d'API est une béquille de
   * transition, pas le modèle. À reprendre avec dec#159.
   */
  apiKey?: string;
}


/**
 * Met une entrée d'outbox à la forme que le cloud attend RÉELLEMENT.
 *
 * ── POURQUOI CETTE FONCTION EXISTE, ET CE QU'ELLE A COÛTÉ ────────────────────
 * La première version envoyait `{ envelope, key_epoch, base_rev }` — la forme que je
 * SUPPOSAIS. Le cloud attend des champs À PLAT : id, entity_kind, entity_id, rev,
 * sealed_b64, content_hash, meta, et quatre champs d'origine. Mon test de bout en bout
 * n'a rien vu : il utilisait un `fetch` simulé, donc il validait mon hypothèse de l'API
 * contre elle-même.
 *
 * C'est la même leçon que d'habitude, à un endroit nouveau : un contrat inter-services ne
 * se vérifie que contre le service, jamais contre l'idée qu'on s'en fait.
 *
 * `sealed` est encodé en base64 d'un JSON canonique : le cloud le stocke sans jamais
 * l'ouvrir — il n'en a pas la clé.
 */
/** En-têtes communs : type, idempotence, et porteur si le déploiement l'exige. */
function authHeaders(idempotencyKey: string, apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    // La clé d'idempotence voyage AUSSI en en-tête : le cloud doit pouvoir dédoublonner
    // sans ouvrir le corps, qu'il ne peut de toute façon pas lire.
    'idempotency-key': idempotencyKey,
  };
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  return headers;
}

/**
 * Charge SIGNÉE DU TRANSPORT — reconstruite exactement comme le cloud la reconstruit.
 *
 * L'ordre des clés compte : le cloud fait `JSON.stringify` sur cet objet littéral, sans
 * tri. Une clé déplacée produit une chaîne différente, donc un condensé différent, donc un
 * refus SIG_PAYLOAD_HASH_MISMATCH que rien dans le message n'expliquerait.
 */
function transportPayload(wire: Record<string, unknown>, baseRev: string | null): string {
  return JSON.stringify({
    v: 1,
    kind: 'brainclaw.federation.v2.envelope',
    envelope_id: wire['id'],
    project_id: wire['__project_id'],
    entity_kind: wire['entity_kind'],
    entity_id: wire['entity_id'],
    rev: wire['rev'],
    base_rev: baseRev,
    content_hash: wire['content_hash'],
    key_epoch: wire['key_epoch'],
    is_tombstone: false,
  });
}

/**
 * Signe la charge de transport et renseigne les trois champs qui en dépendent.
 *
 * ── POURQUOI LE TRANSPORT SIGNE, ALORS QUE L'ENVELOPPE EST DÉJÀ SIGNÉE ───────
 * Ce sont DEUX garanties distinctes. La signature d'enveloppe (RFC) lie meta ‖ sealed ‖
 * key_epoch : elle dit « ce contenu vient de cet auteur ». La signature de transport lie
 * envelope_id, rev, base_rev et content_hash : elle dit « cette opération-ci s'applique à
 * CETTE révision », ce que la première ne peut pas dire — ces champs n'existent pas encore
 * au moment de sceller.
 *
 * ── ET C'EST CE QUI DÉBLOQUE LE RECALAGE SUR 409 ────────────────────────────
 * J'avais d'abord jugé les deux contrats incompatibles (dec#160 §6), parce que `base_rev`
 * peut changer au réessai et invaliderait une signature calculée à l'émission. Faire signer
 * le TRANSPORT lève l'objection : il resigne simplement avec la nouvelle valeur.
 *
 * Cette clé Ed25519 SIGNE, elle ne déchiffre rien : la propriété « ce module ne peut pas
 * divulguer de clair » tient toujours.
 */
function signTransport(
  wire: Record<string, unknown>,
  baseRev: string | null,
  identityPem: string,
): Record<string, unknown> {
  const payload = Buffer.from(transportPayload(wire, baseRev), 'utf-8');
  const signature = crypto.sign(null, payload, crypto.createPrivateKey(identityPem));
  const body: Record<string, unknown> = { ...wire, base_rev: baseRev };
  delete body['__project_id'];
  return {
    ...body,
    origin_sig: signature.toString('base64'),
    origin_sig_payload_hash: crypto.createHash('sha256').update(payload).digest('hex'),
  };
}

function toWireBody(entry: OutboxEntry): Record<string, unknown> {
  const env = entry.sealed as {
    meta: Record<string, unknown>;
    sealed: unknown;
    key_epoch: number;
    origin_sig: { alg: string; key_id: string; value: string };
  };
  const meta = env.meta;
  const transport = (meta['transport'] ?? {}) as Record<string, unknown>;

  // ── L'EMPREINTE PORTE SUR CE QUI EST RÉELLEMENT ENVOYÉ ──────────────────────
  //
  // Le cloud recalcule SHA-256 sur les octets DÉCODÉS de `sealed_b64`, en hexadécimal, et
  // refuse tout écart (CONTENT_HASH_MISMATCH). Le `content_hash` du core est calculé
  // autrement — base64url sur une autre sérialisation — donc le réutiliser tel quel
  // échouait systématiquement.
  //
  // Le calculer ICI, sur les octets exacts qu'on encode, rend l'accord vrai PAR
  // CONSTRUCTION plutôt que par coïncidence de conventions. Deux sérialisations qui
  // doivent produire le même condensé sont un pari ; hacher ce qu'on envoie n'en est pas un.
  const sealedBytes = Buffer.from(JSON.stringify(env.sealed), 'utf-8');
  const contentHashHex = crypto.createHash('sha256').update(sealedBytes).digest('hex');

  return {
    id: String(transport['idempotency_key'] ?? entry.idempotency_key),
    entity_kind: meta['kind'],
    entity_id: meta['id_opaque'],
    rev: String(meta['base_rev'] ?? entry.base_rev ?? 0),
    // Aucune tête connue au premier envoi : le cloud l'annonce dans son 409 et l'appelant
    // se recale une fois. Suivre cette tête localement dupliquerait un état dont le cloud
    // est déjà l'autorité.
    base_rev: null,
    sealed_b64: sealedBytes.toString('base64'),
    key_epoch: env.key_epoch,
    content_hash: contentHashHex,
    idempotency_key: String(transport['idempotency_key'] ?? entry.idempotency_key),
    // `key_id` de l'enveloppe EST l'empreinte du signataire (cf. federation-emit).
    // L'agent d'origine voyage à part : le cloud vérifie l'un ET l'autre.
    origin_agent_id: entry.origin_agent_id ?? env.origin_sig.key_id,
    // Renseignés par `signTransport` : ils dépendent de `base_rev`, connu seulement ici.
    origin_sig: '',
    origin_sig_payload_hash: '',
    origin_signer_fingerprint: env.origin_sig.key_id,
    meta,
  };
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

  // L'identité SIGNATAIRE du transport : celle de l'agent qui a produit les enveloppes.
  // Elle est portée par l'entrée d'outbox, donc le transport n'a pas à deviner qui signe.
  const agentId = options.agentId ?? list('pending', cwd)[0]?.origin_agent_id;
  const identity = agentId ? loadAgentSigningKey(agentId) : undefined;
  if (!identity) {
    throw new Error(
      'Identité de signature introuvable : le cloud vérifie une signature de TRANSPORT ' +
        'liant envelope_id, rev et base_rev. Sans elle, chaque envoi est refusé en 422.',
    );
  }
  const identityPem = identity.privateKeyPem;

  const pending = list('pending', cwd);
  const batch = options.limit ? pending.slice(0, options.limit) : pending;
  result.attempted = batch.length;
  if (options.dryRun) return result;

  const endpoint = `${base}/api/v1/projects/${state.cloud_project_id}/projection/envelopes`;

  for (const entry of batch) {
    try {
      const wire = { ...toWireBody(entry), __project_id: state.cloud_project_id };
      let signed = signTransport(wire, null, identityPem);
      let res = await doFetch(endpoint, {
        method: 'POST',
        headers: authHeaders(entry.idempotency_key, options.apiKey),
        body: JSON.stringify(signed),
      });

      // ── RECALAGE SUR 409, UNE SEULE FOIS ──────────────────────────────────
      //
      // Le cloud applique une concurrence optimiste : `base_rev` doit désigner la tête
      // courante. Un émetteur qui n'a jamais poussé ne CONNAÎT pas cette tête — et la
      // suivre localement dupliquerait un état dont le cloud est déjà l'autorité.
      //
      // Le refus la contient (`expected_base_rev`) : on renvoie donc une fois avec la
      // valeur annoncée. UNE SEULE, délibérément : boucler transformerait un désaccord
      // réel en écrasement silencieux du travail d'un autre appareil.
      if (res.status === 409) {
        const detail = (await res.clone().json().catch(() => ({}))) as Record<string, unknown>;
        const expected = detail['expected_base_rev'] ?? detail['expected'];
        if (typeof expected === 'string' || typeof expected === 'number') {
          // On RESIGNE avec la nouvelle base_rev : c'est précisément ce que la signature
          // au niveau du transport rend possible, et qu'une signature figée à l'émission
          // interdisait.
          signed = signTransport(wire, String(expected), identityPem);
          res = await doFetch(endpoint, {
            method: 'POST',
            headers: authHeaders(entry.idempotency_key, options.apiKey),
            body: JSON.stringify(signed),
          });
        }
      }

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
