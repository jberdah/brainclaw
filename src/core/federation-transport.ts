import {
  type FederationMessage,
  validateMessage,
  serializeMessage,
  deserializeMessage,
} from './federation-message.js';
import { loadConfig } from './config.js';
import { memoryDir } from './io.js';
import fs from 'node:fs';
import path from 'node:path';

function signalInboxDir(projectPath: string): string {
  return path.join(memoryDir(projectPath), 'coordination', 'inbox', 'cross-project');
}

export function pushSignal(targetProjectPath: string, message: FederationMessage): void {
  validateMessage(message);
  const dir = signalInboxDir(targetProjectPath);
  const filepath = path.join(dir, `${message.id}.json`);
  if (fs.existsSync(filepath)) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filepath, serializeMessage(message) + '\n', 'utf-8');
}

export function pullSignals(
  sourceProjectPath: string,
  options?: { since?: string },
): FederationMessage[] {
  const dir = signalInboxDir(sourceProjectPath);
  if (!fs.existsSync(dir)) return [];

  const messages: FederationMessage[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    try {
      const msg = deserializeMessage(fs.readFileSync(path.join(dir, entry), 'utf-8'));
      if (options?.since && msg.created_at <= options.since) continue;
      messages.push(msg);
    } catch { /* skip invalid files */ }
  }

  return messages.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function pullSignalsFromLinkedProjects(cwd?: string): FederationMessage[] {
  let config;
  try {
    config = loadConfig(cwd);
  } catch {
    return [];
  }

  const baseCwd = cwd ?? process.cwd();
  const all: FederationMessage[] = [];

  for (const link of config.cross_project_links ?? []) {
    if (link.role !== 'subscriber' && link.role !== 'publisher') continue;
    const absolutePath = path.isAbsolute(link.path)
      ? link.path
      : path.resolve(baseCwd, link.path);
    try {
      all.push(...pullSignals(absolutePath));
    } catch { /* unavailable project — skip */ }
  }

  return all.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function markSignalProcessed(projectPath: string, messageId: string): void {
  const dir = signalInboxDir(projectPath);
  const processedDir = path.join(dir, '.processed');
  fs.mkdirSync(processedDir, { recursive: true });
  fs.renameSync(
    path.join(dir, `${messageId}.json`),
    path.join(processedDir, `${messageId}.json`),
  );
}
