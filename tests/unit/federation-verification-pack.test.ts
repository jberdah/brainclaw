/**
 * pln#651 étape 8 — PACK DE VÉRIFICATION À LA SURFACE.
 *
 * Pas des tests de helpers : les scénarios qu'un agent et un opérateur traversent
 * réellement, assertés SUR DISQUE et SUR LE FIL. trp#1292 : un test vert sur une fonction
 * interne ne prouve pas que la fonctionnalité tire — deux fonctionnalités inertes ont été
 * publiées sur npm avec des tests verts sur leur cœur.
 *
 * TOPOLOGIE : DEUX HÔTES SIMULÉS, chacun avec son propre HOME et son propre workspace.
 * Le dépôt brainclaw seul masque la classe de défauts — c'est la leçon de pln#649 étape 6,
 * où le pack a invalidé deux morceaux de travail déjà livré. Ici, « A projette, B lit »
 * n'a de sens que si A et B ne partagent ni trousseau ni store.
 *
 * CE QUE CE FICHIER COUVRE, et ce qui est déjà couvert ailleurs :
 *   (a) fuite ............... federation-projection.test.ts (sentinelle, 17 familles)
 *   (b) cloud hostile ....... federation-inbound.test.ts
 *   (c) rejeu / rollback .... federation-inbound.test.ts
 *   (d) pairing ............. federation-pairing.test.ts
 *   (e) membre fantôme ...... ICI
 *   (f) révocation forward-only ICI
 *   (g) deux machines ....... ICI
 *   (h) board aveugle ....... ICI
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../../src/core/federation-canonical.js';
import { open as hpkeOpen } from '../../src/core/federation-hpke.js';
import { buildEnvelope, newOpaqueId, type FederationEnvelope } from '../../src/core/federation-projection.js';
import { verifyInbound, type AttestedRoster } from '../../src/core/federation-inbound.js';
import {
  createConnectionState, saveConnectionState, loadConnectionState, summarizeConnection,
  type FederationConnectionState,
} from '../../src/core/federation-state.js';
import { storeEpochPrivateKey, heldEpochs, ensureDeviceKey } from '../../src/core/federation-keyring.js';
import { enqueue, counters, transition } from '../../src/core/federation-outbox-v2.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

const CLOUD_PROJECT = 'cp_deux_machines';

/** Un hôte simulé : workspace + HOME propres, donc trousseau propre. */
interface Host {
  ws: TestWorkspace;
  home: string;
  state: FederationConnectionState;
  identity: { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject };
  keyId: string;
}

function makeHost(keyId: string): Host {
  const ws = createTestWorkspace({ prefix: `bclaw-host-${keyId}-` });
  const identity = crypto.generateKeyPairSync('ed25519');
  const device = ensureDeviceKey(`dev_${keyId}`, ws.fakeHome);
  const state = createConnectionState({
    cloudProjectId: CLOUD_PROJECT,
    device: {
      device_id: device.device_id,
      x25519_fingerprint: device.fingerprint,
      attested_by_ed25519: crypto.createHash('sha256')
        .update(identity.publicKey.export({ type: 'spki', format: 'pem' }).toString().trim())
        .digest('hex'),
      enrolled_at: new Date().toISOString(),
      recovery: true,
    },
    workspacePath: ws.dir,
  });
  saveConnectionState(state, ws.dir);
  return { ws, home: ws.fakeHome, state, identity, keyId };
}

function pem(k: crypto.KeyObject, kind: 'public' | 'private'): string {
  return kind === 'public'
    ? k.export({ type: 'spki', format: 'pem' }).toString()
    : k.export({ type: 'pkcs8', format: 'pem' }).toString();
}

let hostA: Host;
let hostB: Host;
/** Clés d'epoch du PROJET — distribuées aux appareils autorisés par enveloppe HPKE. */
let epoch1: { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject };
let epoch2: { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject };

beforeEach(() => {
  hostA = makeHost('a');
  hostB = makeHost('b');
  epoch1 = crypto.generateKeyPairSync('x25519');
  epoch2 = crypto.generateKeyPairSync('x25519');
});

afterEach(() => {
  hostA.ws.cleanup();
  hostB.ws.cleanup();
});

function project(from: Host, over: { idOpaque?: string; baseRev?: number; content?: unknown; epochPublic?: string; keyEpoch?: number; operationId?: string } = {}): FederationEnvelope {
  return buildEnvelope({
    kind: 'plan',
    idOpaque: over.idOpaque ?? newOpaqueId(),
    cloudProjectId: CLOUD_PROJECT,
    baseRev: over.baseRev ?? 1,
    statusObject: 'in_progress',
    priority: 'high',
    rank: 2,
    occurredAt: '2026-08-08T09:15:44.000Z',
    wrapHint: `wrap_epoch_${over.keyEpoch ?? 1}`,
    operationId: over.operationId ?? `op_${Math.abs(crypto.randomBytes(4).readInt32BE(0))}`,
    keyEpoch: over.keyEpoch ?? 1,
    content: over.content ?? { text: 'refondre la fédération', tags: ['secret'] },
    recipientPublicKeyPem: over.epochPublic ?? pem(epoch1.publicKey, 'public'),
    originKeyId: from.keyId,
    originPrivateKeyPem: pem(from.identity.privateKey, 'private'),
  });
}

function rosterOf(...hosts: Host[]): AttestedRoster {
  return { keys: new Map(hosts.map((h) => [h.keyId, pem(h.identity.publicKey, 'public')])) };
}

// ── (g) DEUX MACHINES ────────────────────────────────────────────────────────

describe('pack (g) — deux machines : A projette, B lit après appairage', () => {
  it('B déchiffre ce que A a scellé, une fois la clé d’epoch remise', () => {
    // B détient la clé de l'epoch 1 : c'est ce que la cérémonie d'appairage lui remet.
    storeEpochPrivateKey(CLOUD_PROJECT, 1, pem(epoch1.privateKey, 'private'), hostB.home);

    const envelope = project(hostA, { content: { text: 'roadmap de A' } });
    const res = verifyInbound({
      raw: envelope,
      roster: rosterOf(hostA),
      state: hostB.state,
      epochPrivateKey: crypto.createPrivateKey(pem(epoch1.privateKey, 'private')),
    });

    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.deepEqual(res.content, { text: 'roadmap de A' });
  });

  it('un hôte NON enrôlé ne peut rien lire, même en interceptant l’enveloppe', () => {
    const intrus = crypto.generateKeyPairSync('x25519');
    const envelope = project(hostA);
    const opened = hpkeOpen({
      recipientPrivateKey: intrus.privateKey,
      sealed: envelope.sealed,
      aadCanonicalBytes: new TextEncoder().encode(canonicalJson(envelope.meta.aad)),
    });
    assert.equal(opened, undefined);
  });

  it('les trousseaux des deux hôtes sont INDÉPENDANTS', () => {
    // Garde du harnais : si les deux hôtes partageaient un HOME, tout ce fichier
    // testerait une machine unique en croyant en tester deux.
    storeEpochPrivateKey(CLOUD_PROJECT, 1, pem(epoch1.privateKey, 'private'), hostA.home);
    assert.deepEqual(heldEpochs(CLOUD_PROJECT, hostA.home), [1]);
    assert.deepEqual(heldEpochs(CLOUD_PROJECT, hostB.home), [], 'les deux hôtes partagent un trousseau');
  });

  it('mode DÉCONNECTÉ : la file locale se remplit, reprend et ne double pas', () => {
    const envelope = project(hostA, { operationId: 'op_hors_ligne' });
    const key = envelope.meta.transport.idempotency_key;

    // Hors ligne : l'opération s'accumule localement, visible en « pending ».
    assert.equal(enqueue({ idempotency_key: key, operation_id: 'op_hors_ligne', key_epoch: 1, sealed: envelope.sealed }, hostA.ws.dir), true);
    assert.deepEqual(counters(hostA.ws.dir), { pending: 1, synced: 0, conflict: 0 });

    // Reprise : une seconde mise en file de la MÊME opération ne crée pas de doublon.
    assert.equal(enqueue({ idempotency_key: key, operation_id: 'op_hors_ligne', key_epoch: 1, sealed: envelope.sealed }, hostA.ws.dir), false);

    transition(key, 'pending', 'synced', hostA.ws.dir);
    assert.deepEqual(counters(hostA.ws.dir), { pending: 0, synced: 1, conflict: 0 });
    // Et après reprise, elle n'est pas remise en file.
    assert.equal(enqueue({ idempotency_key: key, operation_id: 'op_hors_ligne', key_epoch: 1, sealed: envelope.sealed }, hostA.ws.dir), false);
  });
});

// ── (e) MEMBRE FANTÔME ───────────────────────────────────────────────────────

describe('pack (e) — membre fantôme : une clé non attestée est refusée', () => {
  it('une identité absente du roster attesté ne peut RIEN écrire dans la mémoire de B', () => {
    // Le Cloud orchestre l'appairage ; s'il pouvait ajouter une identité au roster, il
    // signerait ses propres enveloppes et l'E2EE serait arbitré par la partie visée.
    storeEpochPrivateKey(CLOUD_PROJECT, 1, pem(epoch1.privateKey, 'private'), hostB.home);
    const fantome = makeHost('fantome');

    const forged = project(fantome, { content: { text: 'injection' } });
    const res = verifyInbound({
      raw: forged,
      roster: rosterOf(hostA), // le fantôme n'y est pas
      state: hostB.state,
      epochPrivateKey: crypto.createPrivateKey(pem(epoch1.privateKey, 'private')),
    });

    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.reason, 'unknown_signer');
    fantome.ws.cleanup();
  });

  it('même DÉCHIFFRABLE, une enveloppe d’un signataire inconnu est refusée', () => {
    // Point important : le fantôme peut chiffrer POUR le projet — la clé publique
    // d'epoch est distribuée aux émetteurs. « Écrire sans lire » est une propriété
    // voulue. Ce qui l'arrête n'est pas le chiffrement, c'est la SIGNATURE.
    storeEpochPrivateKey(CLOUD_PROJECT, 1, pem(epoch1.privateKey, 'private'), hostB.home);
    const fantome = makeHost('fantome2');
    const forged = project(fantome);

    // Le contenu EST déchiffrable...
    const opened = hpkeOpen({
      recipientPrivateKey: crypto.createPrivateKey(pem(epoch1.privateKey, 'private')),
      sealed: forged.sealed,
      aadCanonicalBytes: new TextEncoder().encode(canonicalJson(forged.meta.aad)),
    });
    assert.ok(opened, 'le fantôme sait chiffrer pour le projet — c’est attendu');

    // ...et pourtant l'enveloppe est refusée.
    const res = verifyInbound({
      raw: forged, roster: rosterOf(hostA), state: hostB.state,
      epochPrivateKey: crypto.createPrivateKey(pem(epoch1.privateKey, 'private')),
    });
    assert.equal(res.ok, false);
    fantome.ws.cleanup();
  });
});

// ── (f) RÉVOCATION FORWARD-ONLY ──────────────────────────────────────────────

describe('pack (f) — révocation forward-only : ce qui est perdu et CE QUI NE L’EST PAS', () => {
  it('après rotation, l’ancien porteur NE LIT PLUS le futur', () => {
    // A détient l'epoch 1 seulement. Après révocation, les écritures passent en epoch 2.
    storeEpochPrivateKey(CLOUD_PROJECT, 1, pem(epoch1.privateKey, 'private'), hostA.home);
    const futur = project(hostB, { keyEpoch: 2, epochPublic: pem(epoch2.publicKey, 'public') });

    const opened = hpkeOpen({
      recipientPrivateKey: crypto.createPrivateKey(pem(epoch1.privateKey, 'private')),
      sealed: futur.sealed,
      aadCanonicalBytes: new TextEncoder().encode(canonicalJson(futur.meta.aad)),
    });
    assert.equal(opened, undefined, "l'ancien porteur a lu une écriture postérieure à sa révocation");
  });

  it('MAIS il lit ENCORE le passé qu’il détenait — et ce test l’AFFIRME', () => {
    // Le critère de sortie l'exige explicitement : « il lit encore le passé qu'il
    // détenait, et LE TEST L'AFFIRME EXPLICITEMENT au lieu de laisser croire l'inverse ».
    // Prétendre qu'une révocation efface le passé serait une promesse que la
    // cryptographie ne tient pas : la clé d'epoch 1 est sur son disque.
    storeEpochPrivateKey(CLOUD_PROJECT, 1, pem(epoch1.privateKey, 'private'), hostA.home);
    const passe = project(hostB, { keyEpoch: 1, content: { text: 'écrit avant la révocation' } });

    const opened = hpkeOpen({
      recipientPrivateKey: crypto.createPrivateKey(pem(epoch1.privateKey, 'private')),
      sealed: passe.sealed,
      aadCanonicalBytes: new TextEncoder().encode(canonicalJson(passe.meta.aad)),
    });
    assert.ok(opened, 'le passé détenu doit rester lisible — la révocation est forward-only');
    assert.deepEqual(JSON.parse(new TextDecoder().decode(opened)), { text: 'écrit avant la révocation' });
  });

  it('un porteur révoqué ne peut plus faire ACCEPTER ce qu’il écrit', () => {
    // Deuxième couche de la révocation : l'autorisation Cloud est coupée. Même si
    // l'ancien porteur produit une enveloppe valide sous un epoch qu'il détient, son
    // key_id est marqué révoqué et le lecteur refuse.
    storeEpochPrivateKey(CLOUD_PROJECT, 1, pem(epoch1.privateKey, 'private'), hostB.home);
    const env = project(hostA, { keyEpoch: 1 });
    const res = verifyInbound({
      raw: env,
      roster: { keys: rosterOf(hostA).keys, revoked: new Set([hostA.keyId]) },
      state: hostB.state,
      epochPrivateKey: crypto.createPrivateKey(pem(epoch1.privateKey, 'private')),
    });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.reason, 'revoked_signer');
  });

  it('le trousseau multi-epoch permet de lire passé ET présent simultanément', () => {
    storeEpochPrivateKey(CLOUD_PROJECT, 1, pem(epoch1.privateKey, 'private'), hostB.home);
    storeEpochPrivateKey(CLOUD_PROJECT, 2, pem(epoch2.privateKey, 'private'), hostB.home);
    assert.deepEqual(heldEpochs(CLOUD_PROJECT, hostB.home), [1, 2]);

    for (const [epoch, key] of [[1, epoch1], [2, epoch2]] as const) {
      const env = project(hostA, { keyEpoch: epoch, epochPublic: pem(key.publicKey, 'public') });
      const opened = hpkeOpen({
        recipientPrivateKey: crypto.createPrivateKey(pem(key.privateKey, 'private')),
        sealed: env.sealed,
        aadCanonicalBytes: new TextEncoder().encode(canonicalJson(env.meta.aad)),
      });
      assert.ok(opened, `epoch ${epoch} illisible malgré sa présence au trousseau`);
    }
  });
});

// ── (h) BOARD AVEUGLE ────────────────────────────────────────────────────────

describe('pack (h) — board aveugle : la structure se rend SANS clé', () => {
  it('un lecteur sans aucune clé obtient la structure et AUCUN libellé', () => {
    const envelope = project(hostA, {
      content: { text: 'Refonte de la fédération', lane: 'crypto', owner: 'Juan', tags: ['e2ee'] },
    });

    // Ce que le board voit : uniquement `meta`. Il n'a pas de clé, par construction.
    const boardView = envelope.meta;

    // La STRUCTURE est là : c'est ce qui permet de rendre un Gantt.
    assert.equal(boardView.kind, 'plan');
    assert.equal(boardView.status.object, 'in_progress');
    assert.equal(boardView.priority, 'high');
    assert.equal(boardView.rank, 2);
    assert.equal(boardView.timestamp_bucket_jour, '2026-08-08');

    // AUCUN libellé humain n'apparaît.
    const rendered = JSON.stringify(boardView);
    for (const label of ['Refonte', 'crypto', 'Juan', 'e2ee']) {
      assert.ok(!rendered.includes(label), `libellé en clair sur le board : ${label}`);
    }
  });

  it('l’heure précise ne fuit pas — seul le jour est rendu', () => {
    const envelope = project(hostA);
    assert.ok(!JSON.stringify(envelope.meta).includes('09:15'), 'heure précise visible sur le board');
  });

  it('l’état « en attente côté local » est VISIBLE plutôt que masqué', () => {
    // dec#154 : le Cloud n'infère jamais un état local absent. Un board qui masquerait
    // « pending » ferait croire à une synchronisation acquise.
    const envelope = project(hostA);
    const withSync = buildEnvelope({
      kind: 'plan', idOpaque: envelope.meta.id_opaque, cloudProjectId: CLOUD_PROJECT,
      baseRev: 1, statusObject: 'in_progress', syncState: 'pending',
      occurredAt: '2026-08-08T09:15:44.000Z', wrapHint: 'w', operationId: 'op_sync', keyEpoch: 1,
      content: { text: 'x' }, recipientPublicKeyPem: pem(epoch1.publicKey, 'public'),
      originKeyId: hostA.keyId, originPrivateKeyPem: pem(hostA.identity.privateKey, 'private'),
    });
    assert.equal(withSync.meta.status.sync, 'pending');
  });

  it('le RÉSIDUEL assumé est bien là : le graphe reste visible', () => {
    // « Lane 3 » cache le libellé, PAS le graphe. Ce test fige l'honnêteté de la
    // garantie : si un jour on prétend masquer la structure, il rougira.
    const a = newOpaqueId();
    const b = newOpaqueId();
    const env = buildEnvelope({
      kind: 'sequence', idOpaque: a, cloudProjectId: CLOUD_PROJECT, baseRev: 1,
      statusObject: 'active', deps: [{ from: a, to: b }],
      occurredAt: '2026-08-08T09:00:00.000Z', wrapHint: 'w', operationId: 'op_g', keyEpoch: 1,
      content: { name: 'lane secrète' }, recipientPublicKeyPem: pem(epoch1.publicKey, 'public'),
      originKeyId: hostA.keyId, originPrivateKeyPem: pem(hostA.identity.privateKey, 'private'),
    });
    assert.equal(env.meta.deps.length, 1, 'le graphe est assumé visible — ne pas prétendre le masquer');
    assert.ok(!JSON.stringify(env.meta).includes('lane secrète'));
  });
});

// ── Surface opérateur ────────────────────────────────────────────────────────

describe('pack — la surface que l’opérateur appelle réellement', () => {
  it('summarizeConnection rend un état relu DEPUIS LE DISQUE après « redémarrage »', () => {
    storeEpochPrivateKey(CLOUD_PROJECT, 1, pem(epoch1.privateKey, 'private'), hostB.home);
    const state = loadConnectionState(hostB.ws.dir);
    assert.ok(state);
    saveConnectionState(
      { ...state, enrollment: { stage: 'active', role: 'member', updated_at: new Date().toISOString() }, keys: { current_epoch: 1, known_epochs: [1] } },
      hostB.ws.dir,
    );

    const summary = summarizeConnection(hostB.ws.dir);
    assert.equal(summary.connected, true);
    assert.equal(summary.role, 'member');
    assert.deepEqual(summary.readable_epochs, [1]);
  });

  it('les compteurs de sync du statut viennent du DISQUE, pas de la déclaration', () => {
    const state = loadConnectionState(hostA.ws.dir)!;
    saveConnectionState({ ...state, counters: { pending: 42, synced: 42, conflict: 42 } }, hostA.ws.dir);
    const env = project(hostA, { operationId: 'op_compte' });
    enqueue({ idempotency_key: env.meta.transport.idempotency_key, operation_id: 'op_compte', key_epoch: 1, sealed: env.sealed }, hostA.ws.dir);

    assert.deepEqual(summarizeConnection(hostA.ws.dir).sync, { pending: 1, synced: 0, conflict: 0 });
  });

  it('aucun secret n’a atteint le store de workspace, sur AUCUN des deux hôtes', () => {
    // La frontière la plus importante du dispositif, vérifiée à la fin du parcours
    // complet plutôt qu'au moment de l'écriture d'une clé isolée.
    storeEpochPrivateKey(CLOUD_PROJECT, 1, pem(epoch1.privateKey, 'private'), hostA.home);
    storeEpochPrivateKey(CLOUD_PROJECT, 1, pem(epoch1.privateKey, 'private'), hostB.home);
    for (const host of [hostA, hostB]) {
      for (const file of walk(`${host.ws.dir}/.brainclaw`)) {
        const content = fs.readFileSync(file, 'utf-8');
        assert.ok(!content.includes('PRIVATE KEY'), `clé privée dans le store : ${file}`);
      }
    }
  });
});

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
