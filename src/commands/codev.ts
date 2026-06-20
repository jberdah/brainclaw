/**
 * CLI command: brainclaw codev <topic>
 *
 * v2: Autonomous facilitation with auto-generated briefs.
 * Creates a thread, loads project context, generates rich exposition,
 * persona briefs with phase instructions, facilitation contract, and synthesis.
 * Optionally spawns agent CLI instances with --spawn.
 *
 * Supports multiple agent engines via --agents (e.g. claude-code,codex,antigravity).
 * Personas are distributed round-robin across available agents.
 *
 * Without --spawn: enhanced v1 — creates thread + prints coordinator prompt.
 *
 * @module
 */
import { spawn, spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { memoryExists, readProjectVision } from '../core/io.js';
import { sendMessage, getThread, getThreadCount } from '../core/messaging.js';
import { resolveCurrentAgentName } from '../core/agent-registry.js';
import { CODEV_PERSONAS, listPersonas } from '../core/codev-personas.js';
import type { CodevPersona } from '../core/codev-personas.js';
import { buildContext } from '../core/context.js';
import { buildCoordinationSnapshot } from '../core/coordination.js';
import { getDefaultInvokeTemplate, getSpawnableAgents, type DefaultInvokeTemplate } from '../core/agent-capability.js';
import { executeRound, type RoundConfig } from '../core/codev-rounds.js';
import { buildWorkerIdentityEnv } from '../core/execution-profile.js';
import { loadIdeationRound } from '../core/ideation.js';
import { summarizeMetrics, summarizeMetricsByRound } from '../core/codev-metrics.js';
import { generatePlansFromConvergence, generateSummaryNote } from '../core/codev-plan-gen.js';

export interface CodevOptions {
  personas?: string;
  checkpoint?: boolean;
  json?: boolean;
  spawn?: boolean;
  fresh?: boolean;
  agents?: string;
  rounds?: number;
  targetDuration?: number;
  cwd?: string;
  quorum?: number;
  /** Display timing metrics for this session after completion. */
  metrics?: boolean;
  /** Per-persona model overrides, e.g. "simplificateur:sonnet,stratege:opus". */
  modelMap?: string;
}

function toSlug(topic: string): string {
  return topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

function sanitizeForPath(slug: string): string {
  return slug.replace(/[<>:"/\\|?*]/g, '_');
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

  // Parse --model-map into a lookup: persona → model
  const modelOverrides: Record<string, string> = {};
  if (options.modelMap) {
    for (const entry of options.modelMap.split(',')) {
      const [persona, model] = entry.split(':').map(s => s.trim());
      if (persona && model) modelOverrides[persona] = model;
    }
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

  // ── Resolve spawn agents ──────────────────────────────────
  let spawnAgents: ResolvedAgent[] = [];
  if (options.spawn) {
    spawnAgents = resolveSpawnAgents(options.agents);
    if (spawnAgents.length === 0) {
      console.error('Error: --spawn requested but no spawnable agents found in PATH.');
      console.error('Available agents: ' + getSpawnableAgents().map(a => a.name).join(', '));
      console.error('Install one or specify with --agents <name1,name2,...>');
      process.exit(1);
    }
    const agentNames = spawnAgents.map(a => a.name).join(', ');
    console.log(`Resolved ${spawnAgents.length} spawn agent(s): ${agentNames}`);

    if (options.fresh) {
      const tmpDir = path.join(os.tmpdir(), 'brainclaw-codev', sanitizeForPath(threadId));
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
      // Also delete ideation artifacts for this thread
      const ideDir = path.join(cwd, '.brainclaw', 'coordination', 'ideation', sanitizeForPath(threadId));
      if (fs.existsSync(ideDir)) fs.rmSync(ideDir, { recursive: true, force: true });
      console.log('Fresh run: cleared cached responses and artifacts.');
    }

    // ── v3: Round-based orchestration ────────────────────────
    const totalRounds = Math.max(2, options.rounds ?? 3);
    const targetDuration = options.targetDuration ?? 120;
    const sessionStart = Date.now();

    for (let r = 0; r < totalRounds; r++) {
      let roundType: 'position' | 'reaction' | 'convergence';
      if (r === 0) roundType = 'position';
      else if (r === totalRounds - 1) roundType = 'convergence';
      else roundType = 'reaction';

      console.log(`\nRound ${r}/${totalRounds} (${roundType})...`);

      executeRound({
        threadSlug: threadId,
        roundNumber: r,
        roundType,
        personas,
        agents: spawnAgents.map(a => ({ name: a.name, binaryPath: a.binaryPath })),
        exposition: expositionText,
        targetDurationSeconds: targetDuration,
        cwd,
        quorum: options.quorum,
        modelOverrides: Object.keys(modelOverrides).length > 0 ? modelOverrides : undefined,
      });
    }

    // Cleanup temp response files
    const tmpDir = path.join(os.tmpdir(), 'brainclaw-codev', sanitizeForPath(threadId));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }

    // ── Print final summary ──────────────────────────────────
    const lastRound = loadIdeationRound(threadId, totalRounds - 1, cwd);

    if (options.json) {
      console.log(JSON.stringify({
        threadId,
        opening: opening.id,
        personas: personas.map(p => p.name),
        rounds: totalRounds,
        convergences: lastRound?.convergences ?? [],
        tensions: lastRound?.tensions ?? [],
        spawned: true,
      }, null, 2));
      return;
    }

    console.log(`\n--- CoDev v3 session complete: ${threadId} ---\n`);
    const elapsedSec = Math.round((Date.now() - sessionStart) / 1000);
    const elapsedMin = Math.floor(elapsedSec / 60);
    const elapsedDisplay = elapsedMin > 0 ? `${elapsedMin}m ${elapsedSec % 60}s` : `${elapsedSec}s`;
    console.log(`${totalRounds} rounds completed across ${spawnAgents.length} agent(s) [${agentNames}] in ${elapsedDisplay}.`);

    if (lastRound) {
      if (lastRound.convergences.length > 0) {
        console.log('\nConvergences:');
        for (const c of lastRound.convergences) console.log(`  - ${c}`);
      }
      if (lastRound.tensions.length > 0) {
        console.log('\nTensions:');
        for (const t of lastRound.tensions) console.log(`  - ${t}`);
      }
      if (lastRound.positions.length > 0) {
        console.log('\nFinal positions:');
        for (const p of lastRound.positions) {
          console.log(`  [${p.persona}] ${p.text.slice(0, 200)}`);
        }
      }
    }

    console.log(`\nMonitor thread: brainclaw thread ${threadId}`);

    // ── Plan generation from convergences ───────────────────
    if (lastRound?.convergences.length) {
      console.log('\nGenerating plan items from convergences...');
      try {
        const planResult = generatePlansFromConvergence(threadId, cwd);
        if (planResult.plans.length > 0) {
          console.log(`  ✓ Created ${planResult.plans.length} plan(s):`);
          for (const p of planResult.plans) console.log(`    [${p.id}] ${p.text.slice(0, 120)}`);
          generateSummaryNote(threadId, planResult, cwd);
        }
        if (planResult.skipped.length > 0) {
          console.log(`  ⚠ Skipped ${planResult.skipped.length} convergence(s) (plan creation failed).`);
        }
      } catch (err) {
        console.warn(`  ⚠ Plan generation failed: ${(err as Error).message}`);
      }
    }

    // ── Timing metrics ───────────────────────────────────────
    if (options.metrics) {
      printMetricsSummary(threadId, cwd);
    }

    return;
  }

  // ── Phase 2: Clarification briefs ─────────────────────────
  for (let i = 0; i < personas.length; i++) {
    const persona = personas[i];
    // For spawned agents, skip thread history to avoid exponential message growth.
    // Each spawned agent gets the exposition + their persona brief — that's enough context.
    const threadHistory = options.spawn ? [] : getThread(threadId, cwd, { truncateText: 2000 });
    const brief = buildConsultantBrief(persona, expositionText, 'clarification', threadHistory);
    sendMessage({
      from: agent,
      to: agent,
      type: 'rfc',
      text: brief,
      thread_id: threadId,
      tags: ['codev', 'phase:clarification', `persona:${persona.name}`],
    }, cwd);

    if (options.spawn && spawnAgents.length > 0) {
      const targetAgent = spawnAgents[i % spawnAgents.length];
      console.log(`  → ${persona.name} (clarification) → ${targetAgent.name}`);
      spawnConsultant(brief, threadId, persona.name, cwd, targetAgent);
    }
  }

  if (options.spawn) {
    const baseline = getThreadCount(threadId, cwd);
    console.log(`Waiting for ${personas.length} clarification responses (timeout: 5 min)...`);
    const poll = awaitThreadGrowth(threadId, baseline, personas.length, cwd);
    if (poll.timedOut) {
      console.log(`Warning: timed out — received ${poll.received}/${personas.length} clarification responses.`);
    } else {
      console.log(`All ${personas.length} clarification responses received.`);
    }
  }

  // ── Phase 3: Facilitation contract ────────────────────────
  const clarificationMessages = getThread(threadId, cwd, { truncateText: 3000 })
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
  for (let i = 0; i < personas.length; i++) {
    const persona = personas[i];
    // For spawned agents, include only the contract (not full history) to avoid message explosion
    const threadHistory = options.spawn ? [] : getThread(threadId, cwd, { truncateText: 2000 });
    const brief = buildConsultantBrief(persona, expositionText, 'consultation', threadHistory);
    sendMessage({
      from: agent,
      to: agent,
      type: 'rfc',
      text: brief,
      thread_id: threadId,
      tags: ['codev', 'phase:consultation', `persona:${persona.name}`],
    }, cwd);

    if (options.spawn && spawnAgents.length > 0) {
      const targetAgent = spawnAgents[i % spawnAgents.length];
      console.log(`  → ${persona.name} (consultation) → ${targetAgent.name}`);
      spawnConsultant(brief, threadId, persona.name, cwd, targetAgent);
    }
  }

  if (options.spawn) {
    const baseline = getThreadCount(threadId, cwd);
    console.log(`Waiting for ${personas.length} consultation responses (timeout: 5 min)...`);
    const poll = awaitThreadGrowth(threadId, baseline, personas.length, cwd);
    if (poll.timedOut) {
      console.log(`Warning: timed out — received ${poll.received}/${personas.length} consultation responses.`);
    } else {
      console.log(`All ${personas.length} consultation responses received.`);
    }
  }

  // ── Phase 5: Synthesis ────────────────────────────────────
  const consultationMessages = getThread(threadId, cwd, { truncateText: 3000 })
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
    const agentNames = spawnAgents.map(a => a.name).join(', ');
    console.log(`Spawned ${personas.length * 2} agent instances across [${agentNames}] (clarification + consultation).`);
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

// ── Agent resolution ─────────────────────────────────────────

interface ResolvedAgent {
  name: string;
  binary: string;
  binaryPath: string;
  template: DefaultInvokeTemplate;
}

function resolveAgentBinaryPath(binary: string): string | undefined {
  try {
    const isWindows = process.platform === 'win32';
    const cmd = isWindows ? 'where' : 'which';
    const result = execFileSync(cmd, [binary], { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    const firstLine = result.trim().split('\n')[0]?.trim();
    return firstLine || undefined;
  } catch {
    return undefined;
  }
}

function resolveSpawnAgents(agentsOption?: string): ResolvedAgent[] {
  if (agentsOption) {
    const names = agentsOption.split(',').map(n => n.trim()).filter(Boolean);
    const resolved: ResolvedAgent[] = [];
    for (const name of names) {
      const template = getDefaultInvokeTemplate(name);
      if (!template) {
        console.warn(`⚠ Agent '${name}' has no invoke template — skipping.`);
        continue;
      }
      const binaryPath = resolveAgentBinaryPath(template.binary);
      if (!binaryPath) {
        console.warn(`⚠ Agent '${name}' binary '${template.binary}' not found in PATH — skipping.`);
        continue;
      }
      resolved.push({ name, binary: template.binary, binaryPath, template });
    }
    return resolved;
  }

  // Default: auto-detect available spawnable agents
  const all = getSpawnableAgents();
  const resolved: ResolvedAgent[] = [];
  for (const { name, template } of all) {
    const binaryPath = resolveAgentBinaryPath(template.binary);
    if (binaryPath) {
      resolved.push({ name, binary: template.binary, binaryPath, template });
    }
  }
  return resolved;
}

// ── Spawn helper ──────────────────────────────────────────────

function buildResponseInstruction(threadId: string, personaName: string): string {
  return [
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
}

function writeBriefToTempFile(brief: string, personaName: string): string {
  const tmpDir = path.join(os.tmpdir(), 'brainclaw-codev');
  fs.mkdirSync(tmpDir, { recursive: true });
  const filePath = path.join(tmpDir, `${personaName}-${Date.now()}.md`);
  fs.writeFileSync(filePath, brief, 'utf-8');
  return filePath;
}

function spawnConsultant(brief: string, threadId: string, personaName: string, cwd: string, agent: ResolvedAgent): void {
  const fullBrief = brief + buildResponseInstruction(threadId, personaName);
  const briefFile = writeBriefToTempFile(fullBrief, personaName);

  const { binaryPath, name: agentName } = agent;

  // Attach error handler to all spawned children to prevent unhandled 'error' events from crashing the parent
  const attachErrorHandler = (child: ReturnType<typeof spawn>) => {
    child.on('error', (err) => {
      // Log but don't crash — the agent simply failed to start
      console.warn(`  ⚠ Spawn error for ${agentName}/${personaName}: ${(err as Error).message}`);
    });
  };

  // F7 (trp_0e5150d3): scrub coordinator identity so a consultant worker is an
  // independent agent — these spawns previously inherited the full parent env.
  const workerEnv = buildWorkerIdentityEnv(process.env, { agent: agentName });

  if (agentName === 'codex') {
    // Codex: use temp file via shell to avoid Windows .cmd ENOENT issues
    const child = spawn('sh', ['-c', `cat "${briefFile}" | "${binaryPath}" exec --full-auto - ; rm -f "${briefFile}"`], {
      detached: true,
      stdio: 'ignore',
      cwd,
      env: workerEnv,
    });
    attachErrorHandler(child);
    child.unref();
  } else if (agentName === 'antigravity') {
    // Gemini CLI: use temp file via shell redirection
    const child = spawn('sh', ['-c', `"${binaryPath}" -p "$(cat "${briefFile}")" ; rm -f "${briefFile}"`], {
      detached: true,
      stdio: 'ignore',
      cwd,
      env: workerEnv,
    });
    attachErrorHandler(child);
    child.unref();
  } else {
    // Claude Code: use temp file via shell cat substitution
    const child = spawn('sh', ['-c', `"${binaryPath}" -p "$(cat "${briefFile}")" --allowedTools "Read,Glob,Grep,Bash" ; rm -f "${briefFile}"`], {
      detached: true,
      stdio: 'ignore',
      cwd,
      env: workerEnv,
    });
    attachErrorHandler(child);
    child.unref();
  }
}

// ── Polling helpers ──────────────────────────────────────────

function sleepSync(ms: number): void {
  if (process.platform === 'win32') {
    spawnSync('powershell', ['-NonInteractive', '-Command', `Start-Sleep -Milliseconds ${ms}`], { stdio: 'ignore' });
  } else {
    spawnSync('sleep', [`${ms / 1000}`], { stdio: 'ignore' });
  }
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
    // Use lightweight count to avoid OOM from loading full messages each poll
    const count = getThreadCount(threadId, cwd);
    if (count >= target) {
      return { received: count - baselineCount, timedOut: false };
    }
    sleepSync(intervalMs);
  }

  const count = getThreadCount(threadId, cwd);
  return { received: count - baselineCount, timedOut: true };
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

  // Limit thread history to avoid string explosion — only include last 5 messages, truncated
  const MAX_HISTORY_MESSAGES = 5;
  const MAX_HISTORY_CHARS = 8000;
  const recentHistory = threadHistory.slice(-MAX_HISTORY_MESSAGES);
  let historyText = recentHistory.map(m => (m.text ?? '').slice(0, 1500)).join('\n---\n');
  if (historyText.length > MAX_HISTORY_CHARS) {
    historyText = historyText.slice(0, MAX_HISTORY_CHARS) + '\n[...truncated]';
  }
  const historyBlock = recentHistory.length > 0
    ? `\n## Thread History (last ${recentHistory.length})\n${historyText}`
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
      const truncatedText = (msg.text ?? '').slice(0, 3000);
      sections.push(`\n### ${personaName}\n${truncatedText}`);
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
      const truncatedText = (msg.text ?? '').slice(0, 3000);
      sections.push(`\n### ${personaName}\n${truncatedText}`);
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

// ── codev metrics ─────────────────────────────────────────────

function printMetricsSummary(threadSlug: string, cwd: string): void {
  const summary = summarizeMetrics(threadSlug, cwd);
  if (!Object.keys(summary.by_agent).length) return;
  const byRound = summarizeMetricsByRound(threadSlug, cwd);
  console.log('\n── Response Metrics ──────────────────────────────');
  console.log(`  Overall avg: ${Math.round(summary.avg_ms / 1000)}s  p95: ${Math.round(summary.p95_ms / 1000)}s`);
  if (byRound.length > 0) {
    console.log('  Per round:');
    for (const r of byRound) {
      console.log(`    Round ${r.round}: avg=${Math.round(r.avg_ms / 1000)}s  p95=${Math.round(r.p95_ms / 1000)}s  responses=${r.count}`);
    }
  }
  for (const [agent, stats] of Object.entries(summary.by_agent)) {
    console.log(`  ${agent}: avg=${Math.round(stats.avg_ms / 1000)}s  count=${stats.count}`);
  }
  console.log('');
}

export function runCodevMetrics(threadSlug: string | undefined, options: { cwd?: string; json?: boolean } = {}): void {
  if (!threadSlug) {
    console.error('Error: <thread> is required. Usage: brainclaw codev-metrics <thread>');
    process.exit(1);
  }
  const cwd = options.cwd ?? process.cwd();
  const summary = summarizeMetrics(threadSlug, cwd);
  const byRound = summarizeMetricsByRound(threadSlug, cwd);

  if (options.json) {
    console.log(JSON.stringify({ summary, by_round: byRound }, null, 2));
    return;
  }

  if (!Object.keys(summary.by_agent).length) {
    console.log(`No metrics found for thread: ${threadSlug}`);
    return;
  }

  console.log(`\nCoDev metrics for thread: ${threadSlug}\n`);
  console.log(`  Overall avg: ${Math.round(summary.avg_ms / 1000)}s  p95: ${Math.round(summary.p95_ms / 1000)}s`);

  if (byRound.length > 0) {
    console.log('\n  Per round:');
    for (const r of byRound) {
      console.log(`    Round ${r.round}: avg=${Math.round(r.avg_ms / 1000)}s  p95=${Math.round(r.p95_ms / 1000)}s  responses=${r.count}`);
    }
  }

  console.log('\n  Per agent:');
  for (const [agent, stats] of Object.entries(summary.by_agent)) {
    console.log(`    ${agent}: avg=${Math.round(stats.avg_ms / 1000)}s  count=${stats.count}`);
  }
  console.log('');
}
