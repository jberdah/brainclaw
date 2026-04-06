/**
 * CoDev persona definitions for multi-perspective ideation.
 * @module
 */

export interface CodevPersona {
  name: string;
  focus: string;
}

export const CODEV_PERSONAS: Record<string, CodevPersona[]> = {
  tier1: [
    { name: 'visionnaire', focus: 'radical possibilities, unconventional approaches, what becomes possible if we remove all constraints' },
    { name: 'conservateur', focus: 'risks, technical debt, maintainability, what could go wrong and what we will regret' },
    { name: 'produit', focus: 'user impact, adoption friction, who benefits and how this changes their workflow' },
    { name: 'avocat_du_diable', focus: 'challenge every assumption, find the weakest argument, stress-test the premise' },
    { name: 'simplificateur', focus: 'cut complexity ruthlessly, find the 80/20, what is the smallest thing that works' },
  ],
  tier2: [
    { name: 'stratege', focus: 'competitive moat, long-term positioning, what makes this defensible' },
    { name: 'scenariste', focus: 'what-if scenarios, edge cases, how this plays out under different futures' },
    { name: 'systemicien', focus: 'second-order effects, feedback loops, unintended consequences across the system' },
    { name: 'opportuniste', focus: 'quick wins, low-hanging fruit, what can we ship this week that moves the needle' },
    { name: 'temporaliste', focus: 'past lessons, present constraints, future trajectory — what does the timeline tell us' },
  ],
};

export function listPersonas(): string {
  const lines: string[] = [];
  for (const [tier, personas] of Object.entries(CODEV_PERSONAS)) {
    lines.push(`${tier}:`);
    for (const p of personas) {
      lines.push(`  ${p.name} — ${p.focus}`);
    }
  }
  return lines.join('\n');
}
