/**
 * pln#651 étape 7 — commandes cloud matérialisées localement.
 *
 * CRITÈRE DE SORTIE : « une commande de priorité émise depuis le dashboard atterrit dans
 * le journal local avec son operation_id et son base_rev ; un base_rev périmé produit un
 * conflit VISIBLE et non un écrasement ; le rejouer deux fois ne produit qu'un effet ».
 *
 * Les trois sont assertés SUR DISQUE, pas sur une valeur de retour : le journal est ce que
 * l'opérateur et l'interface liront, et c'est donc lui qui doit être juste.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  applyCloudCommand,
  loadJournalEntry,
  listCommands,
  markCommandSynced,
  resolveCommandConflict,
  commandAuditDigest,
  RELAYABLE_FIELDS,
  CloudCommandSchema,
} from '../../src/core/federation-relay.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';

let ws: TestWorkspace;
beforeEach(() => { ws = createTestWorkspace({ prefix: 'bclaw-relay-' }); });
afterEach(() => { ws.cleanup(); });

const CMD = {
  operation_id: 'op_dashboard_1',
  object_id: 'obj_opaque_1',
  base_rev: 4,
  field: 'priority' as const,
  value: 'high',
  issued_by: 'key_operateur',
  issued_at: '2026-08-08T12:00:00.000Z',
};

const atRev = (rev: number | undefined) => () => rev;

function journalFile(operationId: string): string {
  return path.join(ws.dir, '.brainclaw', 'coordination', 'federation', 'commands', `${operationId}.json`);
}

describe('relais — la commande atterrit dans le journal local', () => {
  it('écrit SUR DISQUE l’operation_id, le base_rev et l’émetteur', () => {
    const res = applyCloudCommand({ raw: CMD, cwd: ws.dir, resolveLocalRev: atRev(4) });
    assert.equal(res.status, 'applied');

    // Assertion sur le FICHIER, pas sur la valeur de retour : c'est ce fichier que
    // l'interface et l'opérateur liront.
    const onDisk = JSON.parse(fs.readFileSync(journalFile('op_dashboard_1'), 'utf-8'));
    assert.equal(onDisk.operation_id, 'op_dashboard_1');
    assert.equal(onDisk.base_rev, 4);
    assert.equal(onDisk.issued_by, 'key_operateur');
    assert.equal(onDisk.field, 'priority');
    assert.equal(onDisk.value, 'high');
    // État VISIBLE dès l'écriture (dec#154) : jamais un effet sans état observable.
    assert.equal(onDisk.state, 'pending');
  });

  it('passe en « synced » une fois l’effet local appliqué', () => {
    applyCloudCommand({ raw: CMD, cwd: ws.dir, resolveLocalRev: atRev(4) });
    assert.equal(markCommandSynced(ws.dir, 'op_dashboard_1'), true);
    assert.equal(loadJournalEntry(ws.dir, 'op_dashboard_1')?.state, 'synced');
  });
});

describe('relais — REJOUER deux fois ne produit qu’un effet', () => {
  it('la seconde application est un doublon, pas un second effet', () => {
    const first = applyCloudCommand({ raw: CMD, cwd: ws.dir, resolveLocalRev: atRev(4) });
    const second = applyCloudCommand({ raw: CMD, cwd: ws.dir, resolveLocalRev: atRev(4) });
    assert.equal(first.status, 'applied');
    assert.equal(second.status, 'duplicate');
    assert.equal(listCommands(ws.dir).length, 1);
  });

  it('un retry reste un doublon MÊME SI la révision locale a changé entre-temps', () => {
    // Sans ce comportement, un simple retry réseau produirait un conflit fantôme sur une
    // opération pourtant déjà réussie.
    applyCloudCommand({ raw: CMD, cwd: ws.dir, resolveLocalRev: atRev(4) });
    const retry = applyCloudCommand({ raw: CMD, cwd: ws.dir, resolveLocalRev: atRev(9) });
    assert.equal(retry.status, 'duplicate');
    assert.equal(listCommands(ws.dir, 'conflict').length, 0);
  });

  it('deux commandes DIFFÉRENTES sur la même révision coexistent', () => {
    // Changer la priorité puis le rang vise légitimement la même révision : un index par
    // (object_id, base_rev) les confondrait.
    applyCloudCommand({ raw: CMD, cwd: ws.dir, resolveLocalRev: atRev(4) });
    applyCloudCommand({
      raw: { ...CMD, operation_id: 'op_dashboard_2', field: 'rank', value: 3 },
      cwd: ws.dir, resolveLocalRev: atRev(4),
    });
    assert.equal(listCommands(ws.dir).length, 2);
  });
});

describe('relais — un base_rev périmé produit un CONFLIT VISIBLE', () => {
  it('n’écrase pas : il enregistre un conflit avec une proposition', () => {
    const res = applyCloudCommand({ raw: CMD, cwd: ws.dir, resolveLocalRev: atRev(7) });
    assert.equal(res.status, 'conflict');
    if (res.status !== 'conflict') return;

    assert.equal(res.entry.state, 'conflict');
    assert.equal(res.entry.conflict?.local_rev, 7);
    assert.match(res.entry.conflict?.proposal ?? '', /Rejouer la commande sur la révision 7/);

    // Visible sur disque, donc listable par une commande d'opérateur.
    assert.equal(listCommands(ws.dir, 'conflict').length, 1);
  });

  it('distingue « le local a avancé » de « le local a régressé »', () => {
    // Deux causes différentes appellent deux gestes différents ; une proposition unique
    // enverrait l'opérateur dans la mauvaise direction dans un cas sur deux.
    const ahead = applyCloudCommand({ raw: CMD, cwd: ws.dir, resolveLocalRev: atRev(7) });
    const behind = applyCloudCommand({ raw: { ...CMD, operation_id: 'op_b' }, cwd: ws.dir, resolveLocalRev: atRev(2) });
    assert.equal(ahead.status, 'conflict');
    assert.equal(behind.status, 'conflict');
    if (ahead.status !== 'conflict' || behind.status !== 'conflict') return;
    assert.match(ahead.entry.conflict!.proposal, /Le local a avancé/);
    assert.match(behind.entry.conflict!.proposal, /restauré/);
  });

  it('un conflit se résout par une DÉCISION explicite, jamais automatiquement', () => {
    applyCloudCommand({ raw: CMD, cwd: ws.dir, resolveLocalRev: atRev(7) });

    const accepted = resolveCommandConflict({ cwd: ws.dir, operationId: 'op_dashboard_1', decision: 'accept' });
    assert.equal(accepted?.state, 'pending');
    assert.equal(accepted?.conflict, undefined);
    assert.equal(listCommands(ws.dir, 'conflict').length, 0);
  });

  it('abandonner un conflit le clôt sans effet', () => {
    applyCloudCommand({ raw: { ...CMD, operation_id: 'op_x' }, cwd: ws.dir, resolveLocalRev: atRev(7) });
    const discarded = resolveCommandConflict({ cwd: ws.dir, operationId: 'op_x', decision: 'discard' });
    assert.equal(discarded?.state, 'synced');
  });
});

describe('relais — la troisième classe d’appelants (dec#155)', () => {
  it('REFUSE un objet inconnu au lieu de retomber sur un projet ambiant', () => {
    // La tentation « si le projet n'est pas précisé, prendre le projet actif » est
    // exactement la dérive corrigée par pln#648/649 pour le routage local.
    const res = applyCloudCommand({ raw: CMD, cwd: ws.dir, resolveLocalRev: atRev(undefined) });
    assert.equal(res.status, 'refused');
    if (res.status !== 'refused') return;
    assert.match(res.reason, /aucune résolution ambiante/);
    // Un refus n'écrit RIEN : pas d'entrée fantôme à nettoyer ensuite.
    assert.equal(listCommands(ws.dir).length, 0);
  });

  it('refuse une commande portant un champ hors de la liste relayable', () => {
    // « Le relais n'écrit jamais de contenu » (dec#154) : accepter `text` ferait du Cloud
    // une source d'écriture de contenu.
    for (const field of ['text', 'description', 'title', 'related_paths']) {
      const res = applyCloudCommand({ raw: { ...CMD, field, operation_id: `op_${field}` }, cwd: ws.dir, resolveLocalRev: atRev(4) });
      assert.equal(res.status, 'refused', `champ non relayable accepté : ${field}`);
    }
    assert.equal(listCommands(ws.dir).length, 0);
  });

  it('la liste des champs relayables ne porte QUE des métadonnées', () => {
    assert.deepEqual([...RELAYABLE_FIELDS].sort(), ['priority', 'rank', 'status']);
  });

  it('refuse une commande portant un champ inconnu (parse strict)', () => {
    const res = applyCloudCommand({ raw: { ...CMD, cwd: 'C:\\Users\\x' }, cwd: ws.dir, resolveLocalRev: atRev(4) });
    assert.equal(res.status, 'refused');
  });

  it('un operation_id hostile ne peut pas écrire hors du journal', () => {
    // Le nom de fichier vient du réseau : sans assainissement, '../../..' écrirait
    // n'importe où sous le workspace.
    applyCloudCommand({
      raw: { ...CMD, operation_id: '../../../evade' },
      cwd: ws.dir, resolveLocalRev: atRev(4),
    });
    assert.equal(fs.existsSync(path.join(ws.dir, 'evade.json')), false);
    assert.equal(listCommands(ws.dir).length, 1, "l'entrée doit rester dans le journal");
  });
});

describe('relais — audit et validation', () => {
  it('l’empreinte d’audit est reproductible et indépendante de l’ordre des clés', () => {
    // Un audit qu'on ne peut pas recalculer identiquement des deux côtés ne prouve rien.
    const a = commandAuditDigest(CloudCommandSchema.parse(CMD));
    const reordered = { issued_at: CMD.issued_at, value: CMD.value, field: CMD.field, base_rev: CMD.base_rev, object_id: CMD.object_id, operation_id: CMD.operation_id, issued_by: CMD.issued_by };
    assert.equal(commandAuditDigest(CloudCommandSchema.parse(reordered)), a);
  });

  it('l’empreinte ne contient PAS issued_at — l’horodatage n’est pas la commande', () => {
    // Deux retries de la même commande à deux instants portent la même intention ; les
    // distinguer par l'horodatage rendrait l'audit inutilisable pour repérer un doublon.
    const later = CloudCommandSchema.parse({ ...CMD, issued_at: '2026-09-09T00:00:00.000Z' });
    assert.equal(commandAuditDigest(later), commandAuditDigest(CloudCommandSchema.parse(CMD)));
  });

  it('refuse d’appliquer à l’aveugle sur un journal corrompu', () => {
    // Traiter une entrée illisible comme absente ferait RÉAPPLIQUER une commande déjà
    // appliquée — exactement ce que ce module empêche.
    fs.mkdirSync(path.dirname(journalFile('op_corrompu')), { recursive: true });
    fs.writeFileSync(journalFile('op_corrompu'), '{ pas du json', 'utf-8');
    assert.throws(
      () => applyCloudCommand({ raw: { ...CMD, operation_id: 'op_corrompu' }, cwd: ws.dir, resolveLocalRev: atRev(4) }),
      /Journal corrompu/,
    );
  });
});
