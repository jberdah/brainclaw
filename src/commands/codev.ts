/**
 * CLI command: brainclaw codev <topic>
 *
 * v2: Autonomous facilitation with auto-generated briefs.
 * Creates a thread, loads project context, generates rich exposition,
 * persona briefs with phase instructions, facilitation contract, and synthesis.
 * Optionally spawns Claude CLI instances with --spawn.
 *
 * Without --spawn: enhanced v1 — creates thread + prints coordinator prompt.
 *
 * @module
 */
import { spawn } from 'node:child_process';
import { memoryExists, readProjectVision } from '../core/io.js';
import { sendMessage, getThread } from '../core/messaging.js';
import { resolveCurrentAgentName } from '../core/agent-registry.js';
import { CODEV_PERSONAS, listPersonas } from '../core/codev-personas.js';
import type { CodevPersona } from '../core/codev-personas.js';
import { buildContext } from '../core/context.js';
import { buildCoordinationSnapshot } from '../core/coordination.js';

export interface CodevOptions {
  personas?: string;
  checkpoint?: boolean;
  json?: boolean;
  spawn?: boolean;
  cwd?: string;
}

function toSlug(topic: string): string {
  return topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'and', 'but', 'or', 'nor',
  'not', 'so', 'yet', 'both', 'each', 'few', 'more', 'most', 'other',
  'some', 'such', 'no', 'only', 'own', 'same', 'than', 'too', 'very',
  'just', 'about', 'how', 'what', 'which', 'who', 'when', 'where', 'why',
  'all', 'any', 'every', 'this', 'that', 'these', 'those', 'it', 'its',
]);

function extractKeywords(topic: string): string[] {
  return topic.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
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

  // ── Load project context ──────────────────────────────────
  const vision = readProjectVision(cwd);
  const snapshot = buildCoordinationSnapshot({ cwd });
  const contextResult = buildContext({ cwd });

  // Find related plans via keyword matching
  const keywords = extractKeywords(topic);
  const relatedPlans = snapshot.active_plans.filter(p =>
    keywords.some(k => p.text?.toLowerCase().includes(k))
  );

  // Extract constraints, decisions, traps from context
  const constraints = contextResult.selected
    .filter(i => i.section === 'constraint')
    .map(i => i.text);
  const decisions = contextResult.selected
    .filter(i => i.section === 'decision')
    .map(i => i.text);
  const traps = (snapshot.known_traps ?? [])
    .map(t => `[${t.severity}] ${t.text}`);

  // ── Phase 1: Exposition ───────────────────────────────────
  const expositionText = buildExposition(topic, vision, relatedPlans, constraints, traps);
  const opening = sendMessage({
    from: agent,
    to: agent,
    type: 'rfc',
    text: expositionText,
    thread_id: threadId,
    tags: ['codev', 'phase:exposition'],
  }, cwd);

  // ── Phase 2: Clarification briefs ─────────────────────────
  for (const persona of personas) {
    const threadHistory = getThread(threadId, cwd);
    const brief = buildConsultantBrief(persona, expositionText, 'clarification', threadHistory);
    sendMessage({
      from: agent,
      to: agent,
      type: 'rfc',
      text: brief,
      thread_id: threadId,
      tags: ['codev', 'phase:clarification', `persona:${persona.name}`],
    }, cwd);

    if (options.spawn) {
      spawnConsultant(brief, threadId, persona.name, cwd);
    }
  }

  if (options.spawn) {
    const baseline = getThread(threadId, cwd).length;
    console.log(`Waiting for ${personas.length} clarification responses (timeout: 5 min)...`);
    const poll = awaitThreadGrowth(threadId, baseline, personas.length, cwd);
    if (poll.timedOut) {
      console.log(`Warning: timed out — received ${poll.received}/${personas.length} clarification responses.`);
    } else {
      console.log(`All ${personas.length} clarification responses received.`);
    }
  }

  // ── Phase 3: Facilitation contract ────────────────────────
  const clarificationMessages = getThread(threadId, cwd)
    .filter(m => m.tags?.includes('phase:clarification'));
  const contractText = buildContract(topic, clarificationMessages, decisions, constraints, traps);
  sendMessage({
    from: agent,
    to: agent,
    type: 'rfc',
    text: contractText,
    thread_id: threadId,
    tags: ['codev', 'phase:contract'],
  }, cwd);

  // ── Phase 4: Consultation briefs ──────────────────────────
  for (const persona of personas) {
    const threadHistory = getThread(threadId, cwd);
    const brief = buildConsultantBrief(persona, expositionText, 'consultation', threadHistory);
    sendMessage({
      from: agent,
      to: agent,
      type: 'rfc',
      text: brief,
      thread_id: threadId,
      tags: ['codev', 'phase:consultation', `persona:${persona.name}`],
    }, cwd);

    if (options.spawn) {
      spawnConsultant(brief, threadId, persona.name, cwd);
    }
  }

  if (options.spawn) {
    const baseline = getThread(threadId, cwd).length;
    console.log(`Waiting for ${personas.length} consultation responses (timeout: 5 min)...`);
    const poll = awaitThreadGrowth(threadId, baseline, personas.length, cwd);
    if (poll.timedOut) {
      console.log(`Warning: timed out — received ${poll.received}/${personas.length} consultation responses.`);
    } else {
      console.log(`All ${personas.length} consultation responses received.`);
    }
  }

  // ── Phase 5: Synthesis ────────────────────────────────────
  const consultationMessages = getThread(threadId, cwd)
    .filter(m => m.tags?.includes('phase:consultation'));
  const synthesisText = buildSynthesis(topic, consultationMessages);
  sendMessage({
    from: agent,
    to: agent,
    type: 'rfc',
    text: synthesisText,
    thread_id: threadId,
    tags: ['codev', 'phase:synthesis'],
  }, cwd);

  // ── Output ────────────────────────────────────────────────
  if (options.json) {
    console.log(JSON.stringify({
      threadId,
      opening: opening.id,
      personas: personas.map(p => p.name),
      phases: ['exposition', 'clarification', 'contract', 'consultation', 'synthesis'],
      spawned: options.spawn ?? false,
    }, null, 2));
    return;
  }

  console.log(`\n--- CoDev v2 session: ${threadId} ---\n`);
  console.log(`Thread created with ${personas.length} persona briefs (${tierName}).`);
  console.log(`Phases: exposition → clarification → contract → consultation → synthesis\n`);

  if (options.spawn) {
    console.log(`Spawned ${personas.length * 2} Claude instances (clarification + consultation).`);
    console.log('Agents will write responses to the thread. Monitor with:');
    console.log(`  brainclaw thread ${threadId}\n`);
  } else {
    if (options.checkpoint) {
      console.log('CHECKPOINT: Review the topic and personas above.');
      console.log('When ready, ask the LLM to proceed with the consultation.\n');
    }
    console.log(buildCoordinatorPrompt(threadId, personas, topic, options.checkpoint));
  }
}

// ── Spawn helper ──────────────────────────────────────────────

function spawnConsultant(brief: string, threadId: string, personaName: string, cwd: string): void {
  const responseInstruction = [
    '',
    '## Response Protocol',
    'After formulating your response, you MUST post it back to the brainclaw thread.',
    'Run this command in Bash (adapt quoting as needed for your response content):',
    '',
    `brainclaw inbox send coordinator "$(cat <<'CODEV_RESPONSE'`,
    '<YOUR RESPONSE HERE>',
    `CODEV_RESPONSE`,
    `)" --type rfc --thread ${threadId} --agent ${personaName}`,
    '',
    'Replace <YOUR RESPONSE HERE> with your actual response text.',
    'This is REQUIRED — your work is lost if you do not post it.',
  ].join('\n');

  const fullBrief = brief + responseInstruction;

  spawn('claude', ['-p', fullBrief, '--allowedTools', 'Read,Glob,Grep,Bash'], {
    detached: true,
    stdio: 'ignore',
    cwd,
  }).unref();
}

// ── Polling helpers ──────────────────────────────────────────

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function awaitThreadGrowth(
  threadId: string,
  baselineCount: number,
  expectedNew: number,
  cwd: string,
  timeoutMs = 300_000,
  intervalMs = 30_000,
): { received: number; timedOut: boolean } {
  const target = baselineCount + expectedNew;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const thread = getThread(threadId, cwd);
    if (thread.length >= target) {
      return { received: thread.length - baselineCount, timedOut: false };
    }
    sleepSync(intervalMs);
  }

  const thread = getThread(threadId, cwd);
  return { received: thread.length - baselineCount, timedOut: true };
}

// ── Exposition builder ────────────────────────────────────────

function buildExposition(
  topic: string,
  vision: string | undefined,
  relatedPlans: { text?: string; id?: string }[],
  constraints: string[],
  traps: string[],
): string {
  const sections: string[] = [
    `[CoDev] Topic for multi-perspective consultation:\n\n${topic}`,
  ];

  if (vision) {
    sections.push(`\n## Project Vision\n${vision}`);
  }

  if (relatedPlans.length > 0) {
    const planLines = relatedPlans.map(p => `- ${p.text ?? p.id}`).join('\n');
    sections.push(`\n## Related Plans\n${planLines}`);
  }

  if (constraints.length > 0) {
    sections.push(`\n## Active Constraints\n${constraints.map(c => `- ${c}`).join('\n')}`);
  }

  if (traps.length > 0) {
    sections.push(`\n## Relevant Traps\n${traps.map(t => `- ${t}`).join('\n')}`);
  }

  return sections.join('\n');
}

// ── Consultant brief builder ──────────────────────────────────

function buildConsultantBrief(
  persona: CodevPersona,
  exposition: string,
  phase: 'clarification' | 'consultation',
  threadHistory: { text: string; tags?: string[] }[],
): string {
  const phaseInstruction = phase === 'clarification'
    ? 'CLARIFICATION: Ask 3-5 questions ONLY, no suggestions'
    : 'CONSULTATION: Give concrete proposals';

  const historyBlock = threadHistory.length > 0
    ? `\n## Thread History\n${threadHistory.map(m => m.text).join('\n---\n')}`
    : '';

  return [
    `[Persona: ${persona.name}]`,
    `Focus: ${persona.focus}`,
    '',
    `Phase: ${phaseInstruction}`,
    '',
    '## Context',
    exposition,
    historyBlock,
    '',
    phase === 'clarification'
      ? 'Ask 3-5 clarifying questions from your perspective. Do NOT provide suggestions yet.'
      : 'Provide concrete, actionable proposals from your perspective in 3-5 key points.',
  ].join('\n');
}

// ── Facilitation contract builder ─────────────────────────────

function buildContract(
  topic: string,
  clarificationMessages: { text: string; tags?: string[] }[],
  decisions: string[],
  constraints: string[],
  traps: string[],
): string {
  const sections: string[] = [
    `[Facilitator Contract] Answering clarification questions for: ${topic}`,
    '',
    '## Clarification Questions Received',
  ];

  if (clarificationMessages.length > 0) {
    for (const msg of clarificationMessages) {
      const personaTag = msg.tags?.find(t => t.startsWith('persona:'));
      const personaName = personaTag?.replace('persona:', '') ?? 'unknown';
      sections.push(`\n### ${personaName}\n${msg.text}`);
    }
  } else {
    sections.push('\n(No clarification questions received yet — consultants will ask during clarification phase)');
  }

  sections.push('\n## Project Context for Answers');

  if (decisions.length > 0) {
    sections.push(`\n### Decisions\n${decisions.map(d => `- ${d}`).join('\n')}`);
  }

  if (constraints.length > 0) {
    sections.push(`\n### Constraints\n${constraints.map(c => `- ${c}`).join('\n')}`);
  }

  if (traps.length > 0) {
    sections.push(`\n### Known Traps\n${traps.map(t => `- ${t}`).join('\n')}`);
  }

  sections.push('\n## Contract');
  sections.push('Use the project context above to answer clarification questions.');
  sections.push('Consultants may now proceed to the consultation phase with this context.');

  return sections.join('\n');
}

// ── Synthesis builder ─────────────────────────────────────────

function buildSynthesis(
  topic: string,
  consultationMessages: { text: string; tags?: string[] }[],
): string {
  const sections: string[] = [
    `[Synthesis] Multi-perspective analysis: ${topic}`,
    '',
  ];

  if (consultationMessages.length > 0) {
    sections.push('## Consultation Responses');
    for (const msg of consultationMessages) {
      const personaTag = msg.tags?.find(t => t.startsWith('persona:'));
      const personaName = personaTag?.replace('persona:', '') ?? 'unknown';
      sections.push(`\n### ${personaName}\n${msg.text}`);
    }
  }

  sections.push('\n## Synthesis Template');
  sections.push('');
  sections.push('### Consensus Points');
  sections.push('(Points where 3+ perspectives agree)');
  sections.push('');
  sections.push('### Key Tensions / Dissent');
  sections.push('(Where perspectives conflict)');
  sections.push('');
  sections.push('### Risks Identified');
  sections.push('(Top risks surfaced across perspectives)');
  sections.push('');
  sections.push('### Recommended Action');
  sections.push('(Concrete next step based on the analysis)');

  return sections.join('\n');
}

// ── Coordinator prompt (v1 fallback, enhanced) ────────────────

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
    '1. Read the thread messages to understand each persona brief and the project context.',
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
