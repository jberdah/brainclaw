#!/usr/bin/env node
/**
 * build-mcp-schemas.mjs — generate JSON Schemas from zod sources for use in
 * the brainclaw MCP tool catalog (src/commands/mcp.ts).
 *
 * Why: hand-written MCP inputSchemas drift from their underlying zod schemas.
 * This produced the trp#180 bug (bclaw_loop arrays missing `items`). Single
 * source of truth = zod; this script materializes the JSON Schema view.
 *
 * Pattern (committed-and-checked, not chained to every build):
 * - This script writes `src/commands/mcp-schemas.generated.ts`.
 * - The file is committed for PR visibility.
 * - Run `npm run build:mcp-schemas` after changing any of the source zod schemas.
 * - The parity test in `tests/unit/mcp-zod-parity.test.ts` fails CI if the
 *   committed file diverges from a fresh regen.
 *
 * Same spirit as pln#492 step 7's compile-time invariant on DEFAULT_PROTOCOLS:
 * make drift a CI-time error rather than a runtime surprise.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(rootDir, 'src', 'commands', 'mcp-schemas.generated.ts');

// Imports come from compiled dist/ — run `tsc` first. Use pathToFileURL so
// absolute Windows paths (c:\\…) resolve under the ESM loader.
const { LoopPhaseSchema } = await import(
  pathToFileURL(path.join(rootDir, 'dist', 'core', 'loops', 'types.js')).href
);
const { LoopSlotInputSchema } = await import(
  pathToFileURL(path.join(rootDir, 'dist', 'core', 'loops', 'facade-schema.js')).href
);

// pln#599 batch 1 — famille CAPTURE. Migree en entier plutot qu'outil par outil : une
// source unique de verite n'en est une que sur un ensemble coherent, et laisser une
// famille a cheval sur deux mecanismes double la maintenance sans donner le benefice.
const { WriteNoteRequestSchema, QuickCaptureRequestSchema } = await import(
  pathToFileURL(path.join(rootDir, 'dist', 'core', 'capture-schema.js')).href
);

// pln#599 batch 2 — famille SEQUENCE, premiere composite. Les deux outils partagent
// l'item de lane : le deriver d'une source zod UNIQUE supprime la classe de defaut de
// trp#180 (un sous-schema duplique, corrige d'un cote seulement).
const { CreateSequenceRequestSchema, UpdateSequenceRequestSchema } = await import(
  pathToFileURL(path.join(rootDir, 'dist', 'core', 'sequence-request-schema.js')).href
);

// pln#599 batch 2 — famille CLAIM. Les deux outils ne partagent pas de sous-objet, mais
// bien l'identite de l'appelant ; la deriver d'une source commune evite la derive lente
// entre deux copies d'un meme bloc agent/agentId.
const { ClaimRequestSchema, ReleaseClaimRequestSchema } = await import(
  pathToFileURL(path.join(rootDir, 'dist', 'core', 'claim-request-schema.js')).href
);

// pln#599 batch 2 — famille SESSION. Particularite : AUCUN champ requis des deux cotes.
// zod n'emet `required` que s'il existe un champ non-optionnel, donc tout marquer
// .optional() reproduit exactement l'absence de la cle. Oublier un .optional() creerait un
// requis la ou il n'y en avait aucun — un DURCISSEMENT qui casserait l'appel sans argument.
const { SessionStartRequestSchema, SessionEndRequestSchema } = await import(
  pathToFileURL(path.join(rootDir, 'dist', 'core', 'session-request-schema.js')).href
);

// pln#599 batch 2 — famille STEP. C'est elle qui a montre que la profondeur de retrait
// d'additionalProperties devait etre decidee PAR SCHEMA : son sous-objet `data` n'en
// portait pas a la main, la ou l'item de lane de SEQUENCE en portait un.
const {
  AddStepRequestSchema, UpdateStepRequestSchema,
  CompleteStepRequestSchema, DeleteStepRequestSchema,
} = await import(
  pathToFileURL(path.join(rootDir, 'dist', 'core', 'step-request-schema.js')).href
);

// pln#599 batch 2 — famille ASSIGNMENT, la plus profonde migree. Deux objets imbriques
// portent LEURS PROPRES `required` (item d'artefact, action_required) : ils doivent
// survivre. Et deux champs sont des objets NUS (payload, response_schema) — les decrire
// avec z.object({}) produirait un objet qui n'accepte plus rien.
const {
  AssignmentUpdateRequestSchema, AssignmentActionRequestSchema, AssignmentEventsRequestSchema,
} = await import(
  pathToFileURL(path.join(rootDir, 'dist', 'core', 'assignment-request-schema.js')).href
);

const SCHEMAS = {
  LoopPhase: LoopPhaseSchema,
  LoopSlotInput: LoopSlotInputSchema,
  WriteNoteRequest: WriteNoteRequestSchema,
  QuickCaptureRequest: QuickCaptureRequestSchema,
  CreateSequenceRequest: CreateSequenceRequestSchema,
  UpdateSequenceRequest: UpdateSequenceRequestSchema,
  ClaimRequest: ClaimRequestSchema,
  ReleaseClaimRequest: ReleaseClaimRequestSchema,
  SessionStartRequest: SessionStartRequestSchema,
  SessionEndRequest: SessionEndRequestSchema,
  AddStepRequest: AddStepRequestSchema,
  UpdateStepRequest: UpdateStepRequestSchema,
  CompleteStepRequest: CompleteStepRequestSchema,
  DeleteStepRequest: DeleteStepRequestSchema,
  AssignmentUpdateRequest: AssignmentUpdateRequestSchema,
  AssignmentActionRequest: AssignmentActionRequestSchema,
  AssignmentEventsRequest: AssignmentEventsRequestSchema,
};

/**
 * Retire `additionalProperties: false` que zod ajoute d'office.
 *
 * Les inputSchema ecrits a la main ne le portaient pas : un client passant une cle
 * inconnue etait ACCEPTE, la cle simplement ignoree. Le laisser DURCIT le contrat — un
 * appelant qui ajoute un champ par anticipation, ou un hote MCP qui joint un champ de
 * transport, se ferait rejeter. C'est un changement de surface publique, pas un effet de
 * bord de migration.
 *
 * Detecte par la garde de gouvernance (tests/unit/mcp-governance.test.ts), qui a eu
 * raison contre l'affirmation que la migration etait transparente.
 */
function stripAdditionalPropertiesFalse(node, deep = false) {
  // PROFONDEUR DECIDEE PAR SCHEMA, pas par regle globale — cf. OPEN_SCHEMAS.
  //
  // La premiere version disait « racine uniquement », au motif que le sous-schema d'item
  // de lane (famille SEQUENCE) portait deja additionalProperties dans sa version manuelle :
  // le lui retirer aurait ete un ASSOUPLISSEMENT.
  //
  // C'etait vrai LA, et faux comme regle. Le sous-objet `data` de bclaw_add_step n'en
  // porte PAS dans sa version manuelle : « racine uniquement » y laisserait donc celui
  // emis par zod, soit exactement le DURCISSEMENT que la regle devait empecher.
  //
  // La consigne reelle n'a jamais ete « racine » mais « reproduire le manuel au bit pres ».
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  if (node.additionalProperties === false) delete node.additionalProperties;
  if (!deep) return;
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) child.forEach((c) => stripAdditionalPropertiesFalse(c, true));
    else if (child && typeof child === 'object') stripAdditionalPropertiesFalse(child, true);
  }
}

function toJsonSchema(zodSchema) {
  const generated = z.toJSONSchema(zodSchema);
  // Strip the $schema declaration: we embed these as sub-schemas inside
  // larger inputSchemas, where $schema would be redundant or harmful.
  if (generated && typeof generated === 'object' && '$schema' in generated) {
    delete generated.$schema;
  }
  return generated;
}

// Retrait CIBLE : LoopPhase et LoopSlotInput portaient deja additionalProperties et font
// partie de la surface etablie. Le leur retirer changerait le contrat de bclaw_loop.
// 'root' = ne retirer additionalProperties qu'a la racine ; 'deep' = l'y retirer aussi
// dans les sous-objets. Le choix se lit sur la version MANUELLE de chaque schema, pas sur
// une preference : reproduire ce qui etait publie.
//   - CreateSequence/UpdateSequence : 'root'. Leur item de lane le portait DEJA a la main.
//   - AddStep : 'deep'. Son sous-objet `data` ne le portait PAS.
const OPEN_SCHEMAS = new Map([
  ['WriteNoteRequest', 'root'], ['QuickCaptureRequest', 'root'],
  ['CreateSequenceRequest', 'root'], ['UpdateSequenceRequest', 'root'],
  ['ClaimRequest', 'root'], ['ReleaseClaimRequest', 'root'],
  ['SessionStartRequest', 'root'], ['SessionEndRequest', 'root'],
  ['AddStepRequest', 'deep'],
  ['UpdateStepRequest', 'root'], ['CompleteStepRequest', 'root'], ['DeleteStepRequest', 'root'],
  // 'deep' : l'item d'artefact et action_required ne portaient pas additionalProperties.
  ['AssignmentUpdateRequest', 'deep'],
  ['AssignmentActionRequest', 'deep'], ['AssignmentEventsRequest', 'root'],
]);

const generated = Object.fromEntries(
  Object.entries(SCHEMAS).map(([name, schema]) => {
    const json = toJsonSchema(schema);
    const mode = OPEN_SCHEMAS.get(name);
    if (mode) stripAdditionalPropertiesFalse(json, mode === 'deep');
    return [name, json];
  }),
);

const banner = `// AUTO-GENERATED by scripts/build-mcp-schemas.mjs — DO NOT EDIT BY HAND.
// Source zod schemas: src/core/loops/types.ts, src/core/loops/facade-schema.ts,
// src/core/capture-schema.ts, src/core/sequence-request-schema.ts,
// src/core/claim-request-schema.ts, src/core/session-request-schema.ts,
// src/core/step-request-schema.ts, src/core/assignment-request-schema.ts
// Regenerate: npm run build:mcp-schemas
//
// This file materializes the zod-derived JSON Schema view consumed by the
// MCP tool catalog (src/commands/mcp.ts). Drift between the committed
// version of this file and a fresh regen is caught at CI time by
// tests/unit/mcp-zod-parity.test.ts (pln#494 phase 2).
`;

const body = `\nexport const generatedSchemas = ${JSON.stringify(generated, null, 2)} as const;\n`;

const content = banner + body;

const previous = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf-8') : null;
fs.writeFileSync(outFile, content, 'utf-8');

if (previous === content) {
  console.log(`[build-mcp-schemas] ${path.relative(rootDir, outFile)} unchanged`);
} else {
  const verb = previous === null ? 'created' : 'updated';
  console.log(`[build-mcp-schemas] ${verb} ${path.relative(rootDir, outFile)}`);
  for (const name of Object.keys(generated)) {
    console.log(`  • ${name}`);
  }
}
