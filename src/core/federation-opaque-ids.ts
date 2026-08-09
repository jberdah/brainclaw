/**
 * Correspondance id LOCAL ↔ id OPAQUE — et elle ne quitte jamais la machine (RFC §7).
 *
 * ── POURQUOI UNE TABLE PLUTÔT QU'UN HACHAGE ──────────────────────────────────
 * Un id opaque doit être STABLE : sans stabilité, chaque émission créerait un nouvel objet
 * côté cloud et le board afficherait un doublon par mise à jour. La tentation est donc de
 * dériver l'opaque du local par un hachage — c'est reproductible et sans état.
 *
 * Mais un hachage NON CLEFÉ est réversible par devinette : le cloud connaît la forme des
 * ids locaux (`pln_`, `dec_`, `trp_` + hexadécimal court), il lui suffit d'énumérer pour
 * confirmer qu'un opaque correspond à `pln_5047fdb1`. Il apprendrait alors le compteur
 * local, l'ordre de création, et le lien entre deux projets partageant un objet.
 *
 * Une table locale n'a pas ce défaut : l'opaque est un UUID v4 sans relation calculable
 * avec le local. Le prix est un état à conserver — assumé, parce que le RFC pose déjà que
 * la correspondance reste locale, et parce que la PERDRE n'est pas une catastrophe : on
 * réémet sous de nouveaux opaques, ce qui duplique l'affichage sans rien divulguer.
 *
 * ── CE FICHIER NE SORT JAMAIS ────────────────────────────────────────────────
 * Il contient exactement ce que la projection existe pour cacher : la liaison entre un
 * objet du cloud et son identité locale. Il vit sous `.brainclaw/coordination/federation/`
 * et n'est référencé par aucune enveloppe.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { memoryDir, writeFileAtomic } from './io.js';
import { logger } from './logger.js';

const MAP_FILE = 'opaque-ids.json';
export const OPAQUE_MAP_SCHEMA = 'brainclaw.federation-opaque-map/v1';

interface OpaqueMap {
  schema: typeof OPAQUE_MAP_SCHEMA;
  /** Clé : `<cloud_project_id>/<id local>`. Valeur : UUID opaque. */
  entries: Record<string, string>;
}

function mapPath(cwd: string): string {
  return path.join(memoryDir(cwd), 'coordination', 'federation', MAP_FILE);
}

function loadMap(cwd: string): OpaqueMap {
  const file = mapPath(cwd);
  if (!fs.existsSync(file)) return { schema: OPAQUE_MAP_SCHEMA, entries: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<OpaqueMap>;
    if (parsed.schema !== OPAQUE_MAP_SCHEMA || typeof parsed.entries !== 'object' || !parsed.entries) {
      // FAIL-CLOSED sur un fichier d'une autre forme : repartir d'une table vide
      // RÉÉMETTRA sous de nouveaux opaques (doublons visibles), ce qui est bruyant mais
      // sûr. Réutiliser une table mal comprise pourrait au contraire rattacher un objet à
      // l'identité d'un autre.
      logger.warn(`Table d'ids opaques d'une forme inconnue — ignorée : ${file}`);
      return { schema: OPAQUE_MAP_SCHEMA, entries: {} };
    }
    return { schema: OPAQUE_MAP_SCHEMA, entries: parsed.entries as Record<string, string> };
  } catch (err) {
    logger.warn(`Table d'ids opaques illisible (${err instanceof Error ? err.message : String(err)}) — ignorée.`);
    return { schema: OPAQUE_MAP_SCHEMA, entries: {} };
  }
}

/**
 * Renvoie l'id opaque STABLE d'un objet local, en le créant à la première demande.
 *
 * La clé inclut le projet cloud : le même objet local projeté vers deux projets cloud
 * distincts reçoit deux opaques différents. Sans cela, deux clouds pourraient recouper
 * leurs tables et découvrir qu'ils regardent le même objet.
 */
export function opaqueIdFor(
  cloudProjectId: string,
  localId: string,
  cwd: string = process.cwd(),
): string {
  const map = loadMap(cwd);
  const key = `${cloudProjectId}/${localId}`;
  const existing = map.entries[key];
  if (existing) return existing;

  const fresh = crypto.randomUUID();
  map.entries[key] = fresh;
  const file = mapPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(map, null, 2)}\n`);
  return fresh;
}

/** Résout l'identifiant local correspondant à un opaque reçu du cloud. */
export function localIdForOpaque(
  cloudProjectId: string,
  opaqueId: string,
  cwd: string = process.cwd(),
): string | undefined {
  const prefix = `${cloudProjectId}/`;
  for (const [key, value] of Object.entries(loadMap(cwd).entries)) {
    if (key.startsWith(prefix) && value === opaqueId) return key.slice(prefix.length);
  }
  return undefined;
}

/**
 * Enregistre le sens inverse du mapping après la création canonique de l'objet local.
 * Refuse une incohérence au lieu de rattacher un opaque au mauvais objet.
 */
export function rememberOpaqueId(
  cloudProjectId: string,
  localId: string,
  opaqueId: string,
  cwd: string = process.cwd(),
): void {
  const map = loadMap(cwd);
  const key = `${cloudProjectId}/${localId}`;
  const current = map.entries[key];
  if (current && current !== opaqueId) {
    throw new Error(`Correspondance opaque incohérente pour ${localId}.`);
  }
  const prefix = `${cloudProjectId}/`;
  const inverse = Object.entries(map.entries).find(([entryKey, value]) =>
    entryKey.startsWith(prefix) && value === opaqueId && entryKey !== key,
  );
  if (inverse) throw new Error(`Opaque ${opaqueId} déjà rattaché à ${inverse[0].slice(prefix.length)}.`);
  if (current === opaqueId) return;
  map.entries[key] = opaqueId;
  const file = mapPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(map, null, 2)}\n`);
}
/** Nombre de correspondances connues — utile au diagnostic, jamais projeté. */
export function opaqueMapSize(cloudProjectId: string, cwd: string = process.cwd()): number {
  const prefix = `${cloudProjectId}/`;
  return Object.keys(loadMap(cwd).entries).filter((k) => k.startsWith(prefix)).length;
}
