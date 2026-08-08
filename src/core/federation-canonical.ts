/**
 * Sérialisation canonique — fédération v2 (pln#651 étape 5, RFC §3.1).
 *
 * ── POURQUOI « CANONIQUE » ET PAS SIMPLEMENT `JSON.stringify` ─────────────────
 * Ces octets sont hachés, chiffrés et signés par UN programme, puis vérifiés par UN
 * AUTRE. Une différence d'un seul octet — un espace, un ordre de clés, un `1e3` au lieu
 * de `1000` — fait échouer la vérification sans qu'aucun message ne dise laquelle des
 * deux implémentations a tort.
 *
 * `JSON.stringify` sur un OBJET n'est déterministe que si l'ordre d'insertion l'est. Il
 * ne l'est pas quand l'objet vient d'un `JSON.parse`, d'un spread ou d'un tri différent.
 * D'où un sérialiseur explicite qui trie par point de code, comme l'exige le RFC.
 *
 * Le RFC dit aussi : « Core et Cloud partagent les vecteurs de test ; ils ne
 * réimplémentent pas chacun une quasi-canonicalisation. » Les vecteurs vivent dans les
 * tests des deux dépôts, sur les mêmes chaînes littérales.
 */

import crypto from 'node:crypto';

/**
 * Trie par POINT DE CODE et non par `localeCompare`.
 *
 * `Array.prototype.sort()` sans comparateur trie déjà par unité de code UTF-16, ce qui
 * diffère du point de code pour les caractères hors du plan multilingue de base. Un
 * emoji dans un nom de clé suffirait à faire diverger deux implémentations qui croient
 * toutes deux « trier les clés ». On compare donc explicitement les points de code.
 */
function compareCodePoints(a: string, b: string): number {
  const ai = Array.from(a);
  const bi = Array.from(b);
  const n = Math.min(ai.length, bi.length);
  for (let i = 0; i < n; i++) {
    const ca = ai[i].codePointAt(0)!;
    const cb = bi[i].codePointAt(0)!;
    if (ca !== cb) return ca - cb;
  }
  return ai.length - bi.length;
}

/**
 * JSON canonique : clés triées, aucune espace, chaînes NFC, entiers finis sans notation
 * exponentielle.
 *
 * REFUSE plutôt que d'inventer une représentation pour ce que JSON ne porte pas
 * fidèlement : `undefined`, `NaN`, `Infinity`, fonctions, symboles, `BigInt`. Les
 * sérialiser en `null` — ce que fait `JSON.stringify` pour certains — produirait deux
 * objets différents avec les mêmes octets, donc une signature valide pour un contenu
 * qu'on n'a pas signé.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(`Canonicalisation impossible : nombre non fini (${String(value)}).`);
      }
      // `String(1e21)` rend "1e+21". Le RFC interdit la notation exponentielle, et un
      // vérificateur qui lirait "1e+21" produirait d'autres octets que celui qui écrit
      // "1000000000000000000000". Refuser est plus sûr qu'une conversion approximative.
      if (Number.isInteger(value) && Math.abs(value) >= 1e21) {
        throw new Error(`Canonicalisation impossible : entier hors de la plage sérialisable sans exposant (${value}).`);
      }
      return JSON.stringify(value);
    case 'string':
      // NFC : « é » composé et « e + accent » combinés sont visuellement identiques et
      // produisent des octets différents. Sans normalisation, un titre saisi sur macOS
      // (NFD par défaut) et le même titre saisi sur Windows ne se vérifieraient pas.
      return JSON.stringify(value.normalize('NFC'));
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort(compareCodePoints);
      return `{${keys.map((k) => `${JSON.stringify(k.normalize('NFC'))}:${canonicalJson(obj[k])}`).join(',')}}`;
    }
    default:
      throw new Error(`Canonicalisation impossible : type '${typeof value}' non sérialisable en JSON.`);
  }
}

/** base64url sans padding — la seule forme admise par le RFC pour les champs binaires. */
export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  return new Uint8Array(Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64'));
}

/** SHA-256 des octets canoniques d'une valeur, rendu en base64url (RFC §3.2). */
export function canonicalSha256(value: unknown): string {
  return b64url(new Uint8Array(crypto.createHash('sha256').update(canonicalJson(value), 'utf-8').digest()));
}
