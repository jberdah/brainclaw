/**
 * pln#651 étape 5 — le projecteur et ses trois filets.
 *
 * CRITÈRE DE SORTIE DE L'ÉTAPE, littéralement : « sentinelle injectée dans CHAQUE champ
 * scellé et interdit de CHAQUE entité projetable, aucune retrouvée dans le JSON produit,
 * sur TOUS les créateurs — pas seulement celui qu'on a pensé à tester ».
 *
 * Le « tous les créateurs » n'est pas rhétorique : trp#5a8fb7d9 dit qu'un test couvre la
 * SORTIE et non la CONSTRUCTION, et qu'avec N projecteurs on en teste un. Ici la liste
 * des types projetables est énumérée DEPUIS LA SOURCE (`FEDERATED_KINDS`), pas recopiée :
 * ajouter une famille sans la couvrir fait rougir ce fichier.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { canonicalJson, canonicalSha256, b64url, b64urlDecode } from '../../src/core/federation-canonical.js';
import { seal, open, HPKE_SUITE, rawPublicKey } from '../../src/core/federation-hpke.js';
import {
  buildEnvelope,
  toPublicProjection,
  assertNoForbiddenLeaf,
  originSigningInput,
  newOpaqueId,
  FederationEnvelopeSchema,
  FEDERATED_KINDS,
  FORBIDDEN_LEAF_NAMES,
  ProjectionRefused,
  ENVELOPE_SCHEMA,
  type FederatedKind,
} from '../../src/core/federation-projection.js';

const SENTINEL = 'SENTINELLE-a7f3e1c9-NE-DOIT-JAMAIS-SORTIR';

function keys() {
  const enc = crypto.generateKeyPairSync('x25519');
  const sig = crypto.generateKeyPairSync('ed25519');
  return {
    recipientPublicKeyPem: enc.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    recipientPrivateKey: enc.privateKey,
    originPrivateKeyPem: sig.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    originPublicKey: sig.publicKey,
  };
}

function baseParams(kind: FederatedKind, content: unknown) {
  const k = keys();
  return {
    params: {
      kind,
      idOpaque: newOpaqueId(),
      cloudProjectId: 'cp_opaque',
      baseRev: 3,
      statusObject: 'active',
      occurredAt: '2026-08-08T14:37:52.913Z',
      wrapHint: 'wrap_abc',
      operationId: 'op_1',
      keyEpoch: 1,
      content,
      recipientPublicKeyPem: k.recipientPublicKeyPem,
      originKeyId: 'key_pseudonyme',
      originPrivateKeyPem: k.originPrivateKeyPem,
    },
    k,
  };
}

/**
 * Cherche la sentinelle dans le JSON de sortie, EN CLAIR **ET APRÈS DÉCODAGE**.
 *
 * POURQUOI LE DÉCODAGE EST INDISPENSABLE, trouvé par contre-épreuve : en neutralisant le
 * chiffrement — `ciphertext = base64url(plaintext)` — le test qui ne faisait qu'un
 * `wire.includes(SENTINEL)` restait VERT. Le clair sortait intégralement, simplement
 * encodé. Or c'est exactement la forme que prendrait une fuite réelle : personne
 * n'expédie du clair non encodé dans un champ nommé `ciphertext`.
 *
 * Un test de fuite qui ne cherche que la forme littérale ne teste donc pas la fuite ; il
 * teste que quelqu'un n'a pas oublié d'encoder.
 */
function leaksSentinel(wire: string): boolean {
  if (wire.includes(SENTINEL) || wire.includes('SENTINELLE')) return true;
  // Toute chaîne du fil est retentée en base64 et base64url : un blob réellement chiffré
  // se décode en octets aléatoires, un blob simplement encodé rend le clair.
  for (const match of wire.match(/[A-Za-z0-9+/_=-]{16,}/g) ?? []) {
    for (const enc of ['base64', 'base64url'] as const) {
      try {
        const decoded = Buffer.from(match, enc).toString('utf-8');
        if (decoded.includes(SENTINEL) || decoded.includes('SENTINELLE')) return true;
      } catch { /* pas décodable : sans conséquence */ }
    }
  }
  return false;
}

describe('projecteur — filet 3 : aucune sentinelle ne sort, sur TOUS les créateurs', () => {
  it('le contenu scellé n’apparaît ni en clair NI APRÈS DÉCODAGE, pour chaque type projetable', () => {
    // Énuméré DEPUIS LA SOURCE : une famille ajoutée à FEDERATED_KINDS sans classification
    // est automatiquement couverte ici.
    for (const kind of FEDERATED_KINDS) {
      const { params } = baseParams(kind, {
        text: SENTINEL,
        title: SENTINEL,
        tags: [SENTINEL],
        nested: { deep: { deeper: SENTINEL } },
      });
      assert.ok(!leaksSentinel(JSON.stringify(buildEnvelope(params))), `sentinelle trouvée sur le fil pour kind=${kind}`);
    }
  });

  it('le détecteur de fuite attrape une sentinelle SEULEMENT encodée', () => {
    // Garde du garde. Sans ce contrôle, une régression de `leaksSentinel` rendrait tout
    // le filet 3 silencieusement inopérant — et la suite resterait verte.
    assert.equal(leaksSentinel(JSON.stringify({ ciphertext: Buffer.from(SENTINEL).toString('base64url') })), true);
    assert.equal(leaksSentinel(JSON.stringify({ ciphertext: Buffer.from(SENTINEL).toString('base64') })), true);
    assert.equal(leaksSentinel(JSON.stringify({ ciphertext: crypto.randomBytes(64).toString('base64url') })), false);
  });

  it('couvre bien les 17 familles déclarées — le test ne peut pas se vider en silence', () => {
    // Sans cette assertion, vider FEDERATED_KINDS rendrait la boucle précédente verte
    // en n'exécutant rien. C'est le mode d'échec le plus discret d'un test énuméré.
    assert.ok(FEDERATED_KINDS.length >= 17, `inventaire suspect : ${FEDERATED_KINDS.length} familles`);
  });

  it('le contenu scellé reste déchiffrable par le destinataire — la sentinelle est cachée, pas perdue', () => {
    const { params, k } = baseParams('plan', { text: SENTINEL });
    const envelope = buildEnvelope(params);

    const aadBytes = new TextEncoder().encode(canonicalJson(envelope.meta.aad));
    const opened = open({ recipientPrivateKey: k.recipientPrivateKey, sealed: envelope.sealed, aadCanonicalBytes: aadBytes });
    assert.ok(opened, 'le destinataire légitime doit pouvoir ouvrir');
    assert.equal(JSON.parse(new TextDecoder().decode(opened)).text, SENTINEL);
  });
});

describe('projecteur — classe « interdit de sortir »', () => {
  it('refuse CHAQUE nom de champ interdit, même profondément imbriqué', () => {
    for (const forbidden of FORBIDDEN_LEAF_NAMES) {
      const content = { a: { b: { [forbidden]: 'peu importe' } } };
      assert.throws(
        () => assertNoForbiddenLeaf(content),
        (err: unknown) => err instanceof ProjectionRefused && err.path.includes(forbidden),
        `le champ interdit '${forbidden}' est passé`,
      );
    }
  });

  it('refuse un chemin local QUEL QUE SOIT le nom du champ', () => {
    // Une liste de noms ne rattrape pas un chemin rangé dans un champ anodin.
    for (const value of ['C:\\Users\\jberdah\\projet', '/home/alice/x', '/Users/bob/y', 'C:/Users/x/.brainclaw/worktrees/z']) {
      assert.throws(() => assertNoForbiddenLeaf({ innocent: value }), ProjectionRefused, `chemin non détecté : ${value}`);
    }
  });

  it('REFUSE la projection entière — un champ interdit ne part pas « chiffré »', () => {
    // Chiffré n'est pas « autorisé à sortir » : le jour où la clé fuit, la donnée a fui.
    const { params } = baseParams('claim', { scope: 'ok', worktree_path: 'C:\\Users\\x\\wt' });
    assert.throws(() => buildEnvelope(params), ProjectionRefused);
  });

  it('laisse passer un contenu sain', () => {
    assert.doesNotThrow(() => assertNoForbiddenLeaf({ text: 'un plan', tags: ['a'], nested: { n: 1 } }));
  });
});

describe('projecteur — filet 2 : le parse strict du point de sortie', () => {
  it('refuse une clé inconnue dans meta', () => {
    const { params } = baseParams('plan', { text: 'x' });
    const envelope = buildEnvelope(params);
    const polluted = { ...envelope, meta: { ...envelope.meta, champ_ajoute_demain: 'fuite' } };
    // Zod .strip() — le défaut — l'aurait accepté en retirant la clé EN SILENCE.
    assert.throws(() => FederationEnvelopeSchema.parse(polluted));
  });

  it('refuse une clé inconnue au niveau de l’enveloppe', () => {
    const { params } = baseParams('plan', { text: 'x' });
    const envelope = buildEnvelope(params);
    assert.throws(() => FederationEnvelopeSchema.parse({ ...envelope, extra: 1 }));
  });

  it('refuse une clé inconnue dans sealed', () => {
    const { params } = baseParams('plan', { text: 'x' });
    const envelope = buildEnvelope(params);
    assert.throws(() => FederationEnvelopeSchema.parse({ ...envelope, sealed: { ...envelope.sealed, plaintext: 'oups' } }));
  });
});

describe('projecteur — filet 1 : sélection explicite', () => {
  it('n’invente PAS priority ni rank pour un objet qui n’en porte pas', () => {
    // L'absence d'un champ optionnel est SIGNIFICATIVE (RFC §3) : inventer
    // priority='medium' ferait croire au Cloud à une priorité choisie.
    const sealed = { alg: HPKE_SUITE, enc: 'a', nonce: 'b', ciphertext: 'c' } as const;
    const meta = toPublicProjection({
      kind: 'plan', idOpaque: newOpaqueId(), cloudProjectId: 'cp', baseRev: 1,
      statusObject: 'todo', occurredAt: '2026-08-08T10:00:00.000Z',
      wrapHint: 'w', operationId: 'op', sealed,
    });
    assert.ok(!('priority' in meta), 'priority inventée');
    assert.ok(!('rank' in meta), 'rank inventé');
  });

  it('réduit l’horodatage au JOUR — l’heure précise ne sort pas', () => {
    const sealed = { alg: HPKE_SUITE, enc: 'a', nonce: 'b', ciphertext: 'c' } as const;
    const meta = toPublicProjection({
      kind: 'plan', idOpaque: newOpaqueId(), cloudProjectId: 'cp', baseRev: 1,
      statusObject: 'todo', occurredAt: '2026-08-08T14:37:52.913Z',
      wrapHint: 'w', operationId: 'op', sealed,
    });
    assert.equal(meta.timestamp_bucket_jour, '2026-08-08');
    assert.ok(!JSON.stringify(meta).includes('14:37'), 'heure précise trouvée dans meta');
  });

  it('les ids opaques ne sont PAS dérivés de l’id local — pas de corrélation cross-projet', () => {
    // Un hachage de l'id local donnerait le même opaque dans deux projets Cloud,
    // et un observateur corrélerait les deux.
    assert.notEqual(newOpaqueId(), newOpaqueId());
    assert.match(newOpaqueId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('projecteur — dérivés de transport et signature', () => {
  it('content_hash porte sur le CIPHERTEXT, jamais sur le clair', () => {
    const { params } = baseParams('decision', { text: 'oui' });
    const envelope = buildEnvelope(params);
    assert.equal(envelope.meta.transport.content_hash, canonicalSha256(envelope.sealed));
    // Contre-vérification : ce n'est pas le hash du clair. Sinon le Cloud pourrait
    // confirmer une devinette sur un contenu à faible entropie.
    assert.notEqual(envelope.meta.transport.content_hash, canonicalSha256({ text: 'oui' }));
  });

  it('deux scellements du MÊME contenu donnent des content_hash différents', () => {
    // L'AEAD est randomisé par la clé éphémère : sans cela, le hash du ciphertext
    // redeviendrait un oracle de confirmation.
    const a = buildEnvelope(baseParams('decision', { text: 'identique' }).params);
    const b = buildEnvelope(baseParams('decision', { text: 'identique' }).params);
    assert.notEqual(a.meta.transport.content_hash, b.meta.transport.content_hash);
  });

  it('idempotency_key est clefée par l’identité du signataire', () => {
    const shared = baseParams('plan', { text: 'x' });
    const first = buildEnvelope(shared.params);
    const second = buildEnvelope({ ...shared.params, originKeyId: 'autre_identite' });
    assert.notEqual(first.meta.transport.idempotency_key, second.meta.transport.idempotency_key);
  });

  it('la signature d’origine couvre meta, sealed ET key_epoch', () => {
    const { params, k } = baseParams('trap', { text: 'x' });
    const envelope = buildEnvelope(params);
    const input = originSigningInput(envelope.meta, envelope.sealed, envelope.key_epoch);
    assert.equal(
      crypto.verify(null, input, k.originPublicKey, Buffer.from(envelope.origin_sig.value, 'base64url')),
      true,
    );

    // Modifier l'epoch invalide la signature — c'est ce que le raccourci
    // « meta || ciphertext » ne garantissait pas.
    const tampered = originSigningInput(envelope.meta, envelope.sealed, envelope.key_epoch + 1);
    assert.equal(crypto.verify(null, tampered, k.originPublicKey, Buffer.from(envelope.origin_sig.value, 'base64url')), false);
  });

  it('modifier alg ou nonce dans sealed invalide la signature', () => {
    const { params, k } = baseParams('trap', { text: 'x' });
    const envelope = buildEnvelope(params);
    for (const mutation of [{ nonce: 'autre' }, { enc: 'autre' }]) {
      const input = originSigningInput(envelope.meta, { ...envelope.sealed, ...mutation }, envelope.key_epoch);
      assert.equal(crypto.verify(null, input, k.originPublicKey, Buffer.from(envelope.origin_sig.value, 'base64url')), false);
    }
  });
});

describe('HPKE — scellement lié à l’AAD', () => {
  it('un AAD différent d’un seul octet fait échouer l’ouverture (fail-closed)', () => {
    const k = keys();
    const aad = new TextEncoder().encode(canonicalJson({ protocol: 'p', base_rev: 1 }));
    const other = new TextEncoder().encode(canonicalJson({ protocol: 'p', base_rev: 2 }));
    const sealedBlob = seal({ recipientPublicKeyPem: k.recipientPublicKeyPem, plaintext: new TextEncoder().encode('secret'), aadCanonicalBytes: aad });

    assert.ok(open({ recipientPrivateKey: k.recipientPrivateKey, sealed: sealedBlob, aadCanonicalBytes: aad }));
    assert.equal(open({ recipientPrivateKey: k.recipientPrivateKey, sealed: sealedBlob, aadCanonicalBytes: other }), undefined);
  });

  it('un autre destinataire ne peut pas ouvrir', () => {
    const k = keys();
    const stranger = crypto.generateKeyPairSync('x25519');
    const aad = new TextEncoder().encode('{}');
    const blob = seal({ recipientPublicKeyPem: k.recipientPublicKeyPem, plaintext: new TextEncoder().encode('x'), aadCanonicalBytes: aad });
    assert.equal(open({ recipientPrivateKey: stranger.privateKey, sealed: blob, aadCanonicalBytes: aad }), undefined);
  });

  it('un nonce substitué est refusé — la réutilisation de nonce est la faute la plus grave sur un AEAD', () => {
    const k = keys();
    const aad = new TextEncoder().encode('{}');
    const blob = seal({ recipientPublicKeyPem: k.recipientPublicKeyPem, plaintext: new TextEncoder().encode('x'), aadCanonicalBytes: aad });
    const forged = { ...blob, nonce: b64url(new Uint8Array(12)) };
    assert.equal(open({ recipientPrivateKey: k.recipientPrivateKey, sealed: forged, aadCanonicalBytes: aad }), undefined);
  });

  it('deux scellements du même clair produisent des ciphertexts distincts', () => {
    const k = keys();
    const aad = new TextEncoder().encode('{}');
    const a = seal({ recipientPublicKeyPem: k.recipientPublicKeyPem, plaintext: new TextEncoder().encode('meme'), aadCanonicalBytes: aad });
    const b = seal({ recipientPublicKeyPem: k.recipientPublicKeyPem, plaintext: new TextEncoder().encode('meme'), aadCanonicalBytes: aad });
    assert.notEqual(a.ciphertext, b.ciphertext);
    assert.notEqual(a.enc, b.enc);
  });

  it('rawPublicKey rend 32 octets réimportables', () => {
    const k = keys();
    assert.equal(rawPublicKey(k.recipientPublicKeyPem).length, 32);
  });
});

describe('canonicalisation — le contrat inter-programmes', () => {
  it('trie les clés et n’émet aucune espace', () => {
    assert.equal(canonicalJson({ b: 1, a: 2, c: { z: 1, y: 2 } }), '{"a":2,"b":1,"c":{"y":2,"z":1}}');
  });

  it('donne les MÊMES octets quel que soit l’ordre d’insertion', () => {
    // C'est la propriété qui compte : `JSON.stringify` n'est déterministe que si l'ordre
    // d'insertion l'est, ce qui n'est pas le cas après un parse ou un spread.
    assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  });

  it('normalise en NFC — le même texte saisi sur deux OS donne les mêmes octets', () => {
    const compose = 'caf\u00e9';        // é précomposé
    const decompose = 'cafe\u0301';     // e + accent combinant
    assert.notEqual(compose, decompose);
    assert.equal(canonicalJson(compose), canonicalJson(decompose));
  });

  it('REFUSE ce que JSON ne porte pas fidèlement plutôt que d’inventer null', () => {
    // JSON.stringify rend `null` pour NaN et Infinity : deux valeurs différentes, mêmes
    // octets, donc une signature valide pour un contenu qu'on n'a pas signé.
    for (const bad of [NaN, Infinity, -Infinity]) {
      assert.throws(() => canonicalJson(bad), /non fini/);
    }
    assert.throws(() => canonicalJson(1e21), /exposant/);
  });

  it('omet les clés undefined au lieu de les sérialiser', () => {
    assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  });

  it('base64url fait un aller-retour exact et ne porte pas de padding', () => {
    const bytes = crypto.randomBytes(33);
    assert.equal(b64url(new Uint8Array(bytes)).includes('='), false);
    assert.deepEqual(Buffer.from(b64urlDecode(b64url(new Uint8Array(bytes)))), bytes);
  });
});

describe('projecteur — fixture golden byte-exacte', () => {
  it('la forme de meta est GELÉE, champ pour champ', () => {
    // Motif de pln#649 étape 6. Ce littéral est le contrat public : le modifier change ce
    // que le Cloud reçoit, et doit donc être un acte délibéré plutôt que l'effet de bord
    // d'une refactorisation. Les valeurs dérivées du ciphertext sont neutralisées, étant
    // aléatoires par construction.
    const sealed = { alg: HPKE_SUITE, enc: 'ENC', nonce: 'NONCE', ciphertext: 'CT' } as const;
    const meta = toPublicProjection({
      kind: 'plan',
      idOpaque: '00000000-0000-4000-8000-000000000001',
      cloudProjectId: 'cp_golden',
      baseRev: 7,
      statusObject: 'in_progress',
      syncState: 'pending',
      priority: 'high',
      rank: 2,
      deps: [{ from: '00000000-0000-4000-8000-000000000001', to: '00000000-0000-4000-8000-000000000002' }],
      occurredAt: '2026-08-08T14:37:52.913Z',
      wrapHint: 'wrap_golden',
      operationId: 'op_golden',
      sealed,
    });

    assert.equal(
      canonicalJson(meta),
      '{"aad":{"base_rev":7,"cloud_project_id":"cp_golden","object_id":"00000000-0000-4000-8000-000000000001",'
      + '"object_type":"plan","protocol":"brainclaw/federation/v1","schema":"brainclaw.federation-envelope/v1"},'
      + '"base_rev":7,'
      + '"deps":[{"from":"00000000-0000-4000-8000-000000000001","to":"00000000-0000-4000-8000-000000000002"}],'
      + '"id_opaque":"00000000-0000-4000-8000-000000000001","kind":"plan","priority":"high","rank":2,'
      + '"status":{"object":"in_progress","sync":"pending"},'
      + '"timestamp_bucket_jour":"2026-08-08",'
      + '"transport":{"content_hash":"' + canonicalSha256(sealed) + '","idempotency_key":"","operation_id":"op_golden"},'
      + '"wrap_hint":"wrap_golden"}',
    );
  });

  it('l’enveloppe complète valide contre son schéma et porte le bon identifiant', () => {
    const { params } = baseParams('sequence', { name: SENTINEL });
    const envelope = buildEnvelope(params);
    assert.equal(envelope.schema, ENVELOPE_SCHEMA);
    assert.equal(envelope.sealed.alg, HPKE_SUITE);
    assert.doesNotThrow(() => FederationEnvelopeSchema.parse(envelope));
  });
});
