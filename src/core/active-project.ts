import fs from 'node:fs';
import path from 'node:path';
import { MEMORY_DIR } from './io.js';

const ACTIVE_PROJECT_FILE = 'active-project.json';

export interface ActiveProject {
  /** Absolute path to the project directory. */
  path: string;
  /** Project name from config.yaml (when available). */
  name?: string;
  /** ISO timestamp of the switch. */
  switched_at: string;
  /** Agent or user who performed the switch. */
  switched_by?: string;
}

/**
 * Load the active project for a workspace.
 * Returns undefined when no active project is set or the file is unreadable.
 */
export function loadActiveProject(workspaceRoot: string): ActiveProject | undefined {
  const filePath = path.join(workspaceRoot, MEMORY_DIR, ACTIVE_PROJECT_FILE);
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    if (typeof raw.path !== 'string' || !raw.path) {
      return undefined;
    }
    return {
      path: raw.path as string,
      name: typeof raw.name === 'string' ? raw.name : undefined,
      switched_at: typeof raw.switched_at === 'string' ? raw.switched_at : new Date().toISOString(),
      switched_by: typeof raw.switched_by === 'string' ? raw.switched_by : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Persist the active project for a workspace.
 */
export function saveActiveProject(workspaceRoot: string, project: ActiveProject): void {
  const dir = path.join(workspaceRoot, MEMORY_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = path.join(dir, ACTIVE_PROJECT_FILE);
  fs.writeFileSync(filePath, JSON.stringify(project, null, 2) + '\n', 'utf-8');
}

/**
 * Clear the active project (revert to process.cwd() default).
 */
export function clearActiveProject(workspaceRoot: string): void {
  const filePath = path.join(workspaceRoot, MEMORY_DIR, ACTIVE_PROJECT_FILE);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}
