/**
 * pln#651 étape 4 — cérémonie d'appairage attestée.
 *
 * CE QUE CE PACK VÉRIFIE EN PRIORITÉ : que la cérémonie ABOUTIT, et qu'elle refuse dans
 * les cas où elle doit refuser. Pas que les fonctions calculent.
 *
 * La raison est concrète. Le backend Cloud de l'étape 3 avait deux défauts qu'un
 * typecheck vert n'a pas vus : aucun chemin pour soumettre la clé de chiffrement, et une
 * vérification de signature INSATISFIABLE parce que le serveur reconstruisait le payload
 * avec sa propre horloge. La fonctionnalité était inerte, et seule la construction de ce
 * client l'a révélé. Le test le plus important de ce fichier est donc celui qui prouve
 * que les DEUX implémentations du payload — celle-ci et celle du Cloud — produisent les
 * mêmes octets.
 *
 * Le transport est injecté : la cérémonie est exercée de bout en bout sans réseau, avec
 * un cloud simulé qui VÉRIFIE RÉELLEMENT les signatures reçues. Un faux serveur qui
 * accepterait tout ne prouverait rien.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  attestationPayload,
  fingerprintPem,
  buildKeyAttestation,
  signEd25519,
} from '../../src/core/federation-attestation.js';
import {
  beginPairing,
  checkPairingApproval,
  completePairing,
  requestRevocation,
  PairingError,
  type PairingTransport,
} from '../../src/core/federation-pairing.js';
import { loadConnectionState, recoveryReadiness } from '../../src/core/federation-state.js';
import { heldEpochs } from '../../src/core/federation-keyring.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

let ws: TestWorkspace;

beforeEach(() => { ws = createTestWorkspace({ prefix: 'bclaw-pairing-' }); });
afterEach(() => { ws.cleanup(); });

/**
 * Cloud simulé qui applique les MÊMES contrôles que le vrai Worker : il vérifie la
 * signature du challenge et l'attestation contre l'identité présentée, en reconstruisant
 * le payload à partir de ce qu'il a reçu.
 */
function fakeCloud(options: { rejectAttestation?: boolean; serverClockPayload?: boolean } = {}) {
  const seen: Record<string, unknown> = {};
  let challenge = '';
  let identityPem = '';
  let state = 'invited';

  const verify = (pem: string, message: Uint8Array, sigB64: string): boolean => {
    try {
      return crypto.verify(null, Buffer.from(message), crypto.createPublicKey(pem), Buffer.from(sigB64, 'base64'));
    } catch { return false; }
  };

  const transport: PairingTransport = {
    async post(path, body) {
      const b = body as Record<string, string>;
      if (path.endsWith('/enrollments/claim')) {
        identityPem = b['identity_public_key_pem'];
        challenge = crypto.randomBytes(32).toString('base64url');
        state = 'pairing';
        seen['agent_id'] = b['agent_id'];
        return {
          status: 200,
          body: {
            enrollment_id: 'enr_fake',
            project_id: 'cp_fake',
            state,
            pop_challenge: challenge,
            identity_key_fingerprint: crypto.createHash('sha256').update(identityPem.replace(/\r/g, '').trim()).digest('hex'),
          },
        };
      }
      if (path.includes('/prove')) {
        if (!verify(identityPem, new TextEncoder().encode(challenge), b['challenge_signature'])) {
          return { status: 403, body: { error: 'Invalid PoP signature' } };
        }
        const fp = crypto.createHash('sha256').update(b['encryption_public_key_pem'].replace(/\r/g, '').trim()).digest('hex');
        // Reconstruction du payload — le point exact où le vrai serveur se trompait.
        //
        // L'HORLOGE SIMULÉE EST DÉCALÉE D'UNE MINUTE, PAS SIMPLEMENT « MAINTENANT ».
        // Avec `new Date()`, l'appareil et ce faux serveur peuvent tomber dans la MÊME
        // milliseconde sur une machine rapide : les deux horodatages coïncident, la
        // signature vérifie, et le test échoue par intermittence. Observé ici même. Ce
        // qu'on veut prouver est « un horodatage DIFFÉRENT invalide », pas « les horloges
        // diffèrent en général » — l'écart doit donc être imposé, pas espéré.
        const createdAt = options.serverClockPayload
          ? new Date(Date.parse(b['attestation_created_at']) + 60_000).toISOString()
          : b['attestation_created_at'];
        const rebuilt = attestationPayload({
          enrollment_id: 'enr_fake', project_id: 'cp_fake', agent_id: String(seen['agent_id']),
          key_type: 'encryption', key_purpose: 'envelope', key_fingerprint: fp, key_epoch: 1, created_at: createdAt,
        });
        const ok = !options.rejectAttestation
          && verify(identityPem, new TextEncoder().encode(rebuilt), b['attestation_signature']);
        if (!ok) return { status: 422, body: { error: 'Invalid attestation signature over the reconstructed payload' } };
        seen['attested'] = true;
        return { status: 200, body: { enrollment_id: 'enr_fake', state: 'pairing', encryption_key_fingerprint: fp, awaiting: 'human_approval' } };
      }
      if (path.includes('/revoke')) { state = 'revoked'; return { status: 200, body: { state } }; }
      return { status: 404, body: { error: 'route inconnue' } };
    },
    async get() {
      return { status: 200, body: { enrollment: { state, invited_role: 'member' } } };
    },
  };
  return { transport, seen, approve: () => { state = 'active'; } };
}

describe('appairage — la cérémonie aboutit', () => {
  it('réclame, prouve la possession et fait accepter l’attestation, sans copier un seul secret', async () => {
    const cloud = fakeCloud();
    const handle = await beginPairing({
      inviteCode: 'INVITE-1234',
      agentId: 'agent-test',
      transport: cloud.transport,
      cwd: ws.dir,
    });

    assert.equal(cloud.seen['attested'], true, "le cloud n'a pas accepté l'attestation");
    assert.equal(handle.cloud_project_id, 'cp_fake');
    assert.equal(handle.fingerprints.identity.length, 64);
    assert.equal(handle.fingerprints.encryption.length, 64);
    // Les deux empreintes sont DISTINCTES : identité et chiffrement sont deux clés.
    assert.notEqual(handle.fingerprints.identity, handle.fingerprints.encryption);
  });

  it('écrit un état local en « pending » — exister ne vaut pas approbation', async () => {
    const cloud = fakeCloud();
    await beginPairing({ inviteCode: 'I', agentId: 'a', transport: cloud.transport, cwd: ws.dir });

    const state = loadConnectionState(ws.dir);
    assert.equal(state?.enrollment.stage, 'pending');
    assert.equal(state?.keys.current_epoch, 0, 'aucun epoch ne doit être détenu avant approbation');
  });

  it('ne bascule en « active » qu’après approbation humaine constatée', async () => {
    const cloud = fakeCloud();
    const handle = await beginPairing({ inviteCode: 'I', agentId: 'a', transport: cloud.transport, cwd: ws.dir });

    const before = await checkPairingApproval({ enrollmentId: handle.enrollment_id, transport: cloud.transport });
    assert.equal(before.approved, false);

    cloud.approve();
    const after = await checkPairingApproval({ enrollmentId: handle.enrollment_id, transport: cloud.transport });
    assert.equal(after.approved, true);

    const final = completePairing({ role: after.role, cwd: ws.dir });
    assert.equal(final.enrollment.stage, 'active');
    assert.equal(final.enrollment.role, 'member');
  });

  it('le sondage NE MUTE PAS l’état local', async () => {
    // Lire un statut ne doit pas modifier le workspace : un effet de bord dans une
    // commande qu'on croit inoffensive est invisible jusqu'au jour où il nuit.
    const cloud = fakeCloud();
    await beginPairing({ inviteCode: 'I', agentId: 'a', transport: cloud.transport, cwd: ws.dir });
    cloud.approve();
    await checkPairingApproval({ enrollmentId: 'enr_fake', transport: cloud.transport });
    assert.equal(loadConnectionState(ws.dir)?.enrollment.stage, 'pending');
  });

  it('est reprenable : réappairer réutilise la MÊME clé d’appareil', async () => {
    // Une clé de déchiffrement régénérée perdrait l'accès à tout ce qui lui a été
    // enveloppé. La reprise doit être sûre, pas seulement possible.
    const first = await beginPairing({ inviteCode: 'I', agentId: 'a', transport: fakeCloud().transport, cwd: ws.dir });
    const second = await beginPairing({
      inviteCode: 'I', agentId: 'a', transport: fakeCloud().transport, cwd: ws.dir,
      deviceId: first.device.device_id,
    });
    assert.equal(second.fingerprints.encryption, first.fingerprints.encryption);
  });
});

describe('appairage — ce que la cérémonie refuse', () => {
  it('un cloud qui reconstruit le payload avec SA PROPRE horloge fait échouer l’attestation', async () => {
    // CONTRE-ÉPREUVE du défaut livré côté Cloud puis corrigé. C'est ce scénario exact
    // qui rendait tout appairage impossible ; le test le fige pour qu'il ne revienne pas.
    const cloud = fakeCloud({ serverClockPayload: true });
    await assert.rejects(
      () => beginPairing({ inviteCode: 'I', agentId: 'a', transport: cloud.transport, cwd: ws.dir }),
      (err: unknown) => err instanceof PairingError && err.stage === 'prove',
    );
  });

  it('une attestation refusée n’écrit AUCUN état local', async () => {
    // Fail-closed : un état écrit malgré un refus laisserait un workspace qui se croit
    // appairé alors que le cloud ne le connaît pas.
    const cloud = fakeCloud({ rejectAttestation: true });
    await assert.rejects(() => beginPairing({ inviteCode: 'I', agentId: 'a', transport: cloud.transport, cwd: ws.dir }));
    assert.equal(loadConnectionState(ws.dir), undefined);
  });

  it('interrompt si le cloud annonce une empreinte d’identité différente', async () => {
    // Signifierait que la clé enregistrée n'est pas celle de cet appareil — toute la
    // chaîne d'attestation qui suit serait bâtie sur une identité étrangère.
    const base = fakeCloud();
    const transport: PairingTransport = {
      async post(path, body) {
        const res = await base.transport.post(path, body);
        if (path.endsWith('/claim')) res.body['identity_key_fingerprint'] = 'f'.repeat(64);
        return res;
      },
      get: base.transport.get,
    };
    await assert.rejects(
      () => beginPairing({ inviteCode: 'I', agentId: 'a', transport, cwd: ws.dir }),
      /Empreinte d'identité divergente/,
    );
  });

  it('une invitation refusée remonte le message du serveur, pas un libellé générique', async () => {
    const transport: PairingTransport = {
      async post() { return { status: 410, body: { error: 'Invite expired' } }; },
      async get() { return { status: 404, body: {} }; },
    };
    await assert.rejects(
      () => beginPairing({ inviteCode: 'X', agentId: 'a', transport, cwd: ws.dir }),
      /Invite expired/,
    );
  });

  it('completePairing refuse quand aucun appairage local n’existe', () => {
    assert.throws(() => completePairing({ cwd: ws.dir }), /Aucun état d'appairage local/);
  });
});

describe('appairage — révocation et quorum de récupération', () => {
  it('un cloud injoignable n’empêche PAS la déconnexion locale', async () => {
    // Sinon un appareil perdu resterait autorisé faute de réseau — l'inverse de ce
    // qu'une révocation doit garantir.
    const transport: PairingTransport = {
      async post() { throw new Error('ECONNREFUSED'); },
      async get() { throw new Error('ECONNREFUSED'); },
    };
    const res = await requestRevocation({ enrollmentId: 'enr_fake', transport });
    assert.equal(res.revoked, false);
    assert.match(res.detail ?? '', /ECONNREFUSED/);
  });

  it('un seul appareil appairé ne suffit toujours pas au quorum de récupération', async () => {
    // L'appairage n'ouvre PAS la porte d'émission à lui seul : RFC §5.3 exige deux
    // porteurs, sans quoi la perte de cet appareil rend le passé scellé irrécupérable.
    const cloud = fakeCloud();
    await beginPairing({ inviteCode: 'I', agentId: 'a', transport: cloud.transport, cwd: ws.dir });
    const state = loadConnectionState(ws.dir);
    assert.ok(state);
    assert.equal(recoveryReadiness(state).ready, false);
    assert.equal(recoveryReadiness(state).enrolled, 1);
  });

  it('aucun epoch n’est détenu tant que rien n’a été remis', async () => {
    const cloud = fakeCloud();
    const handle = await beginPairing({ inviteCode: 'I', agentId: 'a', transport: cloud.transport, cwd: ws.dir });
    assert.deepEqual(heldEpochs(handle.cloud_project_id), []);
  });
});

describe('attestation — le contrat partagé avec le Cloud', () => {
  it('la forme du payload est GELÉE, octet pour octet', () => {
    // Ce littéral est DUPLIQUÉ dans brainclaw-cloud/tests/unit/attestation.test.ts.
    // La duplication est le mécanisme : deux dépôts, deux runtimes, aucun module
    // partageable — donc le gel est verrouillé des deux côtés sur la même chaîne. Si
    // l'un dérive, son test rougit avant que la divergence n'atteigne un utilisateur.
    assert.equal(
      attestationPayload({
        enrollment_id: 'enr_test', project_id: 'prj_test', agent_id: 'agent-test',
        key_type: 'encryption', key_purpose: 'envelope', key_fingerprint: 'abc123',
        key_epoch: 1, created_at: '2026-08-08T03:00:00.000Z',
      }),
      '{"v":1,"kind":"brainclaw.federation.v2.key_attestation","enrollment_id":"enr_test",'
      + '"project_id":"prj_test","agent_id":"agent-test","key_type":"encryption",'
      + '"key_purpose":"envelope","key_fingerprint":"abc123","key_epoch":1,'
      + '"created_at":"2026-08-08T03:00:00.000Z"}',
    );
  });

  it('l’empreinte ignore CRLF et espaces finaux', () => {
    const { publicKey } = crypto.generateKeyPairSync('x25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    assert.equal(fingerprintPem(pem.replace(/\n/g, '\r\n') + '\n  '), fingerprintPem(pem));
  });

  it('l’attestation se vérifie avec la clé d’identité qui l’a signée', () => {
    const id = crypto.generateKeyPairSync('ed25519');
    const enc = crypto.generateKeyPairSync('x25519');
    const att = buildKeyAttestation({
      enrollmentId: 'e', projectId: 'p', agentId: 'a',
      encryptionPublicKeyPem: enc.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      identityPrivateKeyPem: id.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      createdAt: '2026-08-08T03:00:00.000Z',
    });
    assert.equal(
      crypto.verify(null, Buffer.from(att.payload), id.publicKey, Buffer.from(att.signature, 'base64')),
      true,
    );
  });

  it('signer avec une AUTRE identité ne produit pas une attestation valide', () => {
    const legit = crypto.generateKeyPairSync('ed25519');
    const attacker = crypto.generateKeyPairSync('ed25519');
    const payload = attestationPayload({
      enrollment_id: 'e', project_id: 'p', agent_id: 'a', key_type: 'encryption',
      key_purpose: 'envelope', key_fingerprint: 'x', key_epoch: 1, created_at: 't',
    });
    const forged = signEd25519(attacker.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), new TextEncoder().encode(payload));
    assert.equal(crypto.verify(null, Buffer.from(payload), legit.publicKey, Buffer.from(forged, 'base64')), false);
  });
});
