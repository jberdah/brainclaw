/**
 * pln#648 SUITE (a) — unifier la disposition des records de session.
 *
 * LE DÉFAUT MESURÉ. `identity.ts` — le module qui POSSÈDE les records, `active_project`
 * compris — écrivait dans la disposition LEGACY (`.brainclaw/sessions/`), tandis que
 * `session-start.ts` définissait SA PROPRE version via `resolveEntityDir(…, 'read')`, une
 * heuristique de contenu. Sur le store de l'auteur au moment du correctif : 182 records
 * d'un côté, 1030 de l'autre.
 *
 * Deux écrivains, deux emplacements, un seul id : un `active_project` pouvait atterrir
 * dans l'un et être cherché dans l'autre. C'est le second vecteur de divergence de
 * pln#648 — le premier déplaçait la vérité à chaque switch, celui-ci la dédoublait.
 *
 * CE QUE CE PACK VÉRIFIE : la lecture couvre les DEUX dispositions, l'écriture ne vise
 * que la canonique, et une copie résiduelle est CONVERGÉE plutôt que laissée en place.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defaultConfig, saveConfig } from '../../src/core/config.js';
import { isolateAgentEnv } from '../helpers/workspace.js';
import { registerAgentIdentity } from '../../src/core/agent-registry.js';
import {
  saveCurrentSession, loadSessionById, loadAllSessions, clearCurrentSession, gcStaleSessions,
} from '../../src/core/identity.js';

const AGENT = 'layout-bench';
const CANONICAL = path.join('coordination', 'sessions');
const LEGACY = 'sessions';

let isolation: { restore: () => void } | undefined;
let root: string;

function record(sessionId: string, lastSeen = new Date().toISOString()) {
  return {
    session_id: sessionId,
    started_at: new Date().toISOString(),
    last_seen_at: lastSeen,
    agent: AGENT,
    agent_id: 'agt_layout',
    host_id: 'host-test',
    pid: process.pid,
  };
}

/** Écrit un record DIRECTEMENT dans la disposition legacy, comme le faisait l'ancien code. */
function writeLegacy(sessionId: string, lastSeen = new Date().toISOString()): string {
  const dir = path.join(root, '.brainclaw', LEGACY);
  fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(dir, `${sessionId}.json`);
  fs.writeFileSync(filepath, JSON.stringify({ schema_version: 1, ...record(sessionId, lastSeen) }), 'utf-8');
  return filepath;
}

const canonicalPath = (id: string) => path.join(root, '.brainclaw', CANONICAL, `${id}.json`);
const legacyPath = (id: string) => path.join(root, '.brainclaw', LEGACY, `${id}.json`);

beforeEach(() => {
  isolation = isolateAgentEnv();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-layout-'));
  const config = defaultConfig('layout');
  config.project_id = 'prj_layout';
  saveConfig(config, root);
  process.env.BRAINCLAW_STORE_BOUNDARY = root;
  process.env.BRAINCLAW_AGENT_NAME = AGENT;
  registerAgentIdentity({ agentName: AGENT, kind: 'agent', cwd: root });
});

afterEach(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  isolation?.restore();
  isolation = undefined;
});

describe('sessions — l’écriture vise la disposition CANONIQUE', () => {
  it('écrit dans coordination/sessions et non dans sessions/', () => {
    saveCurrentSession(record('sess_a'), root);
    assert.ok(fs.existsSync(canonicalPath('sess_a')), 'record absent de la disposition canonique');
    assert.ok(!fs.existsSync(legacyPath('sess_a')), 'record écrit dans la disposition legacy');
  });

  it('CONVERGE : une copie legacy du même id est supprimée à la sauvegarde', () => {
    // La laisser signifierait deux vérités pour un seul id, dont la plus ancienne peut
    // encore être lue par un chemin qu'on aurait oublié de migrer.
    writeLegacy('sess_b');
    assert.ok(fs.existsSync(legacyPath('sess_b')));

    saveCurrentSession(record('sess_b'), root);

    assert.ok(fs.existsSync(canonicalPath('sess_b')));
    assert.ok(!fs.existsSync(legacyPath('sess_b')), 'la copie legacy survit à la convergence');
  });
});

describe('sessions — la LECTURE couvre les deux dispositions', () => {
  it('charge par id un record écrit AVANT la migration', () => {
    // C'est le cœur du défaut : un record invisible à son propre chargeur.
    writeLegacy('sess_legacy');
    const loaded = loadSessionById('sess_legacy', root);
    assert.ok(loaded, 'un record legacy est invisible à loadSessionById');
    assert.equal(loaded.session_id, 'sess_legacy');
  });

  it('loadAllSessions voit les deux côtés', () => {
    writeLegacy('sess_old');
    saveCurrentSession(record('sess_new'), root);
    const ids = loadAllSessions(root).map((s) => s.session_id).sort();
    assert.deepEqual(ids, ['sess_new', 'sess_old']);
  });

  it('loadAllSessions NE COMPTE PAS deux fois un id présent des deux côtés', () => {
    // Un doublon ferait apparaître des agents fantômes dans `brainclaw who`.
    writeLegacy('sess_dup');
    fs.mkdirSync(path.join(root, '.brainclaw', CANONICAL), { recursive: true });
    fs.writeFileSync(canonicalPath('sess_dup'), JSON.stringify({ schema_version: 1, ...record('sess_dup') }), 'utf-8');

    const found = loadAllSessions(root).filter((s) => s.session_id === 'sess_dup');
    assert.equal(found.length, 1, `id compté ${found.length} fois`);
  });
});

describe('sessions — effacement et GC couvrent les deux dispositions', () => {
  it('clearCurrentSession efface la copie legacy AUSSI', () => {
    // N'en nettoyer qu'une laisserait une session « fermée » encore chargeable.
    writeLegacy('sess_c');
    saveCurrentSession(record('sess_c'), root);
    // La convergence a déjà retiré la legacy ; on la recrée pour tester l'effacement seul.
    writeLegacy('sess_c');

    clearCurrentSession(root, 'sess_c');

    assert.ok(!fs.existsSync(canonicalPath('sess_c')));
    assert.ok(!fs.existsSync(legacyPath('sess_c')), 'la copie legacy survit à l’effacement');
  });

  it('le GC balaie la disposition legacy — sinon elle s’accumule indéfiniment', () => {
    // Personne ne les lit plus, et personne ne les effaçait non plus.
    const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    writeLegacy('sess_stale', old);
    const removed = gcStaleSessions(root, '1h');
    assert.ok(removed >= 1, 'le GC n’a rien retiré de la disposition legacy');
    assert.ok(!fs.existsSync(legacyPath('sess_stale')));
  });

  it('le GC épargne un record VIVANT des deux côtés', () => {
    writeLegacy('sess_alive');
    saveCurrentSession(record('sess_alive2'), root);
    gcStaleSessions(root, '4h');
    assert.ok(fs.existsSync(legacyPath('sess_alive')));
    assert.ok(fs.existsSync(canonicalPath('sess_alive2')));
  });
});
