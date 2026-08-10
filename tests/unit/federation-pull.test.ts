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
import { buildEnvelope, newOpaqueId, type FederatedKind, type FederationEnvelope } from '../../src/core/federation-projection.js';
import { createConnectionState, newDeviceId, saveConnectionState, loadConnectionState } from '../../src/core/federation-state.js';
import { pullFederationDelta } from '../../src/core/federation-pull.js';
import { loadState } from '../../src/core/state.js';
import { listSequences } from '../../src/core/sequence.js';
import { listRuntimeNotes } from '../../src/core/runtime.js';
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

interface WorldCredentials {
  recipientPrivateKey: crypto.KeyObject;
  recipientPublicKeyPem: string;
  signerPrivateKeyPem: string;
  signerPem: string;
}

interface WorldOptions {
  credentials?: WorldCredentials;
  deps?: Array<{ from: string; to: string }>;
  baseRev?: number;
  epoch?: number;
  idOpaque?: string;
  signerKeyId?: string;
}

function worldCredentials(): WorldCredentials {
  const recipient = crypto.generateKeyPairSync('x25519');
  const signer = crypto.generateKeyPairSync('ed25519');
  return {
    recipientPrivateKey: recipient.privateKey,
    recipientPublicKeyPem: recipient.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    signerPrivateKeyPem: signer.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    signerPem: signer.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

function statusFor(kind: FederatedKind): string {
  if (kind === 'plan' || kind === 'plan_step') return 'todo';
  if (kind === 'handoff') return 'open';
  if (kind === 'sequence') return 'active';
  return 'active';
}

function federatedWorld(kind: FederatedKind, text: string, options: WorldOptions = {}) {
  const credentials = options.credentials ?? worldCredentials();
  const opaque = options.idOpaque ?? newOpaqueId();
  const epoch = options.epoch ?? 1;
  const baseRev = options.baseRev ?? 1;
  const signerKeyId = options.signerKeyId ?? 'signer_a';
  const content = kind === 'plan'
    ? { text, type: 'feat', tags: ['federation-test'] }
    : { text, tags: ['federation-test'] };
  const envelope = buildEnvelope({
    kind,
    idOpaque: opaque,
    cloudProjectId: PROJECT,
    baseRev,
    statusObject: statusFor(kind),
    occurredAt: '2026-08-09T10:00:00.000Z',
    wrapHint: `epoch:${epoch}`,
    operationId: `op_${kind}_${opaque}_r${baseRev}`,
    keyEpoch: epoch,
    deps: options.deps,
    content,
    recipientPublicKeyPem: credentials.recipientPublicKeyPem,
    originKeyId: signerKeyId,
    originPrivateKeyPem: credentials.signerPrivateKeyPem,
  });
  return { opaque, envelope, recipientPrivateKey: credentials.recipientPrivateKey, signerPem: credentials.signerPem };
}

function world(epoch = 1, text = 'Plan venu de A', signerKeyId = 'signer_a') {
  return federatedWorld('plan', text, { epoch, signerKeyId });
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
  const deferredFamilies = ['decision', 'constraint', 'trap', 'handoff', 'sequence', 'runtime_note'] as const;

  function textsForFamily(kind: typeof deferredFamilies[number], cwd: string): string[] {
    const state = loadState(cwd);
    switch (kind) {
      case 'decision': return state.recent_decisions.map((item) => item.text);
      case 'constraint': return state.active_constraints.map((item) => item.text);
      case 'trap': return state.known_traps.map((item) => item.text);
      case 'handoff': return state.open_handoffs.map((item) => item.text);
      case 'sequence': return listSequences(cwd).map((item) => item.name);
      case 'runtime_note': return listRuntimeNotes({ visibility: 'all', includeAllHosts: true }, cwd).map((item) => item.text);
    }
  }

  for (const kind of deferredFamilies) {
    it(`matérialise ${kind}, persiste son mapping opaque et dédoublonne le rejeu`, async () => {
      const ws = createTestWorkspace({ prefix: `bclaw-pull-${kind}-` });
      try {
        activeConnection(ws.dir);
        const credentials = worldCredentials();
        const text = `${kind} venu de A`;
        const w = federatedWorld(kind, text, { credentials });
        const fetchImpl = service(
          [cloudItem(w.envelope)],
          [{ signer_fingerprint: 'signer_a', identity_public_key_pem: w.signerPem }],
          [],
        );
        const keyFor = (_project: string, epoch: number) => epoch === 1 ? w.recipientPrivateKey : undefined;

        const first = await pullFederationDelta({ cwd: ws.dir, url: URL, fetchImpl, epochKeyFor: keyFor });
        assert.equal(first.materialized, 1);
        const local = localIdForOpaque(PROJECT, w.opaque, ws.dir);
        assert.ok(local, `${kind}: mapping opaque -> id local persistant`);
        assert.notEqual(local, w.opaque, `${kind}: l'id local reste neuf`);
        assert.deepEqual(textsForFamily(kind, ws.dir).filter((item) => item === text), [text]);

        const updatedText = `${kind} mis à jour`;
        const revised = federatedWorld(kind, updatedText, { credentials, idOpaque: w.opaque, baseRev: 2 });
        const revisedFetch = service(
          [cloudItem(revised.envelope)],
          [{ signer_fingerprint: 'signer_a', identity_public_key_pem: revised.signerPem }],
          [],
        );
        const updated = await pullFederationDelta({ cwd: ws.dir, url: URL, fetchImpl: revisedFetch, epochKeyFor: keyFor });
        assert.equal(updated.materialized, 1, `${kind}: un opaque connu met à jour l'objet local`);
        assert.deepEqual(textsForFamily(kind, ws.dir).filter((item) => item === updatedText), [updatedText]);

        const replay = await pullFederationDelta({ cwd: ws.dir, url: URL, fetchImpl: revisedFetch, epochKeyFor: keyFor });
        assert.equal(replay.materialized, 0, `${kind}: le rejeu ne crée pas de doublon`);
        assert.deepEqual(textsForFamily(kind, ws.dir).filter((item) => item === updatedText), [updatedText]);
      } finally {
        ws.cleanup();
      }
    });
  }

  it('matérialise un magasin complet : plan, étape et les six familles projetées', async () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-pull-complete-store-' });
    try {
      activeConnection(ws.dir);
      const credentials = worldCredentials();
      const plan = federatedWorld('plan', 'Plan complet', { credentials });
      const stepOpaque = newOpaqueId();
      const step = federatedWorld('plan_step', 'Étape complète', {
        credentials,
        idOpaque: stepOpaque,
        deps: [{ from: stepOpaque, to: plan.opaque }],
      });
      const projected = deferredFamilies.map((kind) => federatedWorld(kind, `${kind} complet`, { credentials }));
      const all = [plan, step, ...projected];
      const fetchImpl = service(
        all.map((entry) => cloudItem(entry.envelope)),
        [{ signer_fingerprint: 'signer_a', identity_public_key_pem: credentials.signerPem }],
        [],
      );
      const keyFor = (_project: string, epoch: number) => epoch === 1 ? credentials.recipientPrivateKey : undefined;

      const first = await pullFederationDelta({ cwd: ws.dir, url: URL, fetchImpl, epochKeyFor: keyFor });
      assert.equal(first.materialized, 8, 'plan + étape + six familles doivent tous atteindre B');
      const state = loadState(ws.dir);
      assert.equal(state.plan_items.filter((item) => item.text === 'Plan complet').length, 1);
      assert.equal(state.plan_items.flatMap((item) => item.steps ?? []).filter((item) => item.text === 'Étape complète').length, 1);
      for (const kind of deferredFamilies) {
        assert.deepEqual(textsForFamily(kind, ws.dir).filter((item) => item === `${kind} complet`), [`${kind} complet`]);
      }

      const replay = await pullFederationDelta({ cwd: ws.dir, url: URL, fetchImpl, epochKeyFor: keyFor });
      assert.equal(replay.materialized, 0, 'le magasin complet ne duplique rien au rejeu');
      assert.equal(loadState(ws.dir).plan_items.length, 1);
      for (const kind of deferredFamilies) {
        assert.equal(textsForFamily(kind, ws.dir).filter((item) => item === `${kind} complet`).length, 1);
      }
    } finally {
      ws.cleanup();
    }
  });

  it('reprend une enveloppe différée par une ancienne version du pull', async () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-pull-replay-deferred-' });
    try {
      activeConnection(ws.dir);
      const w = federatedWorld('decision', 'Décision précédemment différée');
      const inbound = path.join(ws.dir, '.brainclaw', 'coordination', 'federation', 'inbound-pull.json');
      fs.mkdirSync(path.dirname(inbound), { recursive: true });
      // Entrée laissée par la version qui vérifiait la décision mais ne savait pas la
      // matérialiser. Le journal stocke l'enveloppe déballée, pas la ligne cloud plate.
      fs.writeFileSync(inbound, JSON.stringify({
        schema: 'brainclaw.federation-inbound-pull/v1',
        seen: [],
        pending: {
          legacy_decision: { raw: w.envelope, key_epoch: 1, received_at: nowISO() },
        },
      }));
      const result = await pullFederationDelta({
        cwd: ws.dir,
        url: URL,
        fetchImpl: service([], [{ signer_fingerprint: 'signer_a', identity_public_key_pem: w.signerPem }], []),
        epochKeyFor: (_project, epoch) => epoch === 1 ? w.recipientPrivateKey : undefined,
      });
      assert.equal(result.received, 0, 'aucun nouvel item cloud n’est nécessaire à la reprise');
      assert.equal(result.materialized, 1);
      assert.deepEqual(textsForFamily('decision', ws.dir), ['Décision précédemment différée']);
      assert.equal(JSON.parse(fs.readFileSync(inbound, 'utf8')).pending.legacy_decision, undefined);
    } finally {
      ws.cleanup();
    }
  });
});
