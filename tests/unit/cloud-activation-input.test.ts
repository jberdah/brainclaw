/**
 * URL d'activation, validation d'identifiant d'agent, normalisation d'URL cloud (pln#655).
 *
 * Ces fonctions sont PURES (aucun réseau) — le plan les exigeait testées, et le worker qui
 * a livré le code n'a pas pu lancer node --test (sandbox EPERM). Le coordinateur complète.
 *
 * ── L'INVARIANT QUI COMPTE (dec#161) ─────────────────────────────────────────
 * L'URL n'ouvre que le droit de CANDIDATER. Le code voyage en FRAGMENT (`/a#<code>`) —
 * jamais dans un chemin ni une query, parce qu'un fragment n'atteint pas les journaux du
 * serveur ni les proxys. Et `parseActivationInput` ne rend au transport que `url`, une
 * origine SANS fragment : le code ne peut pas fuir vers une requête HTTP.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseActivationInput,
  validateAgentId,
  normalizeCloudUrl,
} from '../../src/commands/cloud.js';

describe('parseActivationInput — code nu', () => {
  it('accepte un code d\'invitation brut', () => {
    const r = parseActivationInput('WFEIWeSM27kc8DJB');
    assert.equal(r.inviteCode, 'WFEIWeSM27kc8DJB');
    assert.equal(r.url, undefined, 'un code nu ne porte pas d\'origine');
  });

  it('trime les espaces autour du code', () => {
    assert.equal(parseActivationInput('  ABC123  ').inviteCode, 'ABC123');
  });

  it('refuse une entrée vide', () => {
    assert.throws(() => parseActivationInput('   '), /attendu/i);
  });
});

describe('parseActivationInput — URL d\'activation', () => {
  it('extrait le code du FRAGMENT et l\'origine du reste', () => {
    const r = parseActivationInput('https://app.brainclaw.dev/a#WFEIWeSM27kc8DJB');
    assert.equal(r.inviteCode, 'WFEIWeSM27kc8DJB');
    assert.equal(r.url, 'https://app.brainclaw.dev', 'l\'origine, sans fragment ni chemin');
  });

  it('l\'origine rendue NE CONTIENT JAMAIS le code — il ne peut pas fuir au transport', () => {
    const r = parseActivationInput('https://app.brainclaw.dev/a#SECRET_CODE');
    assert.ok(!(r.url ?? '').includes('SECRET_CODE'), 'le code a fui dans l\'origine transmise au réseau');
    assert.ok(!(r.url ?? '').includes('#'), 'un fragment est parti vers le transport');
  });

  it('REFUSE un code passé en query string (fuite dans les logs serveur)', () => {
    assert.throws(() => parseActivationInput('https://app.brainclaw.dev/a?code=SECRET'), /invalide/i);
  });

  it('REFUSE un code passé dans le chemin d\'une route API', () => {
    // Empêche de prendre un « code » depuis n'importe quelle URL du produit.
    assert.throws(() => parseActivationInput('https://app.brainclaw.dev/api/v1/enrollments#x'), /invalide/i);
  });

  it('refuse une URL sans fragment', () => {
    assert.throws(() => parseActivationInput('https://app.brainclaw.dev/a'), /invalide/i);
  });

  it('refuse des identifiants dans l\'URL (userinfo)', () => {
    assert.throws(() => parseActivationInput('https://user:pass@app.brainclaw.dev/a#x'), /invalide/i);
  });

  it('décode un fragment pourcent-encodé', () => {
    assert.equal(parseActivationInput('https://h.dev/a#a%2Bb').inviteCode, 'a+b');
  });
});

describe('validateAgentId — AVANT tout réseau', () => {
  it('accepte les identifiants opaques conformes', () => {
    for (const id of ['claude-code-pc', 'agt_1', 'A-b_9', 'x'.repeat(64)]) {
      assert.equal(validateAgentId(id), id, `${id} devrait passer`);
    }
  });

  it('REFUSE le format hérité agent@hôte — c\'est la donnée locale que dec#154 exclut', () => {
    // C'est l'erreur réelle rencontrée le 2026-08-09 : `claude-code@pc-thom` refusé APRÈS
    // consommation partielle de l'invitation. La validation doit précéder tout réseau.
    assert.throws(() => validateAgentId('claude-code@pc-thom'), /invalide/i);
  });

  it('refuse trop court, trop long, ou caractères interdits', () => {
    assert.throws(() => validateAgentId('abc'), /invalide/i);
    assert.throws(() => validateAgentId('x'.repeat(65)), /invalide/i);
    assert.throws(() => validateAgentId('a b'), /invalide/i);
  });
});

describe('normalizeCloudUrl — le fragment ne passe jamais', () => {
  it('accepte une origine propre', () => {
    assert.equal(normalizeCloudUrl('https://app.brainclaw.dev'), 'https://app.brainclaw.dev');
  });

  it('REFUSE toute URL portant un fragment — plutôt que de le nettoyer en silence', () => {
    // Choix de sécurité : refuser est plus sûr que retirer. Une adresse cloud ne DOIT pas
    // porter de fragment ; en présenter un signale une confusion avec l'URL d'activation,
    // et on préfère l'erreur franche au nettoyage muet qui masquerait la méprise.
    assert.throws(() => normalizeCloudUrl('https://app.brainclaw.dev/a#x'), /invalide/i);
  });

  it('refuse query et userinfo', () => {
    assert.throws(() => normalizeCloudUrl('https://app.brainclaw.dev?x=1'), /invalide/i);
    assert.throws(() => normalizeCloudUrl('https://u:p@app.brainclaw.dev'), /invalide/i);
  });

  it('refuse une URL non parsable', () => {
    assert.throws(() => normalizeCloudUrl('pas une url'), /invalide/i);
  });
});
