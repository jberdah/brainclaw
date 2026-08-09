/**
 * Chaîne COMPLÈTE : appairage → genèse d'epoch → collecte → scellement → file → envoi.
 *
 * ── POURQUOI UN TEST DE BOUT EN BOUT EN PLUS DES TESTS UNITAIRES ─────────────
 * Parce que chaque maillon de cette chaîne était vert et que la chaîne, elle, ne
 * fonctionnait pas. Mesuré le 2026-08-09 : `buildEnvelope`, `enqueue` et
 * `storeEpochPrivateKey` avaient TOUS zéro appelant de production. Trois modules corrects,
 * bien testés, et rien entre eux — le cloud avait reçu zéro enveloppe depuis le début.
 *
 * Un test par module ne peut pas voir ça. Celui-ci part d'un magasin vide et ne s'arrête
 * qu'au corps HTTP réellement émis.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTestWorkspace } from '../helpers/workspace.js';
import { mutateState } from '../../src/core/state.js';
import { nowISO } from '../../src/core/ids.js';
import { ensureFirstEpochKey } from '../../src/core/federation-keyring.js';
import {
  createConnectionState,
  saveConnectionState,
  newDeviceId,
} from '../../src/core/federation-state.js';
import { emitProjections } from '../../src/core/federation-emit.js';
import { pushPending } from '../../src/core/federation-push.js';
import { counters } from '../../src/core/federation-outbox-v2.js';
import { ensureAgentSigningKey } from '../../src/core/agent-registry.js';

const CLOUD_PROJECT = 'prj_e2e';
const URL_ = 'https://cloud.e2e';

function fullyPaired(cwd: string, home: string): void {
  const state = createConnectionState({
    cloudProjectId: CLOUD_PROJECT,
    workspacePath: cwd,
    device: {
      device_id: newDeviceId(),
      x25519_fingerprint: 'fp_x',
      attested_by_ed25519: 'fp_ed',
      enrolled_at: nowISO(),
      recovery: true,
    },
  });
  state.enrollment = { stage: 'active', role: 'member', updated_at: nowISO() };
  state.keys = { current_epoch: 1, known_epochs: [1] };
  saveConnectionState(state, cwd);
  ensureFirstEpochKey(CLOUD_PROJECT, 1, home);
}

function seedPlan(cwd: string): void {
  mutateState((state) => {
    state.plan_items.push({
      id: 'pln_e2e',
      short_label: 'pln#1',
      text: 'Un plan qui doit atteindre le cloud',
      status: 'todo',
      priority: 'high',
      type: 'feat',
      tags: ['e2e'],
      created_at: nowISO(),
      updated_at: nowISO(),
      author: 'seed',
      depends_on: [],
      steps: [{ id: 'stp_e2e', text: 'Une étape', status: 'todo', created_at: nowISO(), updated_at: nowISO() }],
    } as never);
  }, cwd);
}

describe('chaîne complète — du magasin local au corps HTTP', () => {
  it('un plan local finit en enveloppe scellée envoyée au cloud', async () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-e2e-' });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-e2e-home-'));
    const prevHome = process.env['HOME'];
    const prevUserProfile = process.env['USERPROFILE'];
    process.env['HOME'] = home;
    process.env['USERPROFILE'] = home;
    try {
      const agent = ensureAgentSigningKey('agt_e2e');
      assert.ok(agent, 'identité de signature indisponible');
      seedPlan(ws.dir);
      fullyPaired(ws.dir, home);

      const emitted = emitProjections({ cwd: ws.dir, agentId: 'agt_e2e' });
      assert.equal(emitted.refused, 0, `refus inattendu : ${JSON.stringify(emitted.refusals)}`);
      assert.ok(emitted.enqueued >= 2, `attendu au moins le plan et son étape, obtenu ${emitted.enqueued}`);
      assert.equal(counters(ws.dir).pending, emitted.enqueued);

      const bodies: Array<Record<string, unknown>> = [];
      const capture = (async (_u: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response('{}', { status: 202 });
      }) as unknown as typeof fetch;

      const pushed = await pushPending({ cwd: ws.dir, url: URL_, fetchImpl: capture });
      assert.equal(pushed.sent, emitted.enqueued, 'toutes les enveloppes doivent partir');
      assert.equal(counters(ws.dir).pending, 0);
      assert.equal(counters(ws.dir).synced, emitted.enqueued);

      // LE CONTRÔLE QUI COMPTE : le texte du plan ne doit apparaître NULLE PART en clair
      // dans ce qui part sur le fil. Le chiffrement protège le contenu ; ce test le
      // vérifie sur le corps réellement émis, pas sur l'intention du projecteur.
      const wire = JSON.stringify(bodies);
      assert.ok(
        !wire.includes('Un plan qui doit atteindre le cloud'),
        'le texte du plan est parti EN CLAIR sur le fil',
      );
      assert.ok(!wire.includes('Une étape'), 'le texte de l\'étape est parti en clair');
      assert.ok(!wire.includes(ws.dir), 'un chemin local est parti sur le fil');
    } finally {
      if (prevHome === undefined) delete process.env['HOME']; else process.env['HOME'] = prevHome;
      if (prevUserProfile === undefined) delete process.env['USERPROFILE']; else process.env['USERPROFILE'] = prevUserProfile;
      fs.rmSync(home, { recursive: true, force: true });
      ws.cleanup();
    }
  });

  it('une seconde émission ne renvoie RIEN — l\'idempotence tient sur la chaîne entière', async () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-e2e-' });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-e2e-home-'));
    const prevHome = process.env['HOME'];
    const prevUserProfile = process.env['USERPROFILE'];
    process.env['HOME'] = home;
    process.env['USERPROFILE'] = home;
    try {
      ensureAgentSigningKey('agt_e2e2');
      seedPlan(ws.dir);
      fullyPaired(ws.dir, home);

      const first = emitProjections({ cwd: ws.dir, agentId: 'agt_e2e2' });
      const ok = (async () => new Response('{}', { status: 202 })) as unknown as typeof fetch;
      await pushPending({ cwd: ws.dir, url: URL_, fetchImpl: ok });

      // Rien n'a changé dans le magasin : une relance ne doit RIEN remettre en file.
      const second = emitProjections({ cwd: ws.dir, agentId: 'agt_e2e2' });
      assert.equal(second.enqueued, 0, 'la relance a réémis des objets déjà envoyés');
      assert.equal(second.skipped_duplicate, first.enqueued, 'les doublons doivent être comptés, pas ignorés');
      assert.equal(counters(ws.dir).pending, 0, 'rien ne doit revenir en attente');
    } finally {
      if (prevHome === undefined) delete process.env['HOME']; else process.env['HOME'] = prevHome;
      if (prevUserProfile === undefined) delete process.env['USERPROFILE']; else process.env['USERPROFILE'] = prevUserProfile;
      fs.rmSync(home, { recursive: true, force: true });
      ws.cleanup();
    }
  });
});
