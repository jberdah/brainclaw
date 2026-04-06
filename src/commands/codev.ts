/**
 * CLI command: brainclaw codev <topic>
 *
 * Structured multi-perspective ideation using persona-based consultation.
 * Creates a thread, sends persona briefs, and outputs a coordinator prompt
 * for the current LLM to role-play each perspective and synthesize.
 *
 * @module
 */
import { memoryExists } from '../core/io.js';
import { sendMessage, getThread } from '../core/messaging.js';
import { resolveCurrentAgentName } from '../core/agent-registry.js';
import { CODEV_PERSONAS, listPersonas } from '../core/codev-personas.js';
import type { CodevPersona } from '../core/codev-personas.js';

export interface CodevOptions {
  personas?: string;
  checkpoint?: boolean;
  json?: boolean;
  cwd?: string;
}

function toSlug(topic: string): string {
  return topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

export function runCodev(topic: string | undefined, options: CodevOptions = {}): void {
  // Handle --personas list (no topic required)
  if (options.personas === 'list') {
    console.log('\nAvailable CoDev personas:\n');
    console.log(listPersonas());
    return;
  }

  if (!topic) {
    console.error('Error: <topic> is required. Usage: brainclaw codev <topic>');
    process.exit(1);
  }

  const cwd = options.cwd ?? process.cwd();
  if (!memoryExists(cwd)) {
    console.error('Error: .brainclaw/ not found. Run `brainclaw init` first.');
    process.exit(1);
  }

  const agent = resolveCurrentAgentName(cwd) ?? 'coordinator';
  const tierName = options.personas ?? 'tier1';
  const personas = CODEV_PERSONAS[tierName];
  if (!personas) {
    console.error(`Error: unknown persona tier "${tierName}". Use tier1, tier2, or list.`);
    process.exit(1);
  }

  const date = new Date().toISOString().slice(0, 10);
  const threadId = `codev:${date}:${toSlug(topic)}`;

  // 1. Opening message — exposition
  const opening = sendMessage({
    from: agent,
    to: agent,
    type: 'rfc',
    text: `[CoDev] Topic for multi-perspective consultation:\n\n${topic}`,
    thread_id: threadId,
    tags: ['codev', 'phase:exposition'],
  }, cwd);

  // 2. One message per persona — consultation briefs
  for (const persona of personas) {
    sendMessage({
      from: agent,
      to: agent,
      type: 'rfc',
      text: buildPersonaBrief(persona, topic),
      thread_id: threadId,
      tags: ['codev', 'phase:consultation', `persona:${persona.name}`],
    }, cwd);
  }

  // 3. Output coordinator prompt
  if (options.json) {
    console.log(JSON.stringify({ threadId, opening: opening.id, personas: personas.map(p => p.name) }, null, 2));
    return;
  }

  console.log(`\n--- CoDev session: ${threadId} ---\n`);
  console.log(`Thread created with ${personas.length} persona briefs (${tierName}).\n`);

  if (options.checkpoint) {
    console.log('CHECKPOINT: Review the topic and personas above.');
    console.log('When ready, ask the LLM to proceed with the consultation.\n');
  }

  console.log(buildCoordinatorPrompt(threadId, personas, topic, options.checkpoint));
}

function buildPersonaBrief(persona: CodevPersona, topic: string): string {
  return [
    `[Persona: ${persona.name}]`,
    `Focus: ${persona.focus}`,
    '',
    `Analyze the following topic through your lens:`,
    topic,
    '',
    `Provide your perspective in 3-5 key points. Be specific and actionable.`,
  ].join('\n');
}

function buildCoordinatorPrompt(threadId: string, personas: CodevPersona[], topic: string, checkpoint?: boolean): string {
  const personaList = personas.map(p => `- **${p.name}**: ${p.focus}`).join('\n');
  const checkpointBlock = checkpoint
    ? '\n4. PAUSE and present clarifying questions to the human before proceeding to steps 5-6.\n'
    : '';

  return [
    '--- COORDINATOR PROMPT (copy to your LLM) ---',
    '',
    `You are the coordinator of a CoDev ideation session on thread ${threadId}.`,
    `Topic: ${topic}`,
    '',
    'Participants:',
    personaList,
    '',
    'Instructions:',
    '1. Read the thread messages to understand each persona brief.',
    '2. Role-play each persona in order. For each, write a reply with 3-5 specific points from that perspective.',
    '3. After all personas have spoken, identify areas of agreement and tension.',
    checkpoint ? checkpointBlock : '',
    `${checkpoint ? '5' : '4'}. Synthesize into a structured output:`,
    '   - **Consensus**: points where 3+ personas agree',
    '   - **Key tensions**: where perspectives conflict',
    '   - **Risks**: top 3 risks surfaced',
    '   - **Recommended action**: concrete next step',
    '   - **Dissenting view**: the strongest counter-argument to the recommendation',
    '',
    '--- END COORDINATOR PROMPT ---',
  ].join('\n');
}
