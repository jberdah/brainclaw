/**
 * CoDev v3 — Round protocol engine.
 * Orchestrates prompt generation, agent spawning, response collection,
 * metrics recording, and ideation round persistence.
 * @module
 */
import { saveIdeationRound, loadIdeationRound, listIdeationRounds, type IdeationRound } from './ideation.js';
import { recordResponse } from './codev-metrics.js';
import { buildPositionPrompt, buildReactionPrompt, buildConvergencePrompt } from './codev-prompts.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface RoundConfig {
  threadSlug: string;
  roundNumber: number;
  roundType: 'position' | 'reaction' | 'convergence';
  personas: Array<{ name: string; focus: string }>;
  agents: Array<{ name: string; binaryPath: string }>;
  exposition: string;
  targetDurationSeconds: number;
  cwd: string;
}

// ── Helpers ───────────────────────────────────────────────────

function sanitizeForPath(slug: string): string {
  return slug.replace(/[<>:"/\\|?*]/g, '_');
}

function responseFilePath(threadSlug: string, roundNumber: number, personaName: string): string {
  return path.join(os.tmpdir(), 'brainclaw-codev', sanitizeForPath(threadSlug), `round_${roundNumber}`, `${personaName}.json`);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function spawnAgent(
  binaryPath: string,
  agentName: string,
  prompt: string,
  personaName: string,
  cwd: string,
  outputFile: string,
): void {
  const tmpDir = path.join(os.tmpdir(), 'brainclaw-codev');
  fs.mkdirSync(tmpDir, { recursive: true });
  const promptFile = path.join(tmpDir, `${personaName}-${Date.now()}.md`);
  fs.writeFileSync(promptFile, prompt, 'utf-8');

  // Capture stdout → response file. The agent just responds normally;
  // the facilitator writes its output to the expected response path.
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const outFd = fs.openSync(outputFile + '.partial', 'w');

  const child = spawn(
    'sh',
    ['-c', `"${binaryPath}" -p "$(cat "${promptFile}")" ; rm -f "${promptFile}"`],
    { detached: true, stdio: ['ignore', outFd, 'ignore'], cwd },
  );
  child.on('error', (err) => {
    console.warn(`  ⚠ Spawn error for ${agentName}/${personaName}: ${(err as Error).message}`);
  });
  child.on('exit', () => {
    try { fs.closeSync(outFd); } catch { /* already closed */ }
    // Rename .partial → .json to signal completion atomically
    try {
      const raw = fs.readFileSync(outputFile + '.partial', 'utf-8').trim();
      const response = { persona: personaName, agent: agentName, text: raw, created_at: new Date().toISOString() };
      fs.writeFileSync(outputFile, JSON.stringify(response, null, 2), 'utf-8');
    } catch { /* best effort */ }
  });
  child.unref();
}

// ── Main export ───────────────────────────────────────────────

export function executeRound(config: RoundConfig): IdeationRound {
  const { threadSlug, roundNumber, roundType, personas, agents, exposition, targetDurationSeconds, cwd } = config;
  const dispatchedAt = new Date();

  // a. Generate prompts and spawn agents (round-robin)
  for (let i = 0; i < personas.length; i++) {
    const persona = personas[i];
    const agent = agents[i % agents.length];
    const respFile = responseFilePath(threadSlug, roundNumber, persona.name);
    fs.mkdirSync(path.dirname(respFile), { recursive: true });

    let prompt: string;
    if (roundType === 'position') {
      prompt = buildPositionPrompt(persona, exposition, targetDurationSeconds, respFile);
    } else if (roundType === 'reaction') {
      const prev = loadIdeationRound(threadSlug, roundNumber - 1, cwd);
      const previousPositions = (prev?.positions ?? []).map(p => ({ persona: p.persona, text: p.text }));
      prompt = buildReactionPrompt(persona, previousPositions, roundNumber, targetDurationSeconds, respFile);
    } else {
      const allRounds = listIdeationRounds(threadSlug, cwd);
      const allPositions = allRounds.flatMap(r =>
        r.positions.map(p => ({ persona: p.persona, text: p.text, round: r.round_number }))
      );
      prompt = buildConvergencePrompt(persona, allPositions, targetDurationSeconds, respFile);
    }

    spawnAgent(agent.binaryPath, agent.name, prompt, persona.name, cwd, respFile);
    console.log(`  → [R${roundNumber}] ${persona.name} → ${agent.name}`);
  }

  // b. Poll for responses — no hard timeout
  // Check both .json (final) and .partial (stdout capture still in progress).
  // A .partial is considered done when its size is >0 and stable across 2 polls.
  const pending = new Set(personas.map(p => p.name));
  const collected: Array<{ persona: string; agent: string; text: string; duration_ms: number }> = [];
  const partialSizes = new Map<string, number>();

  console.log(`Polling for ${pending.size} response(s) (round ${roundNumber})...`);
  while (pending.size > 0) {
    sleepSync(10_000);
    for (const personaName of [...pending]) {
      const respFile = responseFilePath(threadSlug, roundNumber, personaName);

      // Check final .json first (written by exit handler)
      let raw: { persona: string; text: string } | undefined;
      if (fs.existsSync(respFile)) {
        try { raw = JSON.parse(fs.readFileSync(respFile, 'utf-8')); } catch { /* not ready */ }
      }

      // Fallback: check .partial stdout capture — stable size means agent finished
      if (!raw) {
        const partialFile = respFile + '.partial';
        if (!fs.existsSync(partialFile)) continue;
        try {
          const stat = fs.statSync(partialFile);
          if (stat.size === 0) continue;
          const prevSize = partialSizes.get(personaName) ?? 0;
          if (stat.size === prevSize && prevSize > 0) {
            // Stable — agent is done writing, read it
            const text = fs.readFileSync(partialFile, 'utf-8').trim();
            if (text.length > 0) {
              raw = { persona: personaName, text };
            }
          }
          partialSizes.set(personaName, stat.size);
          if (!raw) continue;
        } catch { continue; }
      }

      try {
        const respondedAt = new Date();
        const agentIdx = personas.findIndex(p => p.name === personaName);
        const agentName = agents[agentIdx % agents.length].name;
        const duration_ms = respondedAt.getTime() - dispatchedAt.getTime();

        recordResponse(threadSlug, {
          thread_id: threadSlug,
          round: roundNumber,
          persona: personaName,
          agent_name: agentName,
          dispatched_at: dispatchedAt.toISOString(),
          responded_at: respondedAt.toISOString(),
          duration_ms,
        }, cwd);

        collected.push({ persona: personaName, agent: agentName, text: raw.text, duration_ms });
        pending.delete(personaName);
        console.log(`  ✓ ${personaName} responded (${Math.round(duration_ms / 1000)}s)`);
      } catch {
        // File may be partially written — retry on next poll
      }
    }
    if (pending.size > 0) console.log(`  Waiting for: ${[...pending].join(', ')}`);
  }

  // c. Build and persist the IdeationRound artifact
  const round: IdeationRound = {
    schema_version: 1,
    thread_id: threadSlug,
    round_number: roundNumber,
    round_type: roundType,
    positions: collected.map(c => ({ persona: c.persona, agent: c.agent, text: c.text, duration_ms: c.duration_ms })),
    tensions: [],
    convergences: [],
    created_at: new Date().toISOString(),
  };

  saveIdeationRound(threadSlug, round, cwd);
  return round;
}
