/**
 * Fédération v2 — pull : le cloud livre un delta, ce module vérifie puis
 * matérialise seulement le clair accepté. Le cloud reste un relais, jamais la
 * source de vérité locale.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { verifyInboundBatch, type AttestedRoster, type VerificationAccepted } from './federation-inbound.js';
import { loadEpochPrivateKey } from './federation-keyring.js';
import { localIdForOpaque, rememberOpaqueId } from './federation-opaque-ids.js';
import { addStep, createPlan, updatePlan, updateStep } from './operations/plan.js';
import { memoryDir, writeFileAtomic } from './io.js';
import { nowISO } from './ids.js';
import { loadConnectionState, recordRevision, saveConnectionState, type FederationConnectionState } from './federation-state.js';

const INBOUND_SCHEMA = 'brainclaw.federation-inbound-pull/v1';
const INBOUND_FILE = 'inbound-pull.json';

/**
 * Limite transitoire, volontairement rendue à l'UI : le roster signé de dec#159
 * n'existe pas encore. Tirer les attestations du cloud demande donc au relais qui
 * surveiller ; la signature protège le contenu, pas cette sélection de clés.
 */
export const CLOUD_ROSTER_LIMITATION =
  'Roster provisoire : attestations tirées du cloud, pas encore un roster signé (dec#159 §5). Le relais peut influencer qui est accepté comme signataire.';

export interface PullOptions {
  cwd?: string;
  url: string;
  limit?: number;
  fetchImpl?: typeof fetch;
  /** Injection de trousseau pour les tests ; en production lit le keyring local. */
  epochKeyFor?: (cloudProjectId: string, epoch: number) => crypto.KeyObject | undefined;
  apiKey?: string;
}

export interface PullProblem {
  idempotency_key?: string;
  key_epoch?: number;
  reason: string;
}

export interface PullResult {
  received: number;
  verified: number;
  materialized: number;
  unreadable_epoch_absent: PullProblem[];
  rejected: PullProblem[];
  deferred: PullProblem[];
  retained: number;
  feed_cursor?: string;
  roster_limitation: string;
}

interface PendingInbound { raw: unknown; key_epoch?: number; received_at: string }
interface InboundJournal {
  schema: typeof INBOUND_SCHEMA;
  seen: string[];
  pending: Record<string, PendingInbound>;
}

function journalPath(cwd: string): string {
  return path.join(memoryDir(cwd), 'coordination', 'federation', INBOUND_FILE);
}

function loadJournal(cwd: string): InboundJournal {
  const file = journalPath(cwd);
  if (!fs.existsSync(file)) return { schema: INBOUND_SCHEMA, seen: [], pending: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<InboundJournal>;
    if (parsed.schema !== INBOUND_SCHEMA || !Array.isArray(parsed.seen) || !parsed.pending || typeof parsed.pending !== 'object') {
      return { schema: INBOUND_SCHEMA, seen: [], pending: {} };
    }
    return {
      schema: INBOUND_SCHEMA,
      seen: parsed.seen.filter((key): key is string => typeof key === 'string'),
      pending: parsed.pending as Record<string, PendingInbound>,
    };
  } catch {
    // Un journal local corrompu n'est jamais une preuve qu'un message a été appliqué.
    return { schema: INBOUND_SCHEMA, seen: [], pending: {} };
  }
}

function saveJournal(journal: InboundJournal, cwd: string): void {
  const file = journalPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(journal, null, 2)}\n`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function rawKey(raw: unknown): string {
  // Déduplication de stockage uniquement — jamais une décision d'authenticité.
  return crypto.createHash('sha256').update(JSON.stringify(raw)).digest('hex');
}

/**
 * Le cloud rend une LIGNE À PLAT dont un champ, `envelope_json`, porte l'enveloppe signée
 * verbatim (dec#162). C'est ELLE que le vérificateur doit parser — la ligne plate n'a ni
 * la forme imbriquée de FederationEnvelopeSchema ni la signature d'AUTEUR. Sans
 * `envelope_json` (enveloppe poussée avant dec#162), on laisse passer l'objet tel quel :
 * il échouera en `schema_invalid`, ce qui est le verdict juste — non vérifiable.
 */
function toEnvelope(item: unknown): unknown {
  const record = asRecord(item);
  if (record && typeof record['envelope_json'] === 'string') {
    try { return JSON.parse(record['envelope_json']); } catch { return item; }
  }
  return item;
}

function responseArray(value: unknown, fields: string[]): unknown[] | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  for (const field of fields) if (Array.isArray(record[field])) return record[field] as unknown[];
  return undefined;
}

function parseDelta(body: unknown): { envelopes: unknown[]; cursor?: string } {
  if (Array.isArray(body)) return { envelopes: body };
  const root = asRecord(body);
  if (!root) throw new Error('Delta cloud invalide : objet JSON attendu.');
  const source = asRecord(root['data']) ?? asRecord(root['delta']) ?? root;
  const envelopes = responseArray(source, ['envelopes', 'items', 'results']);
  if (!envelopes) throw new Error('Delta cloud invalide : tableau envelopes attendu.');
  const cursor = source['next_seq'] ?? source['next_cursor'] ?? source['nextCursor'] ?? source['cursor'];
  return { envelopes, cursor: typeof cursor === 'string' || typeof cursor === 'number' ? String(cursor) : undefined };
}

/** Lit les attestations cloud. Ce n'est PAS un roster signé : voir la constante exportée. */
function parseCloudRoster(body: unknown): AttestedRoster {
  const root = asRecord(body);
  if (!root) throw new Error('Roster cloud invalide : objet JSON attendu.');
  const source = asRecord(root['data']) ?? root;
  const keys = new Map<string, string>();
  const revoked = new Set<string>();
  const compact = asRecord(source['keys']);
  if (compact) {
    for (const [id, pem] of Object.entries(compact)) if (typeof pem === 'string') keys.set(id, pem);
  }
  for (const value of responseArray(source, ['attestations', 'members', 'roster', 'items']) ?? []) {
    const row = asRecord(value);
    if (!row) continue;
    const id = row['key_id'] ?? row['identity_fingerprint'] ?? row['signer_fingerprint'];
    const pem = row['identity_public_key_pem'] ?? row['ed25519_public_key_pem'] ?? row['public_key_pem'];
    if (typeof id !== 'string' || typeof pem !== 'string') continue;
    keys.set(id, pem);
    if (row['revoked'] === true || row['revoked_at']) revoked.add(id);
  }
  return { keys, revoked };
}

function headers(apiKey?: string): Record<string, string> {
  return apiKey ? { accept: 'application/json', authorization: `Bearer ${apiKey}` } : { accept: 'application/json' };
}

async function readJson(res: Response, label: string): Promise<unknown> {
  if (!res.ok) throw new Error(`${label} refusé par le cloud (HTTP ${res.status}) : ${(await res.text()).slice(0, 200)}`);
  try { return await res.json(); } catch { throw new Error(`${label} invalide : JSON attendu.`); }
}

function problem(raw: unknown, reason: string): PullProblem {
  const env = asRecord(raw);
  const meta = asRecord(env?.['meta']);
  const transport = asRecord(meta?.['transport']);
  return {
    idempotency_key: typeof transport?.['idempotency_key'] === 'string' ? transport['idempotency_key'] : undefined,
    key_epoch: typeof env?.['key_epoch'] === 'number' ? env['key_epoch'] : undefined,
    reason,
  };
}

function contentOf(value: unknown): Record<string, unknown> {
  const content = asRecord(value);
  if (!content || typeof content['text'] !== 'string') throw new Error('clair vérifié non matérialisable : text est attendu.');
  return content;
}

function tagsOf(content: Record<string, unknown>): string[] | undefined {
  return Array.isArray(content['tags']) && content['tags'].every((tag) => typeof tag === 'string')
    ? content['tags'] as string[]
    : undefined;
}

function priorityOf(value: unknown): 'low' | 'medium' | 'high' | 'critical' | undefined {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical' ? value : undefined;
}

class DeferredMaterialization extends Error {}

/**
 * Passe par les opérations métier (donc leur pipeline de mutation/verrous), jamais par
 * l'écriture d'un JSON d'entité. L'opaque est mappé seulement APRES la mutation réussie.
 */
function materialize(accepted: VerificationAccepted, state: FederationConnectionState, cwd: string): void {
  const opaque = accepted.envelope.meta.id_opaque;
  const existing = localIdForOpaque(state.cloud_project_id, opaque, cwd);
  const content = contentOf(accepted.content);
  const priority = priorityOf(accepted.envelope.meta.priority);
  const tags = tagsOf(content);

  if (accepted.kind === 'plan') {
    if (existing) {
      updatePlan({
        id: existing,
        status: accepted.envelope.meta.status.object as never,
        priority,
        patch: { text: content['text'] as string, tags },
      }, cwd);
      return;
    }
    const created = createPlan({
      text: content['text'] as string,
      author: 'federation',
      type: typeof content['type'] === 'string' ? content['type'] as never : undefined,
      priority,
      tags,
    }, cwd);
    rememberOpaqueId(state.cloud_project_id, created.id, opaque, cwd);
    return;
  }

  if (accepted.kind === 'plan_step') {
    const parentOpaque = accepted.envelope.meta.deps.find((dependency) => dependency.from === opaque)?.to;
    const parent = parentOpaque ? localIdForOpaque(state.cloud_project_id, parentOpaque, cwd) : undefined;
    if (!parent) throw new DeferredMaterialization('étape reçue avant son plan parent ; conservée pour relecture.');
    if (existing) {
      updateStep({ stepId: existing, planId: parent, text: content['text'] as string, status: accepted.envelope.meta.status.object as never }, cwd);
      return;
    }
    const created = addStep({
      planId: parent,
      text: content['text'] as string,
      assignee: typeof content['assignee'] === 'string' ? content['assignee'] : undefined,
    }, cwd);
    rememberOpaqueId(state.cloud_project_id, created.stepId, opaque, cwd);
    return;
  }

  // Les familles sans mutation canonique correspondante sont différées. Les accepter dans
  // high_water les ferait disparaître du feed sans jamais atteindre le magasin local.
  throw new DeferredMaterialization(`kind '${accepted.kind}' sans mutation canonique de réception.`);
}

/**
 * GET du delta + attestations, vérification du lot et matérialisation. Une absence de clé
 * d'epoch est le seul échec conservé explicitement comme « illisible » : l'enveloppe reste
 * dans le journal entrant et sera repassée à verifyInboundBatch après remise de la clé.
 */
export async function pullFederationDelta(options: PullOptions): Promise<PullResult> {
  const cwd = options.cwd ?? process.cwd();
  const current = loadConnectionState(cwd);
  if (!current || current.enrollment.stage !== 'active') {
    throw new Error("Aucun appairage actif : un pull n'est autorisé qu'après approbation locale.");
  }
  const base = options.url.replace(/\/+$/, '');
  if (!base) throw new Error('Adresse du cloud absente : aucune origine ne sera devinée.');
  const root = `${base}/api/v1/projects/${encodeURIComponent(current.cloud_project_id)}`;
  const query = new URLSearchParams();
  // Contrat réel de handleListEnvelopes : since_seq est un curseur exclusif et
  // include_sealed est indispensable au déchiffrement local.
  if (current.sync.feed_cursor) query.set('since_seq', current.sync.feed_cursor);
  query.set('include_sealed', 'true');
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  const deltaUrl = `${root}/projection/envelopes${query.size ? `?${query}` : ''}`;
  const doFetch = options.fetchImpl ?? fetch;
  const delta = parseDelta(await readJson(await doFetch(deltaUrl, { headers: headers(options.apiKey) }), 'Delta'));

  // ROSTER PROVISOIRE : le commentaire et le résultat nomment la limite dec#159.
  // Une erreur de roster est fatale AVANT le lot : remplacer la liste par une liste vide
  // ferait passer les refus unknown_signer pour des échecs ordinaires et masquerait la
  // vraie borne de confiance.
  let roster: AttestedRoster;
  try {
    // `/projection/roster` (dec#162) : joignable par la clé d'API de l'agent et rendant
    // {empreinte -> PEM Ed25519}. `/attestations` ne convenait pas — withUserAuth (une clé
    // d'agent y est refusée) et sans le PEM public dont dépend la vérification de signature.
    roster = parseCloudRoster(await readJson(
      await doFetch(`${root}/projection/roster`, { headers: headers(options.apiKey) }),
      'Roster',
    ));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${CLOUD_ROSTER_LIMITATION} Roster indisponible : ${detail}`, { cause: err });
  }

  const journal = loadJournal(cwd);
  const pending = { ...journal.pending };
  const combined = new Map<string, unknown>();
  // Les entrées en attente sont DÉJÀ des enveloppes (parsées au tour précédent) ; le delta
  // frais arrive à plat et doit être déballé de `envelope_json` avant toute vérification.
  for (const [key, entry] of Object.entries(pending)) combined.set(key, entry.raw);
  for (const item of delta.envelopes) {
    const envelope = toEnvelope(item);
    combined.set(rawKey(envelope), envelope);
  }
  const entries = [...combined.entries()];
  if (entries.length > 0 && roster.keys.size === 0) {
    throw new Error(`${CLOUD_ROSTER_LIMITATION} Le endpoint n'a fourni aucune clé Ed25519 publiquement vérifiable ; aucun clair ne sera matérialisé.`);
  }

  const epochKeys = new Map<number, crypto.KeyObject>();
  for (const [, raw] of entries) {
    const epoch = asRecord(raw)?.['key_epoch'];
    if (typeof epoch === 'number' && !epochKeys.has(epoch)) {
      const key = options.epochKeyFor
        ? options.epochKeyFor(current.cloud_project_id, epoch)
        : loadEpochPrivateKey(current.cloud_project_id, epoch);
      if (key) epochKeys.set(epoch, key);
    }
  }

  const batch = verifyInboundBatch({
    envelopes: entries.map(([, raw]) => raw), roster, state: current, epochKeys,
    seenIdempotencyKeys: new Set(journal.seen),
  });
  const result: PullResult = {
    received: delta.envelopes.length, verified: batch.accepted, materialized: 0,
    unreadable_epoch_absent: [], rejected: [], deferred: [], retained: 0,
    feed_cursor: delta.cursor, roster_limitation: CLOUD_ROSTER_LIMITATION,
  };
  let next = current;
  const seen = new Set(journal.seen);

  for (const [index, verdict] of batch.results.entries()) {
    const [key, raw] = entries[index]!;
    if (!verdict.ok) {
      const item = problem(raw, verdict.detail);
      if (verdict.reason === 'undecryptable' && item.key_epoch !== undefined && !epochKeys.has(item.key_epoch)) {
        pending[key] = { raw, key_epoch: item.key_epoch, received_at: pending[key]?.received_at ?? nowISO() };
        result.unreadable_epoch_absent.push({ ...item, reason: `reçue, illisible : epoch ${item.key_epoch} absent ; conservée pour relecture après remise de clé.` });
      } else {
        delete pending[key];
        result.rejected.push({ ...item, reason: `${verdict.reason}: ${verdict.detail}` });
      }
      continue;
    }
    try {
      materialize(verdict, next, cwd);
      delete pending[key];
      seen.add(verdict.idempotencyKey);
      next = recordRevision(next, verdict.envelope.meta.id_opaque, verdict.envelope.meta.base_rev);
      result.materialized++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      pending[key] = { raw, key_epoch: verdict.envelope.key_epoch, received_at: pending[key]?.received_at ?? nowISO() };
      if (err instanceof DeferredMaterialization) result.deferred.push(problem(raw, reason));
      else result.rejected.push(problem(raw, `matérialisation: ${reason} (conservée pour reprise)`));
    }
  }

  // Le curseur n'est qu'une optimisation ; la barrière anti-rejeu persistée dans sync
  // porte la sûreté. Le journal est écrit avant l'état/cursor afin que les epochs absents
  // restent relisibles même si le cloud ne les retourne plus dans le prochain delta.
  saveJournal({ schema: INBOUND_SCHEMA, seen: [...seen], pending }, cwd);
  saveConnectionState({
    ...next,
    sync: {
      ...next.sync,
      feed_cursor: delta.cursor ?? next.sync.feed_cursor,
      last_pull_at: nowISO(),
    },
  }, cwd);
  result.retained = Object.keys(pending).length;
  return result;
}
