/**
 * pln#651 étape 3 — état local de connexion + trousseau multi-epoch.
 *
 * CE QUE CE PACK VÉRIFIE, ET POURQUOI À CE NIVEAU-LÀ : les critères de sortie de l'étape
 * portent sur des propriétés OBSERVABLES sur disque — « relire après redémarrage »,
 * « aucun secret dans la config en clair », « trois états observables par une commande ».
 * Un test qui n'appellerait que les fonctions internes prouverait qu'elles calculent, pas
 * que la fonctionnalité tire (trp#1292 : deux fonctionnalités inertes publiées sur npm
 * avec des tests verts sur leur cœur). On assert donc SUR LE DISQUE et via la surface
 * publique du module, jamais sur un état gardé en mémoire par le test.
 *
 * HARNAIS : isolateAgentEnv() falsifie HOME, ce qui est indispensable ici — les clés
 * privées vont dans ~/.brainclaw/keys/, et un test non isolé écrirait dans le vrai
 * trousseau de la machine (trp#1447 : une copie locale plus faible a coûté trois rondes
 * de CI rouges).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  ensureDeviceKey,
  loadDevicePrivateKey,
  storeEpochPrivateKey,
  loadEpochPrivateKey,
  heldEpochs,
  forgetProjectEpochs,
  deviceKeyPath,
  epochKeyPath,
} from '../../src/core/federation-keyring.js';
import {
  createConnectionState,
  saveConnectionState,
  loadConnectionState,
  summarizeConnection,
  connectionStatePath,
  acceptsRevision,
  recordRevision,
  recoveryReadiness,
  newDeviceId,
  REQUIRED_RECOVERY_DEVICES,
  type DeviceRecord,
  type FederationConnectionState,
} from '../../src/core/federation-state.js';
import { enqueue, transition, counters, list } from '../../src/core/federation-outbox-v2.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

let ws: TestWorkspace;
let home: string;

function makeDevice(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  const deviceId = newDeviceId();
  const key = ensureDeviceKey(deviceId, home);
  return {
    device_id: deviceId,
    x25519_fingerprint: key.fingerprint,
    attested_by_ed25519: 'a'.repeat(64),
    enrolled_at: new Date().toISOString(),
    recovery: true,
    ...overrides,
  };
}

function freshX25519Pem(): string {
  return crypto.generateKeyPairSync('x25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

beforeEach(() => {
  ws = createTestWorkspace({ prefix: 'bclaw-fedstate-' });
  home = ws.fakeHome;
});

afterEach(() => {
  ws.cleanup();
});

describe('federation v2 — identité d’appareil (trousseau)', () => {
  it('génère une paire X25519 et NE LA FAIT PAS TOURNER au second appel', () => {
    const deviceId = newDeviceId();
    const first = ensureDeviceKey(deviceId, home);
    const second = ensureDeviceKey(deviceId, home);

    // Une rotation silencieuse casserait l'attestation déjà approuvée par un humain ET
    // rendrait illisibles les enveloppes d'epoch remises à l'ancienne clé.
    assert.equal(second.fingerprint, first.fingerprint, 'la clé d’appareil a tourné entre deux appels');
    assert.match(first.public_key_pem, /BEGIN PUBLIC KEY/);
  });

  it('écrit la clé privée sous ~/.brainclaw/keys/ et JAMAIS dans le store de workspace', () => {
    const deviceId = newDeviceId();
    ensureDeviceKey(deviceId, home);

    const keyFile = deviceKeyPath(deviceId, home);
    assert.ok(fs.existsSync(keyFile), 'clé privée absente du trousseau maison');
    assert.match(fs.readFileSync(keyFile, 'utf-8'), /BEGIN PRIVATE KEY/);

    // Le store de workspace se copie et se synchronise — un secret qui y atterrit
    // voyage avec lui.
    const storeRoot = path.join(ws.dir, '.brainclaw');
    for (const file of walk(storeRoot)) {
      assert.ok(
        !fs.readFileSync(file, 'utf-8').includes('BEGIN PRIVATE KEY'),
        `matériel de clé privée trouvé dans le store: ${file}`,
      );
    }
  });

  it('n’est PAS dérivée de la clé d’identité Ed25519', () => {
    // Le contrat « écrire sans lire » (RFC §5.1) tient uniquement si signature et
    // déchiffrement sont deux capacités séparables.
    const deviceId = newDeviceId();
    ensureDeviceKey(deviceId, home);
    const priv = loadDevicePrivateKey(deviceId, home);
    assert.equal(priv?.asymmetricKeyType, 'x25519');

    const ed = path.join(home, '.brainclaw', 'keys');
    const files = fs.existsSync(ed) ? fs.readdirSync(ed) : [];
    assert.ok(
      files.some((f) => f.endsWith('.x25519.pem')),
      'la clé de chiffrement doit exister comme fichier distinct',
    );
  });

  it('loadDevicePrivateKey ne CRÉE rien quand la clé est absente', () => {
    // Une clé fabriquée à la volée ferait échouer le déchiffrement bien plus loin,
    // sans lien visible avec l'absence de clé.
    assert.equal(loadDevicePrivateKey('dev_inexistant', home), undefined);
    assert.ok(!fs.existsSync(deviceKeyPath('dev_inexistant', home)));
  });
});

describe('federation v2 — trousseau multi-epoch', () => {
  const project = 'cp_opaque_1';

  it('conserve plusieurs epochs simultanément, pour relire le passé après rotation', () => {
    // La révocation est forward-only : sans trousseau, chaque rotation rendrait
    // l'historique illisible pour un appareil pourtant autorisé.
    storeEpochPrivateKey(project, 1, freshX25519Pem(), home);
    storeEpochPrivateKey(project, 2, freshX25519Pem(), home);

    assert.deepEqual(heldEpochs(project, home), [1, 2]);
    assert.ok(loadEpochPrivateKey(project, 1, home), 'epoch 1 doit rester lisible après rotation');
    assert.ok(loadEpochPrivateKey(project, 2, home));
  });

  it('REFUSE d’écraser un epoch par une clé différente, mais reste idempotent sur la même', () => {
    const pem = freshX25519Pem();
    storeEpochPrivateKey(project, 1, pem, home);

    // Idempotent : une reprise d'appairage interrompu ne doit pas échouer.
    storeEpochPrivateKey(project, 1, pem, home);

    // Écraser rendrait illisible tout ce qui a été scellé sous la première clé.
    assert.throws(
      () => storeEpochPrivateKey(project, 1, freshX25519Pem(), home),
      /Refus d'écraser la clé de l'epoch 1/,
    );
  });

  it('refuse une clé qui n’est pas X25519 AVANT de l’écrire', () => {
    const ed = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    assert.throws(() => storeEpochPrivateKey(project, 7, ed, home), /attendu x25519/);
    // Le refus doit être total : un fichier écrit puis rejeté serait découvert au
    // premier déchiffrement, longtemps après l'appairage qui l'a produit.
    assert.ok(!fs.existsSync(epochKeyPath(project, 7, home)));
  });

  it('cloisonne les epochs par projet : disconnect n’emporte pas un autre projet', () => {
    storeEpochPrivateKey('cp_a', 1, freshX25519Pem(), home);
    storeEpochPrivateKey('cp_b', 1, freshX25519Pem(), home);

    assert.equal(forgetProjectEpochs('cp_a', home), 1);
    assert.deepEqual(heldEpochs('cp_a', home), []);
    assert.deepEqual(heldEpochs('cp_b', home), [1], 'un projet voisin a perdu ses clés');
  });
});

describe('federation v2 — état de connexion', () => {
  it('se relit intégralement après « redémarrage » (critère de sortie)', () => {
    const device = makeDevice();
    let state = createConnectionState({ cloudProjectId: 'cp_x', device, workspacePath: ws.dir });
    state = { ...state, keys: { current_epoch: 2, known_epochs: [1, 2] }, enrollment: { stage: 'active', role: 'writer', updated_at: new Date().toISOString() } };
    storeEpochPrivateKey('cp_x', 1, freshX25519Pem(), home);
    storeEpochPrivateKey('cp_x', 2, freshX25519Pem(), home);
    saveConnectionState(state, ws.dir);

    // Relecture depuis le DISQUE, pas depuis l'objet gardé en mémoire.
    const reloaded = loadConnectionState(ws.dir);
    assert.ok(reloaded);
    assert.equal(reloaded.cloud_project_id, 'cp_x');
    assert.equal(reloaded.enrollment.stage, 'active');
    assert.equal(reloaded.keys.current_epoch, 2);
    assert.deepEqual(reloaded.keys.known_epochs, [1, 2]);
    assert.equal(reloaded.device.device_id, device.device_id);
  });

  it('REFUSE d’écrire un état contenant du matériel de clé privée', () => {
    const state = createConnectionState({ cloudProjectId: 'cp_x', device: makeDevice(), workspacePath: ws.dir });
    // Le typage TS est une borne inférieure : ce champ compile via un cast, exactement
    // comme le ferait `{...state, extra}` dans du vrai code.
    const poisoned = { ...state, leaked: freshX25519Pem() } as unknown as FederationConnectionState;

    assert.throws(() => saveConnectionState(poisoned, ws.dir), /Refus d'écrire l'état de connexion/);
    assert.ok(!fs.existsSync(connectionStatePath(ws.dir)), 'un état refusé ne doit rien laisser sur disque');
  });

  it('réconcilie le trousseau DÉCLARÉ avec celui réellement détenu sur disque', () => {
    // Cas réel : restauration partielle de sauvegarde, ou disconnect interrompu.
    const state = createConnectionState({ cloudProjectId: 'cp_y', device: makeDevice(), workspacePath: ws.dir });
    saveConnectionState({ ...state, keys: { current_epoch: 3, known_epochs: [1, 2, 3] } }, ws.dir);
    storeEpochPrivateKey('cp_y', 1, freshX25519Pem(), home); // seul l'epoch 1 est réellement là

    const reloaded = loadConnectionState(ws.dir);
    assert.deepEqual(reloaded?.keys.known_epochs, [1], 'le disque doit faire autorité sur ce qui est lisible');
  });

  it('renvoie undefined — et non un état par défaut — sur un fichier corrompu', () => {
    const filepath = connectionStatePath(ws.dir);
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    fs.writeFileSync(filepath, '{ pas du json', 'utf-8');

    // « Appairé, epoch 0 » ferait tenter un scellement sous une clé inexistante ;
    // « pas appairé » est la réponse sûre.
    assert.equal(loadConnectionState(ws.dir), undefined);
    assert.equal(summarizeConnection(ws.dir).stage, 'unpaired');
  });

  it('n’accepte pas un état de schéma v1 (aucune migration, dec#156)', () => {
    const filepath = connectionStatePath(ws.dir);
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    fs.writeFileSync(filepath, JSON.stringify({ schema: 'brainclaw.cloud-sync/v1', cloud_project_id: 'cp_old' }), 'utf-8');

    assert.equal(loadConnectionState(ws.dir), undefined);
  });

  it('crée l’état en « pending » et non « active » : exister ne vaut pas approbation', () => {
    const state = createConnectionState({ cloudProjectId: 'cp_z', device: makeDevice(), workspacePath: ws.dir });
    assert.equal(state.enrollment.stage, 'pending');
    // 0 = aucun epoch, pas « premier epoch » : sceller doit être impossible ici.
    assert.equal(state.keys.current_epoch, 0);
  });
});

describe('federation v2 — anti-rejeu (barrière par objet)', () => {
  it('refuse une révision inférieure OU ÉGALE au high-water mark', () => {
    let state = createConnectionState({ cloudProjectId: 'cp_x', device: makeDevice(), workspacePath: ws.dir });
    state = recordRevision(state, 'pln_1', 5);

    assert.equal(acceptsRevision(state, 'pln_1', 6), true);
    assert.equal(acceptsRevision(state, 'pln_1', 5), false, 'l’égalité doit être refusée (RFC §6.5)');
    assert.equal(acceptsRevision(state, 'pln_1', 4), false, 'rollback accepté');
    assert.equal(acceptsRevision(state, 'pln_jamais_vu', 1), true);
  });

  it('la barrière ne régresse jamais, même si l’appelant le demande', () => {
    let state = createConnectionState({ cloudProjectId: 'cp_x', device: makeDevice(), workspacePath: ws.dir });
    state = recordRevision(state, 'pln_1', 9);
    state = recordRevision(state, 'pln_1', 2);
    assert.equal(state.sync.high_water['pln_1'], 9);
  });

  it('survit à un aller-retour sur disque', () => {
    let state = createConnectionState({ cloudProjectId: 'cp_x', device: makeDevice(), workspacePath: ws.dir });
    state = recordRevision(state, 'pln_1', 42);
    saveConnectionState(state, ws.dir);

    const reloaded = loadConnectionState(ws.dir);
    assert.ok(reloaded);
    assert.equal(acceptsRevision(reloaded, 'pln_1', 41), false, 'la barrière anti-rejeu ne survit pas au redémarrage');
  });
});

describe('federation v2 — quorum de récupération (RFC §5.3)', () => {
  it('un seul appareil ne suffit pas à émettre', () => {
    const state = createConnectionState({ cloudProjectId: 'cp_x', device: makeDevice({ recovery: true }), workspacePath: ws.dir });
    const readiness = recoveryReadiness(state);
    assert.equal(readiness.ready, false);
    assert.equal(readiness.enrolled, 1);
    assert.equal(readiness.required, REQUIRED_RECOVERY_DEVICES);
    assert.match(readiness.reason ?? '', /irrécupérable/);
  });

  it('deux appareils de récupération attestés ouvrent la porte', () => {
    const state = createConnectionState({ cloudProjectId: 'cp_x', device: makeDevice({ recovery: true }), workspacePath: ws.dir });
    const withPeer = { ...state, peer_devices: [makeDevice({ recovery: true })] };
    assert.equal(recoveryReadiness(withPeer).ready, true);
  });

  it('un appareil RÉVOQUÉ ne compte pas dans le quorum', () => {
    // Deux porteurs dont un révoqué n'offrent aucun chemin de remplacement.
    const state = createConnectionState({ cloudProjectId: 'cp_x', device: makeDevice({ recovery: true }), workspacePath: ws.dir });
    const withRevoked = { ...state, peer_devices: [makeDevice({ recovery: true, revoked_at: new Date().toISOString() })] };
    assert.equal(recoveryReadiness(withRevoked).ready, false);
  });

  it('un appareil non marqué « recovery » ne compte pas', () => {
    const state = createConnectionState({ cloudProjectId: 'cp_x', device: makeDevice({ recovery: true }), workspacePath: ws.dir });
    const withPlain = { ...state, peer_devices: [makeDevice({ recovery: false })] };
    assert.equal(recoveryReadiness(withPlain).ready, false);
  });
});

describe('federation v2 — outbox et trois états observables', () => {
  const sealed = { alg: 'HPKE-v1/X25519-HKDF-SHA256-CHACHA20POLY1305', enc: 'x', nonce: 'y', ciphertext: 'z' };

  it('l’état d’une opération EST son emplacement, jamais deux à la fois', () => {
    assert.equal(enqueue({ idempotency_key: 'idem_1', operation_id: 'op_1', key_epoch: 1, sealed }, ws.dir), true);
    assert.deepEqual(counters(ws.dir), { pending: 1, synced: 0, conflict: 0 });

    assert.equal(transition('idem_1', 'pending', 'synced', ws.dir), true);
    assert.deepEqual(counters(ws.dir), { pending: 0, synced: 1, conflict: 0 });
  });

  it('un double enqueue de la même clé d’idempotence ne crée pas de doublon', () => {
    // C'est précisément ce que materializeFederationSignal ne faisait pas : un nouvel
    // id et un nouveau created_at à chaque passage.
    enqueue({ idempotency_key: 'idem_2', operation_id: 'op_2', key_epoch: 1, sealed }, ws.dir);
    assert.equal(enqueue({ idempotency_key: 'idem_2', operation_id: 'op_2', key_epoch: 1, sealed }, ws.dir), false);
    assert.equal(counters(ws.dir).pending, 1);
  });

  it('une opération déjà synchronisée n’est pas remise en file', () => {
    enqueue({ idempotency_key: 'idem_3', operation_id: 'op_3', key_epoch: 1, sealed }, ws.dir);
    transition('idem_3', 'pending', 'synced', ws.dir);
    assert.equal(enqueue({ idempotency_key: 'idem_3', operation_id: 'op_3', key_epoch: 1, sealed }, ws.dir), false);
    assert.deepEqual(counters(ws.dir), { pending: 0, synced: 1, conflict: 0 });
  });

  it('un conflit est un état retenu, pas un écrasement silencieux', () => {
    enqueue({ idempotency_key: 'idem_4', operation_id: 'op_4', base_rev: 3, key_epoch: 1, sealed }, ws.dir);
    transition('idem_4', 'pending', 'conflict', ws.dir, (e) => ({ ...e, last_error: 'base_rev périmé' }));

    const conflicts = list('conflict', ws.dir);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].last_error, 'base_rev périmé');
    assert.equal(conflicts[0].base_rev, 3, 'le base_rev doit survivre pour proposer une résolution');
  });

  it('le résumé COMPTE le disque au lieu de relire ses propres compteurs', () => {
    const state = createConnectionState({ cloudProjectId: 'cp_x', device: makeDevice(), workspacePath: ws.dir });
    // Compteurs persistés volontairement FAUX : un statut qui les relirait n'observerait rien.
    saveConnectionState({ ...state, counters: { pending: 99, synced: 99, conflict: 99 } }, ws.dir);
    enqueue({ idempotency_key: 'idem_5', operation_id: 'op_5', key_epoch: 1, sealed }, ws.dir);

    const summary = summarizeConnection(ws.dir);
    assert.deepEqual(summary.sync, { pending: 1, synced: 0, conflict: 0 });
  });

  it('l’outbox ne peut pas divulguer de clair : elle ne reçoit que le scellé', () => {
    enqueue({ idempotency_key: 'idem_6', operation_id: 'op_6', key_epoch: 1, sealed }, ws.dir);
    const onDisk = fs.readFileSync(path.join(ws.dir, '.brainclaw', 'coordination', 'federation', 'outbox', 'idem_6.json'), 'utf-8');
    assert.ok(onDisk.includes('ciphertext'));
    // Les champs « interdits de sortir » de dec#154 n'ont aucun chemin jusqu'ici.
    for (const forbidden of ['worktree_path', 'host_id', 'session_id']) {
      assert.ok(!onDisk.includes(forbidden), `champ interdit présent dans l'outbox: ${forbidden}`);
    }
  });
});

describe('federation v2 — surface observable (brainclaw cloud status)', () => {
  it('un workspace non appairé se déclare non appairé, sans état fabriqué', () => {
    const summary = summarizeConnection(ws.dir);
    assert.equal(summary.connected, false);
    assert.equal(summary.stage, 'unpaired');
    assert.equal(summary.current_epoch, 0);
    assert.deepEqual(summary.readable_epochs, []);
  });

  it('nomme l’epoch courant, le rôle et les epochs réellement lisibles', () => {
    const device = makeDevice();
    const state = createConnectionState({ cloudProjectId: 'cp_status', device, workspacePath: ws.dir });
    storeEpochPrivateKey('cp_status', 1, freshX25519Pem(), home);
    saveConnectionState(
      { ...state, enrollment: { stage: 'active', role: 'reader', updated_at: new Date().toISOString() }, keys: { current_epoch: 1, known_epochs: [1] } },
      ws.dir,
    );

    const summary = summarizeConnection(ws.dir);
    assert.equal(summary.connected, true);
    assert.equal(summary.role, 'reader');
    assert.equal(summary.current_epoch, 1);
    assert.deepEqual(summary.readable_epochs, [1]);
    assert.equal(summary.device_fingerprint, device.x25519_fingerprint);
  });
});

/** Parcours récursif — sert à prouver l'absence de secret dans TOUT le store. */
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

// Garde-fou du harnais LUI-MÊME. Sans lui, une régression d'isolation ferait écrire ces
// tests dans le vrai ~/.brainclaw/keys/ de la machine — et ils resteraient VERTS en le
// faisant, puisqu'ils vérifient le contenu d'un trousseau sans en vérifier l'adresse.
describe('federation v2 — isolation du harnais', () => {
  it('os.homedir() pointe sur le faux HOME, donc les défauts de paramètre sont sûrs', () => {
    // Les fonctions du trousseau ont `home = os.homedir()` par défaut, et
    // `loadConnectionState` s'appuie dessus pour réconcilier. L'isolation ne protège
    // donc que si elle atteint os.homedir(), pas seulement process.env.HOME.
    assert.equal(path.resolve(os.homedir()), path.resolve(home));
  });

  it('le faux HOME est bien un répertoire temporaire, pas un profil utilisateur', () => {
    assert.ok(
      path.resolve(home).startsWith(path.resolve(os.tmpdir())),
      `le HOME de test doit vivre sous tmpdir, reçu: ${home}`,
    );
  });
});
