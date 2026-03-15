import fs from 'node:fs';
import path from 'node:path';
import { withLock } from './lock.js';

export const MEMORY_DIR = '.brainclaw';

export function memoryDir(cwd: string = process.cwd(), preferredDirName?: string): string {
  return path.join(cwd, preferredDirName ?? MEMORY_DIR);
}

export function memoryPath(filename: string, cwd?: string, preferredDirName?: string): string {
  return path.join(memoryDir(cwd, preferredDirName), filename);
}

export function memoryExists(cwd?: string, preferredDirName?: string): boolean {
  return fs.existsSync(memoryDir(cwd, preferredDirName));
}

export function ensureMemoryDir(cwd?: string, preferredDirName?: string): void {
  const dir = memoryDir(cwd, preferredDirName);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Ensure subdirectories exist for split state
  const subdirs = ['constraints', 'decisions', 'traps', 'handoffs', 'plans', 'instructions'];
  for (const subdir of subdirs) {
    const p = path.join(dir, subdir);
    if (!fs.existsSync(p)) {
      fs.mkdirSync(p, { recursive: true });
    }
  }
}

export function readFileSync(filepath: string): string {
  return fs.readFileSync(filepath, 'utf-8');
}

/** Atomic write with advisory file locking: acquire lock, write to a temp file, then rename. */
export function writeFileAtomic(filepath: string, content: string): void {
  withLock(filepath, () => {
    const tmp = filepath + '.tmp';
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, filepath);
  });
}
