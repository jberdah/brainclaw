/**
 * Transport des remises de clés d'epoch : ce qui rend `federation-grant.ts` ATTEIGNABLE.
 *
 * ── POURQUOI CE MODULE EXISTE ─────────────────────────────────────────────────
 * `buildEpochGrant` et `verifyAndStoreEpochGrant` sont corrects et testés — et n'avaient
 * AUCUN appelant de production (mesuré le 2026-08-10, juste après leur livraison). C'est
 * exactement le défaut qui avait rendu la fédération entière inerte : trois primitives
 * impeccables que rien n'appelait. Une primitive sans appelant ne remet aucune clé.
 *
 * Ici : le custodian DÉPOSE (POST), le destinataire RÉCLAME et RANGE (GET + verify).
 *
 * ── CE QUE LE RELAIS NE PEUT PAS FAIRE, ET POURQUOI ON NE LUI FAIT PAS CONFIANCE ─
 * Le cloud choisit QUELS grants il présente — il peut en omettre. Aucune cryptographie ne
 * l'en empêche. Ce qu'il ne peut pas faire : en forger un. Le destinataire vérifie le
 * signataire contre le roster des custodians ACTIFS, recompose l'AAD, compare sa propre
 * clé à la cible, et redérive la clé publique pour la confronter à l'annonce signée — le
 * tout AVANT d'écrire quoi que ce soit sur le disque.
 */

import crypto from 'node:crypto';
import {
  buildEpochGrant,
  verifyAndStoreEpochGrant,
  type AttestedGrantTarget,
  type EpochGrantManifest,
} from './federation-grant.js';
import { loadConnectionState } from './federation-state.js';
import { heldEpochs } from './federation-keyring.js';
import { loadAgentSigningKey } from './agent-registry.js';

export interface GrantTransportOptions {
  cwd?: string;
  url: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

function headers(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' };
  if (apiKey) h['authorization'] = `Bearer ${apiKey}`;
  return h;
}

function projectRoot(base: string, cloudProjectId: string): string {
  return `${base.replace(/\/+$/, '')}/api/v1/projects/${encodeURIComponent(cloudProjectId)}`;
}

async function readJson(res: Response, label: string): Promise<unknown> {
  if (!res.ok) {
    throw new Error(`${label} refusé par le cloud (HTTP ${res.status}) : ${(await res.text()).slice(0, 200)}`);
  }
  try { return await res.json(); } catch { throw new Error(`${label} : réponse JSON attendue.`); }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
}

// ── CÔTÉ CUSTODIAN : déposer une remise ──────────────────────────────────────

export interface GrantEpochsResult {
  granted: number[];
  skipped: Array<{ epoch: number; reason: string }>;
}

/**
 * Remet au destinataire les epochs demandés, un manifeste par epoch.
 *
 * UN MANIFESTE PAR EPOCH, et non un lot : chaque remise porte ses propres liaisons
 * signées (projet, epoch, cible, grant_id). Un lot unique obligerait à faire confiance à
 * une liaison collective, et un refus partiel deviendrait indistinguable d'un succès.
 *
 * L'HORIZON (dec#163 §1) est décidé par l'APPELANT et matérialisé dans `epochs` : tout
 * l'historique pour un autre appareil de la même personne, l'epoch courant seulement pour
 * un membre invité. Ce module ne devine pas la politique — il l'exécute.
 */
export async function grantEpochsToDevice(
  options: GrantTransportOptions & {
    target: AttestedGrantTarget;
    epochs: number[];
    custodianAgentId: string;
    policyRevision?: number;
  },
): Promise<GrantEpochsResult> {
  const cwd = options.cwd ?? process.cwd();
  const state = loadConnectionState(cwd);
  if (!state) throw new Error("Aucun appairage local : impossible de remettre une clé d'epoch.");

  const signing = loadAgentSigningKey(options.custodianAgentId);
  if (!signing) {
    throw new Error(
      `Identité de signature introuvable pour ${options.custodianAgentId} : un custodian signe ` +
      'son manifeste, sans quoi le destinataire le refusera (non_custodian).',
    );
  }

  const doFetch = options.fetchImpl ?? fetch;
  const endpoint = `${projectRoot(options.url, state.cloud_project_id)}/epoch-grants`;
  const result: GrantEpochsResult = { granted: [], skipped: [] };

  for (const epoch of options.epochs) {
    let manifest: EpochGrantManifest;
    try {
      manifest = buildEpochGrant({
        cloudProjectId: state.cloud_project_id,
        epoch,
        grantId: crypto.randomUUID(),
        policyRevision: options.policyRevision ?? 0,
        custodian: { keyId: signing.fingerprint, privateKeyPem: signing.privateKeyPem, active: true },
        // L'HORIZON DÉCIDÉ PAR L'APPELANT *EST* L'AUTORISATION (dec#163 §1) : `epochs` est
        // le résultat de la politique (tout l'historique / l'epoch courant / une extension
        // explicite). Le passer ici rend l'intention vérifiable par `buildEpochGrant`
        // plutôt que supposée — une liste vide ferait échouer CHAQUE remise.
        target: { ...options.target, authorizedEpochs: options.epochs },
        home: undefined,
      });
    } catch (err) {
      // Un epoch non détenu ou hors horizon est SIGNALÉ, jamais avalé : l'opérateur doit
      // savoir que la remise est partielle, sinon il croira le destinataire équipé.
      result.skipped.push({ epoch, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: headers(options.apiKey),
      body: JSON.stringify({
        epoch,
        target_device_fingerprint: manifest.target.x25519_fingerprint,
        target_agent_id: options.target.deviceId,
        grantor_agent_id: options.custodianAgentId,
        // Le manifeste part VERBATIM : le cloud le stocke tel quel et le rend au
        // destinataire, qui doit pouvoir recalculer la signature sur les octets exacts.
        manifest_json: JSON.stringify(manifest),
        sealed_b64: Buffer.from(JSON.stringify(manifest.sealed), 'utf-8').toString('base64'),
      }),
    });

    if (res.ok) { result.granted.push(epoch); continue; }
    if (res.status === 409) {
      result.skipped.push({ epoch, reason: 'une remise est déjà en attente pour cet epoch et cet appareil' });
      continue;
    }
    result.skipped.push({ epoch, reason: `HTTP ${res.status} : ${(await res.text()).slice(0, 160)}` });
  }

  return result;
}

// ── CÔTÉ DESTINATAIRE : réclamer et ranger ───────────────────────────────────

export interface ReceiveGrantsResult {
  offered: number;
  stored: number[];
  rejected: Array<{ epoch?: number; reason: string; detail: string }>;
}

/**
 * Réclame les remises destinées à CET appareil, les vérifie, range celles qui passent.
 *
 * `target` est OBLIGATOIRE côté cloud : chacun ne demande que ce qui lui revient, ce qui
 * empêche un agent d'énumérer les remises destinées aux autres.
 *
 * L'accusé de réception (`consume`) n'est envoyé qu'APRÈS rangement réussi. L'inverse
 * ferait disparaître du feed une remise jamais appliquée — et la clé serait perdue sans
 * qu'aucune erreur ne le dise.
 */
export async function receiveEpochGrants(
  options: GrantTransportOptions & {
    recipientDeviceId: string;
    /** key_id → PEM Ed25519 des custodians ACTIFS. Sans roster, aucune remise n'est acceptée. */
    activeCustodians: ReadonlyMap<string, string>;
    recipientPrivateKey?: crypto.KeyObject;
    home?: string;
  },
): Promise<ReceiveGrantsResult> {
  const cwd = options.cwd ?? process.cwd();
  const state = loadConnectionState(cwd);
  if (!state) throw new Error('Aucun appairage local : rien à réclamer.');

  const doFetch = options.fetchImpl ?? fetch;
  const root = projectRoot(options.url, state.cloud_project_id);
  const result: ReceiveGrantsResult = { offered: 0, stored: [], rejected: [] };

  // L'empreinte de NOTRE clé X25519 : c'est la seule chose que le cloud accepte comme
  // filtre, et c'est aussi ce que le manifeste doit désigner comme cible.
  const { loadDevicePrivateKey, fingerprintKeyPem } = await import('./federation-keyring.js');
  const priv = options.recipientPrivateKey ?? loadDevicePrivateKey(options.recipientDeviceId, options.home);
  if (!priv) {
    throw new Error(
      `Clé X25519 absente pour ${options.recipientDeviceId} : cet appareil ne peut recevoir ` +
      "aucune remise tant que son identité de lecture n'existe pas.",
    );
  }
  const myFingerprint = fingerprintKeyPem(
    crypto.createPublicKey(priv as unknown as crypto.PublicKeyInput).export({ type: 'spki', format: 'pem' }).toString(),
  );

  const body = await readJson(
    await doFetch(`${root}/epoch-grants?target=${encodeURIComponent(myFingerprint)}`, { headers: headers(options.apiKey) }),
    'Remises de clés',
  );
  const grants = Array.isArray(asRecord(body)?.['grants']) ? (asRecord(body)!['grants'] as unknown[]) : [];
  result.offered = grants.length;

  for (const entry of grants) {
    const row = asRecord(entry);
    const manifestJson = typeof row?.['manifest_json'] === 'string' ? row['manifest_json'] as string : null;
    if (!manifestJson) {
      result.rejected.push({ reason: 'schema_invalid', detail: 'remise sans manifeste verbatim' });
      continue;
    }
    let raw: unknown;
    try { raw = JSON.parse(manifestJson); }
    catch { result.rejected.push({ reason: 'schema_invalid', detail: 'manifeste illisible' }); continue; }

    const verdict = verifyAndStoreEpochGrant({
      raw,
      recipientDeviceId: options.recipientDeviceId,
      activeCustodians: options.activeCustodians,
      recipientPrivateKey: priv,
      home: options.home,
    });

    if (!verdict.ok) {
      result.rejected.push({
        epoch: typeof row?.['epoch'] === 'number' ? row['epoch'] as number : undefined,
        reason: verdict.reason,
        detail: verdict.detail,
      });
      continue;
    }

    result.stored.push(verdict.manifest.epoch);
    // Accusé APRÈS rangement. Un échec d'accusé n'annule rien : la clé est rangée, et
    // `storeEpochPrivateKey` est idempotent sur une clé identique — un rejeu est sûr.
    const id = typeof row?.['id'] === 'string' ? row['id'] as string : null;
    if (id) {
      await doFetch(`${root}/epoch-grants/${encodeURIComponent(id)}/consume`, {
        method: 'POST', headers: headers(options.apiKey),
      }).catch(() => { /* sans conséquence : le rangement a déjà eu lieu */ });
    }
  }

  return result;
}

/** Les epochs réellement détenus après réception — la vérité du DISQUE, pas de l'état. */
export function readableEpochs(cloudProjectId: string, home?: string): number[] {
  return heldEpochs(cloudProjectId, home);
}
