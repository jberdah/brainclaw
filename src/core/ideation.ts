import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

import { memoryDir } from './io.js';

export const IdeationRoundSchema = z.object({
  schema_version: z.literal(1),
  thread_id: z.string(),
  round_number: z.number().int().min(0),
  round_type: z.enum(['position', 'reaction', 'convergence']),
  positions: z.array(
    z.object({
      persona: z.string(),
      agent: z.string(),
      text: z.string(),
      duration_ms: z.number().optional(),
    })
  ),
  tensions: z.array(z.string()).default([]),
  convergences: z.array(z.string()).default([]),
  created_at: z.string(),
});

export type IdeationRound = z.infer<typeof IdeationRoundSchema>;

export function ideationDir(threadSlug: string, cwd?: string): string {
  return path.join(memoryDir(cwd), 'coordination', 'ideation', threadSlug);
}

export function saveIdeationRound(threadSlug: string, round: IdeationRound, cwd?: string): void {
  const dir = ideationDir(threadSlug, cwd);
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `round_${round.round_number}.json`);
  fs.writeFileSync(filePath, JSON.stringify(round, null, 2), 'utf8');
}

export function loadIdeationRound(
  threadSlug: string,
  roundNumber: number,
  cwd?: string
): IdeationRound | undefined {
  const filePath = path.join(ideationDir(threadSlug, cwd), `round_${roundNumber}.json`);
  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  return IdeationRoundSchema.parse(JSON.parse(raw));
}

export function listIdeationRounds(threadSlug: string, cwd?: string): IdeationRound[] {
  const dir = ideationDir(threadSlug, cwd);
  if (!fs.existsSync(dir)) {
    return [];
  }

  const rounds: IdeationRound[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const match = /^round_(\d+)\.json$/.exec(entry);
    if (!match) {
      continue;
    }

    const round = loadIdeationRound(threadSlug, Number(match[1]), cwd);
    if (round) {
      rounds.push(round);
    }
  }

  return rounds.sort((a, b) => a.round_number - b.round_number);
}
