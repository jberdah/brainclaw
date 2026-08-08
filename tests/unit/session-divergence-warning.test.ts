/**
 * pln#648 SUITE (d) — garde anti-divergence.
 *
 * CE QUE CE FICHIER PROTÈGE, et en quoi c'est différent de la convergence des lecteurs
 * livrée en 1.21.0. Cette convergence supprime le cas REPRODUIT : `switch` et le routage
 * passent par le même résolveur et rendent le même `active_source`. Mais la propriété
 * dangereuse subsistait — un record de session trouvable peut désigner un projet que le
 * résolveur n'a PAS retenu, et rien ne le disait.
 *
 * Le défaut d'origine n'était pas qu'un lecteur se trompait : c'est que deux lecteurs
 * pouvaient diverger EN SILENCE. `switch` affichait « api » pendant que l'écriture partait
 * dans « web », et ça a tenu des semaines. Ce test verrouille la TRACE, pas la résolution.
 *
 * HARNAIS : identité EXPLICITE, jamais l'ambiante. `isolateAgentEnv` retire les variables
 * de détection d'agent — c'est son but — et un record de session est apparié par NOM
 * D'AGENT autant que par pid. Sans enregistrement explicite, un échec d'identité se
 * déguiserait en échec de routage, exactement la confusion qui a coûté trois rondes de CI
 * sur pln#649.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { defaultConfig, saveConfig } from '../../src/core/config.js';
import { isolateAgentEnv } from '../helpers/workspace.js';
import { registerAgentIdentity } from '../../src/core/agent-registry.js';
import { saveCurrentSession } from '../../src/core/identity.js';
import { resolveEffectiveCwdInfo } from '../../src/core/store-resolution.js';

const AGENT = 'divergence-bench';

let isolation: { restore: () => void } | undefined;
let bench: { root: string; api: string; web: string };

function makeStore(dir: string, name: string, projectId: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const config = defaultConfig(name);
  config.project_id = projectId;
  saveConfig(config, dir);
  return path.resolve(dir);
}

beforeEach(() => {
  isolation = isolateAgentEnv();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bclaw-divergence-'));
  bench = {
    root: makeStore(root, 'workspace', 'prj_ws'),
    api: makeStore(path.join(root, 'apps', 'api'), 'api', 'prj_api'),
    web: makeStore(path.join(root, 'apps', 'web'), 'web', 'prj_web'),
  };
  process.env.BRAINCLAW_STORE_BOUNDARY = bench.root;
  process.env.BRAINCLAW_AGENT_NAME = AGENT;
  for (const store of [bench.root, bench.api, bench.web]) {
    registerAgentIdentity({ agentName: AGENT, kind: 'agent', cwd: store });
  }
});

afterEach(() => {
  try { fs.rmSync(bench.root, { recursive: true, force: true }); } catch { /* best effort */ }
  isolation?.restore();
  isolation = undefined;
});

/** Écrit un record de session valide (agent + pid appariables) sous `store`. */
function session(store: string, target: { path: string; name: string }, pid = process.pid): void {
  saveCurrentSession({
    session_id: 'sess_divergence',
    started_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    agent: AGENT,
    agent_id: 'agt_divergence',
    host_id: 'host-test',
    pid,
    active_project: { path: target.path, name: target.name, switched_at: new Date().toISOString() },
  }, store);
}

describe('divergence de session — la trace', () => {
  it('signale une session désignant un projet DISPARU, sans changer la résolution', () => {
    // Cas réel : le projet a été supprimé ou renommé sous les pieds de la session. Le
    // résolveur refuse de la suivre — c'est correct — mais le taire laisserait
    // l'opérateur croire sa session saine.
    session(bench.root, { path: path.join(bench.root, 'apps', 'disparu'), name: 'disparu' });

    const resolved = resolveEffectiveCwdInfo({ baseCwd: bench.root });

    assert.notEqual(resolved.active_source, 'session');
    assert.ok(resolved.session_divergence, 'aucune trace alors que la session désignait un projet introuvable');
    assert.equal(resolved.session_divergence.session_project_name, 'disparu');
    assert.equal(resolved.session_divergence.resolved_via, resolved.active_source);
  });

  it('NE signale RIEN quand la session est celle qui a gagné', () => {
    // Sinon chaque résolution normale porterait un avertissement — et un avertissement
    // permanent n'est plus lu.
    session(bench.root, { path: bench.api, name: 'api' });
    const resolved = resolveEffectiveCwdInfo({ baseCwd: bench.root });
    assert.equal(resolved.active_source, 'session');
    assert.equal(resolved.session_divergence, undefined);
  });

  it('NE signale RIEN quand la session désigne la MÊME destination que la résolution', () => {
    // Ce qui compte est la DESTINATION, pas le sélecteur : deux chemins menant au même
    // projet ne sont pas une divergence.
    session(bench.api, { path: bench.api, name: 'api' });
    const resolved = resolveEffectiveCwdInfo({ baseCwd: bench.api });
    assert.equal(path.resolve(resolved.cwd), bench.api);
    assert.equal(resolved.session_divergence, undefined);
  });

  it('NE signale RIEN quand aucune session n’existe', () => {
    const resolved = resolveEffectiveCwdInfo({ baseCwd: bench.web });
    assert.equal(resolved.session_divergence, undefined);
  });

  it('la trace est OBSERVATIONNELLE : la destination est identique avec et sans session', () => {
    // Re-trancher ici réintroduirait exactement l'ambiguïté que la convergence ferme.
    const withoutSession = resolveEffectiveCwdInfo({ baseCwd: bench.root });
    session(bench.root, { path: path.join(bench.root, 'apps', 'disparu'), name: 'disparu' });
    const withSession = resolveEffectiveCwdInfo({ baseCwd: bench.root });

    assert.equal(withSession.cwd, withoutSession.cwd, 'la présence d’une session a changé la destination');
    assert.equal(withSession.active_source, withoutSession.active_source);
    assert.ok(withSession.session_divergence);
    assert.equal(withoutSession.session_divergence, undefined);
  });

  it('LIMITE CONNUE : une session d’un AUTRE processus n’est PAS tracée', () => {
    // Ce test fige une limite plutôt qu'une garantie, et c'est délibéré.
    //
    // `loadCurrentSession` filtre lui-même sur le pid : un record appartenant à un autre
    // processus n'est jamais RENDU au résolveur, donc l'observation — qui vit dans la
    // sonde, après le chargement — ne peut pas le voir. Le détecter exigerait une lecture
    // disque supplémentaire dans le chemin chaud de CHAQUE résolution, pour un cas où
    // deux agents distincts travaillent dans le même workspace sur des projets
    // différents : un usage normal, pas un incident.
    //
    // Le prétendre couvert serait pire que la limite. Si ce test se met à ÉCHOUER, c'est
    // que quelqu'un a étendu la détection — auquel cas il faut mesurer le coût en I/O
    // avant de s'en réjouir.
    session(bench.root, { path: path.join(bench.root, 'apps', 'fantome'), name: 'fantome' }, process.pid + 100000);
    const resolved = resolveEffectiveCwdInfo({ baseCwd: bench.root });
    assert.equal(
      resolved.session_divergence,
      undefined,
      'la détection a été étendue aux sessions étrangères — vérifier le coût en lectures disque',
    );
  });
});
