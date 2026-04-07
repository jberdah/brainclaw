/**
 * CoDev v3 prompt builder functions for iterative group discussion model.
 * Prompts are intentionally short — agents should spend time thinking, not reading.
 * @module
 */

export interface CodevPersonaDef {
  name: string;
  focus: string;
}

export interface PositionEntry {
  persona: string;
  text: string;
}

export interface RoundEntry {
  persona: string;
  text: string;
  round: number;
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/**
 * Round 0 — Each agent states their initial position on the topic.
 */
export function buildPositionPrompt(
  persona: CodevPersonaDef,
  exposition: string,
  targetDurationSeconds: number,
  responseFilePath: string,
): string {
  return `[CoDev Round 0 — Position initiale]
Tu es ${persona.name}: ${persona.focus}

## Sujet
${truncate(exposition, 800)}

## Consigne
Donne ta position en 3-5 phrases maximum. Sois direct et concret.
Durée cible: ${targetDurationSeconds}s.

## Format de réponse
Écris ta réponse dans le fichier: ${responseFilePath}
Format: JSON avec { "persona": "${persona.name}", "text": "<ta réponse>" }`;
}

/**
 * Rounds 1-N — Each agent reacts to the previous round's positions.
 */
export function buildReactionPrompt(
  persona: CodevPersonaDef,
  previousPositions: PositionEntry[],
  roundNumber: number,
  targetDurationSeconds: number,
  responseFilePath: string,
): string {
  const positionLines = previousPositions
    .filter((p) => p.persona !== persona.name)
    .map((p) => `**${p.persona}**: ${truncate(p.text, 200)}`)
    .join('\n');

  return `[CoDev Round ${roundNumber} — Réaction]
Tu es ${persona.name}: ${persona.focus}

## Positions précédentes
${positionLines}

## Consigne
Réagis aux positions ci-dessus depuis ton point de vue de ${persona.name}.
Challenge, renforce ou propose une alternative. 3-5 phrases.
Durée cible: ${targetDurationSeconds}s.

## Format de réponse
Écris ta réponse dans le fichier: ${responseFilePath}
Format: JSON avec { "persona": "${persona.name}", "text": "<ta réponse>" }`;
}

/**
 * Final round — Identify convergence and remaining disagreements.
 */
export function buildConvergencePrompt(
  persona: CodevPersonaDef,
  allPositions: RoundEntry[],
  targetDurationSeconds: number,
  responseFilePath: string,
): string {
  const positionLines = allPositions
    .map((p) => `[R${p.round}] **${p.persona}**: ${truncate(p.text, 200)}`)
    .join('\n');

  return `[CoDev — Convergence]
Tu es ${persona.name}: ${persona.focus}

## Toutes les positions
${positionLines}

## Consigne
Identifie 3 points de convergence et 2 désaccords restants.
Propose des actions concrètes pour avancer. 3-5 phrases.
Durée cible: ${targetDurationSeconds}s.

## Format de réponse
Écris ta réponse dans le fichier: ${responseFilePath}
Format: JSON avec { "persona": "${persona.name}", "text": "<ta réponse>" }`;
}
