/**
 * Pull fédéré v2 : delta vérifié -> magasin local, sans double matérialisation.
 *
 * ── CE QUE CES TESTS EXERCENT VRAIMENT (dec#162) ─────────────────────────────
 * Le cloud rend une LIGNE À PLAT ; l'enveloppe SIGNÉE voyage dans son champ `envelope_json`.
 * Le mock ci-dessous reproduit EXACTEMENT cette forme (pas l'enveloppe nue), car c'est le
 * contrat réel — et c'est précisément l'écart qui rendait le pull inerte avant dec#162 :
 * `FederationEnvelopeSchema` refuse une ligne plate, et la signature d'AUTEUR n'y était pas.
 * Le roster est servi par `/projection/roster` (joignable par clé d'API agent), pas par
 * `/attestations` (withUserAuth, sans PEM).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createTestWorkspace } from '../helpers/workspace.js';
import { buildEnvelope, newOpaqueId, type FederationEnvelope } from '../../src/core/federation-projection.js';
import { createConnectionState, newDeviceId, saveConnectionState, loadConnectionState } from '../../src/core/federation-state.js';
import { pullFederationDelta } from '../../src/core/federation-pull.js';
import { loadState } from '../../src/core/state.js';
import { localIdForOpaque } from '../../src/core/federation-opaque-ids.js';
import { nowISO } from '../../src/core/ids.js';

const PROJECT = 'prj_pull_test';
const URL = 'https://cloud.test';

function activeConnection(cwd: string): void {
  const state = createConnectionState({
    cloudProjectId: PROJECT,
    workspacePath: cwd,
    device: {
      device_id: newDeviceId(), x25519_fingerprint: 'fp_x', attested_by_ed25519: 'fp_ed',
      enrolled_at: nowISO(), recovery: true,
    },
  });
  state.enrollment = { stage: 'active', updated_at: nowISO() };
  saveConnectionState(state, cwd);
}

function world(epoch = 1, text = 'Plan venu de A', signerKeyId = 'signer_a') {
  const recipient = crypto.generateKeyPairSync('x25519');
  const signer = crypto.generateKeyPairSync('ed25519');
  const opaque = newOpaqueId();
  const envelope = buildEnvelope({
    kind: 'plan', idOpaque: opaque, cloudProjectId: PROJECT, baseRev: 1,
    statusObject: 'todo', occurredAt: '2026-08-09T10:00:00.000Z', wrapHint: `epoch:${epoch}`,
    operationId: `op_${epoch}_${signerKeyId}`, keyEpoch: epoch, content: { text, type: 'feat' },
    recipientPublicKeyPem: recipient.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    originKeyId: signerKeyId,
    originPrivateKeyPem: signer.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  });
  return {
    opaque, envelope, recipientPrivateKey: recipient.privateKey,
    signerPem: signer.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/**
 * La FORME RÉELLE d'un item de delta : ligne plate + `envelope_json`. C'est ce que le cloud
 * renvoie ; reproduire l'enveloppe nue validerait un contrat que le service ne sert pas.
 */
function cloudItem(env: FederationEnvelope): Record<string, unknown> {
  return {
    id: env.meta.transport.idempotency_key,
    entity_kind: env.meta.kind,
    entity_id: env.meta.id_opaque,
    key_epoch: env.key_epoch,
    content_hash: env.meta.transport.content_hash,
    // Le champ qui rend le pull vérifiable : l'enveloppe signée verbatim.
    envelope_json: JSON.stringify(env),
  };
}

interface RosterRow { signer_fingerprint: string; identity_public_key_pem: string; revoked_at?: string | true }

function service(
  items: Record<string, unknown>[],
  roster: RosterRow[],
  calls: string[],
  opts: { cursor?: string } = {},
): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/projection/roster')) {
      return new Response(JSON.stringify({ roster }));
    }
    return new Response(JSON.stringify({ envelopes: items, next_cursor: opts.cursor ?? 'cursor-1' }));
  }) as unknown as typeof fetch;
}

describe('federation pull', () => {
  it('matérialise un plan avec un id local neuf, persiste le mapping, puis dédoublonne le rejeu', async () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-pull-' });
    try {
      activeConnection(ws.dir);
      const w = world();
      const calls: string[] = [];
      const fetchImpl = service([cloudItem(w.envelope)], [{ signer_fingerprint: 'signer_a', identity_public_key_pem: w.signerPem }], calls);
      const keyFor = (_project: string, epoch: number) => epoch === 1 ? w.recipientPrivateKey : undefined;

      const first = await pullFederationDelta({ cwd: ws.dir, url: URL, fetchImpl, epochKeyFor: keyFor });
      assert.equal(first.received, 1);
      assert.equal(first.verified, 1);
      assert.equal(first.materialized, 1);
      const local = localIdForOpaque(PROJECT, w.opaque, ws.dir);
      assert.ok(local, 'le mapping opaque -> id local doit être persistant');
      assert.notEqual(local, w.opaque, 'l id local est nouveau et ne révèle pas l opaque');
      assert.equal(loadState(ws.dir).plan_items.filter((plan) => plan.text === 'Plan venu de A').length, 1);
      assert.equal(loadConnectionState(ws.dir)?.sync.high_water[w.opaque], 1);

      const replay = await pullFederationDelta({ cwd: ws.dir, url: URL, fetchImpl, epochKeyFor: keyFor });
      assert.equal(replay.materialized, 0, 'un même delta ne doit pas créer de second plan');
      assert.equal(loadState(ws.dir).plan_items.filter((plan) => plan.text === 'Plan venu de A').length, 1);
      assert.ok(calls.some((url) => url.includes('since_seq=cursor-1')), 'le curseur du feed doit être réutilisé');
    } finally {
      ws.cleanup();
    }
  });

  it('conserve une enveloppe dont l epoch est absent, sans avancer son high-water mark', async () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-pull-missing-epoch-' });
    try {
      activeConnection(ws.dir);
      const w = world(9);
      const result = await pullFederationDelta({
        cwd: ws.dir, url: URL,
        fetchImpl: service([cloudItem(w.envelope)], [{ signer_fingerprint: 'signer_a', identity_public_key_pem: w.signerPem }], []),
        epochKeyFor: () => undefined,
      });
      assert.equal(result.materialized, 0);
      assert.equal(result.unreadable_epoch_absent.length, 1);
      assert.equal(loadConnectionState(ws.dir)?.sync.high_water[w.opaque], undefined);
      const inbound = path.join(ws.dir, '.brainclaw', 'coordination', 'federation', 'inbound-pull.json');
      assert.equal(fs.existsSync(inbound), true, 'enveloppe conservée pour relecture après remise de clé');
    } finally {
      ws.cleanup();
    }
  });

  it('REFUSE un signataire absent du roster — un cloud ne peut pas injecter du contenu forgé', async () => {
    // Le cœur de dec#162 : sans la signature d'AUTEUR vérifiée contre le roster, un relais
    // hostile pourrait matérialiser n'importe quoi dans la mémoire locale. Ici l'enveloppe
    // est bien signée, mais par une clé que le roster ne connaît PAS.
    const ws = createTestWorkspace({ prefix: 'bclaw-pull-unknown-' });
    try {
      activeConnection(ws.dir);
      const w = world(1, 'Plan forgé', 'signer_inconnu');
      const result = await pullFederationDelta({
        cwd: ws.dir, url: URL,
        // Le roster ne contient QU'un autre signataire : celui de l'enveloppe est inconnu.
        fetchImpl: service([cloudItem(w.envelope)], [{ signer_fingerprint: 'signer_a', identity_public_key_pem: w.signerPem }], []),
        epochKeyFor: (_p, epoch) => epoch === 1 ? w.recipientPrivateKey : undefined,
      });
      assert.equal(result.materialized, 0, 'rien de non attesté ne doit atteindre le magasin');
      assert.equal(result.rejected.length, 1);
      assert.match(result.rejected[0]!.reason, /unknown_signer/);
      assert.equal(loadState(ws.dir).plan_items.length, 0);
    } finally {
      ws.cleanup();
    }
  });

  it('livre le plan de A dans le magasin de B — deux magasins distincts, mapping opaque isolé', async () => {
    // Le sens même de la bidirectionnalité : ce que A a poussé se matérialise chez B avec
    // un id LOCAL à B (jamais l'opaque, jamais l'id de A), et B détient la clé d'epoch.
    const wsB = createTestWorkspace({ prefix: 'bclaw-pull-devB-' });
    try {
      activeConnection(wsB.dir);
      const w = world(1, 'Plan de A pour B');
      const first = await pullFederationDelta({
        cwd: wsB.dir, url: URL,
        fetchImpl: service([cloudItem(w.envelope)], [{ signer_fingerprint: 'signer_a', identity_public_key_pem: w.signerPem }], []),
        epochKeyFor: (_p, epoch) => epoch === 1 ? w.recipientPrivateKey : undefined,
      });
      assert.equal(first.materialized, 1);
      const localAtB = localIdForOpaque(PROJECT, w.opaque, wsB.dir);
      assert.ok(localAtB && localAtB !== w.opaque, 'B fabrique son propre id local');
      const plans = loadState(wsB.dir).plan_items.filter((p) => p.text === 'Plan de A pour B');
      assert.equal(plans.length, 1, 'le clair déchiffré de A est matérialisé chez B');
      assert.equal(plans[0]!.id, localAtB, 'le plan porte l id local de B, pas l opaque');
    } finally {
      wsB.cleanup();
    }
  });
});
