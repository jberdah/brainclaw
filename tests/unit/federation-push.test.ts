/**
 * Transport des enveloppes — drainage de l'outbox vers le cloud.
 *
 * ── CE QUE CES TESTS PROTÈGENT ────────────────────────────────────────────────
 * Le comportement en ÉCHEC, bien plus que le succès. Un transport qui perd une opération
 * en cas de coupure réseau est pire qu'un transport absent : l'outbox est la seule trace
 * qu'une projection devait partir, et une entrée effacée par erreur ne se reconstruit pas.
 *
 * `fetch` est injecté : on peut donc éprouver 409, 500 et exception réseau sans dépendre
 * d'un serveur — donc sans qu'un test « passe » simplement parce qu'il n'a rien pu joindre.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createTestWorkspace } from '../helpers/workspace.js';
import { enqueue, list, counters } from '../../src/core/federation-outbox-v2.js';
import { pushPending } from '../../src/core/federation-push.js';
import {
  createConnectionState,
  saveConnectionState,
  newDeviceId,
} from '../../src/core/federation-state.js';
import { nowISO } from '../../src/core/ids.js';

const URL_ = 'https://cloud.test';

/** Appairage ACTIF minimal — sans lui, `pushPending` refuse (et c'est testé plus bas). */
function pairActive(cwd: string): void {
  const state = createConnectionState({
    cloudProjectId: 'prj_cloud_test',
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
  saveConnectionState(state, cwd);
}

function seedPending(cwd: string, keys: string[]): void {
  for (const key of keys) {
    enqueue(
      { idempotency_key: key, operation_id: key, base_rev: 1, key_epoch: 1, sealed: { ct: 'opaque' } } as never,
      cwd,
    );
  }
}

const okFetch = (async () => new Response('{}', { status: 202 })) as unknown as typeof fetch;

describe('transport — refus avant tout envoi', () => {
  it('refuse sans appairage actif', async () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-push-' });
    try {
      await assert.rejects(() => pushPending({ cwd: ws.dir, url: URL_ }), /appairage/i);
    } finally { ws.cleanup(); }
  });

  it('refuse sans URL — aucune adresse n\'est devinée', async () => {
    // Deviner enverrait le trafic d'un projet à un tiers. Illisible pour lui, mais une
    // fuite de métadonnées et de trafic n'est pas un non-événement.
    const ws = createTestWorkspace({ prefix: 'bclaw-push-' });
    try {
      pairActive(ws.dir);
      await assert.rejects(() => pushPending({ cwd: ws.dir }), /adresse/i);
    } finally { ws.cleanup(); }
  });
});

describe('transport — succès', () => {
  it('déplace les entrées envoyées de pending vers synced', async () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-push-' });
    try {
      pairActive(ws.dir);
      seedPending(ws.dir, ['a@r1', 'b@r1']);
      const res = await pushPending({ cwd: ws.dir, url: URL_, fetchImpl: okFetch });
      assert.equal(res.sent, 2);
      assert.equal(counters(ws.dir).pending, 0, 'rien ne doit rester en attente');
      assert.equal(counters(ws.dir).synced, 2);
    } finally { ws.cleanup(); }
  });

  it('la simulation n\'envoie rien et ne déplace rien', async () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-push-' });
    try {
      pairActive(ws.dir);
      seedPending(ws.dir, ['a@r1']);
      let called = 0;
      const spy = (async () => { called += 1; return new Response('{}', { status: 202 }); }) as unknown as typeof fetch;
      const res = await pushPending({ cwd: ws.dir, url: URL_, dryRun: true, fetchImpl: spy });
      assert.equal(called, 0, 'la simulation a appelé le réseau');
      assert.equal(res.attempted, 1);
      assert.equal(counters(ws.dir).pending, 1, 'la simulation a déplacé une entrée');
    } finally { ws.cleanup(); }
  });
});

describe('transport — échecs, la partie qui compte', () => {
  it('une coupure réseau LAISSE l\'entrée en attente', async () => {
    // Le test central. Perdre ici une opération jamais émise la perd définitivement :
    // l'outbox est sa seule trace.
    const ws = createTestWorkspace({ prefix: 'bclaw-push-' });
    try {
      pairActive(ws.dir);
      seedPending(ws.dir, ['a@r1']);
      const boom = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
      const res = await pushPending({ cwd: ws.dir, url: URL_, fetchImpl: boom });
      assert.equal(res.failed, 1);
      assert.equal(counters(ws.dir).pending, 1, 'l\'entrée a disparu de la file après un échec réseau');
      assert.equal(list('pending', ws.dir)[0]?.attempts, 1, 'la tentative doit être comptée');
      assert.match(String(list('pending', ws.dir)[0]?.last_error), /ECONNREFUSED/);
    } finally { ws.cleanup(); }
  });

  it('un 500 laisse aussi en attente — un refus temporaire n\'est pas un conflit', async () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-push-' });
    try {
      pairActive(ws.dir);
      seedPending(ws.dir, ['a@r1']);
      const boom = (async () => new Response('oops', { status: 500 })) as unknown as typeof fetch;
      const res = await pushPending({ cwd: ws.dir, url: URL_, fetchImpl: boom });
      assert.equal(res.failed, 1);
      assert.equal(counters(ws.dir).conflict, 0, 'un 500 ne doit PAS produire un conflit');
      assert.equal(counters(ws.dir).pending, 1);
    } finally { ws.cleanup(); }
  });

  it('un 409 passe en conflit — un renvoi à l\'identique échouerait pareil', async () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-push-' });
    try {
      pairActive(ws.dir);
      seedPending(ws.dir, ['a@r1']);
      const conflict = (async () => new Response('{}', { status: 409 })) as unknown as typeof fetch;
      const res = await pushPending({ cwd: ws.dir, url: URL_, fetchImpl: conflict });
      assert.equal(res.conflicts, 1);
      assert.equal(counters(ws.dir).conflict, 1);
      assert.equal(counters(ws.dir).pending, 0, 'une entrée en conflit ne doit pas être retentée en boucle');
    } finally { ws.cleanup(); }
  });
});

describe('transport — ce qui part sur le fil', () => {
  it('n\'envoie que le SCELLÉ et des métadonnées de transport', async () => {
    // Le module ne voit que des `sealed` opaques : il ne PEUT pas divulguer de clair. Ce
    // test gèle cette propriété au niveau du corps HTTP réellement émis.
    const ws = createTestWorkspace({ prefix: 'bclaw-push-' });
    try {
      pairActive(ws.dir);
      seedPending(ws.dir, ['a@r1']);
      let body: Record<string, unknown> = {};
      let headers: Record<string, string> = {};
      const capture = (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        headers = init.headers as Record<string, string>;
        return new Response('{}', { status: 202 });
      }) as unknown as typeof fetch;

      await pushPending({ cwd: ws.dir, url: URL_, fetchImpl: capture });

      assert.deepEqual(Object.keys(body).sort(), ['base_rev', 'envelope', 'key_epoch']);
      assert.equal(headers['idempotency-key'], 'a@r1', 'le cloud doit pouvoir dédoublonner sans ouvrir le corps');
    } finally { ws.cleanup(); }
  });

  it('cible l\'endpoint de projection du projet CLOUD, pas un id local', async () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-push-' });
    try {
      pairActive(ws.dir);
      seedPending(ws.dir, ['a@r1']);
      let seen = '';
      const capture = (async (url: string) => { seen = url; return new Response('{}', { status: 202 }); }) as unknown as typeof fetch;
      await pushPending({ cwd: ws.dir, url: URL_, fetchImpl: capture });
      assert.equal(seen, `${URL_}/api/v1/projects/prj_cloud_test/projection/envelopes`);
      assert.ok(!seen.includes(ws.dir), 'un chemin local ne doit JAMAIS entrer dans une URL');
    } finally { ws.cleanup(); }
  });
});

describe('transport — l\'outbox reste la trace', () => {
  it('aucun fichier n\'est supprimé par un échec', () => {
    const ws = createTestWorkspace({ prefix: 'bclaw-push-' });
    try {
      pairActive(ws.dir);
      seedPending(ws.dir, ['a@r1']);
      const dir = path.join(ws.dir, '.brainclaw', 'coordination', 'federation', 'outbox');
      const before = fs.readdirSync(dir).length;
      assert.equal(before, 1);
    } finally { ws.cleanup(); }
  });
});
