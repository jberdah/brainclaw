/**
 * pln#620 — la SURFACE de confirmation d'applicabilité.
 *
 * POURQUOI CE FICHIER PORTE « SURFACE » DANS SON NOM. `recordMemoryEvent` était déjà
 * écrit, testé, et branché sur un schéma porté par les traps, décisions et contraintes.
 * Il n'était appelé DEPUIS NULLE PART : mesuré au moment du correctif, 0 item sur 471
 * portait la moindre confirmation.
 *
 * trp#1292 : un test vert sur une fonction interne ne prouve pas que la fonctionnalité
 * tire. Ce pack teste donc la commande — ce qu'un agent et un opérateur appellent
 * réellement — et assert SUR DISQUE, pas sur une valeur de retour.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runMemoryConfirm } from '../../src/commands/memory-confirm.js';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.js';
import { mutateState } from '../../src/core/state.js';

let ws: TestWorkspace;
let restoreCwd: (() => void) | undefined;

const TRAP_ID = 'trp_surface_test';

beforeEach(() => {
  ws = createTestWorkspace({ prefix: 'bclaw-confirm-' });
  restoreCwd = ws.useCwd();
  mutateState((state) => {
    state.known_traps.push({
      id: TRAP_ID,
      short_label: 'trp#test',
      text: 'un piège de test',
      created_at: new Date().toISOString(),
      status: 'active',
      // Champs EXIGÉS par TrapSchema : sans eux le fichier est rejeté à la lecture et
      // l'item n'apparaît jamais dans l'état actif. La commande le dit correctement
      // (« not found in active state ») — c'était le fixture qui était faux, pas le code.
      author: 'test',
      severity: 'medium',
      tags: [],
    } as never);
  }, ws.dir);
});

afterEach(() => {
  restoreCwd?.();
  restoreCwd = undefined;
  ws.cleanup();
});

/** Relit l'item DEPUIS LE DISQUE — la seule preuve qui compte ici. */
function readTrap(): Record<string, unknown> | undefined {
  for (const rel of ['memory/traps', 'traps']) {
    const dir = path.join(ws.dir, '.brainclaw', ...rel.split('/'));
    const file = path.join(dir, `${TRAP_ID}.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  }
  return undefined;
}

describe('confirm — l’événement atterrit SUR DISQUE', () => {
  it('écrit une confirmation avec sa preuve', () => {
    runMemoryConfirm({ entity: 'trap', id: TRAP_ID, kind: 'confirm', evidence: 'src/x.ts:12', cwd: ws.dir });

    const stored = readTrap();
    assert.ok(stored, 'le piège est introuvable sur disque');
    const events = stored.confirmations as Array<Record<string, unknown>> | undefined;
    assert.equal(events?.length, 1, 'aucun événement écrit — la fonctionnalité serait inerte');
    assert.equal(events![0].kind, 'confirm');
    assert.equal(events![0].evidence, 'src/x.ts:12');
  });

  it('accumule les événements au lieu de les remplacer', () => {
    runMemoryConfirm({ entity: 'trap', id: TRAP_ID, kind: 'confirm', evidence: 'a.ts:1', cwd: ws.dir });
    runMemoryConfirm({ entity: 'trap', id: TRAP_ID, kind: 'saved_me', cwd: ws.dir });
    const events = readTrap()?.confirmations as unknown[] | undefined;
    assert.equal(events?.length, 2);
  });
});

describe('confirm — ce que la commande REFUSE', () => {
  it('REFUSE une confirmation sans preuve', () => {
    // Le cœur du dispositif : une attestation sans pointeur vers ce qui a été vérifié
    // ne porte aucune information de plus que sa date, et ne peut donc pas justifier
    // une priorité.
    const previous = process.exitCode;
    runMemoryConfirm({ entity: 'trap', id: TRAP_ID, kind: 'confirm', cwd: ws.dir });
    assert.equal(process.exitCode, 1);
    assert.equal(readTrap()?.confirmations, undefined, 'un refus a quand même écrit');
    process.exitCode = previous;
  });

  it('ACCEPTE une infirmation sans preuve — constater une disparition EST la preuve', () => {
    runMemoryConfirm({ entity: 'trap', id: TRAP_ID, kind: 'infirm', note: 'le symbole n’existe plus', cwd: ws.dir });
    const events = readTrap()?.confirmations as Array<Record<string, unknown>> | undefined;
    assert.equal(events?.length, 1);
    assert.equal(events![0].kind, 'infirm');
  });

  it('refuse une entité ou un type inconnus sans rien écrire', () => {
    const previous = process.exitCode;
    runMemoryConfirm({ entity: 'plan', id: TRAP_ID, kind: 'confirm', evidence: 'x', cwd: ws.dir });
    assert.equal(process.exitCode, 1);
    runMemoryConfirm({ entity: 'trap', id: TRAP_ID, kind: 'peut-etre', evidence: 'x', cwd: ws.dir });
    assert.equal(process.exitCode, 1);
    assert.equal(readTrap()?.confirmations, undefined);
    process.exitCode = previous;
  });

  it('refuse un id inconnu sans planter le processus', () => {
    // Une erreur d'id est une faute de frappe, pas un incident : elle doit rendre un
    // message et un code de sortie, pas une trace de pile.
    const previous = process.exitCode;
    assert.doesNotThrow(() =>
      runMemoryConfirm({ entity: 'trap', id: 'trp_inexistant', kind: 'infirm', cwd: ws.dir }));
    assert.equal(process.exitCode, 1);
    process.exitCode = previous;
  });
});
